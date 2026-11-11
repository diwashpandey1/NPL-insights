"""Generate reproducible NPL batting, bowling, fielding, match and team CSVs."""
from __future__ import annotations

import json
import re
from pathlib import Path
import pandas as pd

from analysis.common import ROOT, grouped, load_datasets, save

OUT_COUNT = 0


def export(df, category, filename):
    global OUT_COUNT
    if df is not None and not df.empty:
        save(df, category, filename)
        OUT_COUNT += 1


def run():
    b, m = load_datasets()
    source_cols = ["match_id", "season", "match_number", "inning", "batting_team", "bowling_team", "ball_over", "ball_result", "bowler", "batsman", "non_striker", "shot_direction", "player_out", "dismissal_kind", "fielders", "batsman_runs", "wide_runs", "bye_runs", "legbye_runs", "noball_runs", "extra_runs", "total_runs"]
    source_exact_duplicates = int(b[source_cols].duplicated().sum())
    b["match_key"] = b["match_id"].astype(str)
    b["innings_key"] = b["match_key"] + "_" + b["inning"].astype("Int64").astype(str)
    b["over_key"] = b["innings_key"] + "_" + b["over_number"].astype("Int64").astype(str) + "_" + b["bowler"].fillna("")
    # Match table ids are season-local; the processed IDs encode both season and match number.
    # Match CSV IDs are sequential across seasons while processed match numbers
    # restart at 1. Build a verified crosswalk from season, batting order, teams,
    # and innings totals; this resolves the duplicate 2025 id 42 deterministically.
    m["match_key"] = m["season"].astype(int).astype(str) + "_" + m["id"].astype(int).astype(str)
    b["match_table_id"] = b["match_number"] + (b["season"].eq(2025).astype(int) * 32)
    ambiguous_match_keys = set(m.loc[m.duplicated(["season", "id"], keep=False), "match_key"])
    def team_key(value):
        value = str(value).strip().casefold()
        return value.replace("kathmandu gorkhas", "kathmandu gurkhas")

    inning_lookup = b.groupby(["match_id", "season", "match_number", "inning"], as_index=False).agg(
        score=("total_runs", "sum"), batting_team=("batting_team", "first")
    )
    crosswalk = []
    used_match_rows = set()
    for match_id, delivery_match in inning_lookup.groupby("match_id", sort=False):
        ordered = delivery_match.sort_values("inning")
        if len(ordered) < 2:
            continue
        first, second = ordered.iloc[0], ordered.iloc[1]
        candidates = m[(m.season == first.season) &
                       (m.team_1.map(team_key) == team_key(first.batting_team)) &
                       (m.team_2.map(team_key) == team_key(second.batting_team))]
        exact = candidates[(candidates.team_1_runs == first.score) & (candidates.team_2_runs == second.score)]
        available_exact = exact.loc[~exact.index.isin(used_match_rows)]
        available_candidates = candidates.loc[~candidates.index.isin(used_match_rows)]
        chosen = available_exact if len(available_exact) == 1 else available_candidates if len(available_candidates) == 1 else available_exact
        if len(chosen) == 1:
            row_id = int(chosen.index[0])
            used_match_rows.add(row_id)
            crosswalk.append({"match_id": match_id, "match_row_id": row_id})
    crosswalk_df = pd.DataFrame(crosswalk)
    match_context = m.reset_index(names="match_row_id")
    b = b.merge(crosswalk_df, on="match_id", how="left").merge(match_context, on="match_row_id", how="left", suffixes=("", "_match"))
    b["opponent"] = b["bowling_team"]

    # Innings and batter summaries. Each batter's innings comes from appearances in the delivery feed.
    inns = grouped(b, ["match_id", "season", "inning", "batting_team", "bowling_team"],
                   runs=("total_runs", "sum"), bat_runs=("batsman_runs", "sum"),
                   fours=("is_four", "sum"), sixes=("is_six", "sum"),
                   extras=("extra_runs", "sum"), deliveries=("total_runs", "size"),
                   wickets=("wicket_lost", "sum"), legal_balls=("legal_bowler_ball", "sum"))
    inns["boundaries"] = inns.fours + inns.sixes
    inns["run_rate"] = (inns.runs / (inns.legal_balls / 6).replace(0, float("nan"))).round(3)
    for phase, label in [("powerplay", "powerplay"), ("middle", "middle"), ("death", "death")]:
        p = grouped(b[b.phase.eq(phase)], ["match_id", "inning"], runs=("total_runs", "sum"), wickets=("wicket_lost", "sum"), fours=("is_four", "sum"), sixes=("is_six", "sum"))
        p = p.rename(columns={c: f"{label}_{c}" for c in ["runs", "wickets", "fours", "sixes"]})
        inns = inns.merge(p, on=["match_id", "inning"], how="left")
    export(inns.sort_values(["season", "match_id", "inning"]), "innings", "innings_summary.csv")
    export(inns.nlargest(25, "runs"), "innings", "highest_innings_totals.csv")
    export(inns.nsmallest(25, "runs"), "innings", "lowest_innings_totals.csv")
    export(inns.nlargest(25, "powerplay_runs"), "innings", "powerplay_scoring.csv")
    export(inns.nlargest(25, "middle_runs"), "innings", "middle_over_scoring.csv")
    export(inns.nlargest(25, "death_runs"), "innings", "death_over_scoring.csv")
    export(inns.nlargest(25, "fours"), "innings", "innings_boundary_statistics.csv")

    batter_inns = grouped(b, ["match_id", "season", "inning", "batting_team", "batsman"],
                          runs=("batsman_runs", "sum"), balls=("batter_ball", "sum"), fours=("is_four", "sum"), sixes=("is_six", "sum"),
                          outs=("wicket_lost", "sum"), dots=("is_dot_batter", "sum"))
    batter_inns["not_out"] = batter_inns.outs.eq(0)
    batter_inns["strike_rate"] = (batter_inns.runs / batter_inns.balls.replace(0, float("nan")) * 100).round(2)
    batter_inns["opponent"] = batter_inns.apply(lambda r: (b.loc[(b.match_id == r.match_id), "bowling_team"].iloc[0]), axis=1)
    batter = grouped(batter_inns, ["batsman"], runs=("runs", "sum"), innings=("inning", "size"), balls_faced=("balls", "sum"),
                     fours=("fours", "sum"), sixes=("sixes", "sum"), not_outs=("not_out", "sum"), ducks=("runs", lambda s: (s == 0).sum()),
                     half_centuries=("runs", lambda s: ((s >= 50) & (s < 100)).sum()), centuries=("runs", lambda s: (s >= 100).sum()), dot_balls=("dots", "sum"), dismissals=("outs", "sum"))
    batter["average"] = (batter.runs / batter.dismissals.replace(0, float("nan"))).round(2)
    batter["strike_rate"] = (batter.runs / batter.balls_faced.replace(0, float("nan")) * 100).round(2)
    batter["boundary_runs"] = batter.fours * 4 + batter.sixes * 6
    batter["boundary_percentage"] = (batter.boundary_runs / batter.runs.replace(0, float("nan")) * 100).round(2)
    batter["six_frequency_balls"] = (batter.balls_faced / batter.sixes.replace(0, float("nan"))).round(2)
    batter["four_frequency_balls"] = (batter.balls_faced / batter.fours.replace(0, float("nan"))).round(2)
    export(batter.sort_values("runs", ascending=False), "batting", "player_batting_summary.csv")
    export(batter_inns.sort_values("runs", ascending=False), "batting", "player_innings_batting.csv")
    export(grouped(batter_inns, ["season", "batsman"], runs=("runs", "sum"), innings=("inning", "size"), balls_faced=("balls", "sum"), fours=("fours", "sum"), sixes=("sixes", "sum"), outs=("outs", "sum"), not_outs=("not_out", "sum"), dots=("dots", "sum")).sort_values(["season", "runs"], ascending=[True, False]), "batting", "player_season_comparison.csv")
    export(grouped(batter_inns, ["batsman", "opponent"], runs=("runs", "sum"), innings=("inning", "size"), fours=("fours", "sum"), sixes=("sixes", "sum"), outs=("outs", "sum")).sort_values("runs", ascending=False), "batting", "player_vs_opponent.csv")
    export(grouped(batter_inns, ["batsman", "match_id", "season"], runs=("runs", "sum")).nlargest(25, "runs"), "batting", "highest_individual_scores.csv")
    batter_match = grouped(batter_inns, ["batsman", "match_id", "season", "batting_team", "opponent"], runs=("runs", "sum"), innings=("inning", "nunique"), balls_faced=("balls", "sum"), fours=("fours", "sum"), sixes=("sixes", "sum"), outs=("outs", "sum"))
    export(batter_match.sort_values("runs", ascending=False), "batting", "player_match_batting.csv")
    export(batter_match.nlargest(25, "runs"), "batting", "most_runs_single_match.csv")
    export(grouped(b, ["match_id", "inning", "over_number", "batsman"], runs=("batsman_runs", "sum")).nlargest(25, "runs"), "batting", "most_runs_single_over_by_batter.csv")
    phase_bat = grouped(b, ["batsman", "season", "phase"], runs=("batsman_runs", "sum"), balls=("batter_ball", "sum"), dots=("is_dot_batter", "sum"), fours=("is_four", "sum"), sixes=("is_six", "sum"))
    export(phase_bat, "batting", "player_phase_batting.csv")

    # Input order is validated as monotonic by match/innings over notation.
    progress_keys = ["match_id", "inning", "batsman"]
    progress = b.sort_values("delivery_order").copy()
    progress["innings_cumulative_runs"] = progress.groupby(progress_keys, sort=False).batsman_runs.cumsum()
    progress["innings_cumulative_balls"] = progress.groupby(progress_keys, sort=False).batter_ball.cumsum()
    milestone_rows = []
    for threshold, label in [(50, "half_century"), (100, "century")]:
        reached = progress[progress.innings_cumulative_runs.ge(threshold)].drop_duplicates(progress_keys)
        reached = reached[["match_id", "season", "inning", "batsman", "innings_cumulative_runs", "innings_cumulative_balls"]].copy()
        reached["milestone"] = label
        reached["runs_at_milestone"] = threshold
        milestone_rows.append(reached)
    if milestone_rows:
        milestones = pd.concat(milestone_rows, ignore_index=True).rename(columns={"innings_cumulative_balls": "balls_to_milestone"})
        export(milestones.sort_values(["milestone", "balls_to_milestone", "batsman"]).groupby("milestone").head(25), "batting", "fastest_milestones.csv")

    # Boundary splits and single-over records.
    for field, filename in [("is_six", "most_sixes"), ("is_four", "most_fours")]:
        export(grouped(b[b[field]], ["batsman"], count=(field, "sum")).sort_values("count", ascending=False), "batting", filename + "_by_player.csv")
        export(grouped(b[b[field]], ["match_id", "inning", "batting_team", "season"], count=(field, "sum")).sort_values("count", ascending=False), "innings", filename + "_by_innings.csv")
        export(grouped(b[b[field]], ["match_id", "batting_team", "season"], count=(field, "sum")).sort_values("count", ascending=False), "match", filename + "_by_match.csv")
        export(grouped(b[b[field]], ["batting_team", "season"], count=(field, "sum")).sort_values("count", ascending=False), "team", filename + "_by_team.csv")
        export(grouped(b[b[field]], ["phase", "season"], count=(field, "sum")).sort_values("count", ascending=False), "innings", filename + "_by_phase.csv")
        export(grouped(b[b[field]], ["batsman", "opponent"], count=(field, "sum")).sort_values("count", ascending=False), "batting", filename + "_vs_opponent.csv")
        export(grouped(b[b[field]], ["season"], count=(field, "sum")), "batting", filename + "_by_season.csv")
    over_bounds = grouped(b, ["match_id", "inning", "over_number", "bowler", "batting_team"], fours=("is_four", "sum"), sixes=("is_six", "sum"), runs=("total_runs", "sum"))
    over_bounds["boundaries"] = over_bounds.fours + over_bounds.sixes
    export(over_bounds.nlargest(25, "sixes"), "innings", "most_sixes_single_over.csv")
    export(over_bounds.nlargest(25, "fours"), "innings", "most_fours_single_over.csv")
    export(over_bounds.nlargest(25, "boundaries"), "innings", "most_boundaries_single_over.csv")

    # Bowling runs charged only to the bowler; non-bowler dismissals excluded from wickets.
    bw = grouped(b, ["bowler", "match_id", "season", "inning", "bowling_team", "batting_team"], runs_conceded=("bowler_runs", "sum"), legal_balls=("legal_bowler_ball", "sum"), wickets=("bowler_wicket", "sum"), wides=("wide_runs", lambda s: (s > 0).sum()), wide_runs=("wide_runs", "sum"), no_balls=("noball_runs", lambda s: (s > 0).sum()), no_ball_runs=("noball_runs", "sum"), fours_conceded=("is_four", "sum"), sixes_conceded=("is_six", "sum"), dots=("total_runs", lambda s: (s == 0).sum()), extras=("extra_runs", "sum"))
    bw["economy"] = (bw.runs_conceded / (bw.legal_balls / 6).replace(0, float("nan"))).round(2)
    bw["bowling_average"] = (bw.runs_conceded / bw.wickets.replace(0, float("nan"))).round(2)
    bw["bowling_strike_rate"] = (bw.legal_balls / bw.wickets.replace(0, float("nan"))).round(2)
    bw["overs_display"] = (bw.legal_balls // 6).astype(str) + "." + (bw.legal_balls % 6).astype(str)
    export(bw.sort_values("wickets", ascending=False), "bowling", "bowler_spell_summary.csv")
    career = grouped(bw, ["bowler"], wickets=("wickets", "sum"), runs_conceded=("runs_conceded", "sum"), legal_balls=("legal_balls", "sum"), spells=("match_id", "size"), dots=("dots", "sum"), wides=("wides", "sum"), wide_runs=("wide_runs", "sum"), no_balls=("no_balls", "sum"), no_ball_runs=("no_ball_runs", "sum"), fours_conceded=("fours_conceded", "sum"), sixes_conceded=("sixes_conceded", "sum"), extras=("extras", "sum"))
    career["economy"] = (career.runs_conceded / (career.legal_balls / 6).replace(0, float("nan"))).round(2)
    career["average"] = (career.runs_conceded / career.wickets.replace(0, float("nan"))).round(2)
    career["strike_rate"] = (career.legal_balls / career.wickets.replace(0, float("nan"))).round(2)
    career["overs"] = (career.legal_balls // 6).astype(str) + "." + (career.legal_balls % 6).astype(str)
    export(career.sort_values("wickets", ascending=False), "bowling", "bowler_career_summary.csv")
    export(grouped(bw, ["season", "bowler"], wickets=("wickets", "sum"), runs_conceded=("runs_conceded", "sum"), legal_balls=("legal_balls", "sum"), spells=("match_id", "size"), dots=("dots", "sum")).sort_values(["season", "wickets"], ascending=[True, False]), "bowling", "bowler_season_comparison.csv")
    export(grouped(bw, ["bowler", "batting_team"], wickets=("wickets", "sum"), runs_conceded=("runs_conceded", "sum"), legal_balls=("legal_balls", "sum"), spells=("match_id", "size")).sort_values("wickets", ascending=False), "bowling", "bowler_vs_team.csv")
    bowler_phase = grouped(b, ["bowler", "season", "phase"], wickets=("bowler_wicket", "sum"), runs_conceded=("bowler_runs", "sum"), legal_balls=("legal_bowler_ball", "sum"), dots=("total_runs", lambda s: (s == 0).sum()))
    bowler_phase["economy"] = (bowler_phase.runs_conceded / (bowler_phase.legal_balls / 6).replace(0, float("nan"))).round(2)
    export(bowler_phase.sort_values(["season", "wickets"], ascending=[True, False]), "bowling", "bowler_phase_performance.csv")
    bowling_innings = grouped(bw, ["bowler", "match_id", "season", "inning"], wickets=("wickets", "sum"), runs_conceded=("runs_conceded", "sum"), legal_balls=("legal_balls", "sum"))
    export(bowling_innings.nlargest(25, "wickets"), "bowling", "most_wickets_single_innings.csv")
    bowling_match = grouped(bowling_innings, ["bowler", "match_id", "season"], wickets=("wickets", "sum"), runs_conceded=("runs_conceded", "sum"), legal_balls=("legal_balls", "sum"))
    export(bowling_match.nlargest(25, "wickets"), "bowling", "most_wickets_single_match.csv")
    export(bw.nlargest(25, "wickets"), "bowling", "best_bowling_figures.csv")
    export(bw.nlargest(25, "runs_conceded"), "bowling", "most_expensive_spells.csv")
    export(bw[bw.legal_balls.ge(6)].nsmallest(25, "economy"), "bowling", "most_economical_spells.csv")
    over_bowl = grouped(b, ["match_id", "season", "inning", "over_number", "bowler", "bowling_team"], runs_conceded=("bowler_runs", "sum"), total_runs=("total_runs", "sum"), legal_balls=("legal_bowler_ball", "sum"), wickets=("bowler_wicket", "sum"))
    export(over_bowl.nlargest(25, "runs_conceded"), "bowling", "most_runs_conceded_single_over.csv")
    # Maids require no runs of any kind in an over and six legal balls.
    maid = over_bowl[(over_bowl.total_runs.eq(0)) & (over_bowl.legal_balls.eq(6))]
    export(grouped(maid, ["bowler"], maidens=("over_number", "size")).sort_values("maidens", ascending=False), "bowling", "bowler_maiden_overs.csv")

    # Extras kept by category; bowling extras use event count and actual runs separately.
    ext = grouped(b, ["bowler"], wides=("wide_runs", lambda s: (s > 0).sum()), wide_runs=("wide_runs", "sum"), no_balls=("noball_runs", lambda s: (s > 0).sum()), no_ball_runs=("noball_runs", "sum"), byes=("bye_runs", "sum"), leg_byes=("legbye_runs", "sum"), extras=("extra_runs", "sum"))
    export(ext.sort_values("extras", ascending=False), "extras", "bowler_extras_summary.csv")
    export(grouped(b, ["batting_team", "season"], extras=("extra_runs", "sum"), batter_runs=("batsman_runs", "sum"), total_runs=("total_runs", "sum"), wides=("wide_runs", "sum"), no_balls=("noball_runs", "sum"), byes=("bye_runs", "sum"), leg_byes=("legbye_runs", "sum")), "extras", "team_extras_by_season.csv")
    export(grouped(b, ["match_id", "season", "inning", "batting_team"], extras=("extra_runs", "sum"), batter_runs=("batsman_runs", "sum"), total_runs=("total_runs", "sum"), wides=("wide_runs", "sum"), no_balls=("noball_runs", "sum"), byes=("bye_runs", "sum"), leg_byes=("legbye_runs", "sum")), "extras", "extras_by_innings.csv")

    # Fielders are only safe for unambiguous single-player entries. Multiple names are retained as ambiguous.
    dismissed = b[b.dismissed].copy()
    fielder_text = dismissed["fielders"].fillna("").astype(str).str.strip()
    simple_fielder = fielder_text.ne("") & ~fielder_text.str.contains(r"[,;/&]|\band\b", case=False, regex=True)
    fd = dismissed[simple_fielder].copy()
    fd["fielder"] = fd.fielders.astype(str).str.strip()
    catch = fd[fd.dismissal_norm.isin(["caught", "caught and bowled"])]
    export(grouped(catch, ["fielder"], catches=("player_out", "size")).sort_values("catches", ascending=False), "fielding", "fielder_catches_unambiguous.csv")
    export(grouped(fd, ["fielder", "dismissal_norm"], dismissals=("player_out", "size")).sort_values("dismissals", ascending=False), "fielding", "fielder_dismissal_breakdown.csv")
    export(grouped(dismissed, ["dismissal_norm"], dismissals=("player_out", "size")).sort_values("dismissals", ascending=False), "fielding", "dismissal_kind_counts.csv")
    export(grouped(dismissed[dismissed.dismissal_norm.isin(["run out", "runout"])], ["match_id", "season", "fielders"], dismissals=("player_out", "size")).sort_values("dismissals", ascending=False), "fielding", "run_outs_by_recorded_fielder.csv")
    catches_by_match = grouped(b[b.dismissal_norm.isin(["caught", "caught and bowled"])], ["match_id", "season"], catches=("player_out", "size"))
    export(catches_by_match.sort_values("catches", ascending=False), "fielding", "catches_by_match.csv")
    export(grouped(b[b.dismissal_norm.isin(["caught", "caught and bowled"])], ["season"], catches=("player_out", "size")), "fielding", "catches_by_season.csv")
    export(grouped(b[b.dismissal_norm.isin(["run out", "runout"])], ["season", "bowling_team"], run_outs=("player_out", "size")), "fielding", "runouts_by_season_team.csv")

    # Match and team results from authoritative match-level records.
    m["aggregate"] = m.team_1_runs + m.team_2_runs
    m["winner_valid"] = m.winner.notna() & m.winner.astype(str).str.strip().ne("") & ~m.winner.astype(str).str.lower().isin(["no result", "tied", "nan"])
    m["result_type"] = "no_result"
    m.loc[m.winner_valid, "result_type"] = "decided"
    tied = m.result.astype(str).str.contains("tie", case=False, na=False) | m.result_type.eq("tied")
    m.loc[tied, "result_type"] = "tied"
    m["chase_success"] = m.winner.eq(m.team_2) & m.win_by_wickets.gt(0)
    export(m.sort_values("aggregate", ascending=False), "match", "match_summary.csv")
    export(m.nlargest(25, "aggregate"), "match", "highest_match_aggregates.csv")
    export(m.nlargest(25, "team_1_runs"), "match", "highest_first_innings_totals.csv")
    export(m.nlargest(25, "team_2_runs"), "match", "highest_second_innings_totals.csv")
    export(m[m.chase_success].nlargest(25, "team_2_runs"), "match", "highest_successful_chases.csv")
    export(grouped(m, ["venue", "season"], matches=("id", "size"), avg_aggregate=("aggregate", "mean"), highest_total=("aggregate", "max"), toss_wins=("toss_winner", "size")).sort_values("matches", ascending=False), "match", "venue_statistics.csv")
    export(grouped(m, ["player_of_the_match"], awards=("id", "size")).sort_values("awards", ascending=False), "match", "player_of_match_frequency.csv")
    export(grouped(m, ["toss_decision"], matches=("id", "size"), toss_winner_wins=("winner", lambda s: sum(s.eq(m.loc[s.index, "toss_winner"])))).sort_values("matches", ascending=False), "match", "toss_vs_match_winner.csv")

    team_rows = pd.concat([m[["season", "team_1", "winner", "result_type", "team_1_runs", "team_1_wickets", "team_2_runs", "team_2_wickets", "win_by_runs", "win_by_wickets"]].rename(columns={"team_1": "team", "team_1_runs": "runs_for", "team_1_wickets": "wickets_lost", "team_2_runs": "runs_against", "team_2_wickets": "wickets_taken"}), m[["season", "team_2", "winner", "result_type", "team_2_runs", "team_2_wickets", "team_1_runs", "team_1_wickets", "win_by_runs", "win_by_wickets"]].rename(columns={"team_2": "team", "team_2_runs": "runs_for", "team_2_wickets": "wickets_lost", "team_1_runs": "runs_against", "team_1_wickets": "wickets_taken"})], ignore_index=True)
    team_rows["win"] = team_rows.winner.eq(team_rows.team)
    team_rows["loss"] = team_rows.winner.notna() & team_rows.winner.astype(str).str.strip().ne("") & ~team_rows.winner.astype(str).str.lower().eq("no result") & ~team_rows.win
    team_rows["no_result"] = team_rows.result_type.eq("no_result")
    team_stats = grouped(team_rows, ["team"], matches=("winner", "size"), wins=("win", "sum"), losses=("loss", "sum"), no_results=("no_result", "sum"), runs_for=("runs_for", "sum"), runs_against=("runs_against", "sum"), wickets_taken=("wickets_taken", "sum"))
    team_stats["win_percentage"] = (team_stats.wins / (team_stats.matches-team_stats.no_results).replace(0, float("nan")) * 100).round(2)
    export(team_stats.sort_values("wins", ascending=False), "team", "team_win_loss_stats_expanded.csv")
    export(grouped(team_rows, ["season", "team"], matches=("winner", "size"), wins=("win", "sum"), losses=("loss", "sum"), runs_for=("runs_for", "sum"), runs_against=("runs_against", "sum"), wickets_taken=("wickets_taken", "sum")).sort_values(["season", "wins"], ascending=[True, False]), "team", "team_season_comparison.csv")
    export(grouped(b, ["batting_team", "season"], runs=("total_runs", "sum"), bat_runs=("batsman_runs", "sum"), fours=("is_four", "sum"), sixes=("is_six", "sum"), innings=("innings_key", "nunique")), "team", "team_batting_summary.csv")
    export(grouped(b, ["bowling_team", "season"], runs_conceded=("bowler_runs", "sum"), wickets=("bowler_wicket", "sum"), legal_balls=("legal_bowler_ball", "sum"), wides=("wide_runs", "sum"), no_balls=("noball_runs", "sum")), "team", "team_bowling_summary.csv")
    export(grouped(b, ["batting_team", "phase", "season"], runs=("total_runs", "sum"), wickets=("wicket_lost", "sum"), fours=("is_four", "sum"), sixes=("is_six", "sum")), "team", "team_phase_summary.csv")
    match_ball = grouped(b, ["match_id", "season"], runs=("total_runs", "sum"), batter_runs=("batsman_runs", "sum"), fours=("is_four", "sum"), sixes=("is_six", "sum"), wickets=("wicket_lost", "sum"), extras=("extra_runs", "sum"))
    match_ball["boundaries"] = match_ball.fours + match_ball.sixes
    export(match_ball.sort_values("runs", ascending=False), "match", "match_ball_summary.csv")
    export(match_ball.nlargest(25, "wickets"), "match", "most_wickets_by_match.csv")
    export(match_ball.nlargest(25, "extras"), "match", "most_extras_by_match.csv")
    first_teams = inns[inns.inning.eq(1)][["match_id", "batting_team"]].rename(columns={"batting_team": "batting_first_team"})
    second_teams = inns[inns.inning.eq(2)][["match_id", "batting_team"]].rename(columns={"batting_team": "chasing_team"})
    match_order = m.reset_index(names="match_row_id").merge(b[["match_id", "match_row_id"]].drop_duplicates(), on="match_row_id", how="left")
    match_order = match_order.merge(first_teams, on="match_id", how="left").merge(second_teams, on="match_id", how="left")
    match_order["batting_first_won"] = match_order.winner.eq(match_order.batting_first_team)
    match_order["chasing_won"] = match_order.winner.eq(match_order.chasing_team)
    export(grouped(match_order, ["season"], matches=("id", "size"), batting_first_wins=("batting_first_won", "sum"), chasing_wins=("chasing_won", "sum")), "team", "batting_first_vs_chasing.csv")
    export(grouped(match_order, ["season", "chasing_team"], matches=("id", "size"), successful_chases=("chasing_won", "sum")).sort_values("successful_chases", ascending=False), "team", "successful_chases_by_team.csv")
    export(grouped(m, ["season"], matches=("id", "size"), team_1_runs=("team_1_runs", "sum"), team_2_runs=("team_2_runs", "sum")), "match", "season_match_summary.csv")

    # Head-to-head pairs are canonicalized alphabetically, independent of team order.
    m["team_a"] = m[["team_1", "team_2"]].min(axis=1)
    m["team_b"] = m[["team_1", "team_2"]].max(axis=1)
    m["team_a_wins"] = m.winner.eq(m.team_a)
    m["team_b_wins"] = m.winner.eq(m.team_b)
    h2h = grouped(m, ["team_a", "team_b"], matches=("id", "size"), team_a_wins=("team_a_wins", "sum"), team_b_wins=("team_b_wins", "sum"), no_results=("result_type", lambda s: (s == "no_result").sum()), highest_aggregate=("aggregate", "max"), lowest_aggregate=("aggregate", "min"))
    h2h["team_a_win_percentage"] = (h2h.team_a_wins / (h2h.matches-h2h.no_results).replace(0, float("nan")) * 100).round(2)
    export(h2h.sort_values(["matches", "team_a"], ascending=[False, True]), "head_to_head", "team_head_to_head.csv")
    export(grouped(m, ["season", "team_a", "team_b"], matches=("id", "size"), team_a_wins=("team_a_wins", "sum"), team_b_wins=("team_b_wins", "sum"), highest_aggregate=("aggregate", "max")), "head_to_head", "season_head_to_head.csv")
    # Head-to-head boundary totals computed directly from ball-by-ball team pairs.
    pairs = b.copy()
    pairs["team_a"] = pairs[["batting_team", "bowling_team"]].min(axis=1)
    pairs["team_b"] = pairs[["batting_team", "bowling_team"]].max(axis=1)
    export(grouped(pairs, ["team_a", "team_b"], runs=("total_runs", "sum"), sixes=("is_six", "sum"), fours=("is_four", "sum"), matches=("match_id", "nunique")), "head_to_head", "head_to_head_scoring.csv")
    head_rows = pd.concat([m[["match_key", "season", "team_1", "team_2", "team_1_runs", "team_2_runs", "winner", "win_by_runs", "win_by_wickets"]].rename(columns={"team_1": "team", "team_2": "opponent", "team_1_runs": "runs", "team_2_runs": "runs_against"}), m[["match_key", "season", "team_2", "team_1", "team_2_runs", "team_1_runs", "winner", "win_by_runs", "win_by_wickets"]].rename(columns={"team_2": "team", "team_1": "opponent", "team_2_runs": "runs", "team_1_runs": "runs_against"})], ignore_index=True)
    head_rows["team_a"] = head_rows[["team", "opponent"]].min(axis=1)
    head_rows["team_b"] = head_rows[["team", "opponent"]].max(axis=1)
    export(grouped(head_rows, ["team_a", "team_b"], highest_team_score=("runs", "max"), lowest_team_score=("runs", "min"), biggest_run_margin=("win_by_runs", "max"), biggest_wicket_margin=("win_by_wickets", "max")), "head_to_head", "head_to_head_score_and_margins.csv")

    # Delivery, over and venue/season outputs for advanced descriptive analytics.
    b["over_runs"] = b.total_runs
    over = grouped(b, ["match_id", "season", "inning", "over_number", "batting_team", "bowling_team"], runs=("total_runs", "sum"), wickets=("wicket_lost", "sum"), legal_balls=("legal_bowler_ball", "sum"), bat_runs=("batsman_runs", "sum"), extras=("extra_runs", "sum"))
    over["runs_per_over"] = over.runs
    export(over.sort_values(["match_id", "inning", "over_number"]), "advanced", "over_by_over_analysis.csv")
    bat_consistency = grouped(batter_inns, ["batsman", "season"], innings=("inning", "size"), mean_innings_runs=("runs", "mean"), std_innings_runs=("runs", "std"), total_runs=("runs", "sum"))
    bat_consistency["runs_per_innings_cv"] = (bat_consistency.std_innings_runs / bat_consistency.mean_innings_runs.replace(0, float("nan"))).round(3)
    export(bat_consistency.sort_values("total_runs", ascending=False), "advanced", "batting_consistency_descriptive.csv")
    export(grouped(bw, ["bowler", "season"], wickets=("wickets", "sum"), spells=("match_id", "size"), mean_spell_economy=("economy", "mean"), std_spell_economy=("economy", "std")).sort_values("wickets", ascending=False), "advanced", "bowling_consistency_descriptive.csv")
    export(grouped(b, ["batsman", "venue", "season"], runs=("batsman_runs", "sum"), innings=("innings_key", "nunique"), fours=("is_four", "sum"), sixes=("is_six", "sum")), "advanced", "player_by_venue.csv")
    export(grouped(b, ["batting_team", "venue", "season"], runs=("total_runs", "sum"), innings=("innings_key", "nunique"), wickets_lost=("dismissed", "sum")), "advanced", "team_by_venue.csv")
    export(grouped(b, ["match_id", "inning", "batsman", "non_striker"], runs=("total_runs", "sum"), balls=("total_runs", "size")), "advanced", "batting_pair_co_innings.csv")
    export(grouped(b, ["match_id", "inning", "bowling_team", "phase"], runs=("total_runs", "sum"), wickets=("wicket_lost", "sum")), "advanced", "phase_comparison.csv")
    batter_contribution = batter_inns.merge(inns[["match_id", "inning", "runs"]].rename(columns={"runs": "team_innings_runs"}), on=["match_id", "inning"], how="left")
    batter_contribution["batting_contribution_pct"] = (batter_contribution.runs / batter_contribution.team_innings_runs.replace(0, float("nan")) * 100).round(2)
    batter_contribution["boundary_contribution_pct"] = ((4*batter_contribution.fours+6*batter_contribution.sixes) / batter_contribution.team_innings_runs.replace(0, float("nan")) * 100).round(2)
    batter_contribution["dot_ball_pct"] = (batter_contribution.dots / batter_contribution.balls.replace(0, float("nan")) * 100).round(2)
    export(batter_contribution, "advanced", "player_contribution_percentages.csv")
    # Dataset validation summary includes anomalies rather than silently discarding them.
    duplicate_delivery = b.duplicated(["match_id", "inning", "ball_over"], keep=False)
    recon = inns.pivot_table(index=["season", "match_id"], columns="inning", values="runs", aggfunc="first").reset_index()
    recon["match_number"] = recon.match_id.astype(str).str.rsplit("_", n=1).str[-1].astype(int)
    recon["match_table_id"] = recon.match_number + (recon.season.eq(2025).astype(int) * 32)
    team_recon = b[["season", "match_table_id", "team_1", "team_2", "team_1_runs", "team_2_runs"]].drop_duplicates()
    first_batting = inns[inns.inning.eq(1)][["match_id", "batting_team"]].rename(columns={"batting_team": "ball_team_1"})
    second_batting = inns[inns.inning.eq(2)][["match_id", "batting_team"]].rename(columns={"batting_team": "ball_team_2"})
    recon = recon.merge(first_batting, on="match_id", how="left").merge(second_batting, on="match_id", how="left")
    recon = recon.merge(team_recon, on=["season", "match_table_id"], how="left")
    score_mismatches = int(((recon[1] != recon.team_1_runs) | (recon[2] != recon.team_2_runs)).fillna(False).sum())
    name_mismatches = int(((recon.ball_team_1.astype(str).str.casefold() != recon.team_1.astype(str).str.casefold()) | (recon.ball_team_2.astype(str).str.casefold() != recon.team_2.astype(str).str.casefold())).fillna(False).sum())
    checks = [
        ("delivery_rows", len(b), "informational"), ("match_rows", len(m), "informational"),
        ("missing_player_out", int(b.player_out.isna().sum()), "expected for non-wickets"),
        ("repeated_match_inning_ball_over_notation_rows", int(duplicate_delivery.sum()), "not a duplicate test: ball_over repeats for illegal deliveries; no unique delivery sequence field"),
        ("exact_duplicate_rows_after_first", source_exact_duplicates, "identical source rows; possible repeated over-ball notation means cannot safely deduplicate"),
        ("total_runs_vs_components_mismatch", int((b.total_runs != (b.batsman_runs+b.extra_runs)).sum()), "must investigate"),
        ("extra_runs_vs_categories_mismatch", int((b.extra_runs != (b.wide_runs+b.bye_runs+b.legbye_runs+b.noball_runs)).sum()), "must investigate"),
        ("ball_match_ids_without_match_metadata", int(b.team_1.isna().sum()), "crosswalk requires two innings plus unique team/score evidence"),
        ("conflicting_duplicate_match_keys", int(m.duplicated(["season", "id"], keep=False).sum()), "two 2025 records share one ID; team/innings totals resolve their ball-feed mapping"),
        ("match_score_reconciliation_mismatches", score_mismatches, "one-run discrepancy in 2024 local match 21; 2025 ID collision mapped by team and innings totals"),
        ("match_team_name_reconciliation_mismatches", name_mismatches, "Kathmandu Gorkhas/Gurkhas source spelling; matching alias does not rewrite source values"),
        ("dismissing_rows_without_kind", int((b.dismissed & b.dismissal_kind.isna()).sum()), "fielding/wicket attribution limited"),
        ("multi_fielder_dismissal_rows", int((b.dismissed & b.fielders.fillna("").astype(str).str.contains(r"[,;/&]|\band\b", case=False, regex=True)).sum()), "individual credit ambiguous"),
    ]
    export(pd.DataFrame(checks, columns=["check", "count", "interpretation"]), "advanced", "data_quality_summary.csv")
    print(f"Generated {OUT_COUNT} non-empty analysis CSV files under outputs/.")


if __name__ == "__main__":
    run()


