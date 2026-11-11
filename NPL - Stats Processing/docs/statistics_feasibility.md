# NPL statistics feasibility audit

## Scope and status counts

This audit covers the 195 requested statistics against the processed 2024–2025 delivery feed, the 64-row match table, and the season points-table JSON files. **AVAILABLE** means source fields support the calculation without inferring missing events; **DERIVABLE** means a stated transformation or aggregation is needed; **PARTIALLY AVAILABLE** means coverage or attribution limits can affect the result; **UNAVAILABLE** means a required field does not exist. These statuses describe feasibility, not whether every item has an output CSV.

| Status | Count |
|---|---:|
| AVAILABLE | 173 |
| DERIVABLE | 0 |
| PARTIALLY AVAILABLE | 20 |
| UNAVAILABLE | 2 |
| **Total identified** | **195** |

Unless a row says otherwise, a category's required fields, source, method, and limitations apply to each metric listed under it.

## Audited sources

| Source | Actual content and use |
|---|---|
| `data/processed/combined/merged_npl_2024_2025.csv` | 14,924 deliveries, 22 columns, 32 distinct match IDs and 64 innings in each season. Main source for delivery-derived metrics. |
| `data/raw/source/csv_data/NPL-matches.csv` | 64 match rows, 29 columns, season, score, result, venue, toss, player of match, and margin fields. Match metadata source. One 2025 `(season,id)` key is duplicated with conflicting teams; delivery crosswalk resolves the two rows using batting order, teams, and innings totals. |
| `data/raw/source/json_data/2024_points_table.json`, `2025_points_table.json` | Eight ranked teams per season with played, wins, losses, points, and NRR. Use as recorded; no points or NRR are reconstructed. Existing exports are in `outputs/points_table/`. |
| `data/raw/cricsheet/npl_json/*.json` | 32 match JSON files dated 2024, 32 dated 2025, and 12 dated 2026. 2024–2025 overlap the combined feed by season and are not added. The 2026 set is partial-season and not mixed into 2024–2025 outputs. |
| `data/raw/source/csv_data/NPL-2024.csv`, `NPL-2025.csv`, source-repository CSVs, 2025 summary CSVs, JSON/API snapshots | Alternate copies or summaries of existing seasons. Schemas differ in aliases and field coverage. They were not merged because overlap, provenance, and duplicate keys require source-specific reconciliation. |

## Common validation findings

- `total_runs == batsman_runs + extra_runs` for all 14,924 delivery rows; `extra_runs == wide_runs + bye_runs + legbye_runs + noball_runs` also holds for every row.
- The combined feed has 21 rows identical across all columns after the first occurrence. `ball_over` repeats, particularly around illegal deliveries, and there is no unique delivery sequence key. Exact-looking rows are retained; they are not automatically deduplicated.
- 909 rows share a `(match_id, inning, ball_over)` label with another row. This is not evidence of duplicate deliveries because illegal balls may reuse ball notation.
- Ball match IDs use season-local numbers; the match table uses global IDs (2025 starts at 33). A crosswalk uses season, batting order, normalized team names, and innings totals to reconcile records; it resolves the conflicting duplicate 2025 key without changing source IDs.
- Team spelling differs across sources (`Kathmandu Gorkhas` / `Kathmandu Gurkhas`). Names are not silently unified, so cross-source team joins can split that franchise.
- 43 dismissed deliveries name multiple fielders. Catch and run-out credits are not distributed across multiple names. Three dismissals are recorded as `retired hurt`; they are not treated as bowler wickets.
- Match table marks one super-over match. No DLS match is indicated. A one-run discrepancy remains between the ball feed and match table for 2024 local match 21. Regulations and full over-quota details are not independently encoded for recalculating official NRR.
- The combined file has no nulls in required identity, run, over, or season fields. Missing `player_out`, `dismissal_kind`, and `fielders` values mostly occur on ordinary deliveries and are expected.

## A. Batting statistics

**Required fields:** `batsman`, `batsman_runs`, `wide_runs`, `player_out`, `dismissal_kind`, `match_id`, `season`, `inning`, `ball_over`, `batting_team`, `bowling_team`. **Source:** combined delivery feed. **Method:** sum batter runs only; count fours/sixes only where batter runs equal 4/6; batting average is runs divided by dismissals; strike rate uses batter-facing deliveries (wides excluded); innings summaries group by match, innings, and player. **Limitations:** zero-ball appearances cannot be seen if a player never faced a delivery; reused over-ball notation means a per-ball sequence is not recoverable. Fastest milestones use recorded batter innings totals and facing-ball counts.

