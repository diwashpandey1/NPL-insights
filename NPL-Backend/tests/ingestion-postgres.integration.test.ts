import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createClient } from '@supabase/supabase-js';
import { logicalSourcePath } from '../src/ingestion/config/ingestion.config.js';
import { mapDeliveryRecord, mapMatchRecord } from '../src/ingestion/parsers/delivery-parser.js';
import {
  SupabaseIngestionRepository,
  type DeliveryPersistenceInput,
} from '../src/ingestion/repositories/supabase-repository.js';
import { runSeasonIngestion } from '../src/ingestion/services/ingestion-service.js';
import type { IngestionIssue } from '../src/ingestion/types/index.js';

const localUrl = process.env.NPL_LOCAL_SUPABASE_URL;
const localServiceRoleKey = process.env.NPL_LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const localAnonKey = process.env.NPL_LOCAL_SUPABASE_ANON_KEY;

const matchHeaders = [
  'id', 'season', 'date', 'city', 'venue', 'stage', 'team_1', 'team_2',
  'toss_winner', 'toss_decision', 'result', 'dls_applied', 'super_over',
  'winner', 'player_of_the_match', 'win_by_runs', 'win_by_wickets',
];
const deliveryHeaders = [
  'match_id', 'season', 'match_number', 'inning', 'batting_team', 'bowling_team',
  'ball_over', 'ball_result', 'bowler', 'batsman', 'non_striker', 'shot_direction',
  'player_out', 'dismissal_kind', 'fielders', 'batsman_runs', 'wide_runs',
  'bye_runs', 'legbye_runs', 'noball_runs', 'extra_runs', 'total_runs',
];

type CsvRow = Record<string, string>;

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function toCsv(headers: string[], rows: CsvRow[]): string {
  return [headers.join(','), ...rows.map((row) => headers.map((header) => csvCell(row[header] ?? '')).join(','))].join('\n') + '\n';
}

function makeMatchRow(id: number, season = '2024', teamA = 'Kathmandu Gorkhas', teamB = 'Janakpur Bolts'): CsvRow {
  return {
    id: String(id),
    season,
    date: '2024-12-01',
    city: 'Kathmandu',
    venue: 'Synthetic Ground',
    stage: 'League',
    team_1: teamA,
    team_2: teamB,
    toss_winner: '',
    toss_decision: '',
    result: 'Synthetic result',
    dls_applied: '',
    super_over: '',
    winner: '',
    player_of_the_match: '',
    win_by_runs: '',
    win_by_wickets: '',
  };
}

function makeDeliveryRow(
  matchNo: number,
  inning: number,
  batter: string,
  ballOver: string,
  options: Partial<CsvRow> = {},
  season = '2024',
): CsvRow {
  return {
    match_id: `npl_${season}_${matchNo}`,
    season,
    match_number: String(matchNo),
    inning: String(inning),
    batting_team: inning === 1 ? 'Kathmandu Gorkhas' : 'Janakpur Bolts',
    bowling_team: inning === 1 ? 'Janakpur Bolts' : 'Kathmandu Gorkhas',
    ball_over: ballOver,
    ball_result: 'normal',
    bowler: 'Unreviewed Bowler',
    batsman: batter,
    non_striker: 'Unreviewed Non-Striker',
    shot_direction: '',
    player_out: '',
    dismissal_kind: '',
    fielders: '',
    batsman_runs: '0',
    wide_runs: '0',
    bye_runs: '0',
    legbye_runs: '0',
    noball_runs: '0',
    extra_runs: '0',
    total_runs: '0',
    ...options,
  };
}

