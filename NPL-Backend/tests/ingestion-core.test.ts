import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canonicalSeasonForSourceYear, seasonSelectionToValues, sourceSeasonMappings } from '../src/ingestion/config/ingestion.config.js';
import {
  filterSourceRowsBySeason,
  mapDeliveryRecord,
  mapMatchRecord,
} from '../src/ingestion/parsers/delivery-parser.js';
import {
  parseCsvRecords,
  parseCsvRecordsWithLineNumbers,
  readCsvFile,
} from '../src/ingestion/readers/source-reader.js';
import { canonicalizeTeamName, computeFileSha256, normalizeSeasonValue, splitFielders } from '../src/ingestion/utils/normalization.js';
import {
  assignDeliverySequences,
  mapDeliveryMatchToSourceIdentity,
  resolveUniqueSourceMatch,
  runSeasonIngestion,
  validateSourceData,
} from '../src/ingestion/services/ingestion-service.js';
import { SupabaseIngestionRepository, type IngestionRepository } from '../src/ingestion/repositories/supabase-repository.js';
import type {
  DeliveryRecord,
  IngestionIssue,
  MatchRecord,
  PersistenceOutcome,
  SourceFileRegistration,
} from '../src/ingestion/types/index.js';

const sourceFile = 'data/processed/source.csv';
const matchHeader = [
  'id', 'season', 'date', 'city', 'venue', 'stage', 'team_1', 'team_2',
  'toss_winner', 'toss_decision', 'result', 'dls_applied', 'super_over',
  'winner', 'player_of_the_match', 'win_by_runs', 'win_by_wickets',
].join(',');
const deliveryHeader = [
  'match_id', 'season', 'match_number', 'inning', 'batting_team', 'bowling_team',
  'ball_over', 'ball_result', 'bowler', 'batsman', 'non_striker', 'shot_direction',
  'player_out', 'dismissal_kind', 'fielders', 'batsman_runs', 'wide_runs',
  'bye_runs', 'legbye_runs', 'noball_runs', 'extra_runs', 'total_runs',
].join(',');

interface Fixture {
  directory: string;
  dataPaths: { ballByBallCsv: string; matchCsv: string };
  cleanup(): Promise<void>;
}

interface MockRepositoryState {
  sourceFiles: Map<string, { id: string; hash: string; status: string | null; summary: Record<string, unknown> | null }>;
  matches: Map<string, string>;
  deliveries: Set<string>;
  deliverySourceFiles: Map<string, string>;
  matchSourceKeys: Set<string>;
  issues: IngestionIssue[];
  lastDeliveryBatch: Parameters<IngestionRepository['persistDeliveryBatch']>[0];
  matchAttempts: number;
  deliveryAttempts: number;
  teamAttempts: number;
  failMatch: boolean;
  failDeliveryBatch: boolean;
  failTeam: boolean;
  failIssuePersistence: boolean;
  failedRunFinalizations: number;
  runCount: number;
}

