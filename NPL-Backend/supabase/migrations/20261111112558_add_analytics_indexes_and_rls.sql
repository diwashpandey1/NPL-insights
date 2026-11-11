BEGIN;

CREATE INDEX team_aliases_team_id_idx
    ON public.team_aliases (team_id);
CREATE INDEX players_display_name_idx
    ON public.players (display_name);
CREATE INDEX player_aliases_player_id_idx
    ON public.player_aliases (player_id);
CREATE INDEX player_season_teams_team_season_idx
    ON public.player_season_teams (team_id, season_id);
CREATE INDEX player_season_teams_season_player_idx
    ON public.player_season_teams (season_id, player_id);
CREATE INDEX player_season_teams_player_season_idx
    ON public.player_season_teams (player_id, season_id);
CREATE INDEX player_season_teams_source_file_idx
    ON public.player_season_teams (source_file_id);

CREATE INDEX matches_season_date_idx
    ON public.matches (season_id, match_date DESC);
CREATE INDEX matches_team_a_idx
    ON public.matches (team_a_id);
CREATE INDEX matches_team_b_idx
    ON public.matches (team_b_id);
CREATE INDEX matches_toss_winner_idx
    ON public.matches (toss_winner_team_id);
CREATE INDEX matches_winner_idx
    ON public.matches (winner_team_id);
CREATE INDEX matches_player_of_match_idx
    ON public.matches (player_of_match_id);

CREATE INDEX match_source_keys_match_id_idx
    ON public.match_source_keys (match_id);
CREATE INDEX match_source_keys_source_lookup_idx
    ON public.match_source_keys (source_system, external_match_key);
CREATE UNIQUE INDEX match_source_keys_resolved_source_key_uidx
    ON public.match_source_keys (
        source_system,
        source_season_key,
        external_match_key,
        disambiguator
    )
    WHERE resolution_status = 'resolved';

CREATE INDEX match_innings_batting_team_idx
    ON public.match_innings (batting_team_id);
CREATE INDEX match_innings_bowling_team_idx
    ON public.match_innings (bowling_team_id);
CREATE INDEX match_innings_source_file_idx
    ON public.match_innings (source_file_id);

CREATE INDEX deliveries_batter_match_idx
    ON public.deliveries (batter_id, match_id);
CREATE INDEX deliveries_bowler_match_idx
    ON public.deliveries (bowler_id, match_id);
CREATE INDEX deliveries_non_striker_idx
    ON public.deliveries (non_striker_id);

CREATE INDEX dismissals_player_out_idx
    ON public.dismissals (player_out_id);
CREATE INDEX dismissals_kind_idx
    ON public.dismissals (dismissal_kind);
CREATE INDEX dismissals_source_file_idx
    ON public.dismissals (source_file_id);
CREATE INDEX dismissal_fielders_player_idx
    ON public.dismissal_fielders (player_id);

CREATE INDEX ingestion_runs_status_started_idx
    ON public.ingestion_runs (status, started_at DESC);
CREATE INDEX ingestion_runs_started_at_idx
    ON public.ingestion_runs (started_at DESC);
CREATE INDEX source_files_hash_lookup_idx
    ON public.source_files (source_system, content_sha256);
CREATE INDEX source_files_season_system_idx
    ON public.source_files (season_id, source_system);
CREATE INDEX ingestion_issues_run_severity_idx
    ON public.ingestion_issues (ingestion_run_id, severity);
CREATE INDEX ingestion_issues_file_row_idx
    ON public.ingestion_issues (source_file_id, source_row_number);

CREATE INDEX team_standings_season_rank_idx
    ON public.team_standings_snapshots (season_id, rank);
CREATE INDEX team_standings_team_idx
    ON public.team_standings_snapshots (team_id);
CREATE INDEX team_standings_source_file_idx
    ON public.team_standings_snapshots (source_file_id);

ALTER TABLE public.seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_season_teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_source_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_innings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dismissals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dismissal_fielders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ingestion_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ingestion_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_standings_snapshots ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA public TO service_role;

REVOKE ALL PRIVILEGES ON TABLE
    public.seasons,
    public.teams,
    public.team_aliases,
    public.players,
    public.player_aliases,
    public.player_season_teams,
    public.matches,
    public.match_source_keys,
    public.match_innings,
    public.deliveries,
    public.dismissals,
    public.dismissal_fielders,
    public.ingestion_runs,
    public.source_files,
    public.ingestion_issues,
    public.team_standings_snapshots
FROM PUBLIC, anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE
    public.seasons,
    public.teams,
    public.team_aliases,
    public.players,
    public.player_aliases,
    public.player_season_teams,
    public.matches,
    public.match_source_keys,
    public.match_innings,
    public.deliveries,
    public.dismissals,
    public.dismissal_fielders,
    public.ingestion_runs,
    public.source_files,
    public.ingestion_issues,
    public.team_standings_snapshots
TO service_role;

REVOKE ALL PRIVILEGES ON SEQUENCE
    public.deliveries_id_seq,
    public.dismissals_id_seq,
    public.ingestion_issues_id_seq
FROM PUBLIC, anon, authenticated;

GRANT USAGE, SELECT ON SEQUENCE
    public.deliveries_id_seq,
    public.dismissals_id_seq,
    public.ingestion_issues_id_seq
TO service_role;

COMMIT;