import { defaultDataPaths } from '../config/ingestion.config.js';
import { readCsvFile } from '../readers/source-reader.js';
import { canonicalizeTeamName, normalizeSeasonValue, parseBoolean, parseInteger } from '../utils/normalization.js';
import type { DeliveryRecord, MatchRecord } from '../types/index.js';

export async function parseBallByBallCsv(filePath = defaultDataPaths.ballByBallCsv): Promise<{ path: string; kind: 'ball-by-ball'; seasonKey: string; rows: Record<string, string>[] }> {
  const rows = await readCsvFile<Record<string, string>>(filePath);
  return { path: filePath, kind: 'ball-by-ball', seasonKey: '2024/25', rows };
}

export async function parseMatchCsv(filePath = defaultDataPaths.matchCsv): Promise<{ path: string; kind: 'match'; seasonKey: string; rows: Record<string, string>[] }> {
  const rows = await readCsvFile<Record<string, string>>(filePath);
  return { path: filePath, kind: 'match', seasonKey: '2024/25', rows };
}

export function filterSourceRowsBySeason<T extends { season: string }>(rows: T[], seasonSelection: string): T[] {
  const normalizedSelection = seasonSelection.trim().toLowerCase();
  const selectedSeasons = new Set<string>();

  if (!normalizedSelection || normalizedSelection === 'all') {
    selectedSeasons.add('2024');
    selectedSeasons.add('2025');
  } else if (normalizedSelection === '2024/25' || normalizedSelection === '2024-25' || normalizedSelection === '202425') {
    selectedSeasons.add('2024');
    selectedSeasons.add('2025');
  } else if (normalizedSelection === '2025/26' || normalizedSelection === '2025-26' || normalizedSelection === '202526') {
    selectedSeasons.add('2025');
  } else if (normalizedSelection === '2024' || normalizedSelection === '2025') {
    selectedSeasons.add(normalizedSelection);
  } else {
    throw new Error(`Unsupported season selection: ${seasonSelection}`);
  }

  return rows.filter((row) => selectedSeasons.has(normalizeSeasonValue(row.season)));
}

export function mapDeliveryRecord(record: Record<string, string>, sourceFile: string, rowNumber: number): DeliveryRecord {
  return {
    sourceRowNumber: rowNumber,
    sourceFile,
    match_id: String(record.match_id ?? record.matchId ?? ''),
    season: normalizeSeasonValue(record.season ?? ''),
    match_number: String(record.match_number ?? record.matchNo ?? ''),
    inning: Number(record.inning ?? 0),
    batting_team: canonicalizeTeamName(record.batting_team ?? record.battingTeam ?? ''),
    bowling_team: canonicalizeTeamName(record.bowling_team ?? record.bowlingTeam ?? ''),
    ball_over: String(record.ball_over ?? record.ballOver ?? ''),
    ball_result: String(record.ball_result ?? record.ballResult ?? ''),
    bowler: String(record.bowler ?? ''),
    batsman: String(record.batsman ?? record.batter ?? ''),
    non_striker: String(record.non_striker ?? record.nonStriker ?? ''),
    shot_direction: String(record.shot_direction ?? record.shotDirection ?? ''),
    player_out: String(record.player_out ?? record.player_dismissed ?? record.playerOut ?? ''),
    dismissal_kind: String(record.dismissal_kind ?? record.dismissalKind ?? ''),
    fielders: String(record.fielders ?? record.fielder ?? ''),
    batsman_runs: parseInteger(record.batsman_runs ?? record.batter_runs ?? record.batterRuns),
    wide_runs: parseInteger(record.wide_runs ?? record.wideRuns),
    bye_runs: parseInteger(record.bye_runs ?? record.byeRuns),
    legbye_runs: parseInteger(record.legbye_runs ?? record.legByeRuns ?? record.leg_bye_runs),
    noball_runs: parseInteger(record.noball_runs ?? record.noBallRuns ?? record.noballRuns),
    extra_runs: parseInteger(record.extra_runs ?? record.extraRuns),
    total_runs: parseInteger(record.total_runs ?? record.totalRuns),
  };
}

export function mapMatchRecord(record: Record<string, string>, sourceFile: string, rowNumber: number): MatchRecord {
  return {
    sourceRowNumber: rowNumber,
    sourceFile,
    id: String(record.id ?? ''),
    season: normalizeSeasonValue(record.season ?? ''),
    date: String(record.date ?? ''),
    city: String(record.city ?? ''),
    venue: String(record.venue ?? ''),
    stage: String(record.stage ?? ''),
    team_1: canonicalizeTeamName(record.team_1 ?? record.team1 ?? ''),
    team_2: canonicalizeTeamName(record.team_2 ?? record.team2 ?? ''),
    toss_winner: canonicalizeTeamName(record.toss_winner ?? ''),
    toss_decision: String(record.toss_decision ?? ''),
    result: String(record.result ?? ''),
    dls_applied: parseBoolean(record.dls_applied ?? ''),
    super_over: parseBoolean(record.super_over ?? ''),
    winner: canonicalizeTeamName(record.winner ?? ''),
    player_of_the_match: String(record.player_of_the_match ?? record.playerOfTheMatch ?? ''),
    win_by_runs: parseInteger(record.win_by_runs ?? record.winByRuns),
    win_by_wickets: parseInteger(record.win_by_wickets ?? record.winByWickets),
  };
}

export async function readDeliverySource(filePath: string): Promise<DeliveryRecord[]> {
  const descriptors = await parseBallByBallCsv(filePath);
  return descriptors.rows.map((row, index) => mapDeliveryRecord(row, filePath, index + 2));
}

export async function readMatchSource(filePath: string): Promise<MatchRecord[]> {
  const descriptors = await parseMatchCsv(filePath);
  return descriptors.rows.map((row, index) => mapMatchRecord(row, filePath, index + 2));
}