function createMockRepository(state: MockRepositoryState): IngestionRepository {
  let currentRunFiles: string[] = [];
  return {
    isAvailable: () => true,
    createIngestionRun: async () => ({ id: `run-${++state.runCount}` }),
    registerSourceFile: async (input): Promise<SourceFileRegistration> => {
      const key = `${input.sourceSystem}\u001f${input.logicalPath}`;
      const existing = state.sourceFiles.get(key);
      if (existing?.hash === input.contentSha256) {
        currentRunFiles.push(key);
        return {
          id: existing.id,
          outcome: 'updated',
          previousRunStatus: existing.status,
          previousSummary: existing.summary,
        };
      }
      const entry = {
        id: `source-${state.sourceFiles.size + 1}`,
        hash: input.contentSha256,
        status: null,
        summary: null,
      };
      state.sourceFiles.set(key, entry);
      currentRunFiles.push(key);
      return { id: entry.id, outcome: 'inserted', previousRunStatus: null, previousSummary: null };
    },
    completeIngestionRun: async (_runId, issueCount, _counters, summary) => {
      for (const key of currentRunFiles) {
        const entry = state.sourceFiles.get(key);
        if (entry) {
          entry.status = issueCount > 0 ? 'completed_with_errors' : 'succeeded';
          entry.summary = summary;
        }
      }
      currentRunFiles = [];
    },
    failIngestionRun: async () => {
      state.failedRunFinalizations += 1;
      for (const key of currentRunFiles) {
        const entry = state.sourceFiles.get(key);
        if (entry) entry.status = 'failed';
      }
      currentRunFiles = [];
    },
    persistIssues: async (issues) => {
      if (state.failIssuePersistence) throw new Error('simulated issue store outage');
      state.issues.push(...issues);
    },
    ensureSeason: async (seasonKey) => ({ outcome: 'unchanged', data: { id: `season-${seasonKey}` } }),
    ensureTeam: async (name) => {
      state.teamAttempts += 1;
      if (state.failTeam) throw new Error('simulated alias insertion error');
      const canonical = canonicalizeTeamName(name);
      return { outcome: 'unchanged', data: { id: `team-${canonical}`, canonicalName: canonical } };
    },
    resolvePlayer: async (name) => ({
      outcome: 'rejected',
      reason: `Unreviewed source player alias: ${name}`,
    }),
    persistReviewedPlayerAlias: async () => ({ outcome: 'inserted', data: { id: 'alias-id' } }),
    persistMatch: async ({ record }) => {
      state.matchAttempts += 1;
      if (state.failMatch) throw new Error('simulated match transaction failure');
      const key = `${record.season}\u001f${record.id}`;
      const id = state.matches.get(key);
      if (id) return { outcome: record.result === 'revised' ? 'updated' : 'unchanged', data: { id } };
      const newId = `match-${state.matches.size + 1}`;
      state.matches.set(key, newId);
      return { outcome: 'inserted', data: { id: newId } };
    },
    resolveMatchSourceKey: async ({ sourceSeasonKey, externalMatchKey }) => {
      const id = state.matches.get(`${sourceSeasonKey}\u001f${externalMatchKey}`);
      return id
        ? { outcome: 'unchanged', data: { id } }
        : { outcome: 'rejected', reason: 'Missing source crosswalk in mock database.' };
    },
    persistMatchSourceKey: async ({ matchId, externalMatchKey }) => {
      const key = `${matchId}\u001f${externalMatchKey}`;
      const existed = state.matchSourceKeys.has(key);
      state.matchSourceKeys.add(key);
      return { outcome: existed ? 'unchanged' : 'inserted' };
    },
    persistUnresolvedMatchKey: async () => {},
    persistDeliveryBatch: async (records) => {
      state.deliveryAttempts += 1;
      state.lastDeliveryBatch = records;
      if (state.failDeliveryBatch) {
        state.failDeliveryBatch = false;
        throw new Error('simulated delivery RPC failure');
      }
      return records.map((input) => {
        const key = `${input.matchId}\u001f${input.delivery.inning}\u001f${input.deliveryNumber}`;
        const existingSourceFile = state.deliverySourceFiles.get(key);
        if (existingSourceFile) {
          if (existingSourceFile === input.sourceFileId) {
            return { outcome: 'unchanged', data: { id: state.deliveries.size } };
          }
          state.deliverySourceFiles.set(key, input.sourceFileId);
          return { outcome: 'updated', data: { id: state.deliveries.size } };
        }
        state.deliveries.add(key);
        state.deliverySourceFiles.set(key, input.sourceFileId);
        return { outcome: 'inserted', data: { id: state.deliveries.size } };
      });
    },
  };
}

