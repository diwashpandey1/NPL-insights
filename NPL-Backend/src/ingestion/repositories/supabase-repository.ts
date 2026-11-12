import { supabase } from '../../config/supabase.js';
import { canonicalTeamNames } from '../config/ingestion.config.js';
import { canonicalizeTeamName, normalizeAlias } from '../utils/normalization.js';
import type {
  DeliveryRecord,
  IngestionIssue,
  MatchRecord,
  PersistenceOutcome,
  SourceFileRegistration,
} from '../types/index.js';

export interface MatchPersistenceInput {
  record: MatchRecord;
  sourceFileId: string;
  seasonId: string;
  matchNumber: number;
  teamAId: string | null;
  teamBId: string | null;
  tossWinnerTeamId: string | null;
  winnerTeamId: string | null;
  playerOfMatchId: string | null;
}

export interface DeliveryPersistenceInput {
  delivery: DeliveryRecord;
  matchId: string;
  deliveryNumber: number;
  sourceFileId: string;
  battingTeamId: string | null;
  bowlingTeamId: string | null;
  bowlerId: string | null;
  batterId: string | null;
  nonStrikerId: string | null;
  playerOutId: string | null;
  fielders: Array<{ playerId: string | null; name: string }>;
}

export interface IngestionRepository {
  isAvailable(): boolean;
  /**
   * Atomically creates a run and a durable lease for the source path. An unexpired
   * lease rejects another worker; an expired lease can be recovered for that path.
   *
   * Throws with a message containing 'concurrent_ingestion_conflict' if another run
   * is already active.
   */
  createIngestionRun(input: {
    pipelineVersion: string;
    sourceSet: string;
    sourceSystem?: string;
    logicalPath?: string;
    leaseDurationSeconds?: number;
  }): Promise<{ id: string }>;
  completeIngestionRun(runId: string, issueCount: number, counters: Record<string, number>, summary: Record<string, unknown>): Promise<void>;
  failIngestionRun(runId: string, message: string, counters: Record<string, number>): Promise<void>;
  renewIngestionRunLease(runId: string): Promise<void>;
  /** Expires a lease only when it has passed expires_at for the requested source path. */
  expireStaleRuns(sourceSystem: string, logicalPath: string): Promise<number>;
  registerSourceFile(input: {
    ingestionRunId: string;
    sourceSystem: string;
    logicalPath: string;
    contentSha256: string;
    format: string;
    seasonId: string | null;
    rowCount: number;
  }): Promise<SourceFileRegistration>;
  persistIssues(issues: IngestionIssue[], ingestionRunId: string): Promise<void>;
  ensureSeason(seasonKey: string, label: string, ingestionRunId: string): Promise<PersistenceOutcome<{ id: string }>>;
  ensureTeam(teamName: string, sourceSystem: string, ingestionRunId: string): Promise<PersistenceOutcome<{ id: string; canonicalName: string }>>;
  resolvePlayer(playerName: string, sourceSystem: string): Promise<PersistenceOutcome<{ id: string; displayName: string }>>;
  persistReviewedPlayerAlias(input: { playerId: string; playerName: string; sourceSystem: string }): Promise<PersistenceOutcome<{ id: string }>>;
  persistMatch(input: MatchPersistenceInput): Promise<PersistenceOutcome<{ id: string }>>;
  resolveMatchSourceKey(input: {
    sourceSystem: string;
    sourceSeasonKey: string;
    externalMatchKey: string;
  }): Promise<PersistenceOutcome<{ id: string }>>;
  persistMatchSourceKey(input: {
    matchId: string;
    sourceFileId: string;
    sourceSystem: string;
    sourceSeasonKey: string;
    externalMatchKey: string;
    sourceRowNumber: number;
  }): Promise<PersistenceOutcome>;
  persistUnresolvedMatchKey(input: {
    sourceFileId: string;
    sourceSystem: string;
    sourceSeasonKey: string;
    externalMatchKey: string;
    sourceRowNumber: number;
  }): Promise<void>;
  persistDeliveryBatch(records: DeliveryPersistenceInput[]): Promise<Array<PersistenceOutcome<{ id: number }>>>;
}

