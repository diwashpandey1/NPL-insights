BEGIN;

CREATE OR REPLACE FUNCTION public.ingestion_ensure_season(
    p_season_key text,
    p_label text,
    p_source_season_year smallint
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_season_id uuid;
    v_existing_label text;
    v_existing_year smallint;
    v_outcome text;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_season_key, 0));
    SELECT id, label, source_season_year
    INTO v_season_id, v_existing_label, v_existing_year
    FROM public.seasons
    WHERE season_key = p_season_key
    FOR UPDATE;

    IF NOT FOUND THEN
        INSERT INTO public.seasons (season_key, label, source_season_year, coverage_status)
        VALUES (p_season_key, p_label, p_source_season_year, 'partial')
        RETURNING id INTO v_season_id;
        v_outcome := 'inserted';
    ELSIF ROW(v_existing_label, v_existing_year) IS DISTINCT FROM ROW(p_label, p_source_season_year) THEN
        UPDATE public.seasons
        SET label = p_label,
            source_season_year = p_source_season_year
        WHERE id = v_season_id;
        v_outcome := 'updated';
    ELSE
        v_outcome := 'unchanged';
    END IF;

    RETURN jsonb_build_object('id', v_season_id, 'outcome', v_outcome);
END;
$$;

CREATE OR REPLACE FUNCTION public.ingestion_ensure_team_alias(
    p_team_key text,
    p_canonical_name text,
    p_source_system text,
    p_alias text,
    p_alias_normalized text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_team_id uuid;
    v_existing_team_id uuid;
    v_existing_canonical_name text;
    v_team_key_id uuid;
    v_canonical_name_id uuid;
    v_outcome text;
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtextextended(p_source_system || E'\x1f' || p_alias_normalized, 0)
    );

    SELECT ta.team_id, t.canonical_name
    INTO v_existing_team_id, v_existing_canonical_name
    FROM public.team_aliases AS ta
    JOIN public.teams AS t ON t.id = ta.team_id
    WHERE ta.source_system = p_source_system
      AND ta.alias_normalized = p_alias_normalized
    FOR UPDATE OF ta;

    IF FOUND THEN
        IF v_existing_canonical_name <> p_canonical_name THEN
            RETURN jsonb_build_object(
                'id', v_existing_team_id,
                'canonical_name', v_existing_canonical_name,
                'outcome', 'rejected',
                'reason', 'The source alias is already assigned to a different canonical team.'
            );
        END IF;
        RETURN jsonb_build_object(
            'id', v_existing_team_id,
            'canonical_name', v_existing_canonical_name,
            'outcome', 'unchanged'
        );
    END IF;

    SELECT id INTO v_team_key_id FROM public.teams WHERE team_key = p_team_key FOR UPDATE;
    SELECT id INTO v_canonical_name_id FROM public.teams WHERE canonical_name = p_canonical_name FOR UPDATE;
    IF v_team_key_id IS NOT NULL AND v_canonical_name_id IS NOT NULL AND v_team_key_id <> v_canonical_name_id THEN
        RETURN jsonb_build_object(
            'outcome', 'rejected',
            'reason', 'The canonical team key and name refer to different existing teams.'
        );
    END IF;

    v_team_id := COALESCE(v_team_key_id, v_canonical_name_id);
    IF v_team_id IS NULL THEN
        INSERT INTO public.teams (team_key, canonical_name, active)
        VALUES (p_team_key, p_canonical_name, true)
        RETURNING id INTO v_team_id;
        v_outcome := 'inserted';
    ELSE
        IF NOT EXISTS (
            SELECT 1 FROM public.teams
            WHERE id = v_team_id AND team_key = p_team_key AND canonical_name = p_canonical_name
        ) THEN
            RETURN jsonb_build_object(
                'id', v_team_id,
                'outcome', 'rejected',
                'reason', 'Existing canonical team identity conflicts with the configured mapping.'
            );
        END IF;
        v_outcome := 'updated';
    END IF;

    INSERT INTO public.team_aliases (team_id, source_system, alias, alias_normalized)
    VALUES (v_team_id, p_source_system, p_alias, p_alias_normalized);

    RETURN jsonb_build_object(
        'id', v_team_id,
        'canonical_name', p_canonical_name,
        'outcome', v_outcome
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.ingestion_register_source_file(
    p_ingestion_run_id uuid,
    p_source_system text,
    p_logical_path text,
    p_content_sha256 text,
    p_format text,
    p_season_id uuid,
    p_row_count bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_source_file_id uuid;
    v_existing_count integer;
    v_previous_status text;
    v_previous_summary jsonb;
    v_outcome text;
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtextextended(p_source_system || E'\x1f' || p_logical_path || E'\x1f' || p_content_sha256, 0)
    );

    SELECT count(*)::integer
    INTO v_existing_count
    FROM public.source_files
    WHERE source_system = p_source_system
      AND logical_path = p_logical_path
      AND content_sha256 = p_content_sha256;

    IF v_existing_count > 1 THEN
        RAISE EXCEPTION 'Duplicate source-file metadata exists for % (%). Manual reconciliation is required.',
            p_source_system, p_logical_path;
    END IF;

    IF v_existing_count = 1 THEN
        SELECT sf.id, ir.status, ir.summary
        INTO v_source_file_id, v_previous_status, v_previous_summary
        FROM public.source_files AS sf
        JOIN public.ingestion_runs AS ir ON ir.id = sf.ingestion_run_id
        WHERE sf.source_system = p_source_system
          AND sf.logical_path = p_logical_path
          AND sf.content_sha256 = p_content_sha256
        FOR UPDATE OF sf;

        UPDATE public.source_files
        SET ingestion_run_id = p_ingestion_run_id,
            format = p_format,
            season_id = p_season_id,
            row_count = p_row_count,
            loaded_at = now()
        WHERE id = v_source_file_id;
        v_outcome := 'updated';
    ELSE
        INSERT INTO public.source_files (
            ingestion_run_id, source_system, logical_path, content_sha256, format, season_id, row_count
        )
        VALUES (
            p_ingestion_run_id, p_source_system, p_logical_path, p_content_sha256, p_format, p_season_id, p_row_count
        )
        RETURNING id INTO v_source_file_id;
        v_outcome := 'inserted';
    END IF;

    RETURN jsonb_build_object(
        'id', v_source_file_id,
        'outcome', v_outcome,
        'previousRunStatus', v_previous_status,
        'previousSummary', v_previous_summary
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.ingestion_persist_match(
    p_match jsonb,
    p_source_key jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_match public.matches%ROWTYPE;
    v_existing public.matches%ROWTYPE;
    v_match_id uuid;
    v_key_id uuid;
    v_existing_count integer;
    v_outcome text;
    v_source_system text := p_source_key->>'source_system';
    v_source_season_key text := p_source_key->>'source_season_key';
    v_external_match_key text := p_source_key->>'external_match_key';
    v_disambiguator text := COALESCE(p_source_key->>'disambiguator', '');
BEGIN
    v_match := jsonb_populate_record(NULL::public.matches, p_match);
    IF v_match.season_id IS NULL OR v_match.team_a_id IS NULL OR v_match.team_b_id IS NULL THEN
        RAISE EXCEPTION 'A canonical match requires a season and both resolved participant teams.';
    END IF;
    PERFORM pg_advisory_xact_lock(
        hashtextextended(v_source_system || E'\x1f' || v_source_season_key || E'\x1f' || v_external_match_key || E'\x1f' || v_disambiguator, 0)
    );

    SELECT count(*)::integer
    INTO v_existing_count
    FROM public.match_source_keys
    WHERE source_system = v_source_system
      AND source_season_key = v_source_season_key
      AND external_match_key = v_external_match_key
      AND disambiguator = v_disambiguator;

    IF v_existing_count > 1 THEN
        RAISE EXCEPTION 'Duplicate canonical source keys exist for %/%/%',
            v_source_system, v_source_season_key, v_external_match_key;
    END IF;

    IF v_existing_count = 1 THEN
        SELECT id, match_id
        INTO v_key_id, v_match_id
        FROM public.match_source_keys
        WHERE source_system = v_source_system
          AND source_season_key = v_source_season_key
          AND external_match_key = v_external_match_key
          AND disambiguator = v_disambiguator
        FOR UPDATE;

        IF v_match_id IS NOT NULL THEN
            SELECT * INTO STRICT v_existing
            FROM public.matches
            WHERE id = v_match_id
            FOR UPDATE;

            IF ROW(
                v_existing.season_id, v_existing.match_number, v_existing.match_date, v_existing.start_time,
                v_existing.venue_name, v_existing.city, v_existing.stage, v_existing.team_a_id,
                v_existing.team_b_id, v_existing.toss_winner_team_id, v_existing.toss_decision,
                v_existing.winner_team_id, v_existing.result_text, v_existing.win_by_runs,
                v_existing.win_by_wickets, v_existing.dls_applied, v_existing.super_over,
                v_existing.player_of_match_id, v_existing.match_status
            ) IS DISTINCT FROM ROW(
                v_match.season_id, v_match.match_number, v_match.match_date, v_match.start_time,
                v_match.venue_name, v_match.city, v_match.stage, v_match.team_a_id,
                v_match.team_b_id, COALESCE(v_match.toss_winner_team_id, v_existing.toss_winner_team_id), v_match.toss_decision,
                COALESCE(v_match.winner_team_id, v_existing.winner_team_id), v_match.result_text, v_match.win_by_runs,
                v_match.win_by_wickets, v_match.dls_applied, v_match.super_over,
                COALESCE(v_match.player_of_match_id, v_existing.player_of_match_id), v_match.match_status
            ) THEN
                UPDATE public.matches
                SET season_id = v_match.season_id,
                    match_number = v_match.match_number,
                    match_date = v_match.match_date,
                    start_time = v_match.start_time,
                    venue_name = v_match.venue_name,
                    city = v_match.city,
                    stage = v_match.stage,
                    team_a_id = v_match.team_a_id,
                    team_b_id = v_match.team_b_id,
                    toss_winner_team_id = COALESCE(v_match.toss_winner_team_id, public.matches.toss_winner_team_id),
                    toss_decision = v_match.toss_decision,
                    winner_team_id = COALESCE(v_match.winner_team_id, public.matches.winner_team_id),
                    result_text = v_match.result_text,
                    win_by_runs = v_match.win_by_runs,
                    win_by_wickets = v_match.win_by_wickets,
                    dls_applied = v_match.dls_applied,
                    super_over = v_match.super_over,
                    player_of_match_id = COALESCE(v_match.player_of_match_id, public.matches.player_of_match_id),
                    match_status = v_match.match_status,
                    updated_at = now()
                WHERE id = v_match_id;
                v_outcome := 'updated';
            ELSE
                v_outcome := 'unchanged';
            END IF;
        END IF;
    END IF;

    IF v_match_id IS NULL THEN
        INSERT INTO public.matches (
            season_id, match_number, match_date, start_time, venue_name, city, stage,
            team_a_id, team_b_id, toss_winner_team_id, toss_decision, winner_team_id,
            result_text, win_by_runs, win_by_wickets, dls_applied, super_over,
            player_of_match_id, match_status
        )
        VALUES (
            v_match.season_id, v_match.match_number, v_match.match_date, v_match.start_time,
            v_match.venue_name, v_match.city, v_match.stage, v_match.team_a_id, v_match.team_b_id,
            v_match.toss_winner_team_id, v_match.toss_decision, v_match.winner_team_id,
            v_match.result_text, v_match.win_by_runs, v_match.win_by_wickets, v_match.dls_applied,
            v_match.super_over, v_match.player_of_match_id, v_match.match_status
        )
        RETURNING id INTO v_match_id;
        v_outcome := 'inserted';
    END IF;

    IF v_key_id IS NOT NULL THEN
        UPDATE public.match_source_keys
        SET match_id = v_match_id,
            source_file_id = (p_source_key->>'source_file_id')::uuid,
            source_row_number = (p_source_key->>'source_row_number')::bigint,
            resolution_status = 'resolved'
        WHERE id = v_key_id;
    ELSE
    INSERT INTO public.match_source_keys (
        match_id, source_file_id, source_system, source_season_key, external_match_key,
        disambiguator, source_row_number, resolution_status
    )
    VALUES (
        v_match_id,
        (p_source_key->>'source_file_id')::uuid,
        v_source_system,
        v_source_season_key,
        v_external_match_key,
        v_disambiguator,
        (p_source_key->>'source_row_number')::bigint,
        'resolved'
    )
    ON CONFLICT (source_file_id, source_row_number)
    DO UPDATE SET
        match_id = EXCLUDED.match_id,
        source_system = EXCLUDED.source_system,
        source_season_key = EXCLUDED.source_season_key,
        external_match_key = EXCLUDED.external_match_key,
        disambiguator = EXCLUDED.disambiguator,
        resolution_status = 'resolved';
    END IF;

    RETURN jsonb_build_object('id', v_match_id, 'outcome', v_outcome);
END;
$$;

CREATE OR REPLACE FUNCTION public.ingestion_persist_delivery_batch(p_records jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_record jsonb;
    v_delivery public.deliveries%ROWTYPE;
    v_existing public.deliveries%ROWTYPE;
    v_delivery_id bigint;
    v_innings public.match_innings%ROWTYPE;
    v_innings_changed boolean;
    v_delivery_changed boolean;
    v_children_changed boolean;
    v_action text;
    v_dismissal jsonb;
    v_fielder jsonb;
    v_dismissal_id bigint;
    v_dismissal_existing public.dismissals%ROWTYPE;
    v_fielder_count integer;
    v_existing_fielder_id uuid;
    v_player_out_id uuid;
    v_fielders jsonb;
    v_results jsonb := '[]'::jsonb;
    v_dismissal_numbers smallint[];
BEGIN
    IF jsonb_typeof(p_records) <> 'array' THEN
        RAISE EXCEPTION 'Delivery batch must be a JSON array.';
    END IF;

    FOR v_record IN SELECT value FROM jsonb_array_elements(p_records)
    LOOP
        v_delivery := jsonb_populate_record(NULL::public.deliveries, v_record->'delivery');
        SELECT * INTO v_innings
        FROM public.match_innings
        WHERE match_id = v_delivery.match_id AND innings_no = v_delivery.innings_no
        FOR UPDATE;

        v_innings_changed := NOT FOUND
            OR ROW(v_innings.batting_team_id, v_innings.bowling_team_id, v_innings.source_file_id)
               IS DISTINCT FROM ROW(
                   (v_record->'innings'->>'batting_team_id')::uuid,
                   (v_record->'innings'->>'bowling_team_id')::uuid,
                   (v_record->'innings'->>'source_file_id')::uuid
               );

        INSERT INTO public.match_innings (
            match_id, innings_no, batting_team_id, bowling_team_id, source_file_id
        )
        VALUES (
            v_delivery.match_id, v_delivery.innings_no,
            (v_record->'innings'->>'batting_team_id')::uuid,
            (v_record->'innings'->>'bowling_team_id')::uuid,
            (v_record->'innings'->>'source_file_id')::uuid
        )
        ON CONFLICT (match_id, innings_no)
        DO UPDATE SET
            batting_team_id = COALESCE(EXCLUDED.batting_team_id, public.match_innings.batting_team_id),
            bowling_team_id = COALESCE(EXCLUDED.bowling_team_id, public.match_innings.bowling_team_id),
            source_file_id = EXCLUDED.source_file_id;

        SELECT * INTO v_existing
        FROM public.deliveries
        WHERE match_id = v_delivery.match_id
          AND innings_no = v_delivery.innings_no
          AND delivery_no = v_delivery.delivery_no
        FOR UPDATE;

        IF FOUND THEN
            v_delivery_id := v_existing.id;
            IF v_delivery.bowler_id IS NULL
               AND v_delivery.bowler_name_raw IS NOT DISTINCT FROM v_existing.bowler_name_raw THEN
                v_delivery.bowler_id := v_existing.bowler_id;
            END IF;
            IF v_delivery.batter_id IS NULL
               AND v_delivery.batter_name_raw IS NOT DISTINCT FROM v_existing.batter_name_raw THEN
                v_delivery.batter_id := v_existing.batter_id;
            END IF;
            IF v_delivery.non_striker_id IS NULL
               AND v_delivery.non_striker_name_raw IS NOT DISTINCT FROM v_existing.non_striker_name_raw THEN
                v_delivery.non_striker_id := v_existing.non_striker_id;
            END IF;
            v_delivery_changed := (to_jsonb(v_existing) - 'id')
                IS DISTINCT FROM (to_jsonb(v_delivery) - 'id');
            IF v_delivery_changed THEN
                UPDATE public.deliveries
                SET source_file_id = v_delivery.source_file_id,
                    source_row_number = v_delivery.source_row_number,
                    over_number = v_delivery.over_number,
                    ball_in_over = v_delivery.ball_in_over,
                    source_ball_label = v_delivery.source_ball_label,
                    ball_result = v_delivery.ball_result,
                    shot_direction = v_delivery.shot_direction,
                    bowler_id = v_delivery.bowler_id,
                    batter_id = v_delivery.batter_id,
                    non_striker_id = v_delivery.non_striker_id,
                    bowler_name_raw = v_delivery.bowler_name_raw,
                    batter_name_raw = v_delivery.batter_name_raw,
                    non_striker_name_raw = v_delivery.non_striker_name_raw,
                    batter_runs = v_delivery.batter_runs,
                    wide_runs = v_delivery.wide_runs,
                    no_ball_runs = v_delivery.no_ball_runs,
                    bye_runs = v_delivery.bye_runs,
                    leg_bye_runs = v_delivery.leg_bye_runs,
                    extra_runs = v_delivery.extra_runs,
                    total_runs = v_delivery.total_runs
                WHERE id = v_delivery_id;
            END IF;
            v_action := CASE WHEN v_delivery_changed OR v_innings_changed THEN 'updated' ELSE 'unchanged' END;
        ELSE
            INSERT INTO public.deliveries (
                match_id, innings_no, delivery_no, source_file_id, source_row_number,
                over_number, ball_in_over, source_ball_label, ball_result, shot_direction,
                bowler_id, batter_id, non_striker_id, bowler_name_raw, batter_name_raw,
                non_striker_name_raw, batter_runs, wide_runs, no_ball_runs, bye_runs,
                leg_bye_runs, extra_runs, total_runs
            )
            VALUES (
                v_delivery.match_id, v_delivery.innings_no, v_delivery.delivery_no,
                v_delivery.source_file_id, v_delivery.source_row_number, v_delivery.over_number,
                v_delivery.ball_in_over, v_delivery.source_ball_label, v_delivery.ball_result,
                v_delivery.shot_direction, v_delivery.bowler_id, v_delivery.batter_id,
                v_delivery.non_striker_id, v_delivery.bowler_name_raw, v_delivery.batter_name_raw,
                v_delivery.non_striker_name_raw, v_delivery.batter_runs, v_delivery.wide_runs,
                v_delivery.no_ball_runs, v_delivery.bye_runs, v_delivery.leg_bye_runs,
                v_delivery.extra_runs, v_delivery.total_runs
            )
            RETURNING id INTO v_delivery_id;
            v_action := 'inserted';
            v_delivery_changed := true;
        END IF;

        v_dismissal_numbers := ARRAY[]::smallint[];
        v_children_changed := false;
        FOR v_dismissal IN SELECT value FROM jsonb_array_elements(COALESCE(v_record->'dismissals', '[]'::jsonb))
        LOOP
            v_dismissal_numbers := array_append(v_dismissal_numbers, (v_dismissal->>'dismissal_no')::smallint);
            SELECT * INTO v_dismissal_existing
            FROM public.dismissals
            WHERE delivery_id = v_delivery_id
              AND dismissal_no = (v_dismissal->>'dismissal_no')::smallint
            FOR UPDATE;

            v_player_out_id := (v_dismissal->>'player_out_id')::uuid;
            IF FOUND
               AND v_player_out_id IS NULL
               AND v_dismissal->>'player_out_name_raw' IS NOT DISTINCT FROM v_dismissal_existing.player_out_name_raw THEN
                v_player_out_id := v_dismissal_existing.player_out_id;
            END IF;

            IF NOT FOUND THEN
                v_children_changed := true;
            ELSIF ROW(
                v_dismissal_existing.player_out_id,
                v_dismissal_existing.player_out_name_raw,
                v_dismissal_existing.dismissal_kind,
                v_dismissal_existing.source_file_id
            ) IS DISTINCT FROM ROW(
                v_player_out_id,
                v_dismissal->>'player_out_name_raw',
                v_dismissal->>'dismissal_kind',
                (v_dismissal->>'source_file_id')::uuid
            ) THEN
                v_children_changed := true;
            END IF;

            INSERT INTO public.dismissals (
                delivery_id, dismissal_no, player_out_id, player_out_name_raw, dismissal_kind, source_file_id
            )
            VALUES (
                v_delivery_id,
                (v_dismissal->>'dismissal_no')::smallint,
                v_player_out_id,
                v_dismissal->>'player_out_name_raw',
                v_dismissal->>'dismissal_kind',
                (v_dismissal->>'source_file_id')::uuid
            )
            ON CONFLICT (delivery_id, dismissal_no)
            DO UPDATE SET
                player_out_id = EXCLUDED.player_out_id,
                player_out_name_raw = EXCLUDED.player_out_name_raw,
                dismissal_kind = EXCLUDED.dismissal_kind,
                source_file_id = EXCLUDED.source_file_id
            RETURNING id INTO v_dismissal_id;

            v_fielders := '[]'::jsonb;
            FOR v_fielder IN SELECT value FROM jsonb_array_elements(COALESCE(v_dismissal->'fielders', '[]'::jsonb))
            LOOP
                v_existing_fielder_id := NULL;
                IF (v_fielder->>'player_id') IS NULL THEN
                    SELECT player_id INTO v_existing_fielder_id
                    FROM public.dismissal_fielders
                    WHERE dismissal_id = v_dismissal_id
                      AND fielder_no = (v_fielder->>'fielder_no')::smallint
                      AND fielder_name_raw = v_fielder->>'fielder_name_raw';
                    IF FOUND AND v_existing_fielder_id IS NOT NULL THEN
                        v_fielder := jsonb_set(v_fielder, '{player_id}', to_jsonb(v_existing_fielder_id), true);
                    END IF;
                END IF;
                v_fielders := v_fielders || jsonb_build_array(v_fielder);
            END LOOP;

            SELECT count(*)::integer INTO v_fielder_count
            FROM public.dismissal_fielders
            WHERE dismissal_id = v_dismissal_id;
            IF v_fielder_count <> jsonb_array_length(v_fielders) THEN
                v_children_changed := true;
            ELSE
                FOR v_fielder IN SELECT value FROM jsonb_array_elements(v_fielders)
                LOOP
                    IF NOT EXISTS (
                        SELECT 1
                        FROM public.dismissal_fielders
                        WHERE dismissal_id = v_dismissal_id
                          AND fielder_no = (v_fielder->>'fielder_no')::smallint
                          AND player_id IS NOT DISTINCT FROM (v_fielder->>'player_id')::uuid
                          AND fielder_name_raw = v_fielder->>'fielder_name_raw'
                    ) THEN
                        v_children_changed := true;
                    END IF;
                END LOOP;
            END IF;

            DELETE FROM public.dismissal_fielders WHERE dismissal_id = v_dismissal_id;
            FOR v_fielder IN SELECT value FROM jsonb_array_elements(v_fielders)
            LOOP
                INSERT INTO public.dismissal_fielders (dismissal_id, fielder_no, player_id, fielder_name_raw)
                VALUES (
                    v_dismissal_id,
                    (v_fielder->>'fielder_no')::smallint,
                    (v_fielder->>'player_id')::uuid,
                    v_fielder->>'fielder_name_raw'
                );
            END LOOP;
        END LOOP;

        IF EXISTS (
            SELECT 1 FROM public.dismissals
            WHERE delivery_id = v_delivery_id
              AND NOT (dismissal_no = ANY(v_dismissal_numbers))
        ) THEN
            v_children_changed := true;
            DELETE FROM public.dismissal_fielders AS df
            USING public.dismissals AS d
            WHERE df.dismissal_id = d.id
              AND d.delivery_id = v_delivery_id
              AND NOT (d.dismissal_no = ANY(v_dismissal_numbers));
            DELETE FROM public.dismissals
            WHERE delivery_id = v_delivery_id
              AND NOT (dismissal_no = ANY(v_dismissal_numbers));
        END IF;

        IF v_action = 'unchanged' AND v_children_changed THEN
            v_action := 'updated';
        END IF;

        v_results := v_results || jsonb_build_array(
            jsonb_build_object('id', v_delivery_id, 'outcome', v_action)
        );
    END LOOP;

    RETURN v_results;
END;
$$;

REVOKE ALL ON FUNCTION public.ingestion_ensure_season(text, text, smallint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ingestion_ensure_team_alias(text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ingestion_register_source_file(uuid, text, text, text, text, uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ingestion_persist_match(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ingestion_persist_delivery_batch(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ingestion_ensure_season(text, text, smallint) TO service_role;
GRANT EXECUTE ON FUNCTION public.ingestion_ensure_team_alias(text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.ingestion_register_source_file(uuid, text, text, text, text, uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.ingestion_persist_match(jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.ingestion_persist_delivery_batch(jsonb) TO service_role;

COMMIT;