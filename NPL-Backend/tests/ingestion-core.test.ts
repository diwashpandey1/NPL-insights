import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { filterSourceRowsBySeason, mapDeliveryRecord, mapMatchRecord } from '../src/ingestion/parsers/delivery-parser.js';
import { readCsvFile, parseCsvRecords } from '../src/ingestion/readers/source-reader.js';
import { canonicalizeTeamName, normalizeSeasonValue, splitFielders } from '../src/ingestion/utils/normalization.js';
import { runSeasonIngestion, validateSourceData } from '../src/ingestion/services/ingestion-service.js';
import { SupabaseIngestionRepository } from '../src/ingestion/repositories/supabase-repository.js';

test('CSV parsing handles quoted values and empty rows', async () => {
  const csv = 'id,name,notes\n1,"Alpha, Inc","hello"\n\n2,"Beta","world"\n';
  const rows = parseCsvRecords(csv);
  assert.deepEqual(rows[0], ['id', 'name', 'notes']);
  assert.deepEqual(rows[1], ['1', 'Alpha, Inc', 'hello']);
  assert.deepEqual(rows[2], ['2', 'Beta', 'world']);

  const path = fileURLToPath(new URL('./fixtures/sample.csv', import.meta.url));
  const fileRows = await readCsvFile(path);
  assert.equal(fileRows.length, 2);
  assert.equal(fileRows[0].name, 'Alpha');
});

test('season filtering preserves the selected season and rejects unsupported values', () => {
  const rows = [{ season: '2024' }, { season: '2025' }, { season: '2026' }];
  assert.deepEqual(filterSourceRowsBySeason(rows, '2024').map((row) => row.season), ['2024']);
  assert.deepEqual(filterSourceRowsBySeason(rows, '2024/25').map((row) => row.season), ['2024', '2025']);
  assert.throws(() => filterSourceRowsBySeason(rows, '2027'), /Unsupported season selection/);
});

test('team alias resolution canonicalizes known alias variants', () => {
  assert.equal(canonicalizeTeamName('Gorkhas'), 'Kathmandu Gorkhas');
  assert.equal(canonicalizeTeamName('Gurkhas'), 'Kathmandu Gorkhas');
  assert.equal(canonicalizeTeamName('Janakpur Bolts'), 'Janakpur Bolts');
});

test('delivery and match mappings preserve raw source semantics and identifiers', () => {
  const delivery = mapDeliveryRecord({
    match_id: '1_2024_1',
    season: '2024',
    match_number: '1',
    inning: '1',
    batting_team: 'Biratnagar Kings',
    bowling_team: 'Janakpur Bolts',
    ball_over: '0.1',
    ball_result: '0',
    bowler: 'K Mahato',
    batsman: 'Lokesh Bam',
    non_striker: 'MJ Guptill',
    shot_direction: 'mid-off',
    player_out: '',
    dismissal_kind: '',
    fielders: 'Amit; Bob',
    batsman_runs: '0',
    wide_runs: '0',
    bye_runs: '0',
    legbye_runs: '0',
    noball_runs: '0',
    extra_runs: '0',
    total_runs: '0',
  }, 'source.csv', 42);

  assert.equal(delivery.match_id, '1_2024_1');
  assert.equal(delivery.season, '2024');
  assert.equal(delivery.ball_over, '0.1');
  assert.equal(delivery.batting_team, 'Biratnagar Kings');
  assert.deepEqual(splitFielders(delivery.fielders), ['Amit', 'Bob']);

  const match = mapMatchRecord({
    id: '1',
    season: '2024',
    date: '2024-11-30',
    city: 'Kathmandu',
    venue: 'TUICG',
    stage: 'League',
    team_1: 'Kathmandu Gorkhas',
    team_2: 'Janakpur Bolts',
    toss_winner: 'Janakpur Bolts',
    toss_decision: 'field',
    result: 'normal',
    dls_applied: '0',
    super_over: '0',
    winner: 'Janakpur Bolts',
    player_of_the_match: 'BKEL Milantha',
    win_by_runs: '0',
    win_by_wickets: '8',
  }, 'source.csv', 7);

  assert.equal(match.id, '1');
  assert.equal(match.season, '2024');
  assert.equal(match.winner, 'Janakpur Bolts');
  assert.equal(normalizeSeasonValue('2024/25'), '2024/25');
});

test('dry-run validation never requires a live Supabase connection', async () => {
  const report = await validateSourceData('2024/25', { dryRun: true });
  assert.equal(report.dryRun, true);
  assert.ok(report.totalSourceRows >= 1);
  assert.equal(report.successfullyInserted, 0);
});

test('runSeasonIngestion refuses to write to the database when unavailable', async () => {
  const repo = new SupabaseIngestionRepository();
  repo.client = null;

  await assert.rejects(() => runSeasonIngestion('2024/25', { dryRun: false, repository: repo }), /Supabase is not configured or unavailable/);
});