async function writeFixture(
  directory: string,
  matchRows: CsvRow[],
  deliveryRows: CsvRow[],
): Promise<{ matchCsv: string; ballByBallCsv: string }> {
  const matchCsv = path.join(directory, 'matches.csv');
  const ballByBallCsv = path.join(directory, 'deliveries.csv');
  await fs.writeFile(matchCsv, toCsv(matchHeaders, matchRows), 'utf8');
  await fs.writeFile(ballByBallCsv, toCsv(deliveryHeaders, deliveryRows), 'utf8');
  return { matchCsv, ballByBallCsv };
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

class TrackingIngestionRepository extends SupabaseIngestionRepository {
  readonly runIds = new Set<string>();

  override async createIngestionRun(input: { pipelineVersion: string; sourceSet: string }): Promise<{ id: string }> {
    const run = await super.createIngestionRun(input);
    this.runIds.add(run.id);
    return run;
  }
}

async function cleanupIntegrationRows(
  client: ReturnType<typeof createClient>,
  repository: TrackingIngestionRepository,
  tempDirectory: string,
  suffix: string,
  baseline: {
    teamIds: Set<string>;
    seasonIds: Set<string>;
    teamAliasIds: Set<string>;
    playerIds: Set<string>;
  },
): Promise<void> {
  const sourceFilesResult = await client.from('source_files')
    .select('id,ingestion_run_id')
    .like('logical_path', `%${path.basename(tempDirectory)}%`);
  assert.ifError(sourceFilesResult.error);
  const sourceFiles = sourceFilesResult.data ?? [];
  const sourceFileIds = sourceFiles.map((sourceFile) => sourceFile.id);
  const runIds = [...new Set([
    ...repository.runIds,
    ...sourceFiles.map((sourceFile) => sourceFile.ingestion_run_id),
  ])];

  if (runIds.length) {
    const { error } = await client.from('ingestion_issues').delete().in('ingestion_run_id', runIds);
    assert.ifError(error);
  }

  const deliveryRowsResult = sourceFileIds.length
    ? await client.from('deliveries').select('id').in('source_file_id', sourceFileIds)
    : { data: [], error: null };
  assert.ifError(deliveryRowsResult.error);
  const deliveryIds = (deliveryRowsResult.data ?? []).map((row) => row.id);
  const dismissalRowsResult = deliveryIds.length
    ? await client.from('dismissals').select('id').in('delivery_id', deliveryIds)
    : { data: [], error: null };
  assert.ifError(dismissalRowsResult.error);
  const dismissalIds = (dismissalRowsResult.data ?? []).map((row) => row.id);
  if (dismissalIds.length) {
    const { error } = await client.from('dismissal_fielders').delete().in('dismissal_id', dismissalIds);
    assert.ifError(error);
    const { error: dismissalError } = await client.from('dismissals').delete().in('id', dismissalIds);
    assert.ifError(dismissalError);
  }
  if (deliveryIds.length) {
    const { error } = await client.from('deliveries').delete().in('id', deliveryIds);
    assert.ifError(error);
  }

  const matchKeysResult = sourceFileIds.length
    ? await client.from('match_source_keys').select('id,match_id').in('source_file_id', sourceFileIds)
    : { data: [], error: null };
  assert.ifError(matchKeysResult.error);
  const matchIds = [...new Set((matchKeysResult.data ?? [])
    .map((key) => key.match_id)
    .filter((id): id is string => Boolean(id)))];
  if (sourceFileIds.length) {
    const { error } = await client.from('match_source_keys').delete().in('source_file_id', sourceFileIds);
    assert.ifError(error);
  }
  if (matchIds.length) {
    const { error } = await client.from('match_innings').delete().in('match_id', matchIds);
    assert.ifError(error);
    const { error: matchError } = await client.from('matches').delete().in('id', matchIds);
    assert.ifError(matchError);
  }
  if (sourceFileIds.length) {
    const { error } = await client.from('match_innings').delete().in('source_file_id', sourceFileIds);
    assert.ifError(error);
    const { error: sourceError } = await client.from('source_files').delete().in('id', sourceFileIds);
    assert.ifError(sourceError);
  }
  if (runIds.length) {
    const { error } = await client.from('ingestion_runs').delete().in('id', runIds);
    assert.ifError(error);
  }

  const playerAliasResult = await client.from('player_aliases')
    .select('id')
    .eq('source_system', `integration-${suffix}`);
  assert.ifError(playerAliasResult.error);
  const playerAliasIds = (playerAliasResult.data ?? []).map((alias) => alias.id);
  if (playerAliasIds.length) {
    const { error } = await client.from('player_aliases').delete().in('id', playerAliasIds);
    assert.ifError(error);
  }
  const playerRows = await client.from('players')
    .select('id')
    .eq('display_name', `Reviewed Integration Player ${suffix}`);
  assert.ifError(playerRows.error);
  const createdPlayerIds = (playerRows.data ?? []).map((player) => player.id)
    .filter((id) => !baseline.playerIds.has(id));
  if (createdPlayerIds.length) {
    const { error } = await client.from('players').delete().in('id', createdPlayerIds);
    assert.ifError(error);
  }

  const testAliases = await client.from('team_aliases')
    .select('id')
    .in('source_system', ['npl-match-feed', 'npl-master', `integration-${suffix}`])
    .in('alias_normalized', ['kathmandu gorkhas', 'janakpur bolts', 'chitwan rhinos']);
  assert.ifError(testAliases.error);
  const createdAliasIds = (testAliases.data ?? []).map((alias) => alias.id)
    .filter((id) => !baseline.teamAliasIds.has(id));
  if (createdAliasIds.length) {
    const { error } = await client.from('team_aliases').delete().in('id', createdAliasIds);
    assert.ifError(error);
  }

  const teamRows = await client.from('teams')
    .select('id')
    .in('canonical_name', ['Kathmandu Gorkhas', 'Janakpur Bolts']);
  assert.ifError(teamRows.error);
  const createdTeamIds = (teamRows.data ?? []).map((team) => team.id)
    .filter((id) => !baseline.teamIds.has(id));
  if (createdTeamIds.length) {
    const { error } = await client.from('teams').delete().in('id', createdTeamIds);
    assert.ifError(error);
  }

  const seasonKeys = ['2024/25', '2025/26', `2099/${suffix}`];
  const seasonRows = await client.from('seasons').select('id').in('season_key', seasonKeys);
  assert.ifError(seasonRows.error);
  const createdSeasonIds = (seasonRows.data ?? []).map((season) => season.id)
    .filter((id) => !baseline.seasonIds.has(id));
  if (createdSeasonIds.length) {
    const { error } = await client.from('seasons').delete().in('id', createdSeasonIds);
    assert.ifError(error);
  }

  const remainingSources = await client.from('source_files')
    .select('id')
    .like('logical_path', `%${path.basename(tempDirectory)}%`);
  assert.ifError(remainingSources.error);
  assert.equal(remainingSources.data?.length, 0, `Test source files remain below ${path.basename(tempDirectory)}.`);
  const remainingRuns = repository.runIds.size
    ? await client.from('ingestion_runs').select('id').in('id', [...repository.runIds])
    : { data: [], error: null };
  assert.ifError(remainingRuns.error);
  assert.equal(remainingRuns.data?.length, 0, 'Test ingestion runs remain after cleanup.');
}

async function assertLatestRunFailed(
  client: ReturnType<typeof createClient>,
  repository: TrackingIngestionRepository,
): Promise<void> {
  const runIds = [...repository.runIds];
  const latestRunId = runIds[runIds.length - 1];
  assert.ok(latestRunId);
  const run = await client.from('ingestion_runs')
    .select('status,finished_at')
    .eq('id', latestRunId)
    .single();
  assert.ifError(run.error);
  assert.equal(run.data.status, 'failed');
  assert.ok(run.data.finished_at);
}

test('local PostgreSQL ingestion and repository integration', {
  skip: !localUrl || !localServiceRoleKey || !localAnonKey
    ? 'Set local URL, service-role key, and anon key; npm run test:integration reports BLOCKED if unavailable.'
    : false,
}, async () => {
  const parsedUrl = new URL(localUrl!);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsedUrl.hostname), 'Integration tests must use loopback Supabase only.');

  const client = createClient(localUrl!, localServiceRoleKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const repository = new TrackingIngestionRepository();
  repository.client = client;

  const suffix = crypto.randomUUID().replace(/-/g, '');
  const numericId = Number.parseInt(suffix.slice(0, 7), 16) % 700000 + 200000;
  const matchId = String(numericId);
  const sourceSystem = `integration-${suffix}`;
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'npl-ingestion-pg-'));
  const baseline = {
    teamIds: new Set<string>(),
    seasonIds: new Set<string>(),
    teamAliasIds: new Set<string>(),
    playerIds: new Set<string>(),
  };

  try {
    const teamBaseline = await client.from('teams')
      .select('id')
      .in('canonical_name', ['Kathmandu Gorkhas', 'Janakpur Bolts']);
    assert.ifError(teamBaseline.error);
    for (const team of teamBaseline.data ?? []) baseline.teamIds.add(team.id);
    const seasonBaseline = await client.from('seasons')
      .select('id')
      .in('season_key', ['2024/25', '2025/26', `2099/${suffix}`]);
    assert.ifError(seasonBaseline.error);
    for (const season of seasonBaseline.data ?? []) baseline.seasonIds.add(season.id);
    const aliasBaseline = await client.from('team_aliases')
      .select('id')
      .in('source_system', ['npl-match-feed', 'npl-master', sourceSystem])
      .in('alias_normalized', ['kathmandu gorkhas', 'janakpur bolts', 'chitwan rhinos']);
    assert.ifError(aliasBaseline.error);
    for (const alias of aliasBaseline.data ?? []) baseline.teamAliasIds.add(alias.id);
    const playerBaseline = await client.from('players')
      .select('id')
      .eq('display_name', `Reviewed Integration Player ${suffix}`);
    assert.ifError(playerBaseline.error);
    for (const player of playerBaseline.data ?? []) baseline.playerIds.add(player.id);

    const mainDirectory = path.join(tempDirectory, 'main');
    await fs.mkdir(mainDirectory);
    const initialDeliveries = [
      makeDeliveryRow(numericId, 1, `Unreviewed Batter A ${suffix}`, '0.1'),
      makeDeliveryRow(numericId, 1, `Unreviewed Batter B ${suffix}`, '0.1', {
        ball_result: 'wide',
        wide_runs: '1',
        extra_runs: '1',
        total_runs: '1',
      }),
      makeDeliveryRow(numericId, 1, `Unreviewed Batter C ${suffix}`, '0.2', {
        ball_result: 'no-ball',
        player_out: `Unreviewed Out ${suffix}`,
        dismissal_kind: 'caught',
        fielders: 'Unreviewed Fielder One;Unreviewed Fielder Two',
        noball_runs: '1',
        extra_runs: '1',
        total_runs: '1',
      }),
      makeDeliveryRow(numericId, 1, `Unreviewed Batter D ${suffix}`, '0.3'),
      makeDeliveryRow(numericId, 2, `Unreviewed Batter E ${suffix}`, '0.1'),
    ];
    const mainPaths = await writeFixture(mainDirectory, [makeMatchRow(numericId)], initialDeliveries);
    const firstReport = await runSeasonIngestion('2024/25', { repository, dataPaths: mainPaths });
    assert.equal(firstReport.failedRecords, 0);
    assert.equal(firstReport.successfullyInserted, 6);

    const matchLogicalPath = logicalSourcePath(mainPaths.matchCsv);
    const deliveryLogicalPath = logicalSourcePath(mainPaths.ballByBallCsv);
    const matchSource = firstReport.files.find((file) => file.sourceType === 'match');
    const deliverySource = firstReport.files.find((file) => file.sourceType === 'ball-by-ball');
    assert.ok(matchSource);
    assert.ok(deliverySource);

    const matchSourceFiles = await client.from('source_files')
      .select('id')
      .eq('source_system', 'npl-match-feed')
      .eq('logical_path', matchLogicalPath)
      .eq('content_sha256', matchSource.sha256);
    assert.ifError(matchSourceFiles.error);
    assert.equal(matchSourceFiles.data?.length, 1);
    const matchSourceFileId = matchSourceFiles.data![0]!.id;

    const deliverySourceFiles = await client.from('source_files')
      .select('id')
      .eq('source_system', 'npl-master')
      .eq('logical_path', deliveryLogicalPath)
      .eq('content_sha256', deliverySource.sha256);
    assert.ifError(deliverySourceFiles.error);
    assert.equal(deliverySourceFiles.data?.length, 1);
    const initialDeliverySourceFileId = deliverySourceFiles.data![0]!.id;

    const mainMatchKeys = await client.from('match_source_keys')
      .select('match_id')
      .eq('source_system', 'npl-match-feed')
      .eq('source_season_key', '2024')
      .eq('external_match_key', matchId)
      .eq('resolution_status', 'resolved');
    assert.ifError(mainMatchKeys.error);
    assert.equal(mainMatchKeys.data?.length, 1);
    const canonicalMatchId = mainMatchKeys.data![0]!.match_id;
    assert.ok(canonicalMatchId);

    const teamRows = await client.from('teams')
      .select('id,canonical_name')
      .in('canonical_name', ['Kathmandu Gorkhas', 'Janakpur Bolts']);
    assert.ifError(teamRows.error);
    const teamIdByName = new Map((teamRows.data ?? []).map((team) => [team.canonical_name, team.id]));
    const battingTeamId = teamIdByName.get('Kathmandu Gorkhas');
    const bowlingTeamId = teamIdByName.get('Janakpur Bolts');
    assert.ok(battingTeamId);
    assert.ok(bowlingTeamId);

    const canonicalSeason = await client.from('seasons').select('id').eq('season_key', '2024/25').single();
    assert.ifError(canonicalSeason.error);
    const matchRecord = mapMatchRecord(makeMatchRow(numericId), matchLogicalPath, 2);
    const repeatedMatchOutcome = await repository.persistMatch({
      record: matchRecord,
      sourceFileId: matchSourceFileId,
      seasonId: canonicalSeason.data.id,
      matchNumber: numericId,
      teamAId: battingTeamId,
      teamBId: bowlingTeamId,
      tossWinnerTeamId: null,
      winnerTeamId: null,
      playerOfMatchId: null,
    });
    assert.equal(repeatedMatchOutcome.outcome, 'unchanged');

    const allDeliveries = await client.from('deliveries')
      .select('id,innings_no,delivery_no,source_file_id,source_row_number,source_ball_label,wide_runs,no_ball_runs,batter_id,batter_name_raw')
      .eq('match_id', canonicalMatchId)
      .order('innings_no')
      .order('delivery_no');
    assert.ifError(allDeliveries.error);
    assert.equal(allDeliveries.data?.length, 5);
    assert.equal(allDeliveries.data?.filter((row) => row.source_ball_label === '0.1').length, 3);
    assert.equal(allDeliveries.data?.find((row) => row.innings_no === 1 && row.delivery_no === 2)?.wide_runs, 1);
    assert.equal(allDeliveries.data?.find((row) => row.innings_no === 1 && row.delivery_no === 3)?.no_ball_runs, 1);
    assert.equal(allDeliveries.data?.find((row) => row.delivery_no === 1)?.source_file_id, initialDeliverySourceFileId);
    assert.ok(allDeliveries.data?.every((row) => row.batter_id === null));
    assert.ok(allDeliveries.data?.some((row) => row.batter_name_raw === `Unreviewed Batter A ${suffix}`));

    const innings = await client.from('match_innings').select('innings_no').eq('match_id', canonicalMatchId);
    assert.ifError(innings.error);
    assert.deepEqual(new Set(innings.data?.map((row) => row.innings_no)), new Set([1, 2]));
    const dismissedDeliveries = await client.from('deliveries')
      .select('id')
      .eq('match_id', canonicalMatchId)
      .eq('innings_no', 1)
      .eq('delivery_no', 3);
    assert.ifError(dismissedDeliveries.error);
    const dismissalRows = await client.from('dismissals').select('id')
      .eq('delivery_id', dismissedDeliveries.data![0]!.id);
    assert.ifError(dismissalRows.error);
    assert.equal(dismissalRows.data?.length, 1);
    const initialDismissalId = dismissalRows.data![0]!.id;
    const fielderRows = await client.from('dismissal_fielders').select('fielder_no,player_id,fielder_name_raw')
      .eq('dismissal_id', initialDismissalId)
      .order('fielder_no');
    assert.ifError(fielderRows.error);
    assert.equal(fielderRows.data?.length, 2);
    assert.ok(fielderRows.data?.every((fielder) => fielder.player_id === null));
    assert.deepEqual(fielderRows.data?.map((fielder) => fielder.fielder_name_raw), [
      'Unreviewed Fielder One',
      'Unreviewed Fielder Two',
    ]);

    const unknownPlayer = await repository.resolvePlayer(`Definitely Unknown ${suffix}`, sourceSystem);
    assert.equal(unknownPlayer.outcome, 'rejected');
    assert.equal(unknownPlayer.data, undefined);
    const unknownTeam = await repository.ensureTeam(`Unknown Franchise ${suffix}`, sourceSystem);
    assert.equal(unknownTeam.outcome, 'rejected');
    assert.equal(unknownTeam.data, undefined);

    const teamAlias = await repository.ensureTeam('Kathmandu Gorkhas', sourceSystem);
    assert.ok(teamAlias.data?.id);
    const sameTeamAlias = await repository.ensureTeam('Kathmandu Gorkhas', sourceSystem);
    assert.equal(sameTeamAlias.outcome, 'unchanged');
    const conflictingAlias = await client.rpc('ingestion_ensure_team_alias', {
      p_team_key: 'team-janakpur-bolts',
      p_canonical_name: 'Janakpur Bolts',
      p_source_system: 'npl-match-feed',
      p_alias: 'Kathmandu Gorkhas',
      p_alias_normalized: 'kathmandu gorkhas',
    });
    assert.ifError(conflictingAlias.error);
    assert.equal(conflictingAlias.data?.outcome, 'rejected');

    const syntheticSeasonKey = `2099/${suffix}`;
    const newSeason = await repository.ensureSeason(syntheticSeasonKey, syntheticSeasonKey);
    assert.equal(newSeason.outcome, 'inserted');
    const existingSeason = await repository.ensureSeason(syntheticSeasonKey, syntheticSeasonKey);
    assert.equal(existingSeason.outcome, 'unchanged');

    const playerInsert = await client.from('players')
      .insert({ display_name: `Reviewed Integration Player ${suffix}` })
      .select('id')
      .single();
    assert.ifError(playerInsert.error);
    const reviewedAlias = await repository.persistReviewedPlayerAlias({
      playerId: playerInsert.data.id,
      playerName: `Reviewed Alias ${suffix}`,
      sourceSystem,
    });
    assert.equal(reviewedAlias.outcome, 'inserted');
    const sameReviewedAlias = await repository.persistReviewedPlayerAlias({
      playerId: playerInsert.data.id,
      playerName: `Reviewed Alias ${suffix}`,
      sourceSystem,
    });
    assert.equal(sameReviewedAlias.outcome, 'unchanged');
    const resolvedPlayer = await repository.resolvePlayer(`Reviewed Alias ${suffix}`, sourceSystem);
    assert.equal(resolvedPlayer.data?.id, playerInsert.data.id);

    const firstRun = await client.from('source_files').select('ingestion_run_id')
      .eq('id', initialDeliverySourceFileId).single();
    assert.ifError(firstRun.error);
    const firstRunStatus = await client.from('ingestion_runs').select('status,finished_at')
      .eq('id', firstRun.data.ingestion_run_id).single();
    assert.ifError(firstRunStatus.error);
    assert.equal(firstRunStatus.data.status, 'succeeded');
    assert.ok(firstRunStatus.data.finished_at);

    const replayRun = await repository.createIngestionRun({
      pipelineVersion: 'phase-2-final-integrity-audit-v1',
      sourceSet: 'integration-replay',
    });
    const replayDeliverySource = await repository.registerSourceFile({
      ingestionRunId: replayRun.id,
      sourceSystem: 'npl-master',
      logicalPath: deliveryLogicalPath,
      contentSha256: deliverySource.sha256,
      format: 'csv',
      seasonId: null,
      rowCount: initialDeliveries.length,
    });
    assert.equal(replayDeliverySource.id, initialDeliverySourceFileId);
    assert.equal(replayDeliverySource.previousRunStatus, 'succeeded');
    const replayMatchSource = await repository.registerSourceFile({
      ingestionRunId: replayRun.id,
      sourceSystem: 'npl-match-feed',
      logicalPath: matchLogicalPath,
      contentSha256: matchSource.sha256,
      format: 'csv',
      seasonId: null,
      rowCount: 1,
    });
    assert.equal(replayMatchSource.id, matchSourceFileId);
    await repository.completeIngestionRun(replayRun.id, 0, {
      rowsRead: 6,
      rowsInserted: 0,
      rowsUpdated: 0,
      rowsUnchanged: 6,
      rowsRejected: 0,
    }, {
      pipelineVersion: 'phase-2-final-integrity-audit-v1',
      processedSeasons: ['2024/25'],
    });

    const secondReport = await runSeasonIngestion('2024/25', { repository, dataPaths: mainPaths });
    assert.equal(secondReport.successfullyInserted, 0);
    assert.equal(secondReport.updatedRecords, 0);
    assert.equal(secondReport.skippedRecords, 6);
    const repeatedDeliveries = await client.from('deliveries').select('id').eq('match_id', canonicalMatchId);
    assert.ifError(repeatedDeliveries.error);
    assert.equal(repeatedDeliveries.data?.length, 5);

    const changedDeliveries = initialDeliveries.map((row) => ({ ...row }));
    changedDeliveries[1] = {
      ...changedDeliveries[1]!,
      wide_runs: '2',
      extra_runs: '2',
      total_runs: '2',
    };
    await fs.writeFile(mainPaths.ballByBallCsv, toCsv(deliveryHeaders, changedDeliveries), 'utf8');
    const changedReport = await runSeasonIngestion('2024/25', { repository, dataPaths: mainPaths });
    assert.equal(changedReport.successfullyInserted, 0);
    assert.ok(changedReport.updatedRecords > 0);
    const modifiedDelivery = await client.from('deliveries')
      .select('wide_runs,extra_runs,total_runs')
      .eq('match_id', canonicalMatchId)
      .eq('innings_no', 1)
      .eq('delivery_no', 2)
      .single();
    assert.ifError(modifiedDelivery.error);
    assert.deepEqual(modifiedDelivery.data, { wide_runs: 2, extra_runs: 2, total_runs: 2 });

    changedDeliveries[2] = {
      ...changedDeliveries[2]!,
      player_out: '',
      dismissal_kind: '',
      fielders: '',
    };
    await fs.writeFile(mainPaths.ballByBallCsv, toCsv(deliveryHeaders, changedDeliveries), 'utf8');
    await runSeasonIngestion('2024/25', { repository, dataPaths: mainPaths });
    const deliveryThree = await client.from('deliveries')
      .select('id')
      .eq('match_id', canonicalMatchId)
      .eq('innings_no', 1)
      .eq('delivery_no', 3)
      .single();
    assert.ifError(deliveryThree.error);
    const removedDismissals = await client.from('dismissals').select('id')
      .eq('delivery_id', deliveryThree.data.id);
    assert.ifError(removedDismissals.error);
    assert.equal(removedDismissals.data?.length, 0);
    const removedFielders = await client.from('dismissal_fielders').select('fielder_no')
      .eq('dismissal_id', initialDismissalId);
    assert.ifError(removedFielders.error);
    assert.equal(removedFielders.data?.length, 0);

    changedDeliveries[2] = {
      ...changedDeliveries[2]!,
      player_out: `Changed Out ${suffix}`,
      dismissal_kind: 'run out',
      fielders: `Replacement Fielder One ${suffix};Replacement Fielder Two ${suffix}`,
    };
    await fs.writeFile(mainPaths.ballByBallCsv, toCsv(deliveryHeaders, changedDeliveries), 'utf8');
    await runSeasonIngestion('2024/25', { repository, dataPaths: mainPaths });
    const changedDismissal = await client.from('dismissals')
      .select('id,dismissal_kind,player_out_name_raw')
      .eq('delivery_id', deliveryThree.data.id)
      .single();
    assert.ifError(changedDismissal.error);
    assert.equal(changedDismissal.data.dismissal_kind, 'run out');
    assert.equal(changedDismissal.data.player_out_name_raw, `Changed Out ${suffix}`);
    const replacementFielders = await client.from('dismissal_fielders')
      .select('fielder_name_raw')
      .eq('dismissal_id', changedDismissal.data.id)
      .order('fielder_no');
    assert.ifError(replacementFielders.error);
    assert.deepEqual(replacementFielders.data?.map((row) => row.fielder_name_raw), [
      `Replacement Fielder One ${suffix}`,
      `Replacement Fielder Two ${suffix}`,
    ]);

    const withAddedDelivery = [
      ...changedDeliveries,
      makeDeliveryRow(numericId, 1, `Added Delivery ${suffix}`, '0.4'),
    ];
    await fs.writeFile(mainPaths.ballByBallCsv, toCsv(deliveryHeaders, withAddedDelivery), 'utf8');
    await runSeasonIngestion('2024/25', { repository, dataPaths: mainPaths });
    const afterAddition = await client.from('deliveries')
      .select('id,delivery_no,batter_name_raw')
      .eq('match_id', canonicalMatchId)
      .eq('innings_no', 1)
      .order('delivery_no');
    assert.ifError(afterAddition.error);
    assert.equal(afterAddition.data?.length, 5);
    assert.equal(afterAddition.data?.[4]?.delivery_no, 5);
    assert.equal(afterAddition.data?.[4]?.batter_name_raw, `Added Delivery ${suffix}`);

    const beforeBlockedRemoval = afterAddition.data?.map((row) => ({ ...row })) ?? [];
    const removedTailDeliveries = withAddedDelivery.slice(0, -1);
    await fs.writeFile(mainPaths.ballByBallCsv, toCsv(deliveryHeaders, removedTailDeliveries), 'utf8');
    await assert.rejects(
      () => runSeasonIngestion('2024/25', { repository, dataPaths: mainPaths }),
      /Deletion reconciliation is not implemented; refusing to persist this file/,
    );
    await assertLatestRunFailed(client, repository);
    const afterBlockedTailRemoval = await client.from('deliveries')
      .select('id,delivery_no,batter_name_raw')
      .eq('match_id', canonicalMatchId)
      .eq('innings_no', 1)
      .order('delivery_no');
    assert.ifError(afterBlockedTailRemoval.error);
    assert.deepEqual(afterBlockedTailRemoval.data, beforeBlockedRemoval);

    const removedMiddleDeliveries = withAddedDelivery.filter((_, index) => index !== 1);
    await fs.writeFile(mainPaths.ballByBallCsv, toCsv(deliveryHeaders, removedMiddleDeliveries), 'utf8');
    await assert.rejects(
      () => runSeasonIngestion('2024/25', { repository, dataPaths: mainPaths }),
      /Deletion reconciliation is not implemented; refusing to persist this file/,
    );
    await assertLatestRunFailed(client, repository);
    const afterBlockedMiddleRemoval = await client.from('deliveries')
      .select('id,delivery_no,batter_name_raw')
      .eq('match_id', canonicalMatchId)
      .eq('innings_no', 1)
      .order('delivery_no');
    assert.ifError(afterBlockedMiddleRemoval.error);
    assert.deepEqual(afterBlockedMiddleRemoval.data, beforeBlockedRemoval);

    const base2025 = numericId + 100;
    const id2025 = base2025 + 32;
    const correct2025 = await runExtraFixture(
      repository,
      tempDirectory,
      'season-2025',
      '2025/26',
      [makeMatchRow(id2025, '2025')],
      [makeDeliveryRow(base2025, 1, `2025 Batter ${suffix}`, '0.1', {}, '2025')],
    );
    assert.equal(correct2025.failedRecords, 0);
    const resolved2025Key = await client.from('match_source_keys').select('match_id')
      .eq('source_system', 'npl-match-feed')
      .eq('source_season_key', '2025')
      .eq('external_match_key', String(id2025))
      .eq('resolution_status', 'resolved')
      .single();
    assert.ifError(resolved2025Key.error);
    const canonical2025 = await client.from('matches').select('match_number')
      .eq('id', resolved2025Key.data.match_id).single();
    assert.ifError(canonical2025.error);
    assert.equal(canonical2025.data.match_number, base2025);

    const duplicateId = numericId + 200;
    const duplicateReport = await runExtraFixture(
      repository,
      tempDirectory,
      'duplicate-match',
      '2024/25',
      [makeMatchRow(duplicateId), makeMatchRow(duplicateId)],
      [makeDeliveryRow(duplicateId, 1, `Duplicate Batter ${suffix}`, '0.1')],
    );
    assert.ok(duplicateReport.duplicateRecords > 0);
    assert.ok(duplicateReport.issues.some((issue) => issue.code === 'match:crosswalk-ambiguous'));
    const duplicateCanonicalRows = await client.from('match_source_keys').select('match_id')
      .eq('source_system', 'npl-match-feed')
      .eq('source_season_key', '2024')
      .eq('external_match_key', String(duplicateId))
      .eq('resolution_status', 'resolved');
    assert.ifError(duplicateCanonicalRows.error);
    assert.equal(duplicateCanonicalRows.data?.length, 0);

    const missingId = numericId + 300;
    const missingReport = await runExtraFixture(
      repository,
      tempDirectory,
      'missing-match',
      '2024/25',
      [],
      [makeDeliveryRow(missingId, 1, `Missing Batter ${suffix}`, '0.1')],
    );
    assert.ok(missingReport.issues.some((issue) => issue.code === 'match:crosswalk-unresolved'));

    const mismatchId = numericId + 400;
    const mismatchReport = await runExtraFixture(
      repository,
      tempDirectory,
      'team-mismatch',
      '2024/25',
      [makeMatchRow(mismatchId)],
      [makeDeliveryRow(mismatchId, 1, `Mismatch Batter ${suffix}`, '0.1', {
        batting_team: 'Kathmandu Gorkhas',
        bowling_team: 'Chitwan Rhinos',
      })],
    );
    assert.ok(mismatchReport.issues.some((issue) => issue.code === 'match:crosswalk-unresolved'));

    const wrongSeason = await runExtraFixtureFiles(
      tempDirectory,
      'wrong-season',
      [makeMatchRow(numericId + 500, '2025')],
      [makeDeliveryRow(numericId + 500, 1, `Wrong Season Batter ${suffix}`, '0.1', {}, '2025')],
    );
    await assert.rejects(
      () => runSeasonIngestion('2024/25', { repository, dataPaths: wrongSeason }),
      /No matching records found/,
    );

    const failureRun = await repository.createIngestionRun({
      pipelineVersion: 'integration-failure-test',
      sourceSet: 'integration-failure',
    });
    const failureSource = await repository.registerSourceFile({
      ingestionRunId: failureRun.id,
      sourceSystem: 'npl-master',
      logicalPath: logicalSourcePath(path.join(tempDirectory, 'failure.csv')),
      contentSha256: hashContent(`failure-${suffix}`),
      format: 'csv',
      seasonId: null,
      rowCount: 1,
    });

    const invalidMatchId = String(numericId + 600);
    const invalidMatchRecord = mapMatchRecord(makeMatchRow(Number(invalidMatchId)), 'integration/failure-match.csv', 2);
    await assert.rejects(() => repository.persistMatch({
      record: invalidMatchRecord,
      sourceFileId: failureSource.id,
      seasonId: canonicalSeason.data.id,
      matchNumber: Number(invalidMatchId),
      teamAId: '00000000-0000-4000-8000-000000000001',
      teamBId: bowlingTeamId,
      tossWinnerTeamId: null,
      winnerTeamId: null,
      playerOfMatchId: null,
    }));
    const failedMatchKey = await client.from('match_source_keys').select('id')
      .eq('source_system', 'npl-match-feed')
      .eq('source_season_key', '2024')
      .eq('external_match_key', invalidMatchId);
    assert.ifError(failedMatchKey.error);
    assert.equal(failedMatchKey.data?.length, 0);

    const invalidSeasonFile = await repository.registerSourceFile({
      ingestionRunId: failureRun.id,
      sourceSystem: 'npl-master',
      logicalPath: `integration/${suffix}/bad-season.csv`,
      contentSha256: hashContent(`bad-season-${suffix}`),
      format: 'csv',
      seasonId: '00000000-0000-4000-8000-000000000002',
      rowCount: 1,
    }).then(() => null, (error: Error) => error);
    assert.ok(invalidSeasonFile instanceof Error);

    const baseRow = makeDeliveryRow(numericId, 3, `Rollback Batter ${suffix}`, '0.1', {
      player_out: `Rollback Out ${suffix}`,
      dismissal_kind: 'caught',
      fielders: 'Missing Fielder',
    });
    const deliveryRecord = mapDeliveryRecord(baseRow, logicalSourcePath(path.join(tempDirectory, 'failure.csv')), 999);
    const failedBatch: DeliveryPersistenceInput = {
      delivery: deliveryRecord,
      matchId: canonicalMatchId,
      deliveryNumber: 1,
      sourceFileId: failureSource.id,
      battingTeamId: battingTeamId,
      bowlingTeamId: bowlingTeamId,
      bowlerId: null,
      batterId: null,
      nonStrikerId: null,
      playerOutId: null,
      fielders: [{ playerId: '00000000-0000-4000-8000-000000000003', name: 'Missing Fielder' }],
    };
    const deliveriesBeforeFailureQuery = await client.from('deliveries')
      .select('id')
      .eq('match_id', canonicalMatchId);
    assert.ifError(deliveriesBeforeFailureQuery.error);
    const deliveriesBeforeFailure = deliveriesBeforeFailureQuery.data?.length ?? 0;
    await assert.rejects(() => repository.persistDeliveryBatch([failedBatch]));
    const rollbackInnings = await client.from('match_innings').select('innings_no')
      .eq('match_id', canonicalMatchId)
      .eq('innings_no', 3);
    assert.ifError(rollbackInnings.error);
    assert.equal(rollbackInnings.data?.length, 0);
    const rollbackDeliveries = await client.from('deliveries').select('id').eq('match_id', canonicalMatchId);
    assert.ifError(rollbackDeliveries.error);
    assert.equal(rollbackDeliveries.data?.length, deliveriesBeforeFailure);

    const retryBatch: DeliveryPersistenceInput = {
      ...failedBatch,
      fielders: [{ playerId: null, name: 'Missing Fielder' }],
    };
    const retryOutcome = await repository.persistDeliveryBatch([retryBatch]);
    assert.equal(retryOutcome[0]?.outcome, 'inserted');
    const retryDismissal = await client.from('deliveries').select('id')
      .eq('match_id', canonicalMatchId)
      .eq('innings_no', 3)
      .eq('delivery_no', 1)
      .single();
    assert.ifError(retryDismissal.error);
    const retryDismissalRows = await client.from('dismissals').select('id')
      .eq('delivery_id', retryDismissal.data.id);
    assert.ifError(retryDismissalRows.error);
    assert.equal(retryDismissalRows.data?.length, 1);
    const retryFielders = await client.from('dismissal_fielders').select('fielder_name_raw')
      .eq('dismissal_id', retryDismissalRows.data![0]!.id);
    assert.ifError(retryFielders.error);
    assert.deepEqual(retryFielders.data?.map((row) => row.fielder_name_raw), ['Missing Fielder']);

    const failedIssue = await repository.persistIssues([{
      severity: 'error',
      code: 'integration:invalid-row',
      message: 'A row number of zero must be rejected by the database.',
      rowNumber: 0,
    } satisfies IngestionIssue], failureRun.id).then(() => null, (error: Error) => error);
    assert.ok(failedIssue instanceof Error);
    await repository.failIngestionRun(failureRun.id, 'integration failure path', {
      rowsRead: 1,
      rowsInserted: 0,
      rowsUpdated: 0,
      rowsUnchanged: 0,
      rowsRejected: 1,
    });
    const failedRunState = await client.from('ingestion_runs').select('status,finished_at')
      .eq('id', failureRun.id)
      .single();
    assert.ifError(failedRunState.error);
    assert.equal(failedRunState.data.status, 'failed');
    assert.ok(failedRunState.data.finished_at);
  } finally {
    try {
      await cleanupIntegrationRows(client, repository, tempDirectory, suffix, baseline);
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  }
});

