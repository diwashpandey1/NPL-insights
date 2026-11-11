
-- Concurrency protection for the ingestion pipeline.
--
-- Strategy: application-level locking via the ingestion_runs table.
-- Before starting a new ingestion run, the worker calls
-- ingestion_acquire_run_lock(), which atomically:
--   1. Expires any runs that have been 'running' longer than p_stale_threshold_minutes
--   2. Checks whether another 'running' run already exists for the same
--      (source_system, logical_path) pair
--   3. Creates and returns the new run if no conflict is found, or raises
--      a unique-conflict error if one is detected
--
-- This design works across PostgREST's HTTP connection pool because the entire
-- check+insert is a single serialised database transaction with a row-level lock.
-- It is safe against concurrent callers because the advisory_xact_lock on the
-- composite key serialises concurrent attempts.
--
-- Releasing: when a run is completed or failed, the status changes away from
-- 'running', which naturally allows the next worker to proceed.

CREATE OR REPLACE FUNCTION public.ingestion_acquire_run_lock(
    p_source_system        text,
    p_logical_path         text,
    p_pipeline_version     text,
    p_source_set           text,
    p_stale_threshold_minutes integer DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_run_id uuid;
    v_lock_key bigint;
BEGIN
    -- Serialise concurrent attempts for the same source file.
    v_lock_key := hashtextextended(p_source_system || E'\x1f' || p_logical_path, 0);
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- Expire stale running runs for this source file so their "locks" are cleared.
    UPDATE public.ingestion_runs
    SET status     = 'failed',
        finished_at = now(),
        summary    = jsonb_set(
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

    -- Check whether a live 'running' run already holds the slot.
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

    -- No conflict — create the new run.
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
    'Atomically creates a new ingestion run if no live run already exists for the given source file. '
    'First expires any stale (long-running) runs. Raises concurrent_ingestion_conflict if a live run is detected.';

-- Convenience function: expire globally stale running runs (not bound to a source file).
-- Returns the number of runs expired.
CREATE OR REPLACE FUNCTION public.ingestion_expire_stale_runs(
    p_stale_threshold_minutes integer DEFAULT 60
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_count integer;
BEGIN
    UPDATE public.ingestion_runs
    SET status      = 'failed',
        finished_at = now(),
        summary     = jsonb_set(
                          COALESCE(summary, '{}'::jsonb),
                          '{staleness_expired}',
                          'true'::jsonb
                      )
    WHERE status     = 'running'
      AND started_at < now() - (p_stale_threshold_minutes || ' minutes')::interval;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.ingestion_expire_stale_runs(integer) IS
    'Marks all running ingestion runs older than p_stale_threshold_minutes as failed. '
    'Used for global stale-lock recovery when a source file path is not known.';
