"""Shared, read-only loading and cricket delivery helpers for analysis scripts."""
from pathlib import Path
import pandas as pd
from data_provider.data_provider import load_npl_datasets

ROOT = Path(__file__).resolve().parents[1]


def load_datasets():
    balls, matches = load_npl_datasets()
    for col in ["batsman_runs", "wide_runs", "bye_runs", "legbye_runs", "noball_runs", "extra_runs", "total_runs", "inning", "season"]:
        balls[col] = pd.to_numeric(balls[col], errors="coerce")
    balls["over_number"] = balls["ball_over"].astype(float).floordiv(1).astype("Int64")
    balls["delivery_order"] = balls.groupby(["match_id", "inning"], sort=False).cumcount() + 1
    balls["phase"] = pd.cut(balls["over_number"].astype(float), [-1, 5, 14, 19], labels=["powerplay", "middle", "death"])
    balls["legal_bowler_ball"] = balls["wide_runs"].fillna(0).eq(0) & balls["noball_runs"].fillna(0).eq(0)
    balls["bowler_runs"] = balls["batsman_runs"].fillna(0) + balls["wide_runs"].fillna(0) + balls["noball_runs"].fillna(0)
    balls["dismissal_norm"] = balls["dismissal_kind"].fillna("").astype(str).str.strip().str.lower().str.replace("&", "and", regex=False)
    balls["dismissed"] = balls["player_out"].fillna("").astype(str).str.strip().ne("")
    balls["wicket_lost"] = balls["dismissed"] & balls["dismissal_norm"].ne("retired hurt")
    balls["bowler_wicket"] = balls["dismissed"] & balls["dismissal_norm"].isin({"caught", "bowled", "lbw", "stumped", "caught and bowled", "hit wicket"})
    balls["batter_ball"] = balls["wide_runs"].fillna(0).eq(0)
    balls["is_four"] = balls["batsman_runs"].eq(4)
    balls["is_six"] = balls["batsman_runs"].eq(6)
    balls["is_dot_batter"] = balls["batsman_runs"].eq(0) & balls["wide_runs"].fillna(0).eq(0)
    return balls, matches


def save(df, category, name):
    out = ROOT / "outputs" / category / name
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(out, index=False)
    return out


def grouped(df, keys, **aggregations):
    return df.groupby(keys, dropna=False, observed=True).agg(**aggregations).reset_index()
