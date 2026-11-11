import { supabase } from '../../config/supabase.js';
import { canonicalizeTeamName, normalizeAlias, normalizeSeasonValue } from '../utils/normalization.js';
import type { DeliveryRecord, IngestionIssue, MatchRecord } from '../types/index.js';

export class SupabaseIngestionRepository {
  public client: typeof supabase = supabase;

  isAvailable(): boolean {
    return Boolean(this.client);
  }

  private ensureClient(): NonNullable<typeof supabase> {
    if (!this.client) {
      throw new Error('Supabase is not configured or unavailable.');
    }
    return this.client;
  }

  async createIngestionRun(input: { pipelineVersion: string; sourceSet: string }): Promise<{ id: string }> {
    const client = this.ensureClient();
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

    return { id: data.id as string };
  }

  async completeIngestionRun(runId: string, issueCount: number, counters: Record<string, number>): Promise<void> {
    const client = this.ensureClient();
    const status = issueCount > 0 ? 'completed_with_errors' : 'succeeded';
    const { error } = await client.from('ingestion_runs').update({
      finished_at: new Date().toISOString(),
      status,
      rows_read: counters.rowsRead ?? 0,
      rows_inserted: counters.rowsInserted ?? 0,
      rows_updated: counters.rowsUpdated ?? 0,
      rows_unchanged: counters.rowsUnchanged ?? 0,
      rows_rejected: counters.rowsRejected ?? 0,
      summary: { issue_count: issueCount, ...counters },
    }).eq('id', runId);

    if (error) {
      throw new Error(`Failed to complete ingestion run: ${error.message}`);
    }
  }

  async insertSourceFile(input: {
    ingestionRunId: string;
    sourceSystem: string;
    logicalPath: string;
    contentSha256: string;
    format: string;
    seasonId: string | null;
    rowCount: number;
  }): Promise<{ id: string }> {
    const client = this.ensureClient();
    const { data, error } = await client.from('source_files').insert({
      ingestion_run_id: input.ingestionRunId,
      source_system: input.sourceSystem,
      logical_path: input.logicalPath,
      content_sha256: input.contentSha256,
      format: input.format,
      season_id: input.seasonId,
      row_count: input.rowCount,
      loaded_at: new Date().toISOString(),
    }).select('id').single();

    if (error) {
      throw new Error(`Failed to write source file metadata: ${error.message}`);
    }

    return { id: data.id as string };
  }

  async persistIssues(issues: IngestionIssue[], ingestionRunId: string): Promise<void> {
    if (!issues.length) {
      return;
    }
    const client = this.ensureClient();
    const rows = issues.map((issue) => ({
      ingestion_run_id: ingestionRunId,
      source_row_number: issue.rowNumber ?? null,
      entity_name: issue.entityName ?? null,
      source_key: issue.code ?? null,
      severity: issue.severity,
      issue_code: issue.code,
      column_name: issue.columnName ?? null,
      message: issue.message,
    }));

    const { error } = await client.from('ingestion_issues').insert(rows);
    if (error) {
      throw new Error(`Failed to persist ingestion issues: ${error.message}`);
    }
  }

  async ensureSeason(seasonKey: string, label: string): Promise<{ id: string }> {
    const client = this.ensureClient();
    const normalized = normalizeSeasonValue(seasonKey) || seasonKey;
    const { data: existing, error: existingError } = await client.from('seasons').select('id').eq('season_key', normalized).maybeSingle();
    if (existingError && existingError.code !== 'PGRST116') {
      throw new Error(`Failed to fetch season: ${existingError.message}`);
    }
    if (existing) return { id: existing.id as string };

    const { data, error } = await client.from('seasons').insert({
      season_key: normalized,
      label,
      coverage_status: 'partial',
      source_season_year: Number(normalized.slice(0, 4)) || null,
    }).select('id').single();

    if (error) {
      throw new Error(`Failed to create season: ${error.message}`);
    }

    return { id: data.id as string };
  }

  async ensureTeam(teamName: string, sourceSystem: string): Promise<{ id: string; canonicalName: string }> {
    const client = this.ensureClient();
    const canonicalName = canonicalizeTeamName(teamName) || teamName;
    const alias = normalizeAlias(teamName);

    const { data: aliasRow, error: aliasError } = await client
      .from('team_aliases')
      .select('team_id, teams (canonical_name)')
      .eq('source_system', sourceSystem)
      .eq('alias_normalized', alias)
      .maybeSingle() as { data: { team_id?: string; teams?: { canonical_name?: string } | null } | null; error?: { code?: string; message: string } | null };

    if (aliasError && aliasError.code !== 'PGRST116') {
      throw new Error(`Failed to resolve team alias: ${aliasError.message}`);
    }
    if (aliasRow) {
      return { id: aliasRow.team_id as string, canonicalName: aliasRow.teams?.canonical_name ?? canonicalName };
    }

    const { data: teamData, error: teamError } = await client.from('teams').upsert({
      team_key: `team-${canonicalName.trim().toLowerCase().replace(/\s+/g, '-')}`,
      canonical_name: canonicalName,
      active: true,
    }, { onConflict: 'team_key' }).select('id, canonical_name').single();

    if (teamError) {
      throw new Error(`Failed to upsert team: ${teamError.message}`);
    }

    await client.from('team_aliases').upsert({
      team_id: teamData.id,
      source_system: sourceSystem,
      alias: teamName,
      alias_normalized: alias,
    }, { onConflict: 'source_system, alias_normalized' });

    return { id: teamData.id as string, canonicalName: teamData.canonical_name as string };
  }

