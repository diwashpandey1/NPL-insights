import { supabase } from '../../config/supabase.js';
import type { IngestionIssue } from '../types/index.js';

export class SupabaseIngestionRepository {
  async persistIssues(issues: IngestionIssue[]): Promise<void> {
    if (!supabase) {
      return;
    }

    for (const issue of issues) {
      await supabase.from('ingestion_issues').insert({
        severity: issue.severity,
        issue_code: issue.code,
        message: issue.message,
        entity_name: issue.entityName ?? null,
        column_name: issue.columnName ?? null,
      });
    }
  }

  async persistSummary(summary: Record<string, number | string>): Promise<void> {
    if (!supabase) {
      return;
    }

    await supabase.from('ingestion_runs').insert({
      status: 'completed_with_errors',
      pipeline_version: 'phase-2-ingestion',
      source_set: String(summary.sourceSet ?? 'unknown'),
      rows_read: Number(summary.totalSourceRows ?? 0),
      rows_inserted: Number(summary.successfullyInserted ?? 0),
      rows_updated: Number(summary.updatedRecords ?? 0),
      rows_unchanged: Number(summary.skippedRecords ?? 0),
      rows_rejected: Number(summary.failedRecords ?? 0),
      summary: summary,
    });
  }
}
