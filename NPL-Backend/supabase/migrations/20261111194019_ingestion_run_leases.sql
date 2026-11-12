BEGIN;

DROP FUNCTION IF EXISTS public.ingestion_acquire_run_lock(text, text, text, text, integer);
DROP FUNCTION IF EXISTS public.ingestion_expire_stale_runs(integer);
DROP FUNCTION IF EXISTS public.ingestion_try_acquire_lock(bigint);
DROP FUNCTION IF EXISTS public.ingestion_release_lock(bigint);
DROP FUNCTION IF EXISTS public.ingestion_register_source_file(uuid, text, text, text, text, uuid, bigint);
DROP FUNCTION IF EXISTS public.ingestion_ensure_season(text, text, smallint);
DROP FUNCTION IF EXISTS public.ingestion_ensure_team_alias(text, text, text, text, text);

ALTER FUNCTION public.ingestion_persist_match(jsonb, jsonb)
    SET search_path = pg_catalog, public;
ALTER FUNCTION public.ingestion_persist_delivery_batch(jsonb)
    SET search_path = pg_catalog, public;

CREATE TABLE public.ingestion_run_leases (
    source_system text NOT NULL,
    logical_path text NOT NULL,
    ingestion_run_id uuid NOT NULL UNIQUE
        REFERENCES public.ingestion_runs (id) ON DELETE CASCADE,
    lease_token uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    renewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    CONSTRAINT ingestion_run_leases_pkey PRIMARY KEY (source_system, logical_path),
    CONSTRAINT ingestion_run_leases_source_system_nonempty CHECK (btrim(source_system) <> ''),
    CONSTRAINT ingestion_run_leases_logical_path_nonempty CHECK (btrim(logical_path) <> ''),
    CONSTRAINT ingestion_run_leases_expiry_after_acquire CHECK (expires_at > acquired_at),
    CONSTRAINT ingestion_run_leases_renewed_after_acquire CHECK (renewed_at >= acquired_at)
);

ALTER TABLE public.ingestion_run_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.ingestion_run_leases FROM PUBLIC, anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.ingestion_run_leases TO service_role;

