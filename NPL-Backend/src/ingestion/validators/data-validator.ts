import { formatIssueCode, normalizeSeasonValue } from '../utils/normalization.js';
import type { DeliveryRecord, IngestionIssue, IngestionReport, MatchRecord } from '../types/index.js';

export function validateSeasonSelection(seasonSelection: string): boolean {
  const allowed = new Set(['2024', '2025', '2024/25', '2025/26', 'all']);
  const value = seasonSelection.trim().toLowerCase();
  return value === '' || allowed.has(value) || allowed.has(value.replace(/-/g, '/'));
}

export function validateMatchRecord(record: MatchRecord, issues: IngestionIssue[]): boolean {
  let valid = true;

  if (!record.id) {
    issues.push({ severity: 'error', code: formatIssueCode('match', 'missing-id'), message: 'Missing canonical match ID.', sourceFile: record.sourceFile, rowNumber: record.sourceRowNumber, entityName: 'match', columnName: 'id' });
    valid = false;
  }

  if (!record.season) {
    issues.push({ severity: 'warning', code: formatIssueCode('match', 'missing-season'), message: 'Season is missing.', sourceFile: record.sourceFile, rowNumber: record.sourceRowNumber, entityName: 'match', columnName: 'season' });
  }

  if (!record.team_1 || !record.team_2) {
    issues.push({ severity: 'error', code: formatIssueCode('match', 'missing-teams'), message: 'Match must reference both teams.', sourceFile: record.sourceFile, rowNumber: record.sourceRowNumber, entityName: 'match', columnName: 'team_1' });
    valid = false;
  }

  if (record.season && !['2024', '2025'].includes(normalizeSeasonValue(record.season))) {
    issues.push({ severity: 'warning', code: formatIssueCode('match', 'unsupported-season'), message: `Season value ${record.season} is not in the supported source set.`, sourceFile: record.sourceFile, rowNumber: record.sourceRowNumber, entityName: 'match', columnName: 'season' });
  }

  return valid;
}

export function validateDeliveryRecord(record: DeliveryRecord, issues: IngestionIssue[]): boolean {
  let valid = true;

  if (!record.match_id) {
    issues.push({ severity: 'error', code: formatIssueCode('delivery', 'missing-match'), message: 'Missing match reference.', sourceFile: record.sourceFile, rowNumber: record.sourceRowNumber, entityName: 'delivery', columnName: 'match_id' });
    valid = false;
  }

  if (!record.batting_team) {
    issues.push({ severity: 'error', code: formatIssueCode('delivery', 'missing-batting-team'), message: 'Batting team is required.', sourceFile: record.sourceFile, rowNumber: record.sourceRowNumber, entityName: 'delivery', columnName: 'batting_team' });
    valid = false;
  }

  if (!record.bowling_team) {
    issues.push({ severity: 'error', code: formatIssueCode('delivery', 'missing-bowling-team'), message: 'Bowling team is required.', sourceFile: record.sourceFile, rowNumber: record.sourceRowNumber, entityName: 'delivery', columnName: 'bowling_team' });
    valid = false;
  }

  if (!record.batsman) {
    issues.push({ severity: 'error', code: formatIssueCode('delivery', 'missing-batter'), message: 'Batter is required.', sourceFile: record.sourceFile, rowNumber: record.sourceRowNumber, entityName: 'delivery', columnName: 'batsman' });
    valid = false;
  }

  if (!record.bowler) {
    issues.push({ severity: 'error', code: formatIssueCode('delivery', 'missing-bowler'), message: 'Bowler is required.', sourceFile: record.sourceFile, rowNumber: record.sourceRowNumber, entityName: 'delivery', columnName: 'bowler' });
    valid = false;
  }

  if (!record.ball_over) {
    issues.push({ severity: 'error', code: formatIssueCode('delivery', 'missing-ball-over'), message: 'Ball over is required.', sourceFile: record.sourceFile, rowNumber: record.sourceRowNumber, entityName: 'delivery', columnName: 'ball_over' });
    valid = false;
  }

  if (record.inning === 0) {
    issues.push({ severity: 'error', code: formatIssueCode('delivery', 'invalid-innings'), message: 'Innings must be greater than zero.', sourceFile: record.sourceFile, rowNumber: record.sourceRowNumber, entityName: 'delivery', columnName: 'inning' });
    valid = false;
  }

  if (record.total_runs === null && record.batsman_runs === null && record.extra_runs === null) {
    issues.push({ severity: 'warning', code: formatIssueCode('delivery', 'run-values-unknown'), message: 'Runs are missing or incomplete.', sourceFile: record.sourceFile, rowNumber: record.sourceRowNumber, entityName: 'delivery', columnName: 'total_runs' });
  }

  if (record.season && !['2024', '2025'].includes(normalizeSeasonValue(record.season))) {
    issues.push({ severity: 'warning', code: formatIssueCode('delivery', 'unsupported-season'), message: `Season value ${record.season} is not in the supported source set.`, sourceFile: record.sourceFile, rowNumber: record.sourceRowNumber, entityName: 'delivery', columnName: 'season' });
  }

  return valid;
}

export function buildReport(
  issues: IngestionIssue[],
  totalRows: number,
  validRecords: number,
  dryRun: boolean,
  files: IngestionReport['files'],
  sourceSet: string,
): IngestionReport {
  const warnings = issues.filter((issue) => issue.severity === 'warning').length;
  const fatalErrors = issues.filter((issue) => issue.severity === 'error' || issue.severity === 'blocking').length;

  return {
    totalSourceRows: totalRows,
    validRecords,
    successfullyInserted: 0,
    updatedRecords: 0,
    skippedRecords: 0,
    failedRecords: 0,
    unresolvedTeams: 0,
    unresolvedPlayers: 0,
    duplicateRecords: 0,
    warnings,
    fatalErrors,
    issues,
    files,
    sourceSet,
    dryRun,
  };
}