type RpcResult<T> = { data: T | null; error: { message: string } | null };

export class SupabaseIngestionRepository implements IngestionRepository {
  public client: typeof supabase = supabase;
  private readonly leaseTokens = new Map<string, string>();

  isAvailable(): boolean {
    return Boolean(this.client);
  }

  private ensureClient(): NonNullable<typeof supabase> {
    if (!this.client) {
      throw new Error('Supabase is not configured or unavailable.');
    }
    return this.client;
  }

  async createIngestionRun(input: {
    pipelineVersion: string;
    sourceSet: string;
    sourceSystem?: string;
    logicalPath?: string;
    leaseDurationSeconds?: number;
  }): Promise<{ id: string }> {
    const client = this.ensureClient();

    // A path-scoped lease survives the RPC transaction and is retained for renew/finalize calls.
    if (input.sourceSystem && input.logicalPath) {
      const { data, error } = await client.rpc('ingestion_acquire_run_lock', {
        p_source_system: input.sourceSystem,
        p_logical_path: input.logicalPath,
        p_pipeline_version: input.pipelineVersion,
        p_source_set: input.sourceSet,
        p_lease_duration_seconds: input.leaseDurationSeconds ?? 300,
      }) as RpcResult<{ id: string; lease_token: string }>;
      if (error) {
        // Translate the database-level error to a consistent application message.
        if (error.message.includes('concurrent_ingestion_conflict')) {
          throw new Error(
            `Ingestion for ${input.logicalPath} is already running in another process. `
            + 'Wait for it to finish or expire stale runs before retrying.',
          );
        }
        throw new Error(`Failed to create ingestion run: ${error.message}`);
      }
      if (!data?.id || !data.lease_token) {
        throw new Error('ingestion_acquire_run_lock returned an incomplete lease.');
      }
      this.leaseTokens.set(data.id, data.lease_token);
      return { id: data.id };
    }

    // Fallback: simple insert without locking (used for test/manual runs without a source path).
    const { data, error } = await client.from('ingestion_runs').insert({
      status: 'running',
      pipeline_version: input.pipelineVersion,
      source_set: input.sourceSet,
      rows_read: 0,
      rows_inserted: 0,
      rows_updated: 0,
      rows_unchanged: 0,
      rows_rejected: 0,
      summary: {},
    }).select('id').single();

    if (error) {
      throw new Error(`Failed to create ingestion run: ${error.message}`);
    }
    return { id: data.id };
  }

  async completeIngestionRun(
    runId: string,
    issueCount: number,
    counters: Record<string, number>,
    summary: Record<string, unknown>,
  ): Promise<void> {
    const client = this.ensureClient();
    const leaseToken = this.leaseTokens.get(runId);
    if (leaseToken) {
      const { error } = await client.rpc('ingestion_finalize_run', {
        p_run_id: runId,
        p_lease_token: leaseToken,
        p_status: issueCount > 0 ? 'completed_with_errors' : 'succeeded',
        p_counters: counters,
        p_summary: summary,
      });
      if (error) throw new Error(`Failed to complete ingestion run ${runId}: ${error.message}`);
      this.leaseTokens.delete(runId);
      return;
    }

    const { error } = await client.from('ingestion_runs').update({
      finished_at: new Date().toISOString(),
      status: issueCount > 0 ? 'completed_with_errors' : 'succeeded',
      rows_read: counters.rowsRead ?? 0,
      rows_inserted: counters.rowsInserted ?? 0,
      rows_updated: counters.rowsUpdated ?? 0,
      rows_unchanged: counters.rowsUnchanged ?? 0,
      rows_rejected: counters.rowsRejected ?? 0,
      summary,
    }).eq('id', runId).select('id').single();

    if (error) {
      throw new Error(`Failed to complete ingestion run: ${error.message}`);
    }
  }