  async ensurePlayer(playerName: string, sourceSystem: string): Promise<{ id: string | null; displayName: string }> {
    const client = this.ensureClient();
    const alias = normalizeAlias(playerName);
    if (!playerName || !alias) {
      return { id: null, displayName: playerName };
    }

    const { data: aliasRow, error: aliasError } = await client
      .from('player_aliases')
      .select('player_id, players (display_name)')
      .eq('source_system', sourceSystem)
      .eq('alias_normalized', alias)
      .maybeSingle() as { data: { player_id?: string; players?: { display_name?: string } | null } | null; error?: { code?: string; message: string } | null };

    if (aliasError && aliasError.code !== 'PGRST116') {
      throw new Error(`Failed to resolve player alias: ${aliasError.message}`);
    }
    if (aliasRow) {
      return { id: aliasRow.player_id as string, displayName: aliasRow.players?.display_name ?? playerName };
    }

    const { data: newPlayer, error: playerError } = await client.from('players').insert({ display_name: playerName }).select('id').single();
    if (playerError) {
      throw new Error(`Failed to create player: ${playerError.message}`);
    }

    await client.from('player_aliases').upsert({
      player_id: newPlayer.id,
      source_system: sourceSystem,
      alias: playerName,
      alias_normalized: alias,
    }, { onConflict: 'source_system, alias_normalized' });

    return { id: newPlayer.id as string, displayName: playerName };
  }

  async ensureTeamAffiliation(seasonId: string, teamId: string, playerId: string, sourceFileId: string | null): Promise<void> {
    const client = this.ensureClient();
    const { error } = await client.from('player_season_teams').upsert({
      season_id: seasonId,
      team_id: teamId,
      player_id: playerId,
      source_file_id: sourceFileId,
    }, { onConflict: 'season_id, team_id, player_id' });
    if (error) {
      throw new Error(`Failed to persist player-season-team affiliation: ${error.message}`);
    }
  }

  async ensureMatch(match: MatchRecord, ingestionRunId: string, sourceFileId: string | null): Promise<{ id: string }> {
    const client = this.ensureClient();
    const season = await this.ensureSeason(match.season, match.season || 'Unknown season');
    const { data: existing, error: existingError } = await client.from('match_source_keys').select('match_id').eq('source_file_id', sourceFileId ?? '').eq('external_match_key', String(match.id)).maybeSingle();
    if (existingError && existingError.code !== 'PGRST116') {
      throw new Error(`Failed to look up source key: ${existingError.message}`);
    }
    if (existing?.match_id) {
      return { id: existing.match_id as string };
    }

    const teamA = await this.ensureTeam(match.team_1, 'npl-master');
    const teamB = await this.ensureTeam(match.team_2, 'npl-master');
    const teamWinner = match.winner ? await this.ensureTeam(match.winner, 'npl-master') : null;

    const { data: matchData, error: matchError } = await client.from('matches').insert({
      season_id: season.id,
      match_number: Number(match.id.split('_').at(-1) ?? match.id) || null,
      match_date: match.date || null,
      venue_name: match.venue || null,
      city: match.city || null,
      stage: match.stage || null,
      team_a_id: teamA.id,
      team_b_id: teamB.id,
      toss_winner_team_id: match.toss_winner ? (await this.ensureTeam(match.toss_winner, 'npl-master')).id : null,
      toss_decision: match.toss_decision || null,
      winner_team_id: teamWinner?.id ?? null,
      result_text: match.result || null,
      win_by_runs: match.win_by_runs,
      win_by_wickets: match.win_by_wickets,
      dls_applied: match.dls_applied,
      super_over: match.super_over,
      player_of_match_id: match.player_of_the_match ? (await this.ensurePlayer(match.player_of_the_match, 'npl-master')).id : null,
      match_status: 'completed',
    }).select('id').single();

    if (matchError) {
      throw new Error(`Failed to create match: ${matchError.message}`);
    }

    await client.from('match_source_keys').upsert({
      match_id: matchData.id,
      source_file_id: sourceFileId,
      source_system: 'npl-master',
      source_season_key: match.season,
      external_match_key: String(match.id),
      disambiguator: '',
      source_row_number: match.sourceRowNumber,
      resolution_status: 'resolved',
    }, { onConflict: 'source_file_id, source_row_number' });

    return { id: matchData.id as string };
  }

