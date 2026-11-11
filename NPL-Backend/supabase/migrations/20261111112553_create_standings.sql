BEGIN;

CREATE TABLE public.team_standings_snapshots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    season_id uuid NOT NULL REFERENCES public.seasons (id),
    team_id uuid NOT NULL REFERENCES public.teams (id),
    snapshot_key text NOT NULL,
    snapshot_date date,
    rank smallint,
    matches_played smallint,
    wins smallint,
    losses smallint,
    no_results smallint,
    net_run_rate numeric,
    points smallint,
    source_file_id uuid REFERENCES public.source_files (id),
    recorded_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT team_standings_snapshot_unique
        UNIQUE (season_id, team_id, snapshot_key),
    CONSTRAINT team_standings_snapshot_key_nonempty
        CHECK (btrim(snapshot_key) <> ''),
    CONSTRAINT team_standings_rank_positive
        CHECK (rank IS NULL OR rank > 0),
    CONSTRAINT team_standings_counts_nonnegative
        CHECK (
            (matches_played IS NULL OR matches_played >= 0)
            AND (wins IS NULL OR wins >= 0)
            AND (losses IS NULL OR losses >= 0)
            AND (no_results IS NULL OR no_results >= 0)
            AND (points IS NULL OR points >= 0)
        )
);

COMMIT;