function createState(overrides: Partial<MockRepositoryState> = {}): MockRepositoryState {
  return {
    sourceFiles: new Map(),
    matches: new Map(),
    deliveries: new Set(),
    deliverySourceFiles: new Map(),
    matchSourceKeys: new Set(),
    issues: [],
    lastDeliveryBatch: [],
    matchAttempts: 0,
    deliveryAttempts: 0,
    teamAttempts: 0,
    failMatch: false,
    failDeliveryBatch: false,
    failTeam: false,
    failIssuePersistence: false,
    failedRunFinalizations: 0,
    runCount: 0,
    ...overrides,
  };
}

async function createFixture(options: {
  matchRows?: string[];
  deliveryRows?: string[];
  matchYear?: string;
} = {}): Promise<Fixture> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'npl-ingestion-test-'));
  const matchCsvPath = path.join(directory, 'matches.csv');
  const deliveryCsvPath = path.join(directory, 'deliveries.csv');
  const year = options.matchYear ?? '2024';
  const matchId = year === '2025' ? '42' : '1';
  const canonicalNumber = year === '2025' ? '10' : '1';
  const matchRow = [
    matchId, year, `${year}-11-30`, 'Kathmandu', 'TUICG', 'League',
    'Kathmandu Gorkhas', 'Janakpur Bolts', 'Janakpur Bolts', 'field',
    'normal', '0', '0', 'Janakpur Bolts', 'Unlisted Player', '0', '8',
  ].join(',');
  const deliveryRows = options.deliveryRows ?? [
    `${canonicalNumber}_${year}_${canonicalNumber},${year},${canonicalNumber},1,Kathmandu Gorkhas,Janakpur Bolts,0.1,0,Unlisted Bowler,Unlisted Batter,Unlisted Partner,mid-off,,,,0,0,0,0,0,0,0`,
    `${canonicalNumber}_${year}_${canonicalNumber},${year},${canonicalNumber},1,Kathmandu Gorkhas,Janakpur Bolts,0.1,0,Unlisted Bowler,Unlisted Batter,Unlisted Partner,mid-off,,,,0,0,0,0,0,0,0`,
  ];
  await fs.writeFile(matchCsvPath, `${matchHeader}\n${(options.matchRows ?? [matchRow]).join('\n')}\n`, 'utf8');
  await fs.writeFile(deliveryCsvPath, `${deliveryHeader}\n${deliveryRows.join('\n')}\n`, 'utf8');
  return {
    directory,
    dataPaths: { ballByBallCsv: deliveryCsvPath, matchCsv: matchCsvPath },
    cleanup: () => fs.rm(directory, { recursive: true, force: true }),
  };
}

test('CSV parsing preserves quoted values, empty rows, and physical row numbers', async () => {
  const csv = 'id,name,notes\n1,"Alpha, Inc","hello\ncontinued"\n\n2,"Beta","world"\n';
  const rows = parseCsvRecords(csv);
  assert.deepEqual(rows[0], ['id', 'name', 'notes']);
  assert.deepEqual(rows[1], ['1', 'Alpha, Inc', 'hello\ncontinued']);
  assert.deepEqual(parseCsvRecordsWithLineNumbers(csv).map((row) => row.rowNumber), [1, 2, 5]);

  const fixturePath = fileURLToPath(new URL('./fixtures/sample.csv', import.meta.url));
  const fileRows = await readCsvFile(fixturePath);
  assert.equal(fileRows.length, 2);
  assert.equal(fileRows[0].name, 'Alpha');
  assert.throws(() => parseCsvRecords('"unterminated'), /unterminated quoted field/);
});

