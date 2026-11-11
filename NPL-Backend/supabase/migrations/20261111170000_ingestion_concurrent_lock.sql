
-- Replaces the stub advisory-lock functions with an atomic run-creation function
-- that provides reliable concurrent ingestion protection via a table-level check.
--
-- Strategy: ingestion_acquire_run_lock() atomically:
--   1. Serialises concurrent attempts via pg_advisory_xact_lock on the
--      (source_system, logical_path) composite key (transaction-scoped, so it is
--      released automatically at the end of the RPC call even under PostgREST's
--      per-request connection model — the advisory lock only needs to hold for
--      the duration of the check+insert, not for the entire ingestion run).
--   2. Expires stale 'running' runs for the same source file.
--   3. Checks whether a live 'running' run already occupies the slot.
--   4. Creates and returns a new 'running' run if the slot is free.
--
-- Why this works with PostgREST's connection pool: the advisory lock is
-- transaction-scoped (pg_advisory_xact_lock), so it is automatically released
-- when the RPC call's implicit transaction commits. This is sufficient because
-- all three steps (expire, check, insert) happen atomically within that single
-- transaction.

CREATE OR REPLACE FUNCTION public.ingestion_acquire_run_lock(
    p_source_system           text,
    p_logical_path            text,
    p_pipeline_version        text,
    p_source_set              text,
    p_stale_threshold_minutes integer DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_run_id  uuid;
    v_lock_key bigint;
BEGIN
    -- Serialise concurrent callers for the same (source_system, logical_path) pair.
    -- pg_advisory_xact_lock is transaction-scoped: it is released automatically
    -- when this function's implicit transaction commits, so there is no need for
    -- an explicit unlock call and no risk of a permanently-blocked pipeline.
    v_lock_key := hashtextextended(p_source_system || E'\x1f' || p_logical_path, 0);
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- Step 1: expire stale running runs for this source file so their "slots"
    -- are released before we check for active conflicts.
    UPDATE public.ingestion_runs
    SET status      = 'failed',
        finished_at = now(),
        summary     = jsonb_set(
                          COALESCE(summary, '{}'::jsonb),
                          '{staleness_expired}',
                          'true'::jsonb
                      )
    WHERE status = 'running'
      AND started_at < now() - (p_stale_threshold_minutes || ' minutes')::interval
      AND id IN (
          SELECT ir.id
          FROM public.ingestion_runs ir
          JOIN public.source_files sf ON sf.ingestion_run_id = ir.id
          WHERE sf.source_system = p_source_system
            AND sf.logical_path  = p_logical_path
      );

    -- Step 2: check for a live 'running' run on the same source file.
    IF EXISTS (
        SELECT 1
        FROM public.ingestion_runs ir
        JOIN public.source_files sf ON sf.ingestion_run_id = ir.id
        WHERE ir.status       = 'running'
          AND sf.source_system = p_source_system
          AND sf.logical_path  = p_logical_path
    ) THEN
        RAISE EXCEPTION 'concurrent_ingestion_conflict: an ingestion run for % (%) is already in progress',
            p_source_system, p_logical_path;
    END IF;

    -- Step 3: no conflict — create the new run.
    INSERT INTO public.ingestion_runs (
        pipeline_version,
        source_set,
        status,
        rows_read, rows_inserted, rows_updated, rows_unchanged, rows_rejected,
        summary
    )
    VALUES (
        p_pipeline_version,
        p_source_set,
        'running',
        0, 0, 0, 0, 0,
        '{}'::jsonb
    )
    RETURNING id INTO v_run_id;

    RETURN jsonb_build_object('id', v_run_id);
END;
$$;

COMMENT ON FUNCTION public.ingestion_acquire_run_lock(text, text, text, text, integer) IS
    'Atomically creates a new ingestion run if no live run already exists for the given '
    'source file. Expires stale running runs first. Raises concurrent_ingestion_conflict '
    'if a live run is detected. The advisory lock used internally is transaction-scoped '
    'so it is automatically released when the function returns — no explicit unlock needed.';

-- Drop the now-unused advisory lock helper stubs from the previous migration
-- (kept as no-ops so callers that may reference them fail gracefully).
CREATE OR REPLACE FUNCTION public.ingestion_try_acquire_lock(p_lock_key bigint)
RETURNS boolean
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
    SELECT pg_try_advisory_lock(p_lock_key);
$$;

CREATE OR REPLACE FUNCTION public.ingestion_release_lock(p_lock_key bigint)
RETURNS boolean
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
    SELECT pg_advisory_unlock(p_lock_key);
$$;
