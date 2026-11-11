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
There is no deletion reconciliation. The worker now rejects a changed delivery
file whose total source row count is smaller than the most recently successful
version, before persisting match or delivery changes. This prevents isolated
tail and middle removals from shifting sequences or leaving stale tails, but
does not identify a removal compensated by a new row when the file's total row
count is unchanged. Treat such same-count replacements as ambiguous and do not
ingest them; a full import remains blocked until stable source-record identity
or an explicit reconciliation policy is implemented.

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
  a new source-file identity. Before registering a changed delivery file, the
  repository reads the last successful source hash and row count; a smaller
  changed file is failed and finalized before canonical writes. Existing
  duplicate metadata is surfaced instead of silently selecting one row.
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

For real PostgreSQL integration tests, start the disposable local Supabase
stack, then set `NPL_LOCAL_SUPABASE_URL`, `NPL_LOCAL_SUPABASE_ANON_KEY`, and
`NPL_LOCAL_SUPABASE_SERVICE_ROLE_KEY` from its local CLI status in the process
environment. Never use hosted project credentials. `npm run test:integration`
requires all three values, rejects non-loopback URLs, and exits with a
`BLOCKED` status if the environment is unavailable. The regular `npm test`
suite marks the database tests skipped when those values are absent; that is
not database verification.

Generated reports are written under `.ingestion/`, which is ignored by Git.
Report paths are relative logical paths; they do not include local absolute
paths. A dry run performs no database writes and checks the static match
crosswalk, but cannot verify database-backed aliases; reports mark this with
`identityResolutionPerformed: false`.

## Verification status (2026-11-11)

Verified against the disposable local Supabase stack at commit
`ec11d72dcf388ae4a50c0d120c8b0fb2d210aa85`. No hosted project was contacted.

- Seven versioned migrations are applied in order. `supabase migration list
  --local` reports each migration as applied; `supabase db lint --local`
  reports no schema errors.
- PostgreSQL catalog checks found 16 canonical tables, 16 primary keys,
  35 foreign keys, 11 unique constraints, 53 checks, and 62 indexes. RLS is
  enabled on all 16 tables. Service-role table grants and all five ingestion
  RPC grants were verified; the RPCs are invoker functions and are not
  executable by `anon` or `authenticated`.
- `npm run typecheck` and `npm run build` — passed.
- `npm test` — passed, 25 unit tests; the two PostgreSQL tests are skipped
  without local credentials.
- `npm run test:integration` without its required environment — correctly
  reports `BLOCKED` and exits nonzero. With loopback-only local credentials,
  it passed twice in separate executions (2/2 tests each): service-role
  persistence, source replay, delivery/dismissal/fielder changes, additions,
  tail and middle deletion blocking, source sequence stability, atomic batch
  rollback/retry, and anonymous/authenticated permission denials.
- Test teardown removed the fixture's source files, matches, deliveries,
  innings, dismissals, aliases, player/season fixtures, ingestion issues/runs,
  and temporary auth user. Post-run catalog queries found zero test-scoped
  rows. Legacy records from earlier unscoped test executions were inspected
  by their temporary fixture paths and removed from this disposable database.

The regular test suite's skipped database tests are not a pass. These local
integration results do not authorize a production import. A same-row-count
source replacement can conceal a deletion because the source has no stable
record identifier; such files remain ambiguous and must not be ingested until
a full reconciliation policy is implemented.

## Interrupted ingestion runs

There is no heartbeat, stale-run detector, or automatic recovery job. A forced
process interruption can leave an `ingestion_runs` row with `status = 'running'`
and no `finished_at`. Operators can identify candidates by querying running
rows and their `started_at`, then confirm the worker is no longer active and
inspect its issues/source records before manually reconciling the run. Do not
mark a run failed based on age alone. Atomic delivery batch rollback and safe
retry were exercised against local PostgreSQL; forced process interruption
and stale-run recovery automation remain untested and unimplemented.

Do not point ingestion at hosted Supabase until separately authorized. Phase 2
is not approved for a controlled full import until same-count deletion
ambiguity is resolved and stale-run recovery behavior is addressed.

## Known limitations

- This worker persists seasons, configured teams and aliases, matches and
  source keys, innings, deliveries, dismissals, and fielder attributions.
  It does not import reviewed player rosters, create player entities, persist
  `player_season_teams`, or import standings/source-file contents.
- Unknown player names remain unresolved. Existing reviewed `player_aliases`
  must be loaded separately before those player foreign keys can resolve.
- Deleted source rows are not reconciled or removed from canonical tables.
  Decreased-row-count delivery files are blocked before canonical writes;
  same-count replacements remain ambiguous.
- Stale `running` jobs require manual identification and reconciliation.
- No hosted database verification has been performed. Do not treat local
  synthetic test results as authorization for hosted ingestion.
