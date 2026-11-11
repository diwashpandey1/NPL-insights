BEGIN;

CREATE TABLE public.player_season_teams (
    season_id uuid NOT NULL REFERENCES public.seasons (id),
    team_id uuid NOT NULL REFERENCES public.teams (id),
    player_id uuid NOT NULL REFERENCES public.players (id),
    playing_role text,
    batting_style text,
    bowling_style text,
    source_file_id uuid REFERENCES public.source_files (id),
    CONSTRAINT player_season_teams_pkey
        PRIMARY KEY (season_id, team_id, player_id)
);

CREATE TABLE public.matches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    season_id uuid NOT NULL REFERENCES public.seasons (id),
    match_number integer,
    match_date date,
    start_time time,
    venue_name text,
    city text,
    stage text,
    team_a_id uuid REFERENCES public.teams (id),
    team_b_id uuid REFERENCES public.teams (id),
    toss_winner_team_id uuid REFERENCES public.teams (id),
    toss_decision text,
    winner_team_id uuid REFERENCES public.teams (id),
    result_text text,
    win_by_runs integer,
    win_by_wickets integer,
    dls_applied boolean,
    super_over boolean,
    player_of_match_id uuid REFERENCES public.players (id),
    match_status text NOT NULL DEFAULT 'unknown',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT matches_match_number_positive
        CHECK (match_number IS NULL OR match_number > 0),
    CONSTRAINT matches_status_check
        CHECK (match_status IN ('scheduled', 'live', 'completed', 'abandoned', 'unknown')),
    CONSTRAINT matches_margins_nonnegative
        CHECK (
            (win_by_runs IS NULL OR win_by_runs >= 0)
            AND (win_by_wickets IS NULL OR win_by_wickets >= 0)
        ),
    CONSTRAINT matches_distinct_teams
        CHECK (team_a_id IS NULL OR team_b_id IS NULL OR team_a_id <> team_b_id),
    CONSTRAINT matches_toss_winner_is_participant
        CHECK (
            toss_winner_team_id IS NULL
            OR (
                team_a_id IS NOT NULL
                AND team_b_id IS NOT NULL
                AND toss_winner_team_id IN (team_a_id, team_b_id)
            )
        ),
    CONSTRAINT matches_winner_is_participant
        CHECK (
            winner_team_id IS NULL
            OR (
                team_a_id IS NOT NULL
                AND team_b_id IS NOT NULL
                AND winner_team_id IN (team_a_id, team_b_id)
            )
        )
);

CREATE TABLE public.match_source_keys (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    match_id uuid REFERENCES public.matches (id),
    source_file_id uuid NOT NULL REFERENCES public.source_files (id),
    source_system text NOT NULL,
    source_season_key text NOT NULL DEFAULT '',
    external_match_key text NOT NULL,
    disambiguator text NOT NULL DEFAULT '',
    source_row_number bigint NOT NULL,
    resolution_status text NOT NULL DEFAULT 'ambiguous',
    CONSTRAINT match_source_keys_file_row_unique
        UNIQUE (source_file_id, source_row_number),
    CONSTRAINT match_source_keys_source_system_nonempty
        CHECK (btrim(source_system) <> ''),
    CONSTRAINT match_source_keys_external_key_nonempty
        CHECK (btrim(external_match_key) <> ''),
    CONSTRAINT match_source_keys_disambiguator_nonempty
        CHECK (disambiguator = '' OR btrim(disambiguator) <> ''),
    CONSTRAINT match_source_keys_source_row_positive
        CHECK (source_row_number > 0),
    CONSTRAINT match_source_keys_resolution_check
        CHECK (
            resolution_status IN ('resolved', 'ambiguous', 'rejected')
            AND ((resolution_status = 'resolved') = (match_id IS NOT NULL))
        )
);

CREATE TABLE public.match_innings (
    match_id uuid NOT NULL REFERENCES public.matches (id),
    innings_no smallint NOT NULL,
    batting_team_id uuid REFERENCES public.teams (id),
    bowling_team_id uuid REFERENCES public.teams (id),
    is_super_over boolean NOT NULL DEFAULT false,
    source_file_id uuid REFERENCES public.source_files (id),
    CONSTRAINT match_innings_pkey PRIMARY KEY (match_id, innings_no),
    CONSTRAINT match_innings_number_positive CHECK (innings_no > 0),
    CONSTRAINT match_innings_distinct_teams
        CHECK (
            batting_team_id IS NULL
            OR bowling_team_id IS NULL
            OR batting_team_id <> bowling_team_id
        )
);

COMMIT;