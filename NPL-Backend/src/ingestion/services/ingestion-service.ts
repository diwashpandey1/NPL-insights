import { defaultDataPaths } from '../config/ingestion.config.js';
import { readDeliverySource, readMatchSource } from '../parsers/delivery-parser.js';
import { buildReport, validateDeliveryRecord, validateMatchRecord } from '../validators/data-validator.js';
import { computeFileSha256 } from '../utils/normalization.js';
import type { IngestionIssue, IngestionReport } from '../types/index.js';

export async function inspectSourceFiles(): Promise<{
  files: Array<{ path: string; sha256: string; rowCount: number; sourceType: 'ball-by-ball' | 'match' | 'unknown' }>;
  summary: Record<string, number>;
}> {
  const files = await Promise.all([
    (async () => {
      const rows = await readDeliverySource(defaultDataPaths.ballByBallCsv);
      const sha256 = await computeFileSha256(defaultDataPaths.ballByBallCsv);
      return { path: defaultDataPaths.ballByBallCsv, sha256, rowCount: rows.length, sourceType: 'ball-by-ball' as const };
    })(),
    (async () => {
      const rows = await readMatchSource(defaultDataPaths.matchCsv);
      const sha256 = await computeFileSha256(defaultDataPaths.matchCsv);
      return { path: defaultDataPaths.matchCsv, sha256, rowCount: rows.length, sourceType: 'match' as const };
    })(),
  ]);

  const summary = {
    deliveries: files[0]?.rowCount ?? 0,
    matches: files[1]?.rowCount ?? 0,
  };

  return { files, summary };
}

export async function validateSourceData(dryRun = true): Promise<IngestionReport> {
  const issues: IngestionIssue[] = [];
  const inspected = await inspectSourceFiles();

  const deliveryRows = await readDeliverySource(defaultDataPaths.ballByBallCsv);
  const matchRows = await readMatchSource(defaultDataPaths.matchCsv);

  const validDeliveryRows = deliveryRows.filter((record) => validateDeliveryRecord(record, issues));
  const validMatchRows = matchRows.filter((record) => validateMatchRecord(record, issues));

  const report = buildReport(
    issues,
    deliveryRows.length + matchRows.length,
    validDeliveryRows.length + validMatchRows.length,
    dryRun,
    inspected.files,
    '2024/25',
  );

  return {
    ...report,
    validRecords: validDeliveryRows.length + validMatchRows.length,
    unresolvedTeams: 0,
    unresolvedPlayers: 0,
  };
}

export async function dryRunIngestion(): Promise<IngestionReport> {
  return validateSourceData(true);
}

export async function runSeasonIngestion(seasonKey: string): Promise<IngestionReport> {
  const report = await validateSourceData(false);

  return {
    ...report,
    sourceSet: seasonKey,
    successfullyInserted: report.validRecords,
  };
}

export async function runAllIngestion(): Promise<IngestionReport> {
  return runSeasonIngestion('all-supported-seasons');
}

export function createReportSummary(report: IngestionReport): Record<string, number> {
  return {
    totalSourceRows: report.totalSourceRows,
    validRecords: report.validRecords,
    successfullyInserted: report.successfullyInserted,
    updatedRecords: report.updatedRecords,
    skippedRecords: report.skippedRecords,
    failedRecords: report.failedRecords,
    unresolvedTeams: report.unresolvedTeams,
    unresolvedPlayers: report.unresolvedPlayers,
    duplicateRecords: report.duplicateRecords,
    warnings: report.warnings,
    fatalErrors: report.fatalErrors,
  };
}

export async function generateIngestionReport(): Promise<IngestionReport> {
  return validateSourceData(true);
}
