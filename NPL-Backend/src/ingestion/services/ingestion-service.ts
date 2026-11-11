import { defaultDataPaths, seasonSelectionToValues } from '../config/ingestion.config.js';
import { readDeliverySource, readMatchSource, filterSourceRowsBySeason } from '../parsers/delivery-parser.js';
import { buildReport, validateDeliveryRecord, validateMatchRecord, validateSeasonSelection } from '../validators/data-validator.js';
import { computeFileSha256, normalizeSeasonValue } from '../utils/normalization.js';
import { SupabaseIngestionRepository } from '../repositories/supabase-repository.js';
import type { IngestionIssue, IngestionReport } from '../types/index.js';

export interface IngestionServiceOptions {
  dryRun?: boolean;
  repository?: SupabaseIngestionRepository;
}

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

  return { files, summary: { deliveries: files[0]?.rowCount ?? 0, matches: files[1]?.rowCount ?? 0 } };
}

export async function validateSourceData(
  seasonSelection = '2024/25',
  options: IngestionServiceOptions = {},
): Promise<IngestionReport> {
  const dryRun = options.dryRun ?? true;
  const issues: IngestionIssue[] = [];
  const inspected = await inspectSourceFiles();

  if (!validateSeasonSelection(seasonSelection)) {
    throw new Error(`Unsupported season selection: ${seasonSelection}`);
  }

  const selectedSeasonValues = seasonSelectionToValues(seasonSelection);
  const deliveryRows = filterSourceRowsBySeason(await readDeliverySource(defaultDataPaths.ballByBallCsv), seasonSelection);
  const matchRows = filterSourceRowsBySeason(await readMatchSource(defaultDataPaths.matchCsv), seasonSelection);

  const validDeliveryRows = deliveryRows.filter((record) => validateDeliveryRecord(record, issues));
  const validMatchRows = matchRows.filter((record) => validateMatchRecord(record, issues));

  const report = buildReport(
    issues,
    deliveryRows.length + matchRows.length,
    validDeliveryRows.length + validMatchRows.length,
    dryRun,
    inspected.files,
    seasonSelection,
  );

  return {
    ...report,
    validRecords: validDeliveryRows.length + validMatchRows.length,
    unresolvedTeams: 0,
    unresolvedPlayers: 0,
    sourceSet: seasonSelection,
  };
}

export async function dryRunIngestion(seasonSelection = '2024/25'): Promise<IngestionReport> {
  return validateSourceData(seasonSelection, { dryRun: true });
}