  async failIngestionRun(runId: string, message: string, counters: Record<string, number>): Promise<void> {
    const client = this.ensureClient();
    const leaseToken = this.leaseTokens.get(runId);
    if (leaseToken) {
      const { error } = await client.rpc('ingestion_finalize_run', {
        p_run_id: runId,
        p_lease_token: leaseToken,
        p_status: 'failed',
        p_counters: counters,
        p_summary: { failure: message },
      });
      if (error) throw new Error(`Failed to mark ingestion run ${runId} as failed: ${error.message}`);
      this.leaseTokens.delete(runId);
      return;
    }

    const { error } = await client.from('ingestion_runs').update({
      finished_at: new Date().toISOString(),
      status: 'failed',
      rows_read: counters.rowsRead ?? 0,
      rows_inserted: counters.rowsInserted ?? 0,
      rows_updated: counters.rowsUpdated ?? 0,
      rows_unchanged: counters.rowsUnchanged ?? 0,
      rows_rejected: counters.rowsRejected ?? 0,
      summary: { failure: message },
    }).eq('id', runId).select('id').single();

    if (error) {
      throw new Error(`Failed to mark ingestion run ${runId} as failed: ${error.message}`);
    }
  }

  async renewIngestionRunLease(runId: string): Promise<void> {
    const leaseToken = this.requireLeaseToken(runId);
    const { error } = await this.ensureClient().rpc('ingestion_renew_run_lease', {
      p_run_id: runId,
      p_lease_token: leaseToken,
    });
    if (error) throw new Error(`Failed to renew ingestion lease for run ${runId}: ${error.message}`);
  }

  async expireStaleRuns(sourceSystem: string, logicalPath: string): Promise<number> {
    const client = this.ensureClient();
    const { data, error } = await client.rpc('ingestion_expire_stale_runs', {
      p_source_system: sourceSystem,
      p_logical_path: logicalPath,
    }) as RpcResult<number>;
    if (error) {
      throw new Error(`Failed to expire stale ingestion runs: ${error.message}`);
    }
    return data ?? 0;
  }

  async registerSourceFile(input: {
    ingestionRunId: string;
    sourceSystem: string;
    logicalPath: string;
    contentSha256: string;
    format: string;
    seasonId: string | null;
    rowCount: number;
  }): Promise<SourceFileRegistration> {
    const client = this.ensureClient();
    const { data: priorFiles, error: priorFilesError } = await client.from('source_files')
      .select('content_sha256,row_count,ingestion_run_id,loaded_at')
      .eq('source_system', input.sourceSystem)
      .eq('logical_path', input.logicalPath)
      .order('loaded_at', { ascending: false });
    if (priorFilesError) {
      throw new Error(`Failed to inspect prior source files for ${input.logicalPath}: ${priorFilesError.message}`);
    }

    let previousSource: { content_sha256: string; row_count: number | null } | null = null;
    if (priorFiles?.length) {
      const runIds = [...new Set(priorFiles.map((file) => file.ingestion_run_id))];
      const { data: successfulRuns, error: runsError } = await client.from('ingestion_runs')
        .select('id')
        .in('id', runIds)
        .eq('status', 'succeeded');
      if (runsError) {
        throw new Error(`Failed to inspect prior ingestion runs for ${input.logicalPath}: ${runsError.message}`);
      }

      const successfulRunIds = new Set((successfulRuns ?? []).map((run) => run.id));
      const previousFile = priorFiles.find((file) => successfulRunIds.has(file.ingestion_run_id));
      if (previousFile) {
        previousSource = {
          content_sha256: previousFile.content_sha256,
          row_count: previousFile.row_count,
        };
      }
    }

    const { data, error } = await client.rpc('ingestion_register_source_file', {
      p_ingestion_run_id: input.ingestionRunId,
      p_source_system: input.sourceSystem,
      p_logical_path: input.logicalPath,
      p_content_sha256: input.contentSha256,
      p_format: input.format,
      p_season_id: input.seasonId,
      p_row_count: input.rowCount,
      p_lease_token: this.requireLeaseToken(input.ingestionRunId),
    }) as RpcResult<{
      id: string;
      outcome: SourceFileRegistration['outcome'];
      previousRunStatus: string | null;
      previousSummary: Record<string, unknown> | null;
    }>;

    if (error) {
      throw new Error(`Failed to reconcile source file metadata: ${error.message}`);
    }
    if (!data?.id || !data.outcome) {
      throw new Error('Source-file reconciliation returned an invalid result.');
    }
    return {
      id: data.id,
      outcome: data.outcome,
      previousRunStatus: data.previousRunStatus,
      previousSummary: data.previousSummary,
      previousSourceSha256: previousSource?.content_sha256 ?? null,
      previousSourceRowCount: previousSource?.row_count ?? null,
    };
  }