test('season mapping maps each supported selection to the observed source year and canonical season', () => {
  const rows = [{ season: '2024' }, { season: '2025' }, { season: '2026' }];
  const expected: Record<string, string[]> = {
    '2024': ['2024'],
    '2024/25': ['2024'],
    '2025': ['2025'],
    '2025/26': ['2025'],
    all: ['2024', '2025'],
  };
  for (const [selection, years] of Object.entries(expected)) {
    assert.deepEqual([...seasonSelectionToValues(selection)].sort(), years);
    assert.deepEqual(filterSourceRowsBySeason(rows, selection).map((row) => row.season), years);
  }
  assert.deepEqual(canonicalSeasonForSourceYear('2024'), { seasonKey: '2024/25', label: '2024/25' });
  assert.deepEqual(canonicalSeasonForSourceYear('2025'), { seasonKey: '2025/26', label: '2025/26' });
  assert.equal(sourceSeasonMappings['2025']?.matchIdOffset, 32);
  assert.throws(() => filterSourceRowsBySeason(rows, '2027'), /Unsupported season selection/);
});

test('team aliases remain source-original until repository resolution', () => {
  assert.equal(canonicalizeTeamName('Gorkhas'), 'Kathmandu Gorkhas');
  assert.equal(canonicalizeTeamName('Gurkhas'), 'Kathmandu Gorkhas');
  const record = mapDeliveryRecord({
    match_id: '1_2024_1',
    season: '2024',
    batting_team: 'Gurkhas',
    bowling_team: 'Janakpur Bolts',
  }, sourceFile, 2);
  assert.equal(record.batting_team, 'Gurkhas');
});

test('delivery sequencing is source-order stable within match and innings, not ball-label based', () => {
  const first = mapDeliveryRecord({ season: '2024', inning: '1', ball_over: '0.1' }, sourceFile, 8);
  const second = mapDeliveryRecord({ season: '2024', inning: '1', ball_over: '0.1' }, sourceFile, 3);
  const otherInnings = mapDeliveryRecord({ season: '2024', inning: '2', ball_over: '0.1' }, sourceFile, 4);
  const result = assignDeliverySequences([
    { record: first, matchId: 'match-a' },
    { record: second, matchId: 'match-a' },
    { record: otherInnings, matchId: 'match-a' },
  ]);
  assert.deepEqual(result.map((item) => [item.record.sourceRowNumber, item.deliveryNumber]), [[3, 1], [8, 2], [4, 1]]);
});

test('delivery match crosswalk detects 2025 duplicate and missing match-feed IDs', () => {
  const ambiguous = [42, 42].map((id, index) => mapMatchRecord({
    id: String(id),
    season: '2025',
    team_1: 'Kathmandu Gorkhas',
    team_2: 'Janakpur Bolts',
  }, sourceFile, index + 2));
  assert.equal(mapDeliveryMatchToSourceIdentity('2025', 10), '2025\u001f42');
  assert.equal(resolveUniqueSourceMatch(ambiguous).status, 'ambiguous');
  assert.equal(mapDeliveryMatchToSourceIdentity('2025', 11), '2025\u001f43');
  assert.equal(resolveUniqueSourceMatch([]).status, 'missing');
  assert.equal(mapDeliveryMatchToSourceIdentity('2024', 1), '2024\u001f1');
});

test('fielder splitting preserves an ambiguous slash-delimited value as one raw name', () => {
  assert.deepEqual(splitFielders('Amit; Bob | Charlie'), ['Amit', 'Bob', 'Charlie']);
  assert.deepEqual(splitFielders('Amit / Bob'), ['Amit / Bob']);
});

test('source-file hashes change when the source bytes change', async () => {
  const fixture = await createFixture();
  try {
    const before = await computeFileSha256(fixture.dataPaths.matchCsv);
    await fs.appendFile(fixture.dataPaths.matchCsv, '\n', 'utf8');
    const after = await computeFileSha256(fixture.dataPaths.matchCsv);
    assert.notEqual(before, after);
  } finally {
    await fixture.cleanup();
  }
});

