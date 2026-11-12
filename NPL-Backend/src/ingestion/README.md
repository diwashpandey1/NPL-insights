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

The database key `(match_id, innings_no, delivery_no)` is the canonical
source-order position used to replay identical input; it is not a stable
delivery identifier supplied by the source. The inspected delivery CSV has no
reviewed stable row ID. `ball_over` repeats for legitimate wides, no-balls, and
other deliveries, and physical row order is only a locator. The worker
therefore blocks any changed delivery-file content before canonical writes,
records a blocking `delivery:source-identity-ambiguous` issue, and preserves
the previous canonical data. This includes same-count row replacements.
Additions, updates, and deletions cannot be safely reconciled until a human
review establishes trustworthy source identity/mapping and a correction
workflow is implemented. Do not infer identity from sequence position or
`(match_id, inning, ball_over)`.

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
  is skipped for already processed canonical seasons. Each run gets a new
  source-file provenance row; prior rows are not reassigned or overwritten.
  Any changed delivery-file hash is blocked and recorded as an issue before
  canonical match or delivery persistence. Existing duplicate metadata is
  surfaced instead of silently selecting one row.
- Repository outcomes are `inserted`, `updated`, `unchanged`, or `rejected`.
  The report counters use only these returned outcomes. A failed atomic batch
  is counted as failed for every source record in that batch; retry uses the
  same match/innings/delivery keys.

`source_files.ingestion_run_id` preserves the run that registered that
particular source version, maintaining per-run provenance history. Ingestion
runs and issues remain separate audit records. The delivery-source crosswalk
is a separate database request from the match row, but deliveries are not
submitted unless that mapping succeeds. A full
replay/versioned-reconciliation workflow for changed deliveries is not
implemented.

## Concurrency, leases, and recovery

The database lease is keyed by `(source_system, logical_path)` and owned by one
`ingestion_runs` row plus a unique token. A primary-key constraint prevents a
second active lease for the same source path; different paths are independent.
Acquisition and expiry recovery are serialized per source path, and the lease
persists after the acquisition RPC transaction ends.

The worker periodically renews its lease during ingestion. Renewal, release,
and protected writes validate the run/token and unexpired lease. Successful
completion and failure atomically update the run and release its lease.
Expired leases are recovered only for the requested source path; recovery
marks the abandoned run failed. Database fencing rejects a worker that
continues after its lease expires or is taken over. There is no global
age-based expiry operation or periodic global recovery job; a new acquisition
for that same source path performs expired-lease recovery.

The full ingestion run is not one transaction. Each persistence RPC/batch is
atomic, but commits from an earlier stage are not automatically rolled back if
a later unrelated stage fails. Changed delivery files are rejected before
canonical writes, and tests verify that this rejection leaves canonical
deliveries unchanged.

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

For real PostgreSQL integration tests, start the local Supabase stack and put
its local CLI URL and keys in `NPL-Backend/.env.local` as
`NPL_LOCAL_SUPABASE_URL`, `NPL_LOCAL_SUPABASE_ANON_KEY`, and
`NPL_LOCAL_SUPABASE_SERVICE_ROLE_KEY`. The integration runner resolves this
file from its own project-relative path, so it works from either the backend
directory or repository root. It never loads `.env`, rejects non-loopback
URLs before creating a client, and does not fall back to hosted credentials.
`npm run test:integration` exits with a `BLOCKED` status if the required local
environment is unavailable. The regular `npm test` suite marks database tests
skipped when those values are absent; that is not database verification.

Generated reports are written under `.ingestion/`, which is ignored by Git.
Report paths are relative logical paths; they do not include local absolute
paths. A dry run performs no database writes and checks the static match
crosswalk, but cannot verify database-backed aliases; reports mark this with
`identityResolutionPerformed: false`.

## Verification status (2026-11-11)

Verification for the lease and integrity changes:

- `npm run typecheck`, `npm run build`, and `npm test` passed from
  `NPL-Backend/`. The unit run reported 26 passed and six database tests
  skipped because `npm test` does not load `.env.local`.
- `npm run test:integration` passed twice: once invoked from the repository
  root and once from `NPL-Backend/`; each run reported 15 passed and zero
  skipped. This includes same-count blocking/canonical-state checks,
  provenance and idempotency, concurrent and independent source leases,
  success/failure release, renewal, expiry recovery/fencing, and a real worker
  heartbeat that runs longer than a one-second lease.
- `npx supabase migration list --local` reports all ten migrations applied.
  `npx supabase db lint --local` reports no schema errors.
- A local catalog/access check found 17 public tables with RLS enabled, no
  public policies, and service-role lease access only. Anonymous and
  authenticated roles cannot read the lease table or execute its acquisition
  RPC.
- After both integration runs, a local read-only cleanup check found zero
  marked synthetic runs, source files, or remaining leases. Older, explicitly
  test-marked fixtures from prior local executions were also removed; no
  database reset was used.

Local tests do not authorize a production import. Do not point ingestion at
hosted Supabase until separately authorized. Same-count and other changed
delivery-file corrections remain blocked pending source-level identity review
and an audited reconciliation design.

## Known limitations

- This worker persists seasons, configured teams and aliases, matches and
  source keys, innings, deliveries, dismissals, and fielder attributions.
  It does not import reviewed player rosters, create player entities, persist
  `player_season_teams`, or import standings/source-file contents.
- Unknown player names remain unresolved. Existing reviewed `player_aliases`
  must be loaded separately before those player foreign keys can resolve.
- Changed delivery files are blocked before canonical writes because source
  rows lack a reviewed stable identity. No safe correction workflow is
  available yet.
- Interrupted jobs recover after lease expiration when that source path is
  next acquired. There is no global expiry sweep; old workers are fenced from
  writes after expiry/takeover.
- No hosted database verification has been performed. Do not treat local
  synthetic test results as authorization for hosted ingestion.