  async persistIssues(issues: IngestionIssue[], ingestionRunId: string): Promise<void> {
    if (!issues.length) return;
    const client = this.ensureClient();
    const rows = issues.map((issue) => ({
      ingestion_run_id: ingestionRunId,
      source_file_id: issue.sourceFileId ?? null,
      source_row_number: issue.rowNumber ?? null,
      entity_name: issue.entityName ?? null,
      source_key: issue.code ?? null,
      severity: issue.severity,
      issue_code: issue.code,
      column_name: issue.columnName ?? null,
      message: issue.message,
    }));
    const { data, error } = await client.from('ingestion_issues').insert(rows).select('id');
    if (error) throw new Error(`Failed to persist ingestion issues: ${error.message}`);
    if (!data || data.length !== rows.length) {
      throw new Error(`Persisting ingestion issues returned ${data?.length ?? 0} rows; expected ${rows.length}.`);
    }
  }

  async ensureSeason(seasonKey: string, label: string, ingestionRunId: string): Promise<PersistenceOutcome<{ id: string }>> {
    const client = this.ensureClient();
    const { data, error } = await client.rpc('ingestion_ensure_season', {
      p_season_key: seasonKey,
      p_label: label,
      p_source_season_year: Number(seasonKey.slice(0, 4)),
      p_ingestion_run_id: ingestionRunId,
      p_lease_token: this.requireLeaseToken(ingestionRunId),
    }) as RpcResult<{ id: string; outcome: PersistenceOutcome['outcome']; reason?: string }>;
    if (error) throw new Error(`Failed to ensure season ${seasonKey}: ${error.message}`);
    if (!data?.id || !data.outcome) throw new Error(`Season ensure returned an invalid result for ${seasonKey}.`);
    return { outcome: data.outcome, data: { id: data.id }, reason: data.reason };
  }

  async ensureTeam(
    teamName: string,
    sourceSystem: string,
    ingestionRunId: string,
  ): Promise<PersistenceOutcome<{ id: string; canonicalName: string }>> {
    const canonicalName = canonicalizeTeamName(teamName);
    if (!canonicalName || !canonicalTeamNames.has(canonicalName)) {
      return { outcome: 'rejected', reason: `Unrecognized canonical team identity: ${teamName}` };
    }
    const client = this.ensureClient();
    const { data, error } = await client.rpc('ingestion_ensure_team_alias', {
      p_team_key: `team-${canonicalName.trim().toLowerCase().replace(/\s+/g, '-')}`,
      p_canonical_name: canonicalName,
      p_source_system: sourceSystem,
      p_alias: teamName.trim(),
      p_alias_normalized: normalizeAlias(teamName),
      p_ingestion_run_id: ingestionRunId,
      p_lease_token: this.requireLeaseToken(ingestionRunId),
    }) as RpcResult<{ id: string; canonical_name: string; outcome: PersistenceOutcome['outcome']; reason?: string }>;
    if (error) throw new Error(`Failed to resolve team alias ${teamName}: ${error.message}`);
    if (!data?.outcome) throw new Error(`Team alias resolution returned an invalid result for ${teamName}.`);
    if (data.outcome === 'rejected') {
      return { outcome: 'rejected', reason: data.reason };
    }
    if (!data.id || !data.canonical_name) {
      throw new Error(`Team alias resolution returned an incomplete result for ${teamName}.`);
    }
    return {
      outcome: data.outcome,
      data: { id: data.id, canonicalName: data.canonical_name },
      reason: data.reason,
    };
  }