test('local anonymous and authenticated clients cannot access ingestion metadata', {
  skip: !localUrl || !localServiceRoleKey || !localAnonKey
    ? 'Set local URL, service-role key, and anon key; npm run test:integration reports BLOCKED if unavailable.'
    : false,
}, async () => {
  const parsedUrl = new URL(localUrl!);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsedUrl.hostname), 'Integration tests must use loopback Supabase only.');

  const clientOptions = { auth: { autoRefreshToken: false, persistSession: false } };
  const serviceClient = createClient(localUrl!, localServiceRoleKey!, clientOptions);
  const anonymousClient = createClient(localUrl!, localAnonKey!, clientOptions);
  const authenticatedClient = createClient(localUrl!, localAnonKey!, clientOptions);
  const suffix = crypto.randomUUID().replace(/-/g, '');
  const email = `npl-integration-${suffix}@example.test`;
  const password = `${crypto.randomBytes(24).toString('base64url')}!`;
  let userId: string | null = null;
  let runId: string | null = null;

  try {
    const userCreation = await serviceClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    assert.ifError(userCreation.error);
    assert.ok(userCreation.data.user);
    userId = userCreation.data.user.id;

    const signIn = await authenticatedClient.auth.signInWithPassword({ email, password });
    assert.ifError(signIn.error);
    assert.equal(signIn.data.user?.id, userId);

    const privateRun = await serviceClient.from('ingestion_runs').insert({
      pipeline_version: 'integration-rls-v1',
      source_set: `rls-${suffix}`,
      status: 'running',
      summary: { test: true },
    }).select('id').single();
    assert.ifError(privateRun.error);
    runId = privateRun.data.id;

    for (const [label, client] of [
      ['anonymous', anonymousClient],
      ['authenticated', authenticatedClient],
    ] as const) {
      for (const table of ['ingestion_runs', 'source_files', 'ingestion_issues', 'match_source_keys'] as const) {
        const { error } = await client.from(table).select('*').limit(1);
        assert.ok(error, `${label} client unexpectedly read restricted table ${table}.`);
        assert.equal(error.code, '42501', `${label} access to ${table} should be rejected by PostgreSQL privileges.`);
      }

      const { error: insertError } = await client.from('ingestion_runs').insert({
        pipeline_version: 'unauthorized-test',
        source_set: `unauthorized-${suffix}`,
      });
      assert.ok(insertError, `${label} client unexpectedly wrote an ingestion run.`);
      assert.equal(insertError.code, '42501');
    }

    const rpcAttempt = await authenticatedClient.rpc('ingestion_ensure_season', {
      p_season_key: `2098/${suffix}`,
      p_label: `2098/${suffix}`,
      p_source_season_year: 2098,
    });
    assert.ok(rpcAttempt.error, 'Authenticated client unexpectedly executed a service-only ingestion RPC.');
    assert.equal(rpcAttempt.error.code, '42501');

    const stillOnlyPrivateRun = await serviceClient.from('ingestion_runs')
      .select('id')
      .eq('source_set', `rls-${suffix}`);
    assert.ifError(stillOnlyPrivateRun.error);
    assert.deepEqual(stillOnlyPrivateRun.data?.map((row) => row.id), [runId]);
  } finally {
    await authenticatedClient.auth.signOut();
    if (runId) {
      const { error } = await serviceClient.from('ingestion_runs').delete().eq('id', runId);
      assert.ifError(error);
    }
    if (userId) {
      const { error } = await serviceClient.auth.admin.deleteUser(userId);
      assert.ifError(error);
    }
  }
});

async function runExtraFixture(
  repository: SupabaseIngestionRepository,
  root: string,
  name: string,
  selection: string,
  matchRows: CsvRow[],
  deliveryRows: CsvRow[],
) {
  const paths = await runExtraFixtureFiles(root, name, matchRows, deliveryRows);
  return runSeasonIngestion(selection, { repository, dataPaths: paths });
}

async function runExtraFixtureFiles(
  root: string,
  name: string,
  matchRows: CsvRow[],
  deliveryRows: CsvRow[],
): Promise<{ matchCsv: string; ballByBallCsv: string }> {
  const directory = await fs.mkdtemp(path.join(root, `${name}-`));
  return writeFixture(directory, matchRows, deliveryRows);
}