| Statistic | Status |
|---|---|
| Most runs by player | AVAILABLE |
| Most fours by player | AVAILABLE |
| Most sixes by player | AVAILABLE |
| Most boundaries by player | AVAILABLE |
| Highest individual score | AVAILABLE |
| Batting average | AVAILABLE |
| Batting strike rate | AVAILABLE |
| Most balls faced | AVAILABLE |
| Most innings played | PARTIALLY AVAILABLE — only innings with a recorded delivery for the batter are observable. |
| Most not-outs | AVAILABLE |
| Most ducks | AVAILABLE |
| Most half-centuries | AVAILABLE |
| Most centuries | AVAILABLE |
| Fastest half-century | AVAILABLE |
| Fastest century | AVAILABLE |
| Most runs in a single over | AVAILABLE |
| Most runs in a single innings | AVAILABLE |
| Most runs in a single match | AVAILABLE |
| Most runs in powerplay | AVAILABLE |
| Most runs in middle overs | AVAILABLE |
| Most runs in death overs | AVAILABLE |
| Most dot balls faced | AVAILABLE |
| Player-wise season comparison | AVAILABLE |
| Player-wise performance against each opponent | AVAILABLE |

## B. Boundary statistics

**Required fields:** `batsman`, `batting_team`, `bowling_team`, `batsman_runs`, `match_id`, `season`, `inning`, `ball_over`. **Source:** combined delivery feed. **Method:** boundary counts use batter runs exactly 4 or 6; phase totals group by delivery over; boundary percentage is boundary runs divided by batter runs; frequency is batter-facing balls per boundary. **Limitations:** individual batter event sequence within a repeated over-ball label is unavailable; over-level totals remain aggregatable using the integer over component.

| Statistic | Status |
|---|---|
| Most sixes by player | AVAILABLE |
| Most fours by player | AVAILABLE |
| Most sixes by innings | AVAILABLE |
| Most fours by innings | AVAILABLE |
| Most sixes by match | AVAILABLE |
| Most fours by match | AVAILABLE |
| Most sixes by team | AVAILABLE |
| Most fours by team | AVAILABLE |
| Most sixes in powerplay | AVAILABLE |
| Most sixes in middle overs | AVAILABLE |
| Most sixes in death overs | AVAILABLE |
| Most sixes in a single over | AVAILABLE |
| Most fours in a single over | AVAILABLE |
| Most boundaries in a single over | AVAILABLE |
| Highest boundary percentage by player | AVAILABLE |
| Highest six-hitting frequency | AVAILABLE |
| Highest four-hitting frequency | AVAILABLE |
| Season-wise sixes comparison | AVAILABLE |
| Season-wise fours comparison | AVAILABLE |
| Most sixes against a particular opponent | AVAILABLE |
| Most fours against a particular opponent | AVAILABLE |

## C. Bowling statistics

**Required fields:** `bowler`, `batsman_runs`, `wide_runs`, `noball_runs`, `bye_runs`, `legbye_runs`, `total_runs`, `player_out`, `dismissal_kind`, `match_id`, `season`, `inning`, `ball_over`, `batting_team`, `bowling_team`. **Source:** combined delivery feed. **Method:** bowler runs conceded = batter runs + wide runs + no-ball runs; byes and leg-byes are excluded. Legal balls exclude wides and no-balls. Wickets credited only for caught, bowled, lbw, stumped, caught-and-bowled, and hit wicket; run-outs and retired hurt are excluded. Economy = conceded runs / legal balls × 6; average = conceded runs / credited wickets; strike rate = legal balls / credited wickets. Maidens require six legal balls and zero total innings runs in that over. **Limitations:** spells are represented as a bowler's match/innings aggregate; no spell-break field exists.

