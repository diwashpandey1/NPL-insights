BEGIN;

CREATE TABLE public.ingestion_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    status text NOT NULL DEFAULT 'running',
    pipeline_version text NOT NULL,
    source_set text NOT NULL,
    rows_read bigint NOT NULL DEFAULT 0,
    rows_inserted bigint NOT NULL DEFAULT 0,
    rows_updated bigint NOT NULL DEFAULT 0,
    rows_unchanged bigint NOT NULL DEFAULT 0,
    rows_rejected bigint NOT NULL DEFAULT 0,
    summary jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT ingestion_runs_status_check
        CHECK (status IN ('running', 'succeeded', 'completed_with_errors', 'failed')),
    CONSTRAINT ingestion_runs_pipeline_version_nonempty
        CHECK (btrim(pipeline_version) <> ''),
    CONSTRAINT ingestion_runs_source_set_nonempty
        CHECK (btrim(source_set) <> ''),
    CONSTRAINT ingestion_runs_counts_nonnegative
        CHECK (
            rows_read >= 0
            AND rows_inserted >= 0
            AND rows_updated >= 0
            AND rows_unchanged >= 0
            AND rows_rejected >= 0
        ),
    CONSTRAINT ingestion_runs_summary_object
        CHECK (jsonb_typeof(summary) = 'object'),
    CONSTRAINT ingestion_runs_finish_after_start
        CHECK (
            (finished_at IS NULL OR finished_at >= started_at)
            AND (status = 'running' OR finished_at IS NOT NULL)
        )
);

CREATE TABLE public.source_files (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ingestion_run_id uuid NOT NULL REFERENCES public.ingestion_runs (id),
    source_system text NOT NULL,
    logical_path text NOT NULL,
    content_sha256 char(64) NOT NULL,
    format text NOT NULL,
    season_id uuid REFERENCES public.seasons (id),
    row_count bigint,
    loaded_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT source_files_run_hash_unique
        UNIQUE (ingestion_run_id, source_system, content_sha256),
    CONSTRAINT source_files_source_system_nonempty
        CHECK (btrim(source_system) <> ''),
    CONSTRAINT source_files_logical_path_nonempty
        CHECK (btrim(logical_path) <> ''),
    CONSTRAINT source_files_sha256_check
        CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT source_files_format_nonempty CHECK (btrim(format) <> ''),
    CONSTRAINT source_files_row_count_nonnegative
        CHECK (row_count IS NULL OR row_count >= 0)
);

CREATE TABLE public.ingestion_issues (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ingestion_run_id uuid NOT NULL REFERENCES public.ingestion_runs (id),
    source_file_id uuid REFERENCES public.source_files (id),
    source_row_number bigint,
    entity_name text,
    source_key text,
    severity text NOT NULL,
    issue_code text NOT NULL,
    column_name text,
    message text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ingestion_issues_source_row_positive
        CHECK (source_row_number IS NULL OR source_row_number > 0),
    CONSTRAINT ingestion_issues_severity_check
        CHECK (severity IN ('warning', 'error', 'blocking')),
    CONSTRAINT ingestion_issues_issue_code_nonempty
        CHECK (btrim(issue_code) <> ''),
    CONSTRAINT ingestion_issues_message_nonempty
        CHECK (btrim(message) <> '')
);

COMMIT;