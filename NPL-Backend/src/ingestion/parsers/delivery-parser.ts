import { defaultDataPaths, logicalSourcePath, seasonSelectionToValues } from '../config/ingestion.config.js';
import { readCsvFileWithLineNumbers } from '../readers/source-reader.js';
import { normalizeSeasonValue, parseBoolean, parseInteger } from '../utils/normalization.js';
import type { DeliveryRecord, MatchRecord } from '../types/index.js';

export async function parseBallByBallCsv(filePath = defaultDataPaths.ballByBallCsv): Promise<{ path: string; kind: 'ball-by-ball'; seasonKey: string; rows: Record<string, string>[] }> {
  const rows = await readCsvFileWithLineNumbers<Record<string, string>>(filePath);
  return { path: logicalSourcePath(filePath), kind: 'ball-by-ball', seasonKey: 'source-year', rows: rows.map(({ record, rowNumber }) => ({ ...record, __sourceRowNumber: String(rowNumber) })) };
}

export async function parseMatchCsv(filePath = defaultDataPaths.matchCsv): Promise<{ path: string; kind: 'match'; seasonKey: string; rows: Record<string, string>[] }> {
  const rows = await readCsvFileWithLineNumbers<Record<string, string>>(filePath);
  return { path: logicalSourcePath(filePath), kind: 'match', seasonKey: 'source-year', rows: rows.map(({ record, rowNumber }) => ({ ...record, __sourceRowNumber: String(rowNumber) })) };
}

export function filterSourceRowsBySeason<T extends { season: string }>(rows: T[], seasonSelection: string): T[] {
  const selectedSeasons = seasonSelectionToValues(seasonSelection);
  return rows.filter((row) => selectedSeasons.has(normalizeSeasonValue(row.season)));
}

export function mapDeliveryRecord(record: Record<string, string>, sourceFile: string, rowNumber: number): DeliveryRecord {
  return {
    sourceRowNumber: Number(record.__sourceRowNumber) || rowNumber,
    sourceFile,
    match_id: String(record.match_id ?? record.matchId ?? ''),
    season: normalizeSeasonValue(record.season ?? ''),
    match_number: String(record.match_number ?? record.matchNo ?? ''),
    inning: Number(record.inning ?? 0),
    batting_team: String(record.batting_team ?? record.battingTeam ?? '').trim(),
    bowling_team: String(record.bowling_team ?? record.bowlingTeam ?? '').trim(),
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
    sourceRowNumber: Number(record.__sourceRowNumber) || rowNumber,
    sourceFile,
    id: String(record.id ?? ''),
    season: normalizeSeasonValue(record.season ?? ''),
    date: String(record.date ?? ''),
    city: String(record.city ?? ''),
    venue: String(record.venue ?? ''),
    stage: String(record.stage ?? ''),
    team_1: String(record.team_1 ?? record.team1 ?? '').trim(),
    team_2: String(record.team_2 ?? record.team2 ?? '').trim(),
    toss_winner: String(record.toss_winner ?? '').trim(),
    toss_decision: String(record.toss_decision ?? ''),
    result: String(record.result ?? ''),
    dls_applied: parseBoolean(record.dls_applied ?? ''),
    super_over: parseBoolean(record.super_over ?? ''),
    winner: String(record.winner ?? '').trim(),
    player_of_the_match: String(record.player_of_the_match ?? record.playerOfTheMatch ?? ''),
    win_by_runs: parseInteger(record.win_by_runs ?? record.winByRuns),
    win_by_wickets: parseInteger(record.win_by_wickets ?? record.winByWickets),
  };
}

export async function readDeliverySource(filePath: string): Promise<DeliveryRecord[]> {
  const descriptors = await parseBallByBallCsv(filePath);
  return descriptors.rows.map((row) => mapDeliveryRecord(row, descriptors.path, Number(row.__sourceRowNumber)));
}

export async function readMatchSource(filePath: string): Promise<MatchRecord[]> {
  const descriptors = await parseMatchCsv(filePath);
  return descriptors.rows.map((row) => mapMatchRecord(row, descriptors.path, Number(row.__sourceRowNumber)));
}
