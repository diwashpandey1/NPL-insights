# NPL analysis methodology

## Inputs and execution

Run from the project root:

```powershell
python -m analysis.run_all
```

`analysis/common.py` calls the shared `data_provider.load_npl_datasets()` loader for the processed delivery feed and match table. The runner writes only derived CSVs under `outputs/`; it does not rewrite source data or preprocessing outputs. It creates a CSV only when there are rows for that calculation. All CSV writes use `index=False`.

Primary inputs:

- `data/processed/combined/merged_npl_2024_2025.csv` for delivery and player aggregates.
- `data/raw/source/csv_data/NPL-matches.csv` for match results, venue, toss, margins, and player of the match.
- `data/raw/source/json_data/2024_points_table.json` and `2025_points_table.json` for official recorded points and NRR. Values are not recomputed.

Alternative raw/source-repository data is not blended into the main feed. Cricsheet contains 32 matches each from 2024 and 2025 and 12 matches dated 2026. The first two seasons overlap the combined feed. The 2026 set is partial and remains separate from 2024–2025 reporting.

## Cricket calculation rules

### Batting

- Personal runs are the sum of `batsman_runs`; extras are excluded.
- Fours and sixes count deliveries with `batsman_runs == 4` and `batsman_runs == 6` respectively.
- Batter balls faced exclude wides and include no-balls. Strike rate is `100 × batter_runs / balls_faced`.
- Batting average is `batter_runs / dismissals`. `retired hurt` is treated as not dismissed for the average denominator.
- A batter innings is identified by match, season, innings, batting team, and batter. Innings not represented by a delivery cannot be identified.
- Dot balls faced count non-wide deliveries with zero batter runs. Dot balls bowled use zero total runs on the delivery.
- T20 phases use over indices 0–5 for powerplay, 6–14 for middle, and 15–19 for death. These are fixed descriptive phases, not adjusted for shortened innings.
- Fastest 50/100 uses the first row in source order where that batter's cumulative innings runs reach the threshold, then counts batter-facing balls to that row. Source order is monotonic by over notation within every match/innings; repeated over-ball labels remain in their original order.

### Bowling

- Bowler runs conceded are `batsman_runs + wide_runs + noball_runs`. Byes and leg-byes are not charged to the bowler.
- Legal balls exclude a delivery when `wide_runs > 0` or `noball_runs > 0`.
- Overs are displayed as completed legal overs plus remaining legal balls (for example, 54.5), while economy uses `runs_conceded / (legal_balls / 6)`.
- Credited bowler dismissals are caught, bowled, lbw, stumped, caught-and-bowled, and hit wicket. Run-outs and retired hurt are excluded.
- Bowling average is conceded runs / credited wickets; bowling strike rate is legal balls / credited wickets. A zero denominator is exported as blank.
- A maiden requires six legal balls and zero total runs in that over. This excludes overs where byes/leg-byes were scored.
- Bowling summaries are per match/innings bowler aggregate. No within-match spell intervals exist, so “spell” outputs mean the full recorded bowler stint in that innings.

### Extras, innings, teams and matches

- Extra categories remain separate. Delivery component validation confirms `extra_runs = wide_runs + bye_runs + legbye_runs + noball_runs` and `total_runs = batsman_runs + extra_runs` for every combined-feed row.
- Innings totals and phase totals sum `total_runs`; wickets lost exclude retired hurt. Innings run rate divides total runs by legal balls / 6.
- Match outcomes, scores, toss decisions, margins, venues, awards, and official points-table data are taken from their existing match/points sources. Ball-by-ball totals are not substituted for those match result fields.
- Head-to-head team pairs are sorted alphabetically before aggregation, so A-vs-B and B-vs-A share a pair key.
- Team aliases and case differences are not normalized beyond lowercasing in the processed delivery feed. Source team spelling differences remain visible and can split cross-source comparisons.
- A “successful chase” is a recorded win by the second-innings team with a positive wickets margin. The match table's team_1/team_2 batting-order convention was checked against delivery totals, with one conflicting 2025 match key left unmapped.

### Fielding

- Dismissed batter rows are counted once by dismissal kind; the same wicket is never multiplied by the number of fielder names.
- Fielder-level catch attribution includes only a single unambiguous recorded fielder. Multi-name strings are omitted from individual catch credits and preserved in the underlying source.
- Keeper statistics are not inferred from fielding position, team, or dismissal type because no keeper roster/role field is available.
- Run-out participant strings can contain multiple players; this runner does not divide a run-out credit between them.

### Descriptive advanced metrics

- Boundary contribution percentage = (4 × fours + 6 × sixes) / batter runs × 100.
- Dot-ball percentage and runs/wickets per over use observed delivery/over aggregates. Team progression is a chronological over aggregate; individual delivery momentum is not reconstructed.
- Batting consistency output reports innings count, mean and standard deviation of innings runs, plus coefficient of variation (`standard deviation / mean`). Bowling consistency reports mean and standard deviation of the recorded bowler-innings economy values. These are descriptive summaries, not official ratings; small samples are not filtered.
- Partnership output groups co-present striker/non-striker pairs within an innings; it does not claim partnership runs or partnership start/end because wickets, crossing, and sequence are not fully represented.
- No player-impact, bowling-impact, or team-index score is published: no agreed scoring formula or validation target exists.

## Source mapping and validation

- Ball `match_id` uses season-local `match_number`; match-table IDs are global (2025 records begin at 33). The runner crosswalks rows by season, batting order, team names (including the audited Kathmandu spelling alias), and innings totals. It resolves both records sharing 2025 ID 42 without changing either source ID.
- Match summary reconciliation found a one-run mismatch for 2024 local match 21 (ball feed second innings 104; match table 105). This match is linked by its unique season/team pair, and the two score values remain in their respective source-derived outputs.
- Kathmandu team spelling differs between match and delivery sources (`Gorkhas` / `Gurkhas`); no alias mapping is applied.
- 21 exact duplicate instances occur in the delivery feed, and 909 rows share an over-ball label with another row. Reused over-ball notation can be valid when wides/no-balls do not advance legal-ball count. With no delivery sequence ID, the runner preserves all rows and reports the data-quality counts rather than deduplicating.
- The existing `src/data_quality_assertions.py` completed 16/16 checks when run with UTF-8 console encoding. Its duplicate-label check explicitly treats repeated `(match_id, inning, ball_over)` labels as explainable when an extra exists; this is not a proof that every repeated or identical row is a unique delivery.
- The runner additionally exports `outputs/advanced/data_quality_summary.csv` with row counts, score-component reconciliation, duplicate-label observations, fielder ambiguity, and match metadata key issues.

## Known limitations and manual follow-up

1. Resolve the duplicate 2025 match-table ID and reconcile match 21's one-run score difference against authoritative scorecards.
2. Establish a canonical Kathmandu team alias mapping across sources before cross-source team comparison.
3. Obtain stable delivery sequence IDs if exact delivery chronology, partnership transitions, or ball-by-ball momentum is needed.
4. Add a verified player role/keeper roster and standardized multi-fielder attribution for keeper and fielding leaderboards.
5. Confirm competition-specific qualification thresholds for “best” average/economy/strike rate and sample-sensitive consistency tables.
6. Keep 2026 Cricsheet matches as a separately labeled partial season unless and until full-season coverage and source compatibility are established.