  async resolvePlayer(playerName: string, sourceSystem: string): Promise<PersistenceOutcome<{ id: string; displayName: string }>> {
    const alias = normalizeAlias(playerName);
    if (!alias) return { outcome: 'rejected', reason: 'Player name is empty.' };

    const client = this.ensureClient();
    const { data, error } = await client.from('player_aliases')
      .select('player_id, players (display_name)')
      .eq('source_system', sourceSystem)
      .eq('alias_normalized', alias)
      .maybeSingle() as {
        data: { player_id: string; players: { display_name: string } | null } | null;
        error: { message: string } | null;
      };
    if (error) throw new Error(`Failed to resolve reviewed player alias ${playerName}: ${error.message}`);
    if (!data?.player_id) {
      return { outcome: 'rejected', reason: `No reviewed player alias exists for ${playerName}.` };
    }
    return {
      outcome: 'unchanged',
      data: { id: data.player_id, displayName: data.players?.display_name ?? playerName },
    };
  }

  async persistReviewedPlayerAlias(input: {
    playerId: string;
    playerName: string;
    sourceSystem: string;
  }): Promise<PersistenceOutcome<{ id: string }>> {
    const client = this.ensureClient();
    const alias = normalizeAlias(input.playerName);
    const { data: existing, error: lookupError } = await client.from('player_aliases')
      .select('id, player_id')
      .eq('source_system', input.sourceSystem)
      .eq('alias_normalized', alias)
      .maybeSingle();
    if (lookupError) throw new Error(`Failed to inspect player alias ${input.playerName}: ${lookupError.message}`);
    if (existing) {
      if (existing.player_id !== input.playerId) {
        return { outcome: 'rejected', reason: `Player alias ${input.playerName} is already assigned to a different player.` };
      }
      return { outcome: 'unchanged', data: { id: existing.id } };
    }

    const { data, error } = await client.from('player_aliases').insert({
      player_id: input.playerId,
      source_system: input.sourceSystem,
      alias: input.playerName.trim(),
      alias_normalized: alias,
    }).select('id').single();
    if (error) throw new Error(`Failed to persist reviewed player alias ${input.playerName}: ${error.message}`);
    return { outcome: 'inserted', data: { id: data.id } };
  }

  async persistMatch(input: MatchPersistenceInput): Promise<PersistenceOutcome<{ id: string }>> {
    const client = this.ensureClient();
    const { record } = input;
    const { data, error } = await client.rpc('ingestion_persist_match', {
      p_match: {
        season_id: input.seasonId,
        match_number: input.matchNumber,
        match_date: record.date || null,
        start_time: null,
        venue_name: record.venue || null,
        city: record.city || null,
        stage: record.stage || null,
        team_a_id: input.teamAId,
        team_b_id: input.teamBId,
        toss_winner_team_id: input.tossWinnerTeamId,
        toss_decision: record.toss_decision || null,
        winner_team_id: input.winnerTeamId,
        result_text: record.result || null,
        win_by_runs: record.win_by_runs,
        win_by_wickets: record.win_by_wickets,
        dls_applied: record.dls_applied,
        super_over: record.super_over,
        player_of_match_id: input.playerOfMatchId,
        match_status: 'completed',
      },
      p_source_key: {
        source_file_id: input.sourceFileId,
        source_system: 'npl-match-feed',
        source_season_key: record.season,
        external_match_key: record.id,
        disambiguator: '',
        source_row_number: record.sourceRowNumber,
      },
    }) as RpcResult<{ id: string; outcome: PersistenceOutcome['outcome'] }>;
    if (error) throw new Error(`Failed to persist match ${record.id}: ${error.message}`);
    if (!data?.id || !data.outcome) throw new Error(`Match persistence returned an invalid result for ${record.id}.`);
    return { outcome: data.outcome, data: { id: data.id } };
  }

  async resolveMatchSourceKey(input: {
    sourceSystem: string;
    sourceSeasonKey: string;
    externalMatchKey: string;
  }): Promise<PersistenceOutcome<{ id: string }>> {
    const client = this.ensureClient();
    const { data, error } = await client.from('match_source_keys')
      .select('match_id, resolution_status')
      .eq('source_system', input.sourceSystem)
      .eq('source_season_key', input.sourceSeasonKey)
      .eq('external_match_key', input.externalMatchKey)
      .eq('disambiguator', '')
      .maybeSingle();
    if (error) throw new Error(`Failed to resolve match source key ${input.externalMatchKey}: ${error.message}`);
    if (data?.resolution_status !== 'resolved' || !data.match_id) {
      return { outcome: 'rejected', reason: `Match source key ${input.externalMatchKey} has no resolved canonical match.` };
    }
    return { outcome: 'unchanged', data: { id: data.match_id } };
  }