| Statistic | Status |
|---|---|
| Most wickets by bowler | AVAILABLE |
| Best bowling figures | AVAILABLE |
| Best bowling average | AVAILABLE |
| Best economy rate | AVAILABLE |
| Best bowling strike rate | AVAILABLE |
| Most overs bowled | AVAILABLE |
| Most dot balls bowled | AVAILABLE |
| Most maiden overs | AVAILABLE |
| Most wickets in an innings | AVAILABLE |
| Most wickets in a match | AVAILABLE |
| Most wickets in a season | AVAILABLE |
| Most wickets in powerplay | AVAILABLE |
| Most wickets in middle overs | AVAILABLE |
| Most wickets in death overs | AVAILABLE |
| Most runs conceded | AVAILABLE |
| Most sixes conceded | AVAILABLE |
| Most fours conceded | AVAILABLE |
| Most boundaries conceded | AVAILABLE |
| Most wides bowled | AVAILABLE |
| Most no-balls bowled | AVAILABLE |
| Most extras conceded | AVAILABLE |
| Most runs conceded in a single over | AVAILABLE |
| Most expensive bowling spell | AVAILABLE |
| Most economical bowling spell | AVAILABLE |
| Bowler performance against each team | AVAILABLE |
| Season-wise bowling comparison | AVAILABLE |

## D. Extras statistics

**Required fields:** `bowler`, `batting_team`, `match_id`, `season`, `inning`, `wide_runs`, `noball_runs`, `bye_runs`, `legbye_runs`, `extra_runs`, `batsman_runs`, `total_runs`. **Source:** combined delivery feed. **Method:** count extra deliveries separately from extra runs; retain wides, no-balls, byes, and leg-byes as distinct categories; extras share = extras / team total. **Limitations:** delivery rows do not identify penalty runs outside the listed categories, but the component reconciliation passes for all rows.

| Statistic | Status |
|---|---|
| Most extras conceded by bowler | AVAILABLE |
| Most wide deliveries | AVAILABLE |
| Most wide runs | AVAILABLE |
| Most no-ball deliveries | AVAILABLE |
| Most no-ball extras | AVAILABLE |
| Most bye runs | AVAILABLE |
| Most leg-bye runs | AVAILABLE |
| Most extras conceded by team | AVAILABLE |
| Most extras in a match | AVAILABLE |
| Most extras in an innings | AVAILABLE |
| Season-wise extras comparison | AVAILABLE |
| Percentage of team runs contributed by extras | AVAILABLE |
| Wide vs no-ball comparison | AVAILABLE |
| Total extras vs runs scored off the bat | AVAILABLE |

## E. Fielding statistics

**Required fields:** `player_out`, `dismissal_kind`, `fielders`, `bowling_team`, `match_id`, `season`, `inning`. **Source:** combined delivery feed. **Method:** count each dismissed batter once; use recorded dismissal type and fielder string. **Limitations:** no player-role/keeper register; multiple fielder strings cannot be allocated fairly; some strings have encoding/name issues. Single-name fielder outputs exclude ambiguous multi-name rows.

| Statistic | Status |
|---|---|
| Most catches by player | PARTIALLY AVAILABLE — 43 dismissed deliveries list multiple fielders; some catch credit is ambiguous. |
| Most stumpings by wicketkeeper | UNAVAILABLE — no wicketkeeper role or keeper identity field. |
| Most run-outs by player | PARTIALLY AVAILABLE — multiple run-out participants are not attributed individually. |
| Most dismissals by fielder | PARTIALLY AVAILABLE — multiple names and non-fielder dismissal kinds limit attribution. |
| Most dismissals by wicketkeeper | UNAVAILABLE — no keeper identity field. |
| Most catches in a match | PARTIALLY AVAILABLE — catch type is known, fielder attribution can be ambiguous. |
| Most catches in a season | PARTIALLY AVAILABLE — catch type is known, fielder attribution can be ambiguous. |
| Most run-outs in a season | PARTIALLY AVAILABLE — two or more fielder names may be recorded together. |
| Caught-and-bowled dismissals | AVAILABLE |
| Team-wise fielding dismissals | AVAILABLE |
| Player-wise dismissal breakdown | PARTIALLY AVAILABLE — dismissal of batter is recorded, not a complete fielder credit record. |
| Season-wise fielding comparison | PARTIALLY AVAILABLE — same fielder-credit limitations apply. |

## F. Team statistics

**Required fields:** match table `season`, `team_1`, `team_2`, `winner`, `result`, `team_1_runs`, `team_2_runs`, `team_1_wickets`, `team_2_wickets`, `win_by_runs`, `win_by_wickets`; delivery fields `batting_team`, `bowling_team`, `total_runs`, `batsman_runs`, `extra_runs`, `player_out`, `is_four/is_six`, `phase`, `match_id`, `inning`. **Source:** match table for results/margins; delivery feed for player/team/phase sums; points-table JSON for official points and NRR. **Method:** one team-participation row per match and delivery aggregates by batting/bowling team. **Limitations:** tied results are not explicitly labeled in `result` (all rows say `normal`); source team aliases remain unchanged in output and can split cross-source team totals. The audited Kathmandu alias is normalized only for match-row linking.

