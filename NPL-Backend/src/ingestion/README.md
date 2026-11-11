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

Before a real run, apply the migrations only to a disposable local Supabase
stack after Docker is available:

```sh
npx supabase start
npx supabase db reset
npx supabase migration list
```

Do not point ingestion at hosted Supabase until separately authorized. As of
this implementation, Docker's daemon was unavailable, so no migration or RPC
has been verified against local PostgreSQL or hosted Supabase. The backend
unit tests exercise orchestration and mocked repository outcomes only.

## Known limitations

- This worker persists seasons, configured teams and aliases, matches and
  source keys, innings, deliveries, dismissals, and fielder attributions.
  It does not import reviewed player rosters, create player entities, persist
  `player_season_teams`, or import standings/source-file contents.
- Unknown player names remain unresolved. Existing reviewed `player_aliases`
  must be loaded separately before those player foreign keys can resolve.
- No local database execution, migration validation, database integration
  test, or hosted verification has been completed. Do not treat successful
  TypeScript checks or mocked tests as database readiness.
