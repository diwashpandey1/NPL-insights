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

  override async createIngestionRun(
    input: Parameters<SupabaseIngestionRepository['createIngestionRun']>[0],
  ): Promise<{ id: string }> {
    const run = await super.createIngestionRun(input);
    this.runIds.add(run.id);
    return run;
  }
}

async function createLeasedRun(
  repository: TrackingIngestionRepository,
  logicalPath: string,
  sourceSet: string,
  leaseDurationSeconds = 300,
): Promise<{ id: string }> {
  return repository.createIngestionRun({
    pipelineVersion: 'integration-lease-test',
    sourceSet,
    sourceSystem: 'npl-master',
    logicalPath,
    leaseDurationSeconds,
  });
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
  const remainingLeases = repository.runIds.size
    ? await client.from('ingestion_run_leases').select('ingestion_run_id').in('ingestion_run_id', [...repository.runIds])
    : { data: [], error: null };
  assert.ifError(remainingLeases.error);
  assert.equal(remainingLeases.data?.length, 0, 'Test ingestion leases remain after cleanup.');
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

async function cleanupTrackedRuns(
  client: ReturnType<typeof createClient>,
  repositories: TrackingIngestionRepository[],
): Promise<void> {
  const runIds = [...new Set(repositories.flatMap((repository) => [...repository.runIds]))];
  if (!runIds.length) return;
  const { error: leaseError } = await client.from('ingestion_run_leases')
    .delete()
    .in('ingestion_run_id', runIds);
  assert.ifError(leaseError);
  const { error: runError } = await client.from('ingestion_runs').delete().in('id', runIds);
  assert.ifError(runError);
  const remainingLeases = await client.from('ingestion_run_leases')
    .select('ingestion_run_id')
    .in('ingestion_run_id', runIds);
  assert.ifError(remainingLeases.error);
  assert.equal(remainingLeases.data?.length, 0, 'Synthetic ingestion leases remain.');
  const remainingRuns = await client.from('ingestion_runs').select('id').in('id', runIds);
  assert.ifError(remainingRuns.error);
  assert.equal(remainingRuns.data?.length, 0, 'Synthetic ingestion runs remain.');
}

test('local PostgreSQL ingestion and repository integration', {
  skip: !localUrl || !localServiceRoleKey || !localAnonKey
    ? 'Set local URL, service-role key, and anon key; npm run test:integration reports BLOCKED if unavailable.'
    : false,
}, async () => {
  const parsedUrl = new URL(localUrl!);
  assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsedUrl.hostname), 'Integration tests must use loopback Supabase only.');

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
    const metadataRun = await createLeasedRun(
      repository,
      logicalSourcePath(path.join(tempDirectory, 'metadata.csv')),
      `metadata-${suffix}`,
    );
    const metadataMatchSource = await repository.registerSourceFile({
      ingestionRunId: metadataRun.id,
      sourceSystem: 'npl-match-feed',
      logicalPath: matchLogicalPath,
      contentSha256: matchSource.sha256,
      format: 'csv',
      seasonId: null,
      rowCount: 1,
    });
    const repeatedMatchOutcome = await repository.persistMatch({
      record: matchRecord,
      sourceFileId: metadataMatchSource.id,
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
    const unknownTeam = await repository.ensureTeam(`Unknown Franchise ${suffix}`, sourceSystem, metadataRun.id);
    assert.equal(unknownTeam.outcome, 'rejected');
    assert.equal(unknownTeam.data, undefined);

    const teamAlias = await repository.ensureTeam('Kathmandu Gorkhas', sourceSystem, metadataRun.id);
    assert.ok(teamAlias.data?.id);
    const sameTeamAlias = await repository.ensureTeam('Kathmandu Gorkhas', sourceSystem, metadataRun.id);
    assert.equal(sameTeamAlias.outcome, 'unchanged');

    const syntheticSeasonKey = `2099/${suffix}`;
    const newSeason = await repository.ensureSeason(syntheticSeasonKey, syntheticSeasonKey, metadataRun.id);
    assert.equal(newSeason.outcome, 'inserted');
    const existingSeason = await repository.ensureSeason(syntheticSeasonKey, syntheticSeasonKey, metadataRun.id);
    assert.equal(existingSeason.outcome, 'unchanged');
    await repository.completeIngestionRun(metadataRun.id, 0, {
      rowsRead: 0,
      rowsInserted: 0,
      rowsUpdated: 0,
      rowsUnchanged: 0,
      rowsRejected: 0,
    }, { pipelineVersion: 'integration-lease-test' });

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
      sourceSystem: 'npl-master',
      logicalPath: deliveryLogicalPath,
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
    assert.notEqual(replayDeliverySource.id, initialDeliverySourceFileId);
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
    assert.notEqual(replayMatchSource.id, matchSourceFileId);
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
    const repeatedDeliveries = await client.from('deliveries')
      .select('id,source_file_id')
      .eq('match_id', canonicalMatchId);
    assert.ifError(repeatedDeliveries.error);
    assert.equal(repeatedDeliveries.data?.length, 5);
    assert.ok(repeatedDeliveries.data?.every((row) => row.source_file_id === initialDeliverySourceFileId));

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
      sourceSystem: 'npl-master',
      logicalPath: logicalSourcePath(path.join(tempDirectory, 'failure.csv')),
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
      for (const table of ['ingestion_runs', 'ingestion_run_leases', 'source_files', 'ingestion_issues', 'match_source_keys'] as const) {
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
      p_ingestion_run_id: runId,
      p_lease_token: crypto.randomUUID(),
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

test('ambiguous same-count delivery replacement is blocked without canonical writes', {
  skip: !localUrl || !localServiceRoleKey || !localAnonKey
    ? 'Set local URL, service-role key, and anon key; npm run test:integration reports BLOCKED if unavailable.'
    : false,
}, async () => {
  const parsedUrl = new URL(localUrl!);
  assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsedUrl.hostname));

  const client = createClient(localUrl!, localServiceRoleKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const repository = new TrackingIngestionRepository();
  repository.client = client;
  const suffix = crypto.randomUUID().replace(/-/g, '');
  const numericId = Number.parseInt(suffix.slice(0, 7), 16) % 700000 + 200000;
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'npl-swap-'));
  const baseline = {
    teamIds: new Set<string>(),
    seasonIds: new Set<string>(),
    teamAliasIds: new Set<string>(),
    playerIds: new Set<string>(),
  };

  try {
    const teamBaseline = await client.from('teams').select('id')
      .in('canonical_name', ['Kathmandu Gorkhas', 'Janakpur Bolts']);
    assert.ifError(teamBaseline.error);
    for (const team of teamBaseline.data ?? []) baseline.teamIds.add(team.id);
    const seasonBaseline = await client.from('seasons').select('id')
      .in('season_key', ['2024/25', `2099/${suffix}`]);
    assert.ifError(seasonBaseline.error);
    for (const season of seasonBaseline.data ?? []) baseline.seasonIds.add(season.id);
    const aliasBaseline = await client.from('team_aliases').select('id')
      .in('source_system', ['npl-match-feed', 'npl-master'])
      .in('alias_normalized', ['kathmandu gorkhas', 'janakpur bolts']);
    assert.ifError(aliasBaseline.error);
    for (const alias of aliasBaseline.data ?? []) baseline.teamAliasIds.add(alias.id);

    const mainDirectory = path.join(tempDirectory, 'main');
    await fs.mkdir(mainDirectory);
    const originalDeliveries = [
      makeDeliveryRow(numericId, 1, `Swap Batter A ${suffix}`, '0.1'),
      makeDeliveryRow(numericId, 1, `Swap Batter B ${suffix}`, '0.2'),
      makeDeliveryRow(numericId, 1, `Swap Batter C ${suffix}`, '0.3'),
    ];
    const paths = await writeFixture(mainDirectory, [makeMatchRow(numericId)], originalDeliveries);
    const firstReport = await runSeasonIngestion('2024/25', { repository, dataPaths: paths });
    assert.equal(firstReport.failedRecords, 0);

    const matchKey = await client.from('match_source_keys').select('match_id')
      .eq('source_system', 'npl-match-feed')
      .eq('source_season_key', '2024')
      .eq('external_match_key', String(numericId))
      .eq('resolution_status', 'resolved')
      .single();
    assert.ifError(matchKey.error);
    const canonicalMatchId = matchKey.data.match_id;
    const before = await client.from('deliveries')
      .select('id,source_file_id,source_row_number,source_ball_label,batter_name_raw,batter_runs,wide_runs,no_ball_runs,total_runs')
      .eq('match_id', canonicalMatchId)
      .order('innings_no')
      .order('delivery_no');
    assert.ifError(before.error);
    assert.equal(before.data?.length, originalDeliveries.length);

    const swappedDeliveries = [
      originalDeliveries[0]!,
      makeDeliveryRow(numericId, 1, `Replacement Batter ${suffix}`, '0.2'),
      originalDeliveries[2]!,
    ];
    assert.equal(swappedDeliveries.length, originalDeliveries.length);
    await fs.writeFile(paths.ballByBallCsv, toCsv(deliveryHeaders, swappedDeliveries), 'utf8');

    await assert.rejects(
      () => runSeasonIngestion('2024/25', { repository, dataPaths: paths }),
      /no reviewed stable delivery identifier/,
    );
    await assertLatestRunFailed(client, repository);

    const after = await client.from('deliveries')
      .select('id,source_file_id,source_row_number,source_ball_label,batter_name_raw,batter_runs,wide_runs,no_ball_runs,total_runs')
      .eq('match_id', canonicalMatchId)
      .order('innings_no')
      .order('delivery_no');
    assert.ifError(after.error);
    assert.deepEqual(after.data, before.data, 'the failed same-count swap must not mutate canonical deliveries or provenance');

    const failedRunId = [...repository.runIds].at(-1);
    assert.ok(failedRunId);
    const blockingIssue = await client.from('ingestion_issues')
      .select('severity,issue_code,message')
      .eq('ingestion_run_id', failedRunId)
      .eq('issue_code', 'delivery:source-identity-ambiguous')
      .single();
    assert.ifError(blockingIssue.error);
    assert.equal(blockingIssue.data.severity, 'blocking');
    assert.match(blockingIssue.data.message, /same row count/);

    const versions = await client.from('source_files')
      .select('id,content_sha256,ingestion_run_id')
      .eq('source_system', 'npl-master')
      .eq('logical_path', logicalSourcePath(paths.ballByBallCsv))
      .order('loaded_at');
    assert.ifError(versions.error);
    assert.equal(versions.data?.length, 2);
    assert.notEqual(versions.data?.[0]?.id, versions.data?.[1]?.id);
  } finally {
    try {
      await cleanupIntegrationRows(client, repository, tempDirectory, suffix, baseline);
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  }
});

test('active ingestion renews a short lease while processing continues', {
  skip: !localUrl || !localServiceRoleKey || !localAnonKey
    ? 'Set local URL, service-role key, and anon key; npm run test:integration reports BLOCKED if unavailable.'
    : false,
}, async () => {
  const parsedUrl = new URL(localUrl!);
  assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsedUrl.hostname));
  const client = createClient(localUrl!, localServiceRoleKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let delayed = false;
  class SlowIngestionRepository extends TrackingIngestionRepository {
    override async ensureSeason(seasonKey: string, label: string, ingestionRunId: string) {
      if (!delayed) {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 1250));
      }
      return super.ensureSeason(seasonKey, label, ingestionRunId);
    }
  }
  const repository = new SlowIngestionRepository();
  repository.client = client;
  const suffix = crypto.randomUUID().replace(/-/g, '');
  const numericId = Number.parseInt(suffix.slice(0, 7), 16) % 700000 + 200000;
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'npl-heartbeat-'));
  const baseline = {
    teamIds: new Set<string>(),
    seasonIds: new Set<string>(),
    teamAliasIds: new Set<string>(),
    playerIds: new Set<string>(),
  };

  try {
    const teamBaseline = await client.from('teams').select('id')
      .in('canonical_name', ['Kathmandu Gorkhas', 'Janakpur Bolts']);
    assert.ifError(teamBaseline.error);
    for (const team of teamBaseline.data ?? []) baseline.teamIds.add(team.id);
    const seasonBaseline = await client.from('seasons').select('id')
      .in('season_key', ['2024/25', `2099/${suffix}`]);
    assert.ifError(seasonBaseline.error);
    for (const season of seasonBaseline.data ?? []) baseline.seasonIds.add(season.id);
    const aliasBaseline = await client.from('team_aliases').select('id')
      .in('source_system', ['npl-match-feed', 'npl-master'])
      .in('alias_normalized', ['kathmandu gorkhas', 'janakpur bolts']);
    assert.ifError(aliasBaseline.error);
    for (const alias of aliasBaseline.data ?? []) baseline.teamAliasIds.add(alias.id);

    const paths = await writeFixture(
      tempDirectory,
      [makeMatchRow(numericId)],
      [makeDeliveryRow(numericId, 1, `Heartbeat Batter ${suffix}`, '0.1')],
    );
    const report = await runSeasonIngestion('2024/25', {
      repository,
      dataPaths: paths,
      leaseDurationSeconds: 1,
      heartbeatIntervalMs: 100,
    });
    assert.equal(report.failedRecords, 0);
    assert.equal(delayed, true);
    const runId = [...repository.runIds].at(-1);
    assert.ok(runId);
    const run = await client.from('ingestion_runs').select('status').eq('id', runId).single();
    assert.ifError(run.error);
    assert.equal(run.data.status, 'succeeded');
    const releasedLease = await client.from('ingestion_run_leases')
      .select('ingestion_run_id')
      .eq('ingestion_run_id', runId);
    assert.ifError(releasedLease.error);
    assert.equal(releasedLease.data?.length, 0);
  } finally {
    try {
      await cleanupIntegrationRows(client, repository, tempDirectory, suffix, baseline);
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  }
});