  async persistMatchSourceKey(input: {
    matchId: string;
    sourceFileId: string;
    sourceSystem: string;
    sourceSeasonKey: string;
    externalMatchKey: string;
    sourceRowNumber: number;
  }): Promise<PersistenceOutcome> {
    const client = this.ensureClient();
    const { data: existing, error: lookupError } = await client.from('match_source_keys')
      .select('id, match_id, source_file_id, source_row_number')
      .eq('source_system', input.sourceSystem)
      .eq('source_season_key', input.sourceSeasonKey)
      .eq('external_match_key', input.externalMatchKey)
      .eq('disambiguator', '')
      .maybeSingle();
    if (lookupError) throw new Error(`Failed to resolve source match key ${input.externalMatchKey}: ${lookupError.message}`);
    if (existing?.match_id && existing.match_id !== input.matchId) {
      return { outcome: 'rejected', reason: `Source match key ${input.externalMatchKey} already resolves to a different match.` };
    }
    if (!existing?.match_id && existing) {
      const { error } = await client.from('match_source_keys').update({
        match_id: input.matchId,
        source_file_id: input.sourceFileId,
        source_row_number: input.sourceRowNumber,
        resolution_status: 'resolved',
      }).eq('id', existing.id).select('id').single();
      if (error) throw new Error(`Failed to resolve source match key ${input.externalMatchKey}: ${error.message}`);
      return { outcome: 'updated' };
    }
    if (existing?.match_id === input.matchId) {
      if (existing.source_file_id === input.sourceFileId
        && Number(existing.source_row_number) === input.sourceRowNumber) {
        return { outcome: 'unchanged' };
      }
      const { error } = await client.from('match_source_keys').update({
        source_file_id: input.sourceFileId,
        source_row_number: input.sourceRowNumber,
        resolution_status: 'resolved',
      }).eq('id', existing.id).select('id').single();
      if (error) throw new Error(`Failed to update source match key ${input.externalMatchKey}: ${error.message}`);
      return { outcome: 'updated' };
    }

    const { error } = await client.from('match_source_keys').insert({
      match_id: input.matchId,
      source_file_id: input.sourceFileId,
      source_system: input.sourceSystem,
      source_season_key: input.sourceSeasonKey,
      external_match_key: input.externalMatchKey,
      disambiguator: '',
      source_row_number: input.sourceRowNumber,
      resolution_status: 'resolved',
    });
    if (error) throw new Error(`Failed to persist source match key ${input.externalMatchKey}: ${error.message}`);
    return { outcome: 'inserted' };
  }

  async persistUnresolvedMatchKey(input: {
    sourceFileId: string;
    sourceSystem: string;
    sourceSeasonKey: string;
    externalMatchKey: string;
    sourceRowNumber: number;
  }): Promise<void> {
    const client = this.ensureClient();
    const { data: rowExisting, error: rowLookupError } = await client.from('match_source_keys')
      .select('id, match_id')
      .eq('source_file_id', input.sourceFileId)
      .eq('source_row_number', input.sourceRowNumber)
      .maybeSingle();
    if (rowLookupError) throw new Error(`Failed to inspect unresolved source key ${input.externalMatchKey}: ${rowLookupError.message}`);
    if (rowExisting?.match_id) {
      throw new Error(`Source key ${input.externalMatchKey} is already resolved and cannot be overwritten as ambiguous.`);
    }

    const payload = {
      match_id: null,
      source_file_id: input.sourceFileId,
      source_system: input.sourceSystem,
      source_season_key: input.sourceSeasonKey,
      external_match_key: input.externalMatchKey,
      disambiguator: '',
      source_row_number: input.sourceRowNumber,
      resolution_status: 'ambiguous',
    };

    let existing = rowExisting;
    if (!existing) {
      const { data, error: identityLookupError } = await client.from('match_source_keys')
        .select('id, match_id')
        .eq('source_system', input.sourceSystem)
        .eq('source_season_key', input.sourceSeasonKey)
        .eq('external_match_key', input.externalMatchKey)
        .eq('disambiguator', '')
        .maybeSingle();
      if (identityLookupError) {
        throw new Error(`Failed to inspect source identity ${input.externalMatchKey}: ${identityLookupError.message}`);
      }
      if (data?.match_id) return;
      existing = data;
    }

    const query = existing
      ? client.from('match_source_keys').update(payload).eq('id', existing.id)
      : client.from('match_source_keys').insert(payload);
    const { error } = await query.select('id').single();
    if (error) throw new Error(`Failed to persist unresolved source key ${input.externalMatchKey}: ${error.message}`);
  }