CREATE FUNCTION public.ingestion_assert_run_lease(p_run_id uuid, p_lease_token uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_expires_at timestamptz;
    v_status text;
BEGIN
    SELECT l.expires_at, r.status
    INTO v_expires_at, v_status
    FROM public.ingestion_run_leases AS l
    JOIN public.ingestion_runs AS r ON r.id = l.ingestion_run_id
    WHERE l.ingestion_run_id = p_run_id
      AND l.lease_token = p_lease_token
    FOR UPDATE OF l;

    IF NOT FOUND OR v_status <> 'running' OR v_expires_at <= clock_timestamp() THEN
        RAISE EXCEPTION 'ingestion_lease_lost: run % no longer owns a valid source lease', p_run_id
            USING ERRCODE = '55000';
    END IF;
END;
$$;

CREATE FUNCTION public.ingestion_assert_active_run(p_run_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_expires_at timestamptz;
    v_status text;
BEGIN
    SELECT l.expires_at, r.status
    INTO v_expires_at, v_status
    FROM public.ingestion_run_leases AS l
    JOIN public.ingestion_runs AS r ON r.id = l.ingestion_run_id
    WHERE l.ingestion_run_id = p_run_id
    FOR UPDATE OF l;

    IF NOT FOUND OR v_status <> 'running' OR v_expires_at <= clock_timestamp() THEN
        RAISE EXCEPTION 'ingestion_lease_lost: run % has no valid source lease', p_run_id
            USING ERRCODE = '55000';
    END IF;
END;
$$;

CREATE FUNCTION public.ingestion_recover_expired_lease(
    p_source_system text,
    p_logical_path text
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_run_id uuid;
    v_expires_at timestamptz;
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtextextended(p_source_system || E'\x1f' || p_logical_path, 0)
    );

    SELECT l.ingestion_run_id, l.expires_at
    INTO v_run_id, v_expires_at
    FROM public.ingestion_run_leases AS l
    WHERE l.source_system = p_source_system
      AND l.logical_path = p_logical_path
    FOR UPDATE;

    IF NOT FOUND OR v_expires_at > clock_timestamp() THEN
        RETURN 0;
    END IF;

    UPDATE public.ingestion_runs
    SET status = 'failed',
        finished_at = clock_timestamp(),
        summary = jsonb_set(
            COALESCE(summary, '{}'::jsonb),
            '{lease_expired}',
            'true'::jsonb,
            true
        )
    WHERE id = v_run_id
      AND status = 'running';

    DELETE FROM public.ingestion_run_leases
    WHERE source_system = p_source_system
      AND logical_path = p_logical_path
      AND ingestion_run_id = v_run_id;

    RETURN 1;
END;
$$;

CREATE FUNCTION public.ingestion_acquire_run_lock(
    p_source_system text,
    p_logical_path text,
    p_pipeline_version text,
    p_source_set text,
    p_lease_duration_seconds integer DEFAULT 300
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_run_id uuid;
    v_lease_token uuid;
BEGIN
    IF p_source_system IS NULL OR btrim(p_source_system) = ''
       OR p_logical_path IS NULL OR btrim(p_logical_path) = '' THEN
        RAISE EXCEPTION 'A source system and logical path are required.';
    END IF;
    IF p_lease_duration_seconds IS NULL OR p_lease_duration_seconds <= 0
       OR p_lease_duration_seconds > 3600 THEN
        RAISE EXCEPTION 'Lease duration must be between 1 and 3600 seconds.';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(p_source_system || E'\x1f' || p_logical_path, 0)
    );
    PERFORM public.ingestion_recover_expired_lease(p_source_system, p_logical_path);

    IF EXISTS (
        SELECT 1
        FROM public.ingestion_run_leases AS l
        WHERE l.source_system = p_source_system
          AND l.logical_path = p_logical_path
          AND l.expires_at > clock_timestamp()
    ) THEN
        RAISE EXCEPTION 'concurrent_ingestion_conflict: a valid lease already exists for % (%)',
            p_source_system, p_logical_path
            USING ERRCODE = '23505';
    END IF;

    INSERT INTO public.ingestion_runs (
        pipeline_version, source_set, status,
        rows_read, rows_inserted, rows_updated, rows_unchanged, rows_rejected, summary
    )
    VALUES (
        p_pipeline_version, p_source_set, 'running',
        0, 0, 0, 0, 0, '{}'::jsonb
    )
    RETURNING id INTO v_run_id;

    INSERT INTO public.ingestion_run_leases (
        source_system, logical_path, ingestion_run_id, lease_token, expires_at
    )
    VALUES (
        p_source_system,
        p_logical_path,
        v_run_id,
        gen_random_uuid(),
        clock_timestamp() + make_interval(secs => p_lease_duration_seconds)
    )
    RETURNING lease_token INTO v_lease_token;

    RETURN jsonb_build_object('id', v_run_id, 'lease_token', v_lease_token);
END;
$$;

CREATE FUNCTION public.ingestion_renew_run_lease(
    p_run_id uuid,
    p_lease_token uuid,
    p_lease_duration_seconds integer DEFAULT 300
)
RETURNS timestamptz
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_expires_at timestamptz;
BEGIN
    IF p_lease_duration_seconds IS NULL OR p_lease_duration_seconds <= 0
       OR p_lease_duration_seconds > 3600 THEN
        RAISE EXCEPTION 'Lease duration must be between 1 and 3600 seconds.';
    END IF;

    UPDATE public.ingestion_run_leases AS l
    SET renewed_at = clock_timestamp(),
        expires_at = clock_timestamp() + make_interval(secs => p_lease_duration_seconds)
    FROM public.ingestion_runs AS r
    WHERE l.ingestion_run_id = p_run_id
      AND l.lease_token = p_lease_token
      AND l.expires_at > clock_timestamp()
      AND r.id = l.ingestion_run_id
      AND r.status = 'running'
    RETURNING l.expires_at INTO v_expires_at;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ingestion_lease_lost: run % cannot renew its lease', p_run_id
            USING ERRCODE = '55000';
    END IF;
    RETURN v_expires_at;
END;
$$;

CREATE FUNCTION public.ingestion_expire_stale_runs(
    p_source_system text,
    p_logical_path text
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF p_source_system IS NULL OR btrim(p_source_system) = ''
       OR p_logical_path IS NULL OR btrim(p_logical_path) = '' THEN
        RAISE EXCEPTION 'Source-scoped recovery requires a source system and logical path.';
    END IF;
    RETURN public.ingestion_recover_expired_lease(p_source_system, p_logical_path);
END;
$$;

CREATE FUNCTION public.ingestion_finalize_run(
    p_run_id uuid,
    p_lease_token uuid,
    p_status text,
    p_counters jsonb,
    p_summary jsonb
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF p_status NOT IN ('succeeded', 'completed_with_errors', 'failed') THEN
        RAISE EXCEPTION 'Invalid terminal ingestion status: %', p_status;
    END IF;
    PERFORM public.ingestion_assert_run_lease(p_run_id, p_lease_token);

    UPDATE public.ingestion_runs
    SET status = p_status,
        finished_at = clock_timestamp(),
        rows_read = COALESCE((p_counters->>'rowsRead')::bigint, 0),
        rows_inserted = COALESCE((p_counters->>'rowsInserted')::bigint, 0),
        rows_updated = COALESCE((p_counters->>'rowsUpdated')::bigint, 0),
        rows_unchanged = COALESCE((p_counters->>'rowsUnchanged')::bigint, 0),
        rows_rejected = COALESCE((p_counters->>'rowsRejected')::bigint, 0),
        summary = COALESCE(p_summary, '{}'::jsonb)
    WHERE id = p_run_id
      AND status = 'running';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ingestion_run_not_running: run % cannot be finalized', p_run_id;
    END IF;

    DELETE FROM public.ingestion_run_leases
    WHERE ingestion_run_id = p_run_id
      AND lease_token = p_lease_token;
END;
$$;

CREATE FUNCTION public.ingestion_register_source_file(
    p_ingestion_run_id uuid,
    p_source_system text,
    p_logical_path text,
    p_content_sha256 text,
    p_format text,
    p_season_id uuid,
    p_row_count bigint,
    p_lease_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_source_file_id uuid;
    v_previous_status text;
    v_previous_summary jsonb;
    v_outcome text;
BEGIN
    PERFORM public.ingestion_assert_run_lease(p_ingestion_run_id, p_lease_token);

    SELECT ir.status, ir.summary
    INTO v_previous_status, v_previous_summary
    FROM public.source_files AS sf
    JOIN public.ingestion_runs AS ir ON ir.id = sf.ingestion_run_id
    WHERE sf.ingestion_run_id <> p_ingestion_run_id
      AND sf.source_system = p_source_system
      AND sf.logical_path = p_logical_path
      AND sf.content_sha256 = p_content_sha256
      AND ir.status = 'succeeded'
    ORDER BY sf.loaded_at DESC, sf.id DESC
    LIMIT 1;

    SELECT sf.id
    INTO v_source_file_id
    FROM public.source_files AS sf
    WHERE sf.ingestion_run_id = p_ingestion_run_id
      AND sf.source_system = p_source_system
      AND sf.logical_path = p_logical_path
      AND sf.content_sha256 = p_content_sha256;

    IF FOUND THEN
        v_outcome := 'unchanged';
    ELSE
        INSERT INTO public.source_files (
            ingestion_run_id, source_system, logical_path, content_sha256,
            format, season_id, row_count
        )
        VALUES (
            p_ingestion_run_id, p_source_system, p_logical_path, p_content_sha256,
            p_format, p_season_id, p_row_count
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

CREATE FUNCTION public.ingestion_ensure_season(
    p_season_key text,
    p_label text,
    p_source_season_year smallint,
    p_ingestion_run_id uuid,
    p_lease_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_season_id uuid;
    v_existing_label text;
    v_existing_year smallint;
    v_outcome text;
BEGIN
    PERFORM public.ingestion_assert_run_lease(p_ingestion_run_id, p_lease_token);
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
    ELSIF ROW(v_existing_label, v_existing_year)
          IS DISTINCT FROM ROW(p_label, p_source_season_year) THEN
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

CREATE FUNCTION public.ingestion_ensure_team_alias(
    p_team_key text,
    p_canonical_name text,
    p_source_system text,
    p_alias text,
    p_alias_normalized text,
    p_ingestion_run_id uuid,
    p_lease_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_team_id uuid;
    v_existing_team_id uuid;
    v_existing_canonical_name text;
    v_team_key_id uuid;
    v_canonical_name_id uuid;
    v_outcome text;
BEGIN
    PERFORM public.ingestion_assert_run_lease(p_ingestion_run_id, p_lease_token);
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
    SELECT id INTO v_canonical_name_id
    FROM public.teams WHERE canonical_name = p_canonical_name FOR UPDATE;
    IF v_team_key_id IS NOT NULL AND v_canonical_name_id IS NOT NULL
       AND v_team_key_id <> v_canonical_name_id THEN
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
            WHERE id = v_team_id
              AND team_key = p_team_key
              AND canonical_name = p_canonical_name
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

CREATE FUNCTION public.ingestion_enforce_source_file_lease()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW.source_file_id IS NOT NULL THEN
        PERFORM public.ingestion_assert_active_run(
            (SELECT sf.ingestion_run_id
             FROM public.source_files AS sf
             WHERE sf.id = NEW.source_file_id)
        );
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION public.ingestion_enforce_source_run_lease()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    PERFORM public.ingestion_assert_active_run(NEW.ingestion_run_id);
    RETURN NEW;
END;
$$;

CREATE FUNCTION public.ingestion_enforce_fielder_lease()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_run_id uuid;
BEGIN
    SELECT sf.ingestion_run_id
    INTO v_run_id
    FROM public.dismissals AS d
    JOIN public.deliveries AS de ON de.id = d.delivery_id
    JOIN public.source_files AS sf ON sf.id = de.source_file_id
    WHERE d.id = NEW.dismissal_id;
    IF FOUND THEN
        PERFORM public.ingestion_assert_active_run(v_run_id);
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER source_files_require_active_lease
    BEFORE INSERT OR UPDATE OF ingestion_run_id ON public.source_files
    FOR EACH ROW EXECUTE FUNCTION public.ingestion_enforce_source_run_lease();

CREATE TRIGGER ingestion_issues_require_active_lease
    BEFORE INSERT OR UPDATE ON public.ingestion_issues
    FOR EACH ROW EXECUTE FUNCTION public.ingestion_enforce_source_run_lease();

CREATE TRIGGER match_source_keys_require_active_lease
    BEFORE INSERT OR UPDATE OF source_file_id ON public.match_source_keys
    FOR EACH ROW EXECUTE FUNCTION public.ingestion_enforce_source_file_lease();

CREATE TRIGGER match_innings_require_active_lease
    BEFORE INSERT OR UPDATE OF source_file_id ON public.match_innings
    FOR EACH ROW EXECUTE FUNCTION public.ingestion_enforce_source_file_lease();

CREATE TRIGGER deliveries_require_active_lease
    BEFORE INSERT OR UPDATE OF source_file_id ON public.deliveries
    FOR EACH ROW EXECUTE FUNCTION public.ingestion_enforce_source_file_lease();

CREATE TRIGGER dismissals_require_active_lease
    BEFORE INSERT OR UPDATE OF source_file_id ON public.dismissals
    FOR EACH ROW EXECUTE FUNCTION public.ingestion_enforce_source_file_lease();

CREATE TRIGGER player_season_teams_require_active_lease
    BEFORE INSERT OR UPDATE OF source_file_id ON public.player_season_teams
    FOR EACH ROW EXECUTE FUNCTION public.ingestion_enforce_source_file_lease();

CREATE TRIGGER team_standings_require_active_lease
    BEFORE INSERT OR UPDATE OF source_file_id ON public.team_standings_snapshots
    FOR EACH ROW EXECUTE FUNCTION public.ingestion_enforce_source_file_lease();

CREATE TRIGGER dismissal_fielders_require_active_lease
    BEFORE INSERT OR UPDATE OF dismissal_id ON public.dismissal_fielders
    FOR EACH ROW EXECUTE FUNCTION public.ingestion_enforce_fielder_lease();

REVOKE ALL ON FUNCTION public.ingestion_assert_run_lease(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ingestion_assert_active_run(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ingestion_recover_expired_lease(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ingestion_acquire_run_lock(text, text, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ingestion_renew_run_lease(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ingestion_expire_stale_runs(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ingestion_finalize_run(uuid, uuid, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ingestion_register_source_file(uuid, text, text, text, text, uuid, bigint, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ingestion_ensure_season(text, text, smallint, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ingestion_ensure_team_alias(text, text, text, text, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ingestion_enforce_source_file_lease() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ingestion_enforce_source_run_lease() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ingestion_enforce_fielder_lease() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.ingestion_assert_run_lease(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ingestion_assert_active_run(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ingestion_recover_expired_lease(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.ingestion_acquire_run_lock(text, text, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.ingestion_renew_run_lease(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.ingestion_expire_stale_runs(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.ingestion_finalize_run(uuid, uuid, text, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.ingestion_register_source_file(uuid, text, text, text, text, uuid, bigint, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ingestion_ensure_season(text, text, smallint, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ingestion_ensure_team_alias(text, text, text, text, text, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ingestion_enforce_source_file_lease() TO service_role;
GRANT EXECUTE ON FUNCTION public.ingestion_enforce_source_run_lease() TO service_role;
GRANT EXECUTE ON FUNCTION public.ingestion_enforce_fielder_lease() TO service_role;

COMMENT ON TABLE public.ingestion_run_leases IS
    'Durable per-source ingestion leases. A primary key on source_system/logical_path prevents duplicate active leases; expired leases are recovered only for their source.';
COMMENT ON FUNCTION public.ingestion_acquire_run_lock(text, text, text, text, integer) IS
    'Creates a running ingestion run and durable source lease in one transaction. The lease survives the RPC transaction and is protected by a unique source key.';
COMMENT ON FUNCTION public.ingestion_renew_run_lease(uuid, uuid, integer) IS
    'Renews an unexpired lease only for its owning run and fencing token.';
COMMENT ON FUNCTION public.ingestion_expire_stale_runs(text, text) IS
    'Expires only a lease that has passed expires_at for the specified source system and logical path.';
COMMENT ON FUNCTION public.ingestion_finalize_run(uuid, uuid, text, jsonb, jsonb) IS
    'Finalizes an owned run and releases its lease atomically; expired or superseded workers cannot finalize.';

COMMIT;