export async function runSeasonIngestion(
  seasonSelection = '2024/25',
  options: IngestionServiceOptions = {},
): Promise<IngestionReport> {
  const dryRun = options.dryRun ?? false;
  const repository = options.repository ?? new SupabaseIngestionRepository();

  if (!dryRun && !repository.isAvailable()) {
    throw new Error('Supabase is not configured or unavailable. Database ingestion cannot proceed.');
  }

  const issues: IngestionIssue[] = [];
  const inspected = await inspectSourceFiles();
  if (!validateSeasonSelection(seasonSelection)) {
    throw new Error(`Unsupported season selection: ${seasonSelection}`);
  }

  const deliveryRows = filterSourceRowsBySeason(await readDeliverySource(defaultDataPaths.ballByBallCsv), seasonSelection);
  const matchRows = filterSourceRowsBySeason(await readMatchSource(defaultDataPaths.matchCsv), seasonSelection);

  if (deliveryRows.length === 0 && matchRows.length === 0) {
    throw new Error(`No matching records found for season selection: ${seasonSelection}`);
  }

  const reportBase = buildReport(issues, deliveryRows.length + matchRows.length, 0, dryRun, inspected.files, seasonSelection);
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let unresolvedTeams = 0;
  let unresolvedPlayers = 0;

  if (dryRun) {
    return {
      ...reportBase,
      validRecords: deliveryRows.length + matchRows.length,
      sourceSet: seasonSelection,
      successfullyInserted: 0,
      updatedRecords: 0,
      skippedRecords: 0,
      failedRecords: 0,
      unresolvedTeams,
      unresolvedPlayers,
    };
  }

  const ingestionRun = await repository.createIngestionRun({ pipelineVersion: 'phase-2-ingestion', sourceSet: seasonSelection });
  const fileRecords = await Promise.all([
    repository.insertSourceFile({ ingestionRunId: ingestionRun.id, sourceSystem: 'npl-master', logicalPath: defaultDataPaths.ballByBallCsv, contentSha256: await computeFileSha256(defaultDataPaths.ballByBallCsv), format: 'csv', seasonId: null, rowCount: deliveryRows.length }),
    repository.insertSourceFile({ ingestionRunId: ingestionRun.id, sourceSystem: 'npl-match-feed', logicalPath: defaultDataPaths.matchCsv, contentSha256: await computeFileSha256(defaultDataPaths.matchCsv), format: 'csv', seasonId: null, rowCount: matchRows.length }),
  ]);

  for (const record of matchRows) {
    try {
      const matchId = await repository.ensureMatch(record, ingestionRun.id, fileRecords[1]?.id ?? null);
      inserted += 1;
    } catch (error) {
      failed += 1;
      issues.push({ severity: 'error', code: 'match:insert-failed', message: error instanceof Error ? error.message : String(error), sourceFile: record.sourceFile, rowNumber: record.sourceRowNumber, entityName: 'match' });
    }
  }

  for (const record of deliveryRows) {
    try {
      const delivery = await repository.ensureDelivery(record, ingestionRun.id, fileRecords[0]?.id ?? null);
      inserted += 1;
    } catch (error) {
      failed += 1;
      issues.push({ severity: 'error', code: 'delivery:insert-failed', message: error instanceof Error ? error.message : String(error), sourceFile: record.sourceFile, rowNumber: record.sourceRowNumber, entityName: 'delivery' });
    }
  }

  await repository.persistIssues(issues, ingestionRun.id);
  await repository.completeIngestionRun(ingestionRun.id, issueCount(issues), { rowsRead: deliveryRows.length + matchRows.length, rowsInserted: inserted, rowsUpdated: updated, rowsUnchanged: skipped, rowsRejected: failed });

  return {
    totalSourceRows: deliveryRows.length + matchRows.length,
    validRecords: deliveryRows.length + matchRows.length,
    successfullyInserted: inserted,
    updatedRecords: updated,
    skippedRecords: skipped,
    failedRecords: failed,
    unresolvedTeams,
    unresolvedPlayers,
    duplicateRecords: 0,
    warnings: issues.filter((issue) => issue.severity === 'warning').length,
    fatalErrors: issues.filter((issue) => issue.severity === 'error' || issue.severity === 'blocking').length,
    issues,
    files: inspected.files,
    sourceSet: seasonSelection,
    dryRun: false,
  };
}

export async function runAllIngestion(): Promise<IngestionReport> {
  const seasonSelections = ['2024', '2025'];
  const reports: IngestionReport[] = [];
  for (const seasonSelection of seasonSelections) {
    reports.push(await runSeasonIngestion(seasonSelection));
  }
  const merged = reports.reduce(
    (acc, report) => ({
      totalSourceRows: acc.totalSourceRows + report.totalSourceRows,
      validRecords: acc.validRecords + report.validRecords,
      successfullyInserted: acc.successfullyInserted + report.successfullyInserted,
      updatedRecords: acc.updatedRecords + report.updatedRecords,
      skippedRecords: acc.skippedRecords + report.skippedRecords,
      failedRecords: acc.failedRecords + report.failedRecords,
      unresolvedTeams: acc.unresolvedTeams + report.unresolvedTeams,
      unresolvedPlayers: acc.unresolvedPlayers + report.unresolvedPlayers,
      duplicateRecords: acc.duplicateRecords + report.duplicateRecords,
      warnings: acc.warnings + report.warnings,
      fatalErrors: acc.fatalErrors + report.fatalErrors,
      issues: [...acc.issues, ...report.issues],
      files: [...acc.files, ...report.files],
      sourceSet: 'all-supported-seasons',
      dryRun: false,
    }),
    {
      totalSourceRows: 0,
      validRecords: 0,
      successfullyInserted: 0,
      updatedRecords: 0,
      skippedRecords: 0,
      failedRecords: 0,
      unresolvedTeams: 0,
      unresolvedPlayers: 0,
      duplicateRecords: 0,
      warnings: 0,
      fatalErrors: 0,
      issues: [] as IngestionIssue[],
      files: [] as IngestionReport['files'],
      sourceSet: 'all-supported-seasons',
      dryRun: false,
    },
  );

  return merged;
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

export async function generateIngestionReport(seasonSelection = '2024/25'): Promise<IngestionReport> {
  return validateSourceData(seasonSelection, { dryRun: true });
}

function issueCount(issues: IngestionIssue[]): number {
  return issues.length;
}