test('durable ingestion leases protect, renew, release, and recover source locks', {
  skip: !localUrl || !localServiceRoleKey || !localAnonKey
    ? 'Set local URL, service-role key, and anon key; npm run test:integration reports BLOCKED if unavailable.'
    : false,
}, async () => {
  const parsedUrl = new URL(localUrl!);
  assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsedUrl.hostname));
  const client = createClient(localUrl!, localServiceRoleKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const repoA = new TrackingIngestionRepository();
  repoA.client = client;
  const repoB = new TrackingIngestionRepository();
  repoB.client = client;
  const repositories = [repoA, repoB];
  const suffix = crypto.randomUUID().replace(/-/g, '');
  const sourcePath = (name: string) => `integration/${suffix}/${name}.csv`;

  try {
    await test('simultaneous same-path acquisitions have one owner and completion releases the lease', async () => {
      const target = sourcePath('simultaneous');
      const results = await Promise.all([
        createLeasedRun(repoA, target, `simultaneous-a-${suffix}`).then(
          (run) => ({ repository: repoA, run }),
          (error: Error) => ({ error }),
        ),
        createLeasedRun(repoB, target, `simultaneous-b-${suffix}`).then(
          (run) => ({ repository: repoB, run }),
          (error: Error) => ({ error }),
        ),
      ]);
      const winners = results.filter((result): result is { repository: TrackingIngestionRepository; run: { id: string } } => 'run' in result);
      const blocked = results.filter((result): result is { error: Error } => 'error' in result);
      assert.equal(winners.length, 1);
      assert.equal(blocked.length, 1);
      assert.match(blocked[0]!.error.message, /already running in another process/);

      const lease = await client.from('ingestion_run_leases')
        .select('ingestion_run_id,expires_at')
        .eq('source_system', 'npl-master')
        .eq('logical_path', target)
        .single();
      assert.ifError(lease.error);
      assert.equal(lease.data.ingestion_run_id, winners[0]!.run.id);
      assert.ok(Date.parse(lease.data.expires_at) > Date.now());

      const owner = winners[0]!;
      await owner.repository.completeIngestionRun(owner.run.id, 0, {}, { test: true });
      const released = await client.from('ingestion_run_leases')
        .select('ingestion_run_id')
        .eq('ingestion_run_id', owner.run.id);
      assert.ifError(released.error);
      assert.equal(released.data?.length, 0);
      const retry = await createLeasedRun(owner.repository, target, `simultaneous-retry-${suffix}`);
      await owner.repository.failIngestionRun(retry.id, 'release test', {});
    });

    await test('different source paths hold independent leases', async () => {
      const [runA, runB] = await Promise.all([
        createLeasedRun(repoA, sourcePath('independent-a'), `independent-a-${suffix}`),
        createLeasedRun(repoB, sourcePath('independent-b'), `independent-b-${suffix}`),
      ]);
      const leases = await client.from('ingestion_run_leases')
        .select('ingestion_run_id')
        .in('ingestion_run_id', [runA.id, runB.id]);
      assert.ifError(leases.error);
      assert.equal(leases.data?.length, 2);
      await repoA.failIngestionRun(runA.id, 'independent path test', {});
      await repoB.failIngestionRun(runB.id, 'independent path test', {});
    });

    await test('failure releases an active source lease', async () => {
      const target = sourcePath('failed-release');
      const run = await createLeasedRun(repoA, target, `failed-release-${suffix}`);
      await repoA.failIngestionRun(run.id, 'simulated worker failure', {});
      const released = await client.from('ingestion_run_leases')
        .select('ingestion_run_id')
        .eq('ingestion_run_id', run.id);
      assert.ifError(released.error);
      assert.equal(released.data?.length, 0);
      const retry = await createLeasedRun(repoB, target, `failed-release-retry-${suffix}`);
      await repoB.failIngestionRun(retry.id, 'cleanup', {});
    });

    await test('renewal keeps an older worker active beyond its original expiry', async () => {
      const sourceSystem = 'npl-master';
      const target = sourcePath('renewal');
      const run = await createLeasedRun(repoA, target, `renewal-${suffix}`, 1);
      const before = await client.from('ingestion_run_leases')
        .select('expires_at')
        .eq('ingestion_run_id', run.id)
        .single();
      assert.ifError(before.error);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await repoA.renewIngestionRunLease(run.id);
      const after = await client.from('ingestion_run_leases')
        .select('expires_at')
        .eq('ingestion_run_id', run.id)
        .single();
      assert.ifError(after.error);
      assert.ok(Date.parse(after.data.expires_at) > Date.parse(before.data.expires_at));
      assert.equal(await repoB.expireStaleRuns(sourceSystem, target), 0);
      await new Promise((resolve) => setTimeout(resolve, 700));
      await assert.rejects(
        () => createLeasedRun(repoB, target, `renewal-conflict-${suffix}`),
        /already running in another process/,
      );
      await repoA.failIngestionRun(run.id, 'renewal test complete', {});
    });

    await test('interrupted worker recovery is expiry-based, source-scoped, and fences the old owner', async () => {
      const sourceSystem = 'npl-master';
      const pathA = sourcePath('interrupted-a');
      const pathB = sourcePath('interrupted-b');
      const runA = await createLeasedRun(repoA, pathA, `interrupted-a-${suffix}`, 1);
      const runB = await createLeasedRun(repoB, pathB, `interrupted-b-${suffix}`, 1);
      await new Promise((resolve) => setTimeout(resolve, 1200));

      assert.equal(await repoA.expireStaleRuns(sourceSystem, pathA), 1);
      const statusA = await client.from('ingestion_runs').select('status').eq('id', runA.id).single();
      const statusB = await client.from('ingestion_runs').select('status').eq('id', runB.id).single();
      assert.ifError(statusA.error);
      assert.ifError(statusB.error);
      assert.equal(statusA.data.status, 'failed');
      assert.equal(statusB.data.status, 'running', 'recovery must not expire another path');
      await assert.rejects(() => repoA.renewIngestionRunLease(runA.id), /ingestion_lease_lost/);
      await assert.rejects(() => repoA.registerSourceFile({
        ingestionRunId: runA.id,
        sourceSystem,
        logicalPath: pathA,
        contentSha256: hashContent(`fenced-${suffix}`),
        format: 'csv',
        seasonId: null,
        rowCount: 0,
      }), /ingestion_lease_lost/);

      const recoveredRun = await createLeasedRun(repoA, pathA, `recovered-${suffix}`);
      await repoA.failIngestionRun(recoveredRun.id, 'recovery test complete', {});
      assert.equal(await repoB.expireStaleRuns(sourceSystem, pathB), 1);
    });
  } finally {
    await cleanupTrackedRuns(client, repositories);
  }
});
// ─── Task 3: Failure-safe cleanup ────────────────────────────────────────────

