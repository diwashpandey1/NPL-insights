# Supabase database

This directory contains the versioned PostgreSQL foundation for NPL Insights.
It defines canonical cricket entities, source provenance, match/innings/delivery
facts, dismissal attribution, and official standings snapshots. Batting,
bowling, fielding, innings, team, and head-to-head statistics remain derived
queries/views; this foundation does not import cricket data or create sample
records.

The backend's Supabase client remains server-side and optional. The offline
ingestion worker uses that existing client and canonical schema; it does not
add API routes or modify source datasets.

## Migration order

Apply the timestamped files in filename order:

1. `migrations/20261111112534_create_core_entities.sql` — seasons, teams,
   aliases, and players.
2. `migrations/20261111112539_create_ingestion_provenance.sql` — ingestion
   runs, source files, and issues.
3. `migrations/20261111112543_create_matches_and_rosters.sql` — season-team
   affiliations, matches, source-key crosswalks, and innings.
4. `migrations/20261111112548_create_deliveries_and_dismissals.sql` —
   deliveries, dismissals, and fielder attributions.
5. `migrations/20261111112553_create_standings.sql` — standings snapshots.
6. `migrations/20261111112558_add_analytics_indexes_and_rls.sql` — workload
   indexes, RLS, and role grants.
7. `migrations/20261111142559_ingestion_atomic_persistence.sql` — service-role
   RPCs for season/team-alias ensure, source-file hash reconciliation, atomic
   match/source-key persistence, and atomic innings/delivery/dismissal/fielder
   batches.
8. `migrations/20261111160000_ingestion_advisory_locks.sql` — initial
   transaction-scoped lock implementation; retained as migration history and
   superseded by the later forward migrations.
9. `migrations/20261111170000_ingestion_concurrent_lock.sql` — replaces the
   initial acquisition RPC but still protects only its transaction; its
   obsolete advisory-lock helpers are removed by the lease migration.
10. `migrations/20261111194019_ingestion_run_leases.sql` — durable per-source
    leases, heartbeat renewal, source-scoped expiry recovery, fencing triggers,
    immutable per-run source-file provenance, and service-role-only functions.

Migrations are tracked by Supabase's migration history. Do not edit an
already-applied migration; create a new migration for subsequent schema
changes.

## Prerequisites

- Supabase CLI compatible with the project's configuration.
- Docker Desktop/Engine running for the local Supabase stack.
- PostgreSQL 17 for local validation, as set in `config.toml`.
- A hosted Supabase project only if a later deployment is explicitly approved.

No Supabase project credentials are stored in this directory. The local
`project_id` in `config.toml` is only a CLI workspace identifier, not a hosted
project reference. The CLI v3 defaults database operations to the local stack;
hosted targets must be explicitly selected.

This workspace is already initialized: `supabase/config.toml` is present.
Do not run `supabase init` again here. For a different workspace, run
`supabase init` once; this creates local CLI configuration but does not create
or link a hosted Supabase project.

## Local development and applying migrations

From `NPL-Backend/`, start the local stack if needed, then apply pending
migrations without resetting existing local data:

```sh
supabase start
supabase migration up
supabase migration list
supabase db lint
```

`supabase db reset` is destructive. Do not use it unless you have confirmed
that the local database contains no user data that must be preserved.
Seeding is disabled; there is no `seed.sql` and no fabricated cricket data.
Use `supabase status` to view local service URLs and connection information.

All ten migrations have been applied and exercised against the local stack in
this workspace. No hosted project was linked or modified. The forward lease
migration preserves the previous 16 canonical tables and adds one private
operational table, `ingestion_run_leases`, bringing the public table count to
17.
Local `auto_expose_new_tables` is disabled in `config.toml`, so future local
tables require explicit grants. This local setting does not change a hosted
project's Data API defaults; review those separately before deployment.

## Linking and hosted deployment

Only link a hosted project after its owner has approved the target and the
migration plan. Authenticate using the CLI's secure flow and an appropriately
scoped token; never place tokens, database passwords, or service-role keys in
this repository or a frontend environment file.

```sh
supabase link --project-ref <approved-project-ref>
supabase db push --dry-run --remote
```

Review the dry-run output and the target project's existing schema/history.
Only after explicit approval should the migrations be applied:

```sh
supabase db push --remote
```

CLI v3 requires explicit remote selection and confirms hosted changes. Do not
add `--yes` unless a separately reviewed deployment process requires it. This
document does not authorize or claim a hosted migration.

## Verify tables, constraints, indexes, grants, and RLS

After a local reset or an approved deployment, run these queries in the local
database/Studio SQL editor or a trusted `psql` session:

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE'
ORDER BY table_name;

SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
FROM pg_class AS c
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname IN (
    'seasons', 'teams', 'team_aliases', 'players', 'player_aliases',
    'player_season_teams', 'matches', 'match_source_keys', 'match_innings',
    'deliveries', 'dismissals', 'dismissal_fielders', 'ingestion_runs',
    'ingestion_run_leases',
    'source_files', 'ingestion_issues', 'team_standings_snapshots'
  )
ORDER BY c.relname;

SELECT tablename, policyname, roles, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'seasons', 'teams', 'team_aliases', 'players', 'player_aliases',
    'player_season_teams', 'matches', 'match_source_keys', 'match_innings',
    'deliveries', 'dismissals', 'dismissal_fielders', 'ingestion_runs',
    'ingestion_run_leases',
    'source_files', 'ingestion_issues', 'team_standings_snapshots'
  )
ORDER BY tablename, policyname;

SELECT conrelid::regclass AS table_name, conname, contype
FROM pg_constraint
WHERE connamespace = 'public'::regnamespace
ORDER BY conrelid::regclass::text, conname;

SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN (
    'seasons', 'teams', 'team_aliases', 'players', 'player_aliases',
    'player_season_teams', 'matches', 'match_source_keys', 'match_innings',
    'deliveries', 'dismissals', 'dismissal_fielders', 'ingestion_runs',
    'ingestion_run_leases',
    'source_files', 'ingestion_issues', 'team_standings_snapshots'
  )
ORDER BY tablename, indexname;

SELECT table_name,
       has_table_privilege('anon', format('public.%I', table_name), 'SELECT')
           AS anon_can_select,
       has_table_privilege('anon', format('public.%I', table_name), 'INSERT')
           AS anon_can_insert,
       has_table_privilege('anon', format('public.%I', table_name), 'UPDATE')
           AS anon_can_update,
       has_table_privilege('anon', format('public.%I', table_name), 'DELETE')
           AS anon_can_delete,
       has_table_privilege('authenticated', format('public.%I', table_name), 'SELECT')
           AS authenticated_can_select,
       has_table_privilege('authenticated', format('public.%I', table_name), 'INSERT')
           AS authenticated_can_insert,
       has_table_privilege('authenticated', format('public.%I', table_name), 'UPDATE')
           AS authenticated_can_update,
       has_table_privilege('authenticated', format('public.%I', table_name), 'DELETE')
           AS authenticated_can_delete,
       has_table_privilege('service_role', format('public.%I', table_name), 'SELECT')
           AS service_role_can_select
FROM unnest(ARRAY[
  'seasons', 'teams', 'team_aliases', 'players', 'player_aliases',
  'player_season_teams', 'matches', 'match_source_keys', 'match_innings',
  'deliveries', 'dismissals', 'dismissal_fielders', 'ingestion_runs',
  'ingestion_run_leases',
  'source_files', 'ingestion_issues', 'team_standings_snapshots'
]) AS names(table_name)
ORDER BY table_name;

SELECT sequence_name,
       has_sequence_privilege('anon', format('public.%I', sequence_name), 'USAGE')
           AS anon_can_use,
       has_sequence_privilege('authenticated', format('public.%I', sequence_name), 'USAGE')
           AS authenticated_can_use,
       has_sequence_privilege('service_role', format('public.%I', sequence_name), 'USAGE')
           AS service_role_can_use
FROM unnest(ARRAY[
  'deliveries_id_seq', 'dismissals_id_seq', 'ingestion_issues_id_seq'
]) AS sequences(sequence_name)
ORDER BY sequence_name;
```

Expect all 17 tables to have RLS enabled and no policies. The constraint and
index queries should include the declared keys, checks, foreign keys, and
analytics/provenance indexes. Normal `anon` and `authenticated` roles should
have no table or identity-sequence privileges; `service_role` has access for
trusted backend operations.

## Security and RLS

RLS is enabled on every table. No policies are defined because public access and
end-user authorization requirements have not been approved. The migrations
revoke table and identity-sequence privileges from `PUBLIC`, `anon`, and
`authenticated`, and grant table privileges and required sequence access only
to `service_role`. `service_role` bypasses RLS, so its secret key must stay in
the backend/deployment environment and must never be shipped to the frontend.
Local automatic table exposure is disabled. Hosted Data API exposure/default
grants must be checked in that project's settings before migrations are
deployed.

Do not add a permissive policy just to make local tests pass. Any future direct
Data API access needs a separate review of grants, RLS policies, and exposed
objects. The Express backend is the intended access boundary for now.

The ingestion RPCs use `SECURITY INVOKER`, a fixed `search_path`, and explicit
execute grants only to `service_role`; they do not expose elevated SQL to
`anon` or `authenticated`. Atomicity of match/source-key and delivery/innings/
dismissal/fielder writes is provided by each RPC call's single PostgreSQL
statement transaction. Team-alias and season ensure operations are also
single-call RPCs. The whole ingestion run is not one database transaction:
atomicity is per RPC/batch. The delivery-source crosswalk is a separate REST
statement, but dependent delivery batches are not submitted if that mapping
fails.

The final migration uses a primary key on
`(source_system, logical_path)` and a unique run/token association in
`ingestion_run_leases`. Acquisition is atomic; the lease survives the RPC
transaction, and the worker renews it periodically. Completion and failure
finalize the run and delete its lease atomically. Recovery takes an explicit
source system and logical path and expires only rows whose `expires_at` has
passed. Token checks plus source-file/run fencing triggers prevent a recovered
worker from continuing canonical writes. The earlier acquisition migrations
used transaction locks and run age; those functions are dropped/replaced by
the forward lease migration.

No stable delivery identifier is present in the inspected CSV columns.
`ball_over` repeats for wides/no-balls and source row order is only a locator,
not proof that a corrected row is the same delivery. Therefore changed
delivery-file hashes are recorded as a blocking issue and are not written to
canonical deliveries; a reviewed correction workflow is not implemented.

## Future migration changes

1. Confirm the schema change and its data/backfill implications.
2. Generate a sequential file with `supabase migration new <description>`.
3. Write explicit SQL and review key dependencies, constraints, indexes,
   grants, and RLS behavior.
4. Apply with `supabase migration up` on the local stack, preserving existing
   data; use `supabase db reset` only after confirming that no local user data
   needs to be retained. Inspect the catalog and run relevant backend checks.
5. Review the remote dry run and obtain approval before hosted deployment.
6. Never rewrite a migration already applied to a shared or hosted database;
   add a forward migration instead.

For unresolved source identities, keep player references nullable and preserve
the raw value. A match source key with `resolution_status = 'ambiguous'` or
`'rejected'` has a null `match_id`; only reviewed `resolved` mappings require a
canonical match. No fuzzy player/team merge is performed by the database.
