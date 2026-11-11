# Ingestion worker

The ingestion worker is an offline backend job. It reads the consolidated
delivery CSV and the match-feed CSV, writes only through the existing
server-side Supabase client, and does not add HTTP routes or modify source
datasets.

## Source seasons and identifiers

The observed CSV `season` values are source years, not canonical season keys:

| CLI selection | Source `season` values | Canonical season |
|---|---|---|
| `2024` or `2024/25` | `2024` | `2024/25` |
| `2025` or `2025/26` | `2025` | `2025/26` |
| `all` | `2024`, `2025` | both seasons above |

The 2024 match-feed IDs map directly to delivery match numbers. The 2025
match-feed uses an observed +32 offset; match-feed ID `42` is duplicated and
ID `43` is absent, so delivery match numbers 10 and 11 are retained as
unresolved crosswalk issues rather than guessed. Crosswalk candidates are
also checked against the source team pair.

CSV physical row numbers, source match IDs, delivery labels, source file hashes,
and relative logical file paths are retained for audit. Delivery sequence is
the one-based source-row order within the canonical match and innings; repeated
`ball_over` labels remain separate deliveries.

Delivery identity in the database is `(match_id, innings_no, delivery_no)`.
Changed file content gets a different source-file identity, while the
delivery upsert reuses that canonical sequence and refreshes source provenance.
There is no deletion reconciliation: if source rows are removed, old canonical
deliveries are not deleted. Since sequence numbers are assigned from source-row
order, removing a row can also shift later deliveries onto existing sequence
keys, updating those rows and leaving the old tail intact. Do not treat changed
files with removed rows as a clean replacement until an explicit reconciliation
policy is approved.

## Identity and persistence behavior

- Team names resolve through configured canonical team aliases and
  source-specific database aliases. Team creation and alias persistence occur
  together in `ingestion_ensure_team_alias`; conflicting alias assignments are
  rejected.
- Player aliases are lookup-only during ingestion. A missing or ambiguous
  player remains a raw name with a review issue and a nullable canonical FK.
  The worker does not create players or aliases automatically. Reviewed aliases
  can be added through the repository's explicit reviewed-alias operation.
- Match metadata and its primary match-feed source key are persisted together
  by `ingestion_persist_match`. Delivery batches atomically upsert innings and
  ordered deliveries, reconcile dismissals, and replace fielder attributions
  through `ingestion_persist_delivery_batch`.
- A uniquely unresolved source key can be promoted on a retry after the identity
  or persistence issue is resolved. Duplicate source-key candidates remain
  blocked and require explicit reconciliation.
- Source-file registration hashes file bytes and reconciles by source system,
  relative logical path, and SHA-256. An unchanged file from a successful run
  is skipped for already processed canonical seasons. A changed file receives
  a new source-file identity. Existing duplicate metadata is surfaced instead
  of silently selecting one row.
- Repository outcomes are `inserted`, `updated`, `unchanged`, or `rejected`.
  The report counters use only these returned outcomes. A failed atomic batch
  is counted as failed for every source record in that batch; retry uses the
  same match/innings/delivery keys.

The `source_files.ingestion_run_id` column points at the most recently
registered run for that content/path identity, rather than maintaining a
many-run file history. Ingestion runs and issues remain separate audit records.
The delivery-source crosswalk is a separate database request from the match
row, but deliveries are not submitted unless that mapping succeeds. A full
replay/versioned-reconciliation workflow for deletions from changed input is
not implemented; this worker updates/reuses known canonical keys and preserves
prior facts not present in the new file.

## Fielder source format

The consolidated CSV currently has 614 non-empty `fielders` values. In the
inspected source, 571 contain no delimiter and 43 contain `/`; no semicolon or
pipe delimiters were observed. Slash-separated values are retained as one raw
fielder name because the source format does not establish that slash
unambiguously separates people. The parser supports `;` and `|` separators,
but does not split `/`. Ambiguous attribution is not converted into multiple
canonical players.

## Running and validating

From `NPL-Backend/`:

```sh
npm run ingest:inspect
npm run ingest:validate -- 2024/25
npm run ingest:dry-run -- all
npm run ingest:season -- 2024/25
npm run ingest:all
```

