BEGIN;

CREATE TABLE public.deliveries (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    match_id uuid NOT NULL,
    innings_no smallint NOT NULL,
    delivery_no integer NOT NULL,
    source_file_id uuid NOT NULL REFERENCES public.source_files (id),
    source_row_number bigint NOT NULL,
    over_number smallint,
    ball_in_over smallint,
    source_ball_label text,
    ball_result text,
    shot_direction text,
    bowler_id uuid REFERENCES public.players (id),
    batter_id uuid REFERENCES public.players (id),
    non_striker_id uuid REFERENCES public.players (id),
    bowler_name_raw text,
    batter_name_raw text,
    non_striker_name_raw text,
    batter_runs smallint,
    wide_runs smallint,
    no_ball_runs smallint,
    bye_runs smallint,
    leg_bye_runs smallint,
    extra_runs smallint,
    total_runs smallint,
    CONSTRAINT deliveries_innings_fk
        FOREIGN KEY (match_id, innings_no)
        REFERENCES public.match_innings (match_id, innings_no),
    CONSTRAINT deliveries_innings_sequence_unique
        UNIQUE (match_id, innings_no, delivery_no),
    CONSTRAINT deliveries_source_file_row_unique
        UNIQUE (source_file_id, source_row_number),
    CONSTRAINT deliveries_sequence_positive CHECK (delivery_no > 0),
    CONSTRAINT deliveries_source_row_positive CHECK (source_row_number > 0),
    CONSTRAINT deliveries_over_number_nonnegative
        CHECK (over_number IS NULL OR over_number >= 0),
    CONSTRAINT deliveries_ball_number_nonnegative
        CHECK (ball_in_over IS NULL OR ball_in_over >= 0),
    CONSTRAINT deliveries_runs_nonnegative
        CHECK (
            (batter_runs IS NULL OR batter_runs >= 0)
            AND (wide_runs IS NULL OR wide_runs >= 0)
            AND (no_ball_runs IS NULL OR no_ball_runs >= 0)
            AND (bye_runs IS NULL OR bye_runs >= 0)
            AND (leg_bye_runs IS NULL OR leg_bye_runs >= 0)
            AND (extra_runs IS NULL OR extra_runs >= 0)
            AND (total_runs IS NULL OR total_runs >= 0)
        )
);

CREATE TABLE public.dismissals (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    delivery_id bigint NOT NULL REFERENCES public.deliveries (id),
    dismissal_no smallint NOT NULL,
    player_out_id uuid REFERENCES public.players (id),
    player_out_name_raw text,
    dismissal_kind text NOT NULL,
    source_file_id uuid REFERENCES public.source_files (id),
    CONSTRAINT dismissals_delivery_sequence_unique
        UNIQUE (delivery_id, dismissal_no),
    CONSTRAINT dismissals_number_positive CHECK (dismissal_no > 0),
    CONSTRAINT dismissals_kind_nonempty CHECK (btrim(dismissal_kind) <> '')
);

CREATE TABLE public.dismissal_fielders (
    dismissal_id bigint NOT NULL REFERENCES public.dismissals (id),
    fielder_no smallint NOT NULL,
    player_id uuid REFERENCES public.players (id),
    fielder_name_raw text NOT NULL,
    CONSTRAINT dismissal_fielders_pkey PRIMARY KEY (dismissal_id, fielder_no),
    CONSTRAINT dismissal_fielders_number_positive CHECK (fielder_no > 0),
    CONSTRAINT dismissal_fielders_name_nonempty
        CHECK (btrim(fielder_name_raw) <> '')
);

COMMIT;