  async persistDeliveryBatch(records: DeliveryPersistenceInput[]): Promise<Array<PersistenceOutcome<{ id: number }>>> {
    if (!records.length) return [];
    const client = this.ensureClient();
    const rpcRecords = records.map((input) => {
      const { delivery } = input;
      const dismissalRecords = delivery.player_out || delivery.dismissal_kind
        ? [{
          dismissal_no: 1,
          player_out_id: input.playerOutId,
          player_out_name_raw: delivery.player_out || null,
          dismissal_kind: delivery.dismissal_kind || 'unknown',
          source_file_id: input.sourceFileId,
          fielders: input.fielders.map((fielder, index) => ({
            fielder_no: index + 1,
            player_id: fielder.playerId,
            fielder_name_raw: fielder.name,
          })),
        }]
        : [];
      return {
        delivery: {
          match_id: input.matchId,
          innings_no: delivery.inning,
          delivery_no: input.deliveryNumber,
          source_file_id: input.sourceFileId,
          source_row_number: delivery.sourceRowNumber,
          over_number: parseNumberPart(delivery.ball_over, 0),
          ball_in_over: parseNumberPart(delivery.ball_over, -1),
          source_ball_label: delivery.ball_over || null,
          ball_result: delivery.ball_result || null,
          shot_direction: delivery.shot_direction || null,
          bowler_id: input.bowlerId,
          batter_id: input.batterId,
          non_striker_id: input.nonStrikerId,
          bowler_name_raw: delivery.bowler || null,
          batter_name_raw: delivery.batsman || null,
          non_striker_name_raw: delivery.non_striker || null,
          batter_runs: delivery.batsman_runs,
          wide_runs: delivery.wide_runs,
          no_ball_runs: delivery.noball_runs,
          bye_runs: delivery.bye_runs,
          leg_bye_runs: delivery.legbye_runs,
          extra_runs: delivery.extra_runs,
          total_runs: delivery.total_runs,
        },
        innings: {
          batting_team_id: input.battingTeamId,
          bowling_team_id: input.bowlingTeamId,
          source_file_id: input.sourceFileId,
        },
        dismissals: dismissalRecords,
      };
    });

    const { data, error } = await client.rpc('ingestion_persist_delivery_batch', { p_records: rpcRecords }) as RpcResult<
      Array<{ id: number; outcome: PersistenceOutcome['outcome'] }>
    >;
    if (error) throw new Error(`Failed to atomically persist delivery batch: ${error.message}`);
    if (!Array.isArray(data) || data.length !== records.length) {
      throw new Error('Delivery batch persistence returned an incomplete result.');
    }
    return data.map((result) => {
      if (typeof result.id !== 'number' || !result.outcome) {
        throw new Error('Delivery batch persistence returned an invalid record outcome.');
      }
      return { outcome: result.outcome, data: { id: result.id } };
    });
  }

  private requireLeaseToken(runId: string): string {
    const leaseToken = this.leaseTokens.get(runId);
    if (!leaseToken) {
      throw new Error(`Ingestion run ${runId} does not have a source lease owned by this worker.`);
    }
    return leaseToken;
  }
}

function parseNumberPart(label: string, index: number): number | null {
  const parts = label.split('.');
  const value = Number(parts[index < 0 ? parts.length + index : index]);
  return Number.isInteger(value) && value >= 0 ? value : null;
}