Generated reports are written under `.ingestion/`, which is ignored by Git.
Report paths are relative logical paths; they do not include local absolute
paths. A dry run performs no database writes and checks the static match
crosswalk, but cannot verify database-backed aliases; reports mark this with
`identityResolutionPerformed: false`.

## Verification status (2026-11-11)

Inspected the base commit `26662d8e2c1f346c923d7408bf29f0778d4d8b8b`.
The current worktree also contains a targeted fix for a team-alias RPC rejection
that legitimately omits the canonical `id`.

- `npm run typecheck` — passed.
- `npm run build` — passed.
- `npm test` — passed, 24 tests. These are unit and mocked repository tests;
  they are not PostgreSQL integration tests.
- Static review compared these TypeScript RPC callers with the SQL signatures:

  | Function | SQL arguments | JSON result |
  |---|---|---|
  | `ingestion_ensure_season` | `p_season_key text`, `p_label text`, `p_source_season_year smallint` | Object with `id`, `outcome` |
  | `ingestion_ensure_team_alias` | `p_team_key text`, `p_canonical_name text`, `p_source_system text`, `p_alias text`, `p_alias_normalized text` | Object with `outcome`; rejected results may omit `id` and `canonical_name` |
  | `ingestion_register_source_file` | `p_ingestion_run_id uuid`, `p_source_system text`, `p_logical_path text`, `p_content_sha256 text`, `p_format text`, `p_season_id uuid`, `p_row_count bigint` | Object with `id`, `outcome`, nullable `previousRunStatus` and `previousSummary` |
  | `ingestion_persist_match` | `p_match jsonb`, `p_source_key jsonb` | Object with `id`, `outcome` |
  | `ingestion_persist_delivery_batch` | `p_records jsonb` | Array of objects with `id`, `outcome` |

  The team-alias caller now handles the SQL rejection shape without an ID, with
  a regression test. Nullable delivery identity and raw source fields are
  covered by mocked tests. Runtime argument decoding, returned values,
  permissions, and transaction behavior remain unverified.

Database verification is blocked in the current environment. Docker is not
running, `supabase status` cannot inspect the local stack, and
`npx --yes supabase db lint --local` could not connect to PostgreSQL at
`127.0.0.1:54322` (`ECONNREFUSED`). No migration was applied, no database was
reset, and no hosted project was contacted. The migrations define 16 canonical
tables, but their existence and constraints have not been verified in a live
database. The synthetic ingestion, PostgreSQL relationship, idempotency,
changed-file, rollback, and retry fixtures have not been run.

Before attempting database verification, create or confirm an isolated,
disposable local Supabase project. Do not use `db reset` against any local
project that may contain data; it is destructive. In the disposable project,
start Supabase, apply the ordered migrations, run `db lint`, and verify the
catalog and RPC behavior before attempting synthetic ingestion fixtures.

## Interrupted ingestion runs

There is no heartbeat, stale-run detector, or automatic recovery job. A forced
process interruption can leave an `ingestion_runs` row with `status = 'running'`
and no `finished_at`. Operators can identify candidates by querying running
rows and their `started_at`, then confirm the worker is no longer active and
inspect its issues/source records before manually reconciling the run. Do not
mark a run failed based on age alone. A retry should use the same source
identities and rely on the repository's idempotent upserts; database retry
behavior has not yet been verified.

Do not point ingestion at hosted Supabase until separately authorized. Phase 2
is not verified or approved for a controlled full import until migrations,
RPCs, relationships, transaction rollback, idempotency, and retry behavior pass
against disposable local PostgreSQL.

## Known limitations

- This worker persists seasons, configured teams and aliases, matches and
  source keys, innings, deliveries, dismissals, and fielder attributions.
  It does not import reviewed player rosters, create player entities, persist
  `player_season_teams`, or import standings/source-file contents.
- Unknown player names remain unresolved. Existing reviewed `player_aliases`
  must be loaded separately before those player foreign keys can resolve.
- Deleted source rows are not reconciled or removed from canonical tables.
- Stale `running` jobs require manual identification and reconciliation.
- No local database execution, successful migration validation, PostgreSQL
  integration test, or hosted verification has been completed. Do not treat
  successful TypeScript checks or mocked tests as database readiness.