  async ensureDelivery(delivery: DeliveryRecord, ingestionRunId: string, sourceFileId: string | null): Promise<{ id: number }> {
    const client = this.ensureClient();
    const season = await this.ensureSeason(delivery.season, delivery.season || 'Unknown season');
    const matchId = await this.ensureMatchSourceReference(delivery.match_id, sourceFileId);
    const batterId = delivery.batsman ? (await this.ensurePlayer(delivery.batsman, 'npl-master')).id : null;
    const bowlerId = delivery.bowler ? (await this.ensurePlayer(delivery.bowler, 'npl-master')).id : null;
    const strikerId = delivery.non_striker ? (await this.ensurePlayer(delivery.non_striker, 'npl-master')).id : null;
    const inningsNo = Number(delivery.inning) || 1;

    const matchInningsId = await client.from('match_innings').upsert({
      match_id: matchId,
      innings_no: inningsNo,
      batting_team_id: (await this.ensureTeam(delivery.batting_team, 'npl-master')).id,
      bowling_team_id: (await this.ensureTeam(delivery.bowling_team, 'npl-master')).id,
      source_file_id: sourceFileId,
    }, { onConflict: 'match_id, innings_no' }).select('match_id').single();
    if (matchInningsId.error) {
      throw new Error(`Failed to upsert innings: ${matchInningsId.error.message}`);
    }

    const { data: deliveryData, error: deliveryError } = await client.from('deliveries').insert({
      match_id: matchId,
      innings_no: inningsNo,
      delivery_no: delivery.sourceRowNumber,
      source_file_id: sourceFileId,
      source_row_number: delivery.sourceRowNumber,
      over_number: Number(delivery.ball_over.split('.')[0]) || null,
      ball_in_over: Number(delivery.ball_over.split('.').at(-1)) || null,
      source_ball_label: delivery.ball_over,
      ball_result: delivery.ball_result || null,
      shot_direction: delivery.shot_direction || null,
      bowler_id: bowlerId,
      batter_id: batterId,
      non_striker_id: strikerId,
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
    }).select('id').single();

    if (deliveryError) {
      throw new Error(`Failed to create delivery: ${deliveryError.message}`);
    }

    if (delivery.player_out || delivery.dismissal_kind) {
      const { data: dismissalData, error: dismissalError } = await client.from('dismissals').insert({
        delivery_id: deliveryData.id,
        dismissal_no: 1,
        player_out_id: delivery.player_out ? (await this.ensurePlayer(delivery.player_out, 'npl-master')).id : null,
        player_out_name_raw: delivery.player_out || null,
        dismissal_kind: delivery.dismissal_kind || 'unknown',
        source_file_id: sourceFileId,
      }).select('id').single();
      if (dismissalError) {
        throw new Error(`Failed to create dismissal: ${dismissalError.message}`);
      }

      const fielderNames = delivery.fielders ? delivery.fielders.split(/[;,|/]/).map((name) => name.trim()).filter(Boolean) : [];
      for (let index = 0; index < fielderNames.length; index += 1) {
        const fielderName = fielderNames[index];
        const fielderId = fielderName ? (await this.ensurePlayer(fielderName, 'npl-master')).id : null;
        const { error: fielderError } = await client.from('dismissal_fielders').insert({
          dismissal_id: dismissalData.id,
          fielder_no: index + 1,
          player_id: fielderId,
          fielder_name_raw: fielderName,
        });
        if (fielderError) {
          throw new Error(`Failed to create dismissal fielder: ${fielderError.message}`);
        }
      }
    }

    return { id: deliveryData.id as number };
  }

  async ensureMatchSourceReference(externalMatchKey: string, sourceFileId: string | null): Promise<string> {
    const client = this.ensureClient();
    const { data, error } = await client.from('match_source_keys').select('match_id').eq('source_file_id', sourceFileId ?? '').eq('external_match_key', externalMatchKey).maybeSingle();
    if (error && error.code !== 'PGRST116') {
      throw new Error(`Failed to resolve match source key: ${error.message}`);
    }
    if (data?.match_id) {
      return data.match_id as string;
    }

    const fallback = await client.from('matches').select('id').eq('match_number', Number(externalMatchKey.split('_').at(-1) ?? 0)).limit(1);
    if (fallback.error) {
      throw new Error(`Failed to resolve match fallback: ${fallback.error.message}`);
    }
    if (fallback.data && fallback.data.length > 0 && fallback.data[0]?.id) {
      return fallback.data[0].id as string;
    }

    throw new Error(`No match was created for source key: ${externalMatchKey}`);
  }
}