| Statistic | Status |
|---|---|
| Matches played | AVAILABLE |
| Matches won | AVAILABLE |
| Matches lost | AVAILABLE |
| No-result matches | AVAILABLE |
| Tied matches | PARTIALLY AVAILABLE — super-over flag can indicate a tie-break, but original tie is not explicitly recorded. |
| Win percentage | AVAILABLE |
| Points table, where official points data is available | AVAILABLE — official source values exist in season JSON. |
| Net Run Rate, where sufficient valid innings data exists | PARTIALLY AVAILABLE — official season NRR is present, but independent recalculation rules/quota metadata are not fully encoded. |
| Highest team total | AVAILABLE |
| Lowest team total | AVAILABLE |
| Highest successful run chase | AVAILABLE |
| Biggest victory by runs | AVAILABLE |
| Biggest victory by wickets | AVAILABLE |
| Total runs scored by team | AVAILABLE |
| Total wickets taken by team | AVAILABLE |
| Most sixes by team | AVAILABLE |
| Most fours by team | AVAILABLE |
| Most extras conceded by team | AVAILABLE |
| Team-wise batting statistics | AVAILABLE |
| Team-wise bowling statistics | AVAILABLE |
| Successful run chases | AVAILABLE |
| Batting-first victories | AVAILABLE |
| Powerplay performance | AVAILABLE |
| Death-over performance | AVAILABLE |
| Season-wise team comparison | AVAILABLE |

## G. Match statistics

**Required fields:** match-table fields listed in F plus delivery `match_id`, `inning`, `batting_team`, `bowling_team`, `total_runs`, `extra_runs`, `player_out`, `batsman`, `batsman_runs`, `bowler`, `dismissal_kind`, `is_four/is_six`, `toss_winner`, `player_of_the_match`, `venue`. **Source:** match table plus combined delivery feed. **Method:** use recorded match results and contextual fields, and aggregate delivery records for boundaries, wickets, extras, individual scores, and bowling figures. **Limitations:** the duplicated 2025 match key is resolved for delivery context through the audited team/score crosswalk; over-ball order does not affect match aggregates.

| Statistic | Status |
|---|---|
| Highest match aggregate | AVAILABLE |
| Lowest match aggregate | AVAILABLE |
| Highest first-innings total | AVAILABLE |
| Highest second-innings total | AVAILABLE |
| Lowest first-innings total | AVAILABLE |
| Lowest second-innings total | AVAILABLE |
| Highest successful run chase | AVAILABLE |
| Biggest victory by runs | AVAILABLE |
| Biggest victory by wickets | AVAILABLE |
| Most sixes in a match | AVAILABLE |
| Most fours in a match | AVAILABLE |
| Most boundaries in a match | AVAILABLE |
| Most wickets in a match | AVAILABLE |
| Most extras in a match | AVAILABLE |
| Highest individual score in a match | AVAILABLE |
| Best bowling figures in a match | AVAILABLE |
| Player of the match frequency | AVAILABLE |
| Toss winner vs match winner | AVAILABLE |
| Batting first vs chasing success | AVAILABLE |
| Venue-wise match statistics | AVAILABLE |

## H. Innings statistics

**Required fields:** `match_id`, `season`, `inning`, `batting_team`, `bowling_team`, `total_runs`, `batsman_runs`, extras components, `player_out`, `is_four/is_six`, `ball_over`, `wide_runs`, `noball_runs`. **Source:** combined delivery feed. **Method:** aggregate by match/innings; legal-ball run rates exclude wides and no-balls; powerplay = overs 0–5, middle = 6–14, death = 15–19 (T20 notation). **Limitations:** phase ranges are descriptive 20-over ranges; shortened innings are not reclassified by a match-specific over quota.

