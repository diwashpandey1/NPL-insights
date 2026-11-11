BEGIN;

CREATE TABLE public.seasons (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    season_key text NOT NULL UNIQUE,
    label text NOT NULL,
    source_season_year smallint,
    start_date date,
    end_date date,
    coverage_status text NOT NULL DEFAULT 'unknown',
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT seasons_season_key_nonempty CHECK (btrim(season_key) <> ''),
    CONSTRAINT seasons_label_nonempty CHECK (btrim(label) <> ''),
    CONSTRAINT seasons_coverage_status_check
        CHECK (coverage_status IN ('unknown', 'partial', 'complete')),
    CONSTRAINT seasons_date_order_check
        CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date)
);

CREATE TABLE public.teams (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_key text NOT NULL UNIQUE,
    canonical_name text NOT NULL UNIQUE,
    short_name text,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT teams_team_key_nonempty CHECK (btrim(team_key) <> ''),
    CONSTRAINT teams_canonical_name_nonempty CHECK (btrim(canonical_name) <> '')
);

CREATE TABLE public.team_aliases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL REFERENCES public.teams (id),
    source_system text NOT NULL,
    alias text NOT NULL,
    alias_normalized text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT team_aliases_source_alias_unique
        UNIQUE (source_system, alias_normalized),
    CONSTRAINT team_aliases_source_system_nonempty
        CHECK (btrim(source_system) <> ''),
    CONSTRAINT team_aliases_alias_nonempty CHECK (btrim(alias) <> ''),
    CONSTRAINT team_aliases_normalized_nonempty
        CHECK (btrim(alias_normalized) <> '')
);

CREATE TABLE public.players (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name text NOT NULL,
    sort_name text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT players_display_name_nonempty
        CHECK (btrim(display_name) <> '')
);

CREATE TABLE public.player_aliases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id uuid NOT NULL REFERENCES public.players (id),
    source_system text NOT NULL,
    alias text NOT NULL,
    alias_normalized text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT player_aliases_source_alias_unique
        UNIQUE (source_system, alias_normalized),
    CONSTRAINT player_aliases_source_system_nonempty
        CHECK (btrim(source_system) <> ''),
    CONSTRAINT player_aliases_alias_nonempty CHECK (btrim(alias) <> ''),
    CONSTRAINT player_aliases_normalized_nonempty
        CHECK (btrim(alias_normalized) <> '')
);

COMMIT;