test('ingestion counts only repository-confirmed outcomes and retries idempotently', async () => {
  const fixture = await createFixture();
  const state = createState({ failDeliveryBatch: true });
  const repository = createMockRepository(state);
  try {
    const first = await runSeasonIngestion('2024/25', { repository, dataPaths: fixture.dataPaths });
    assert.equal(first.successfullyInserted, 1);
    assert.equal(first.failedRecords, 2);
    assert.equal(first.skippedRecords, 0);
    assert.equal(state.deliveries.size, 0);
    assert.equal(first.processedSeasons.join(','), '2024/25');

    const retry = await runSeasonIngestion('2024/25', { repository, dataPaths: fixture.dataPaths });
    assert.equal(retry.successfullyInserted, 2);
    assert.equal(retry.skippedRecords, 1);
    assert.equal(retry.failedRecords, 0);
    assert.equal(state.deliveries.size, 2);
    assert.equal(state.lastDeliveryBatch[0]?.batterId, null);
    assert.equal(state.lastDeliveryBatch[0]?.delivery.batsman, 'Unlisted Batter');
    assert.equal(state.lastDeliveryBatch[0]?.deliveryNumber, 1);
    assert.equal(state.lastDeliveryBatch[1]?.deliveryNumber, 2);
    assert.equal(retry.unresolvedPlayers, 4);
  } finally {
    await fixture.cleanup();
  }
});

test('unchanged source files skip after successful processing without inserting duplicates', async () => {
  const fixture = await createFixture();
  const state = createState();
  const repository = createMockRepository(state);
  try {
    const first = await runSeasonIngestion('2024', { repository, dataPaths: fixture.dataPaths });
    assert.equal(first.successfullyInserted, 3);
    assert.equal(state.deliveries.size, 2);

    const second = await runSeasonIngestion('2024/25', { repository, dataPaths: fixture.dataPaths });
    assert.equal(second.successfullyInserted, 0);
    assert.equal(second.skippedRecords, 3);
    assert.equal(state.matchAttempts, 1);
    assert.equal(state.deliveryAttempts, 1);
    assert.equal(state.deliveries.size, 2);
  } finally {
    await fixture.cleanup();
  }
});

test('changed delivery file reuses resolved matches and reports updated source provenance', async () => {
  const fixture = await createFixture();
  const state = createState();
  const repository = createMockRepository(state);
  try {
    const first = await runSeasonIngestion('2024', { repository, dataPaths: fixture.dataPaths });
    assert.equal(first.successfullyInserted, 3);

    await fs.appendFile(fixture.dataPaths.ballByBallCsv, '\n', 'utf8');
    const second = await runSeasonIngestion('2024', { repository, dataPaths: fixture.dataPaths });
    assert.equal(second.updatedRecords, 2);
    assert.equal(second.skippedRecords, 1);
    assert.equal(second.failedRecords, 0);
    assert.equal(state.matchAttempts, 1);
    assert.equal(state.deliveryAttempts, 2);
    assert.equal(state.deliveries.size, 2);
  } finally {
    await fixture.cleanup();
  }
});