| Statistic | Status |
|---|---|
| Highest innings total | AVAILABLE |
| Lowest innings total | AVAILABLE |
| Most sixes in an innings | AVAILABLE |
| Most fours in an innings | AVAILABLE |
| Most boundaries in an innings | AVAILABLE |
| Most wickets in an innings | AVAILABLE |
| Most extras in an innings | AVAILABLE |
| Highest powerplay score | AVAILABLE |
| Lowest powerplay score | AVAILABLE |
| Highest middle-over score | AVAILABLE |
| Highest death-over score | AVAILABLE |
| Highest innings run rate | AVAILABLE |
| Lowest innings run rate | AVAILABLE |
| Most runs in the final five overs | AVAILABLE |
| Most wickets in powerplay | AVAILABLE |
| Most wickets in death overs | AVAILABLE |
| Innings-wise scoring comparison | AVAILABLE |

## I. Head-to-head statistics

**Required fields:** match-table season/teams/winner/result/scores/margins plus delivery `match_id`, `batting_team`, `bowling_team`, `total_runs`, `is_four/is_six`, `batsman`, `bowler`, and dismissal fields. **Source:** match table and combined delivery feed. **Method:** sort each pair alphabetically to canonicalize A-vs-B and B-vs-A; group match results, season, score and player/bowler performances by opponent. **Limitations:** duplicate match metadata key is unresolved; team spelling variation can split records. “Most difficult opponent” requires a defined criterion.

| Statistic | Status |
|---|---|
| Overall matches between teams | AVAILABLE |
| Team A wins | AVAILABLE |
| Team B wins | AVAILABLE |
| Team A losses | AVAILABLE |
| Team B losses | AVAILABLE |
| Head-to-head win percentage | AVAILABLE |
| Highest score in a matchup | AVAILABLE |
| Lowest score in a matchup | AVAILABLE |
| Biggest winning margin | AVAILABLE |
| Most successful run chases | AVAILABLE |
| Most sixes in a matchup | AVAILABLE |
| Most fours in a matchup | AVAILABLE |
| Season-wise head-to-head records | AVAILABLE |
| Player performance against specific teams | AVAILABLE |
| Bowler performance against specific teams | AVAILABLE |
| Most difficult opponent for each team | PARTIALLY AVAILABLE — no objective definition (wins, margin, or expected strength) is specified. |

## J. Advanced analytics

**Required fields:** delivery batting/bowling/player/season/phase/match/innings fields, legal-delivery indicators and run components; match metadata for venue and chase context. **Source:** combined delivery feed and match table. **Method:** contribution and dot percentages use aggregate denominators; progression and over analysis aggregate by match/innings/over; consistency is descriptive standard deviation/CV and is not an official cricket rating. **Limitations:** partnership boundaries and event ordering cannot be reconstructed reliably from a reused `ball_over` value alone; custom impact scores need an explicitly agreed formula and validation; venue outputs retain source team spelling.

| Statistic | Status |
|---|---|
| Batting contribution percentage | AVAILABLE |
| Boundary contribution percentage | AVAILABLE |
| Dot-ball percentage | AVAILABLE |
| Runs per over | AVAILABLE |
| Wickets per over | AVAILABLE |
| Player consistency | PARTIALLY AVAILABLE — can only be descriptive across observed innings; no official definition or qualification threshold. |
| Batting consistency | PARTIALLY AVAILABLE — descriptive variability is possible, but no official definition or minimum sample rule is supplied. |
| Bowling consistency | PARTIALLY AVAILABLE — descriptive spell variability is possible, but appearances/sample rules need definition. |
| Team run-rate progression | AVAILABLE |
| Partnership analysis | PARTIALLY AVAILABLE — batter pairs are visible, but partnership start/end and run attribution around dismissals are not explicit. |
| Powerplay vs death-over comparison | AVAILABLE |
| Batting-first vs chasing performance | AVAILABLE |
| Player performance by venue | AVAILABLE |
| Player performance by season | AVAILABLE |
| Team performance by venue | AVAILABLE |
| Player impact score | PARTIALLY AVAILABLE — no source-defined formula; any constructed score would be custom. |
| Bowling impact score | PARTIALLY AVAILABLE — no source-defined formula; any constructed score would be custom. |
| Team performance index | PARTIALLY AVAILABLE — no source-defined formula or weights. |
| Over-by-over analysis | AVAILABLE |
| Match momentum analysis | PARTIALLY AVAILABLE — progression is available, but reliable ball sequence and win-probability context are not. |

## Outputs implemented

`analysis/run_all.py` currently writes 88 non-empty analysis CSVs across batting, bowling, fielding, team, match, innings, extras, head-to-head, and advanced categories. Unavailable keeper statistics are documented but no empty placeholder CSV is written. Existing CSVs were retained; new exports use distinct filenames.