test('failure-safe cleanup: all synthetic records removed despite failures at different persistence stages', {
  skip: !localUrl || !localServiceRoleKey || !localAnonKey
    ? 'Set local URL, service-role key, and anon key; npm run test:integration reports BLOCKED if unavailable.'
    : false,
}, async () => {
  const parsedUrl = new URL(localUrl!);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsedUrl.hostname));

  const client = createClient(localUrl!, localServiceRoleKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const repository = new TrackingIngestionRepository();
  repository.client = client;

  const suffix = crypto.randomUUID().replace(/-/g, '');
  const numericId = Number.parseInt(suffix.slice(0, 7), 16) % 700000 + 200000;
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'npl-cleanup-'));

  const baseline = {
    teamIds: new Set<string>(),
    seasonIds: new Set<string>(),
    teamAliasIds: new Set<string>(),
    playerIds: new Set<string>(),
  };

  try {
    for (const team of (await client.from('teams')
      .select('id').in('canonical_name', ['Kathmandu Gorkhas', 'Janakpur Bolts'])).data ?? []) {
      baseline.teamIds.add(team.id);
    }
    for (const season of (await client.from('seasons')
      .select('id').in('season_key', ['2024/25', `2099/${suffix}`])).data ?? []) {
      baseline.seasonIds.add(season.id);
    }
    for (const alias of (await client.from('team_aliases')
      .select('id')
      .in('source_system', ['npl-match-feed', 'npl-master'])
      .in('alias_normalized', ['kathmandu gorkhas', 'janakpur bolts'])).data ?? []) {
      baseline.teamAliasIds.add(alias.id);
    }

    // ── Subtest 1: Source registration succeeds but ingestion fails ──
    await test('source registration succeeds but ingestion fails: cleanup removes source file and run', async () => {
      const repo = new TrackingIngestionRepository();
      repo.client = client;

      const sourcePath = `integration/${suffix}/stage1-cleanup.csv`;
      const run = await createLeasedRun(repo, sourcePath, `cleanup-stage1-${suffix}`);
      const runId = run.id;

      const sourceFile = await repo.registerSourceFile({
        ingestionRunId: runId,
        sourceSystem: 'npl-master',
        logicalPath: `integration/${suffix}/stage1-cleanup.csv`,
        contentSha256: crypto.createHash('sha256').update(`stage1-${suffix}`).digest('hex'),
        format: 'csv',
        seasonId: null,
        rowCount: 1,
      });

      // Simulate ingestion failure after source registration
      await repo.failIngestionRun(runId, 'simulated stage-1 failure', {});

      // Manual cleanup of synthetic records
      const { error: sfError } = await client.from('source_files').delete().eq('id', sourceFile.id);
      assert.ifError(sfError);
      const { error: runCleanupError } = await client.from('ingestion_runs').delete().eq('id', runId);
      assert.ifError(runCleanupError);
      repo.runIds.delete(runId);

      // Verify no dangling records
      const remainingRun = await client.from('ingestion_runs').select('id').eq('id', runId);
      assert.ifError(remainingRun.error);
      assert.equal(remainingRun.data?.length, 0, 'failed run must be cleaned up');
    });

    // ── Subtest 2: Match persistence succeeds but delivery persistence fails ──
    await test('match persistence succeeds but delivery persistence fails: cleanup removes match and run', async () => {
      // Run a successful first ingestion to ensure season + teams exist in the DB.
      const setupDirectory = await fs.mkdtemp(path.join(tempDirectory, 'stage2-setup-'));
      const setupId = numericId + 1;
      const setupPaths = await writeFixture(
        setupDirectory,
        [makeMatchRow(setupId)],
        [makeDeliveryRow(setupId, 1, `Stage2 Setup Batter ${suffix}`, '0.1')],
      );
      const setupReport = await runSeasonIngestion('2024/25', { repository, dataPaths: setupPaths });
      assert.equal(setupReport.failedRecords, 0);

      // Now exercise the failure scenario with direct repository calls.
      const repo = new TrackingIngestionRepository();
      repo.client = client;

      const sourcePath = `integration/${suffix}/stage2-cleanup.csv`;
      const run = await createLeasedRun(repo, sourcePath, `cleanup-stage2-${suffix}`);
      const runId = run.id;

      const sourceFile = await repo.registerSourceFile({
        ingestionRunId: runId,
        sourceSystem: 'npl-master',
        logicalPath: `integration/${suffix}/stage2-cleanup.csv`,
        contentSha256: crypto.createHash('sha256').update(`stage2-${suffix}`).digest('hex'),
        format: 'csv',
        seasonId: null,
        rowCount: 1,
      });

      // Fetch season and teams (they now exist from the setup run)
      const seasonResult = await client.from('seasons').select('id').eq('season_key', '2024/25');
      assert.ifError(seasonResult.error);
      const seasonId = seasonResult.data?.[0]?.id;
      assert.ok(seasonId, '2024/25 season must exist after setup run');

      const teamRows = await client.from('teams')
        .select('id,canonical_name')
        .in('canonical_name', ['Kathmandu Gorkhas', 'Janakpur Bolts']);
      assert.ifError(teamRows.error);
      const teamIdByName = new Map((teamRows.data ?? []).map((t) => [t.canonical_name, t.id]));
      const teamAId = teamIdByName.get('Kathmandu Gorkhas');
      const teamBId = teamIdByName.get('Janakpur Bolts');
      assert.ok(teamAId);
      assert.ok(teamBId);

      const matchId = numericId + 11;
      const matchRecord = mapMatchRecord(makeMatchRow(matchId), `integration/${suffix}/stage2-cleanup.csv`, 2);
      const matchOutcome = await repo.persistMatch({
        record: matchRecord,
        sourceFileId: sourceFile.id,
        seasonId,
        matchNumber: matchId,
        teamAId,
        teamBId,
        tossWinnerTeamId: null,
        winnerTeamId: null,
        playerOfMatchId: null,
      });
      const matchWasInserted = matchOutcome.outcome === 'inserted' || matchOutcome.outcome === 'updated';
      assert.ok(matchWasInserted, 'match must have been inserted');

      // Delivery persistence fails (invalid player UUID in dismissal fielders)
      // The delivery MUST include a dismissal and fielder so the FK violation fires.
      const deliveryRecord = mapDeliveryRecord(
        makeDeliveryRow(matchId, 1, `Stage2 Batter ${suffix}`, '0.1', {
          player_out: `Stage2 Out ${suffix}`,
          dismissal_kind: 'caught',
          fielders: 'Invalid Fielder',
        }),
        `integration/${suffix}/stage2-cleanup.csv`,
        2,
      );
      const failedDelivery: DeliveryPersistenceInput = {
        delivery: deliveryRecord,
        matchId: matchOutcome.data!.id,
        deliveryNumber: 1,
        sourceFileId: sourceFile.id,
        battingTeamId: teamAId,
        bowlingTeamId: teamBId,
        bowlerId: null,
        batterId: null,
        nonStrikerId: null,
        playerOutId: null,
        // Non-null, non-existent player UUID — triggers FK violation in dismissal_fielders
        fielders: [{ playerId: '00000000-0000-4000-8000-000000000003', name: 'Invalid Fielder' }],
      };
      await assert.rejects(() => repo.persistDeliveryBatch([failedDelivery]));

      await repo.failIngestionRun(runId, 'simulated stage-2 delivery failure', {});

      // Manual cleanup of synthetic records.
      // Delete match_source_keys BEFORE source_files (FK dependency).
      const matchKeyRows = await client.from('match_source_keys').select('id,match_id')
        .eq('source_system', 'npl-match-feed')
        .eq('source_season_key', '2024')
        .eq('external_match_key', String(matchId));
      assert.ifError(matchKeyRows.error);
      for (const key of matchKeyRows.data ?? []) {
        if (key.match_id) {
          await client.from('match_innings').delete().eq('match_id', key.match_id);
          await client.from('deliveries').delete().eq('match_id', key.match_id);
          await client.from('matches').delete().eq('id', key.match_id);
        }
        await client.from('match_source_keys').delete().eq('id', key.id);
      }
      const { error: sfError } = await client.from('source_files').delete().eq('id', sourceFile.id);
      assert.ifError(sfError);
      const { error: runCleanupError } = await client.from('ingestion_runs').delete().eq('id', runId);
      assert.ifError(runCleanupError);
      repo.runIds.delete(runId);

      // Confirm cleanup was complete
      const remainingKey = await client.from('match_source_keys').select('id')
        .eq('external_match_key', String(matchId)).eq('source_season_key', '2024');
      assert.ifError(remainingKey.error);
      assert.equal(remainingKey.data?.length, 0, 'match source key must be cleaned up');

      // Cleanup the setup run
      await cleanupIntegrationRows(client, repository, setupDirectory, suffix, baseline);
    });

    // ── Subtest 3: Delivery persistence succeeds but a later operation fails ──
    await test('delivery persistence succeeds but later operation fails: delivery batch is fully rolled back', async () => {
      // The delivery batch RPC is transactional — a failed batch rolls back all deliveries in it.
      const repo = new TrackingIngestionRepository();
      repo.client = client;

      const mainDirectory = await fs.mkdtemp(path.join(tempDirectory, 'stage3-'));
      const matchId = numericId + 2;
      const paths = await writeFixture(
        mainDirectory,
        [makeMatchRow(matchId)],
        [makeDeliveryRow(matchId, 1, `Stage3 Batter ${suffix}`, '0.1')],
      );
      const firstReport = await runSeasonIngestion('2024/25', { repository: repo, dataPaths: paths });
      assert.equal(firstReport.failedRecords, 0);

      const matchKey = await client.from('match_source_keys')
        .select('match_id')
        .eq('source_system', 'npl-match-feed')
        .eq('source_season_key', '2024')
        .eq('external_match_key', String(matchId))
        .eq('resolution_status', 'resolved')
        .single();
      assert.ifError(matchKey.error);
      const canonicalMatchId = matchKey.data.match_id;

      const teamRows = await client.from('teams')
        .select('id,canonical_name')
        .in('canonical_name', ['Kathmandu Gorkhas', 'Janakpur Bolts']);
      assert.ifError(teamRows.error);
      const teamIdByName = new Map((teamRows.data ?? []).map((t) => [t.canonical_name, t.id]));
      const battingTeamId = teamIdByName.get('Kathmandu Gorkhas')!;
      const bowlingTeamId = teamIdByName.get('Janakpur Bolts')!;

      // Register an extra source file for the failed delivery test
      const extraPath = `integration/${suffix}/stage3-extra.csv`;
      const extraRun = await createLeasedRun(repo, extraPath, `stage3-extra-${suffix}`);
      const failureSourceFile = await repo.registerSourceFile({
        ingestionRunId: extraRun.id,
        sourceSystem: 'npl-master',
        logicalPath: extraPath,
        contentSha256: crypto.createHash('sha256').update(`stage3-extra-${suffix}`).digest('hex'),
        format: 'csv',
        seasonId: null,
        rowCount: 1,
      });

      const deliveryRecord = mapDeliveryRecord(
        makeDeliveryRow(matchId, 3, `Rollback Delivery ${suffix}`, '0.1', {
          player_out: `Rollback Out ${suffix}`,
          dismissal_kind: 'caught',
          fielders: 'Missing Fielder',
        }),
        `integration/${suffix}/stage3-extra.csv`,
        10,
      );

      const deliveriesBeforeCount = (await client.from('deliveries')
        .select('id').eq('match_id', canonicalMatchId)).data?.length ?? 0;

      // Delivery batch with invalid fielder FK — should roll back atomically
      await assert.rejects(() => repo.persistDeliveryBatch([{
        delivery: deliveryRecord,
        matchId: canonicalMatchId,
        deliveryNumber: 1,
        sourceFileId: failureSourceFile.id,
        battingTeamId,
        bowlingTeamId,
        bowlerId: null,
        batterId: null,
        nonStrikerId: null,
        playerOutId: null,
        fielders: [{ playerId: '00000000-0000-4000-8000-000000000003', name: 'Missing Fielder' }],
      }]));

      // Delivery count must be unchanged — the failed batch was fully rolled back
      const deliveriesAfterCount = (await client.from('deliveries')
        .select('id').eq('match_id', canonicalMatchId)).data?.length ?? 0;
      assert.equal(deliveriesAfterCount, deliveriesBeforeCount, 'delivery count must be unchanged after batch rollback');

      // Innings 3 must not exist
      const innings3 = await client.from('match_innings')
        .select('innings_no').eq('match_id', canonicalMatchId).eq('innings_no', 3);
      assert.ifError(innings3.error);
      assert.equal(innings3.data?.length, 0, 'innings 3 must not exist after rollback');

      // Clean up the extra source file and its run
      await repo.failIngestionRun(extraRun.id, 'simulated failed delivery batch', {});
      const { error: sfError } = await client.from('source_files').delete().eq('id', failureSourceFile.id);
      assert.ifError(sfError);
      const { error: extraRunCleanup } = await client.from('ingestion_runs').delete().eq('id', extraRun.id);
      assert.ifError(extraRunCleanup);
      repo.runIds.delete(extraRun.id);

      await cleanupIntegrationRows(client, repo, mainDirectory, suffix, baseline);
    });

    // ── Subtest 4: Dismissal/fielder persistence fails ──
    await test('dismissal or fielder persistence fails: cleanup removes all synthetic records', async () => {
      const repo = new TrackingIngestionRepository();
      repo.client = client;

      const mainDirectory = await fs.mkdtemp(path.join(tempDirectory, 'stage4-'));
      const matchId = numericId + 3;
      const paths = await writeFixture(
        mainDirectory,
        [makeMatchRow(matchId)],
        [makeDeliveryRow(matchId, 1, `Stage4 Batter ${suffix}`, '0.1')],
      );

      const firstReport = await runSeasonIngestion('2024/25', { repository: repo, dataPaths: paths });
      assert.equal(firstReport.failedRecords, 0);

      const matchKey = await client.from('match_source_keys')
        .select('match_id')
        .eq('source_system', 'npl-match-feed')
        .eq('source_season_key', '2024')
        .eq('external_match_key', String(matchId))
        .eq('resolution_status', 'resolved')
        .single();
      assert.ifError(matchKey.error);
      const canonicalMatchId = matchKey.data.match_id;

      const teamRows = await client.from('teams')
        .select('id,canonical_name')
        .in('canonical_name', ['Kathmandu Gorkhas', 'Janakpur Bolts']);
      assert.ifError(teamRows.error);
      const teamIdByName = new Map((teamRows.data ?? []).map((t) => [t.canonical_name, t.id]));
      const battingTeamId = teamIdByName.get('Kathmandu Gorkhas')!;
      const bowlingTeamId = teamIdByName.get('Janakpur Bolts')!;

      // Find the delivery source file by source_system and logical_path basename
      const deliveryCsvPath = logicalSourcePath(paths.ballByBallCsv);
      const sourceFileResult = await client.from('source_files')
        .select('id')
        .eq('source_system', 'npl-master')
        .eq('logical_path', deliveryCsvPath);
      assert.ifError(sourceFileResult.error);
      assert.ok(sourceFileResult.data?.length === 1, 'exactly one delivery source file must exist');
      const sourceFileId = sourceFileResult.data[0]!.id;

      // Delivery with invalid fielder FK to simulate dismissal_fielders failure
      const deliveryRecord = mapDeliveryRecord(
        makeDeliveryRow(matchId, 2, `Stage4 Dismissed Batter ${suffix}`, '0.1', {
          player_out: `Stage4 Out ${suffix}`,
          dismissal_kind: 'caught',
          fielders: 'Missing Fielder',
        }),
        deliveryCsvPath,
        2,
      );

      const deliveriesBeforeCount = (await client.from('deliveries')
        .select('id').eq('match_id', canonicalMatchId)).data?.length ?? 0;

      // This must fail and roll back the entire batch
      await assert.rejects(() => repo.persistDeliveryBatch([{
        delivery: deliveryRecord,
        matchId: canonicalMatchId,
        deliveryNumber: 1,
        sourceFileId,
        battingTeamId,
        bowlingTeamId,
        bowlerId: null,
        batterId: null,
        nonStrikerId: null,
        playerOutId: null,
        fielders: [{ playerId: '00000000-0000-4000-8000-000000000003', name: 'Missing Fielder' }],
      }]));

      // Delivery count unchanged
      const deliveriesAfterCount = (await client.from('deliveries')
        .select('id').eq('match_id', canonicalMatchId)).data?.length ?? 0;
      assert.equal(deliveriesAfterCount, deliveriesBeforeCount, 'delivery count must be unchanged after fielder failure rollback');

      // Innings 2 must not exist (it did not exist before the failed batch)
      const innings2 = await client.from('match_innings')
        .select('innings_no').eq('match_id', canonicalMatchId).eq('innings_no', 2);
      assert.ifError(innings2.error);
      assert.equal(innings2.data?.length, 0, 'innings 2 must not exist after rollback');

      await cleanupIntegrationRows(client, repo, mainDirectory, suffix, baseline);
    });
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});