test('changed match metadata counts only the repository-confirmed update', async () => {
  const fixture = await createFixture();
  const state = createState();
  const repository = createMockRepository(state);
  try {
    await runSeasonIngestion('2024', { repository, dataPaths: fixture.dataPaths });
    const matchCsv = await fs.readFile(fixture.dataPaths.matchCsv, 'utf8');
    await fs.writeFile(fixture.dataPaths.matchCsv, matchCsv.replace(',normal,', ',revised,'), 'utf8');

    const report = await runSeasonIngestion('2024', { repository, dataPaths: fixture.dataPaths });
    assert.equal(report.updatedRecords, 1);
    assert.equal(report.skippedRecords, 2);
    assert.equal(report.successfullyInserted, 0);
    assert.equal(report.failedRecords, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('ambiguous match IDs are preserved as issues and do not persist child deliveries', async () => {
  const fixture = await createFixture({ matchRows: [
    '1,2024,2024-11-30,Kathmandu,TUICG,League,Kathmandu Gorkhas,Janakpur Bolts,Janakpur Bolts,field,normal,0,0,Janakpur Bolts,Player,0,8',
    '1,2024,2024-11-30,Kathmandu,TUICG,League,Kathmandu Gorkhas,Janakpur Bolts,Janakpur Bolts,field,normal,0,0,Janakpur Bolts,Player,0,8',
  ] });
  const state = createState();
  const repository = createMockRepository(state);
  try {
    const report = await runSeasonIngestion('2024', { repository, dataPaths: fixture.dataPaths });
    assert.equal(report.duplicateRecords, 4);
    assert.equal(report.successfullyInserted, 0);
    assert.equal(state.matchAttempts, 0);
    assert.equal(state.deliveryAttempts, 0);
    assert.ok(report.issues.some((issue) => issue.code === 'match:crosswalk-ambiguous'));
  } finally {
    await fixture.cleanup();
  }
});

test('dry-run reports crosswalk duplicates without claiming database identity verification', async () => {
  const fixture = await createFixture({
    matchYear: '2025',
    matchRows: [
      '42,2025,2025-11-20,Kathmandu,TUICG,League,Kathmandu Gorkhas,Janakpur Bolts,Janakpur Bolts,field,normal,0,0,Janakpur Bolts,Player,0,8',
      '42,2025,2025-11-20,Kathmandu,TUICG,League,Kathmandu Gorkhas,Janakpur Bolts,Janakpur Bolts,field,normal,0,0,Janakpur Bolts,Player,0,8',
    ],
    deliveryRows: [
      [
        '10_2025_10', '2025', '10', '1', 'Kathmandu Gorkhas', 'Janakpur Bolts',
        '0.1', '0', 'Bowler', 'Batter', 'Partner', '', '', '', '', '0', '0',
        '0', '0', '0', '0', '0',
      ].join(','),
    ],
  });
  try {
    const report = await validateSourceData('2025/26', { dryRun: true, dataPaths: fixture.dataPaths });
    assert.equal(report.identityResolutionPerformed, false);
    assert.equal(report.failedRecords, 3);
    assert.equal(report.duplicateRecords, 3);
    assert.ok(report.issues.some((issue) => issue.code === 'match:crosswalk-ambiguous'));
  } finally {
    await fixture.cleanup();
  }
});

test('failed parent match persistence blocks dependent deliveries and reports failure', async () => {
  const fixture = await createFixture();
  const state = createState({ failMatch: true });
  const repository = createMockRepository(state);
  try {
    const report = await runSeasonIngestion('2024', { repository, dataPaths: fixture.dataPaths });
    assert.equal(report.failedRecords, 3);
    assert.equal(report.successfullyInserted, 0);
    assert.equal(state.deliveryAttempts, 0);
    assert.ok(report.issues.some((issue) => issue.code === 'delivery:parent-match-unavailable'));
  } finally {
    await fixture.cleanup();
  }
});

test('team alias persistence errors are explicit and stop dependent record writes', async () => {
  const fixture = await createFixture();
  const state = createState({ failTeam: true });
  const repository = createMockRepository(state);
  try {
    const report = await runSeasonIngestion('2024', { repository, dataPaths: fixture.dataPaths });
    assert.equal(report.successfullyInserted, 0);
    assert.equal(state.matchAttempts, 0);
    assert.equal(state.deliveryAttempts, 0);
    assert.ok(report.issues.some((issue) => issue.code === 'team:alias-persistence-failed'));
  } finally {
    await fixture.cleanup();
  }
});

test('dry-run performs no repository writes and database unavailability is explicit', async () => {
  const fixture = await createFixture();
  const state = createState();
  const repository = createMockRepository(state);
  try {
    const report = await validateSourceData('2024/25', { dryRun: true, repository, dataPaths: fixture.dataPaths });
    assert.equal(report.dryRun, true);
    assert.equal(report.totalSourceRows, 3);
    assert.equal(report.successfullyInserted, 0);
    assert.equal(state.runCount, 0);
    assert.equal(state.matchAttempts, 0);
    assert.equal(state.deliveryAttempts, 0);

    const unavailable = new SupabaseIngestionRepository();
    unavailable.client = null;
    await assert.rejects(() => runSeasonIngestion('2024/25', { repository: unavailable, dataPaths: fixture.dataPaths }), /Supabase is not configured or unavailable/);
  } finally {
    await fixture.cleanup();
  }
});

test('delivery batch database errors are accurately reported and ingestion run is finalized', async () => {
  const fixture = await createFixture();
  const state = createState({ failDeliveryBatch: true });
  const repository = createMockRepository(state);
  try {
    const report = await runSeasonIngestion('2024/25', { repository, dataPaths: fixture.dataPaths });
    assert.equal(report.failedRecords, 2);
    assert.equal(report.successfullyInserted, 1);
    assert.ok(report.issues.filter((issue) => issue.code === 'delivery:batch-persistence-failed').length === 2);
    const sourceFileStates = [...state.sourceFiles.values()];
    assert.ok(sourceFileStates.every((sourceFile) => sourceFile.status === 'completed_with_errors'));
  } finally {
    await fixture.cleanup();
  }
});

test('issue persistence failure still attempts to finalize the ingestion run', async () => {
  const fixture = await createFixture();
  const state = createState({ failIssuePersistence: true });
  const repository = createMockRepository(state);
  try {
    await assert.rejects(
      () => runSeasonIngestion('2024/25', { repository, dataPaths: fixture.dataPaths }),
      /simulated issue store outage/,
    );
    assert.equal(state.failedRunFinalizations, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('mapped dismissal and fielder values retain null identity and raw source text', () => {
  const delivery = mapDeliveryRecord({
    season: '2024',
    inning: '1',
    player_out: 'Unresolved Player',
    dismissal_kind: 'caught',
    fielders: 'First Fielder / Second Fielder',
  }, sourceFile, 22);
  assert.equal(delivery.player_out, 'Unresolved Player');
  assert.equal(delivery.dismissal_kind, 'caught');
  assert.deepEqual(splitFielders(delivery.fielders), ['First Fielder / Second Fielder']);
});

test('the repository never creates a player when reviewed alias resolution misses', async () => {
  const repository = new SupabaseIngestionRepository();
  let selectCalls = 0;
  const fakeQuery = {
    select() { return this; },
    eq() { return this; },
    async maybeSingle() {
      selectCalls += 1;
      return { data: null, error: null };
    },
  };
  const client = {
    from() { return fakeQuery; },
  } as unknown as NonNullable<typeof repository.client>;
  repository.client = client;
  const result: PersistenceOutcome<{ id: string; displayName: string }> = await repository.resolvePlayer('Ambiguous Name', 'npl-master');
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.data, undefined);
  assert.equal(selectCalls, 1);
});

test('source-file reconciliation sends stable path and hash and returns the previous run state', async () => {
  const repository = new SupabaseIngestionRepository();
  let calledFunction = '';
  let rpcArgs: Record<string, unknown> = {};
  repository.client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calledFunction = name;
      rpcArgs = args;
      return {
        data: {
          id: 'source-file-id',
          outcome: 'updated',
          previousRunStatus: 'completed_with_errors',
          previousSummary: { processedSeasons: ['2024/25'] },
        },
        error: null,
      };
    },
  } as unknown as NonNullable<typeof repository.client>;

  const result = await repository.registerSourceFile({
    ingestionRunId: 'run-id',
    sourceSystem: 'npl-master',
    logicalPath: 'data/processed/source.csv',
    contentSha256: 'a'.repeat(64),
    format: 'csv',
    seasonId: null,
    rowCount: 20,
  });
  assert.equal(calledFunction, 'ingestion_register_source_file');
  assert.equal(rpcArgs.p_logical_path, 'data/processed/source.csv');
  assert.equal(rpcArgs.p_content_sha256, 'a'.repeat(64));
  assert.equal(result.id, 'source-file-id');
  assert.equal(result.previousRunStatus, 'completed_with_errors');
  assert.deepEqual(result.previousSummary, { processedSeasons: ['2024/25'] });
});

test('repository surfaces team alias RPC errors instead of hiding partial writes', async () => {
  const repository = new SupabaseIngestionRepository();
  repository.client = {
    rpc: async () => ({ data: null, error: { message: 'alias unique constraint failed' } }),
  } as unknown as NonNullable<typeof repository.client>;
  await assert.rejects(
    () => repository.ensureTeam('Gurkhas', 'npl-master'),
    /alias unique constraint failed/,
  );
});

test('repository accepts a rejected team alias result without a canonical id', async () => {
  const repository = new SupabaseIngestionRepository();
  repository.client = {
    rpc: async () => ({
      data: { outcome: 'rejected', reason: 'The canonical team key and name refer to different existing teams.' },
      error: null,
    }),
  } as unknown as NonNullable<typeof repository.client>;

  assert.deepEqual(await repository.ensureTeam('Gurkhas', 'npl-master'), {
    outcome: 'rejected',
    reason: 'The canonical team key and name refer to different existing teams.',
  });
});

test('delivery RPC mapping preserves dismissal, ambiguous fielder text, and nullable identities', async () => {
  const repository = new SupabaseIngestionRepository();
  let rpcArgs: Record<string, unknown> = {};
  repository.client = {
    rpc: async (_name: string, args: Record<string, unknown>) => {
      rpcArgs = args;
      return { data: [{ id: 17, outcome: 'inserted' }], error: null };
    },
  } as unknown as NonNullable<typeof repository.client>;

  const delivery = mapDeliveryRecord({
    season: '2024',
    inning: '1',
    ball_over: '4.3',
    bowler: 'Unknown Bowler',
    batsman: 'Unknown Batter',
    non_striker: 'Unknown Partner',
    player_out: 'Unknown Player',
    dismissal_kind: 'caught',
    fielders: 'First / Second',
    batsman_runs: '0',
    wide_runs: '',
    bye_runs: '',
    legbye_runs: '',
    noball_runs: '',
    extra_runs: '0',
    total_runs: '0',
  }, sourceFile, 24);
  const result = await repository.persistDeliveryBatch([{
    delivery,
    matchId: 'match-uuid',
    deliveryNumber: 1,
    sourceFileId: 'source-file-uuid',
    battingTeamId: null,
    bowlingTeamId: null,
    bowlerId: null,
    batterId: null,
    nonStrikerId: null,
    playerOutId: null,
    fielders: [{ name: 'First / Second', playerId: null }],
  }]);

  const records = rpcArgs.p_records as Array<{
    delivery: Record<string, unknown>;
    innings: Record<string, unknown>;
    dismissals: Array<{
      player_out_id: string | null;
      player_out_name_raw: string;
      dismissal_kind: string;
      fielders: Array<{ player_id: string | null; fielder_name_raw: string }>;
    }>;
  }>;
  assert.equal(records[0]?.delivery.source_ball_label, '4.3');
  assert.equal(records[0]?.delivery.batter_id, null);
  assert.equal(records[0]?.delivery.batter_name_raw, 'Unknown Batter');
  assert.equal(records[0]?.innings.batting_team_id, null);
  assert.equal(records[0]?.dismissals[0]?.player_out_id, null);
  assert.equal(records[0]?.dismissals[0]?.player_out_name_raw, 'Unknown Player');
  assert.equal(records[0]?.dismissals[0]?.dismissal_kind, 'caught');
  assert.deepEqual(records[0]?.dismissals[0]?.fielders, [{
    fielder_no: 1,
    player_id: null,
    fielder_name_raw: 'First / Second',
  }]);
  assert.equal(result[0]?.outcome, 'inserted');
});
