"""
src/cricket_stats.py
=====================
Phase 2 — ICC-Standard Cricket Logic Corrections.

Provides pure, stateless functions for computing cricket statistics in strict
compliance with International Cricket Council (ICC) playing conditions and
statistical definitions. All functions operate on a **normalized** DataFrame
(lowercase strings, explicit ``season`` column) produced by
``src/normalize_master_csv.py``.

Functions
---------
- ``is_bowler_wicket``        — per-delivery boolean mask for bowler-credited dismissals.
- ``compute_batter_runs``     — aggregate career / per-season batter run totals.
- ``compute_boundaries``      — count genuine bat-off-bat fours and sixes.
- ``compute_bowler_wickets``  — aggregate bowler wicket tallies (run-outs excluded).
- ``compute_batting_average`` — batting average (runs / dismissals) per player.
- ``compute_economy_rate``    — bowler economy rate (runs / overs).
- ``compute_strike_rate``     — batter strike rate (runs / balls × 100).
"""

from __future__ import annotations

import re
from typing import Literal

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# ICC bowling-credited dismissal kinds (all lowercase, post-normalization)
# ---------------------------------------------------------------------------
# Reference: ICC Playing Conditions 2024, Appendix B — Scorers' handbook
BOWLER_CREDITED_DISMISSALS: frozenset[str] = frozenset(
    {
        "caught",
        "bowled",
        "lbw",
        "stumped",
        "caught and bowled",
        "caught & bowled",
        "hit wicket",
    }
)

# Regex: extracts digits from composite codes like '1w', '2nb', '1W', '5w', '7nb', etc.
_DIGIT_RE = re.compile(r"(\d+)")


# ---------------------------------------------------------------------------
# Delivery-level helpers
# ---------------------------------------------------------------------------

def is_bowler_wicket(df: pd.DataFrame) -> "pd.Series[bool]":
    """Return a boolean Series that is ``True`` only for genuine bowler wickets.

    A delivery is a *bowler wicket* when ALL of the following hold:
    1. ``player_out`` is not null/empty.
    2. ``dismissal_kind`` (lowercase) belongs to :data:`BOWLER_CREDITED_DISMISSALS`.
    3. The delivery is **not** a run-out (belt-and-suspenders guard against
       mislabelled rows).

    This correctly handles composite delivery codes such as ``'1w'``, ``'2w'``,
    ``'1nb'``, and ``'1w'`` where a wicket and extras occurred on the same ball
    — including the **3 stumpings** found on ``1w``-coded deliveries in the NPL
    dataset.

    Parameters
    ----------
    df:
        Normalized ball-by-ball DataFrame.

    Returns
    -------
    pd.Series[bool]
        Element-wise mask aligned with ``df``'s index.
    """
    # Guard: normalize dismissal_kind defensively in case caller skipped Phase 1
    dk: pd.Series = (
        df["dismissal_kind"]
        .fillna("")
        .astype(str)
        .str.lower()
        .str.strip()
        # Normalize "caught & bowled" → "caught and bowled" for set membership
        .str.replace(r"\s*&\s*", " and ", regex=True)
    )

    has_player_out: pd.Series = df["player_out"].notna() & (
        df["player_out"].astype(str).str.strip() != ""
    )
    is_credited_dismissal: pd.Series = dk.isin(BOWLER_CREDITED_DISMISSALS)

    return has_player_out & is_credited_dismissal


def extract_wide_runs(ball_result_series: pd.Series) -> pd.Series:
    """Extract the numeric run value from wide delivery codes like ``'1w'``, ``'5w'``.

    For plain ``'w'`` (1 extra) the implicit value of 1 is returned.
    Non-wide deliveries return 0.

    Parameters
    ----------
    ball_result_series:
        The ``ball_result`` column (lowercase, stripped).

    Returns
    -------
    pd.Series[int]
        Wide run value per delivery.
    """
    def _parse(val: str) -> int:
        val = val.strip()
        if val.endswith("w") and "nb" not in val:
            match = _DIGIT_RE.search(val)
            return int(match.group(1)) if match else 1
        return 0

    return ball_result_series.astype(str).map(_parse).astype("int64")


# ---------------------------------------------------------------------------
# Batting statistics
# ---------------------------------------------------------------------------

def compute_batter_runs(
    df: pd.DataFrame,
    *,
    group_by_season: bool = False,
) -> pd.DataFrame:
    """Aggregate per-batter run totals using ``batsman_runs`` exclusively.

    Extras (wides, no-balls, byes, leg-byes) are **never** attributed to the
    batter's personal tally, in strict ICC compliance.

    Parameters
    ----------
    df:
        Normalized ball-by-ball DataFrame (must contain ``batsman_runs``).
    group_by_season:
        If ``True``, totals are broken down per ``(batsman, season)`` pair.

    Returns
    -------
    pd.DataFrame
        Sorted DataFrame with columns ``['batsman', 'total_runs']`` or
        ``['batsman', 'season', 'total_runs']``.
    """
    group_cols: list[str] = ["batsman"] + (["season"] if group_by_season else [])
    return (
        df.groupby(group_cols, as_index=False)
        .agg(total_runs=("batsman_runs", "sum"))
        .sort_values("total_runs", ascending=False)
        .reset_index(drop=True)
    )


def compute_boundaries(
    df: pd.DataFrame,
    boundary: Literal[4, 6] = 4,
    *,
    group_by_season: bool = False,
) -> pd.DataFrame:
    """Count bat-off-bat boundaries (fours or sixes) per batter.

    Uses ``batsman_runs == boundary`` to strictly exclude 4-wide or 4-bye
    deliveries from the batter's boundary count.

    Parameters
    ----------
    df:
        Normalized ball-by-ball DataFrame.
    boundary:
        4 for fours, 6 for sixes.
    group_by_season:
        Stratify by season when ``True``.

    Returns
    -------
    pd.DataFrame
        Columns: ``['batsman', 'count']`` or ``['batsman', 'season', 'count']``.
    """
    if boundary not in (4, 6):
        raise ValueError(f"boundary must be 4 or 6, got {boundary!r}")

    boundary_df: pd.DataFrame = df[df["batsman_runs"] == boundary].copy()
    group_cols: list[str] = ["batsman"] + (["season"] if group_by_season else [])
    col_name = "fours" if boundary == 4 else "sixes"
    return (
        boundary_df.groupby(group_cols)
        .size()
        .reset_index(name=col_name)
        .sort_values(col_name, ascending=False)
        .reset_index(drop=True)
    )


def compute_batting_average(
    df: pd.DataFrame,
    *,
    group_by_season: bool = False,
    min_innings: int = 3,
) -> pd.DataFrame:
    """Compute batting average = batsman_runs / number-of-dismissals.

    Not-out innings (no dismissal) are excluded from the denominator per ICC
    convention. Batters with fewer than ``min_innings`` dismissals are dropped.

    Parameters
    ----------
    df:
        Normalized ball-by-ball DataFrame.
    group_by_season:
        Stratify by season.
    min_innings:
        Minimum innings threshold to be included.

    Returns
    -------
    pd.DataFrame
        Columns: ``['batsman', 'runs', 'dismissals', 'average']``.
    """
    group_cols: list[str] = ["batsman"] + (["season"] if group_by_season else [])
    agg = df.groupby(group_cols, as_index=False).agg(
        runs=("batsman_runs", "sum"),
    )
    # Count dismissals = rows where batsman was dismissed
    dismissals = (
        df[df["player_out"].notna() & (df["player_out"].astype(str).str.strip() != "")]
        .groupby(group_cols)
        .size()
        .reset_index(name="dismissals")
    )
    result = agg.merge(dismissals, on=group_cols, how="left")
    result["dismissals"] = result["dismissals"].fillna(0).astype("int64")
    result = result[result["dismissals"] >= min_innings]
    result["average"] = (result["runs"] / result["dismissals"]).round(2)
    return result.sort_values("average", ascending=False).reset_index(drop=True)


def compute_strike_rate(
    df: pd.DataFrame,
    *,
    group_by_season: bool = False,
    min_balls: int = 20,
) -> pd.DataFrame:
    """Batter strike rate = (batsman_runs / balls_faced) × 100.

    Wides do not count as balls faced per ICC rule 18.5.

    Parameters
    ----------
    df:
        Normalized ball-by-ball DataFrame.
    group_by_season:
        Stratify by season.
    min_balls:
        Minimum balls-faced threshold.

    Returns
    -------
    pd.DataFrame
        Columns: ``['batsman', 'runs', 'balls_faced', 'strike_rate']``.
    """
    # Ball is faced only when it is NOT a wide
    legal_deliveries: pd.DataFrame = df[df["wide_runs"] == 0].copy()
    group_cols: list[str] = ["batsman"] + (["season"] if group_by_season else [])

    balls_faced = (
        legal_deliveries.groupby(group_cols).size().reset_index(name="balls_faced")
    )
    runs = (
        legal_deliveries.groupby(group_cols, as_index=False)
        .agg(runs=("batsman_runs", "sum"))
    )
    result = runs.merge(balls_faced, on=group_cols, how="inner")
    result = result[result["balls_faced"] >= min_balls]
    result["strike_rate"] = (result["runs"] / result["balls_faced"] * 100).round(2)
    return result.sort_values("strike_rate", ascending=False).reset_index(drop=True)


# ---------------------------------------------------------------------------
# Bowling statistics
# ---------------------------------------------------------------------------

def compute_bowler_wickets(
    df: pd.DataFrame,
    *,
    group_by_season: bool = False,
) -> pd.DataFrame:
    """Aggregate bowler wicket tallies, excluding run-outs.

    Correctly attributes wickets from composite delivery codes
    (e.g. ``'1w'`` stumpings, ``'2w'`` run-outs excluded).

    Parameters
    ----------
    df:
        Normalized ball-by-ball DataFrame.
    group_by_season:
        Break down by season when ``True``.

    Returns
    -------
    pd.DataFrame
        Columns: ``['bowler', 'wickets']`` or ``['bowler', 'season', 'wickets']``.
    """
    mask: pd.Series = is_bowler_wicket(df)
    wicket_df: pd.DataFrame = df[mask].copy()
    group_cols: list[str] = ["bowler"] + (["season"] if group_by_season else [])
    return (
        wicket_df.groupby(group_cols)
        .size()
        .reset_index(name="wickets")
        .sort_values("wickets", ascending=False)
        .reset_index(drop=True)
    )


def compute_economy_rate(
    df: pd.DataFrame,
    *,
    group_by_season: bool = False,
    min_overs: float = 1.0,
) -> pd.DataFrame:
    """Bowler economy rate = runs_conceded / overs_bowled.

    Runs conceded includes no-ball and wide penalties but excludes byes/leg-byes
    (ICC Scorers' Handbook §4.2).

    Parameters
    ----------
    df:
        Normalized ball-by-ball DataFrame.
    group_by_season:
        Stratify by season.
    min_overs:
        Minimum overs bowled threshold.

    Returns
    -------
    pd.DataFrame
        Columns: ``['bowler', 'runs_conceded', 'legal_balls', 'overs', 'economy']``.
    """
    group_cols: list[str] = ["bowler"] + (["season"] if group_by_season else [])

    # Runs conceded = batsman_runs + wide_runs + noball_runs (NOT byes/legbyes)
    df = df.copy()
    df["_runs_conceded"] = df["batsman_runs"] + df["wide_runs"] + df["noball_runs"]

    # Legal balls = deliveries that are NOT wides or no-balls
    legal: pd.DataFrame = df[(df["wide_runs"] == 0) & (df["noball_runs"] == 0)]
    legal_balls = legal.groupby(group_cols).size().reset_index(name="legal_balls")

    runs = (
        df.groupby(group_cols, as_index=False)
        .agg(runs_conceded=("_runs_conceded", "sum"))
    )
    result = runs.merge(legal_balls, on=group_cols, how="left")
    result["legal_balls"] = result["legal_balls"].fillna(0).astype("int64")
    result["overs"] = (result["legal_balls"] // 6) + (result["legal_balls"] % 6) / 10
    result = result[result["overs"] >= min_overs]
    result["economy"] = (result["runs_conceded"] / (result["legal_balls"] / 6)).round(2)
    return result.sort_values("economy").reset_index(drop=True)


# ---------------------------------------------------------------------------
# CLI helper — run all aggregations and print summaries
# ---------------------------------------------------------------------------

def _print_section(title: str, df: pd.DataFrame, n: int = 10) -> None:
    separator = "─" * 70
    print(f"\n{separator}")
    print(f"  {title}")
    print(separator)
    print(df.head(n).to_string(index=False))


def main() -> None:
    """Quick CLI smoke-test: load normalized CSV, print top-10 for each metric."""
    import sys
    from pathlib import Path

    csv_path = Path("data/processed/combined/merged_npl_2024_2025.csv")
    if not csv_path.exists():
        print(f"[ERROR] Master CSV not found: {csv_path}", file=sys.stderr)
        sys.exit(1)

    print(f"[cricket_stats] Loading {csv_path} …")
    df = pd.read_csv(csv_path, low_memory=False)

    # Defensive check: ensure normalization has been run
    if "season" not in df.columns:
        print("[cricket_stats] 'season' column missing — run normalize_master_csv.py first.")
        sys.exit(1)

    _print_section("Top 10 Run-scorers (all seasons)", compute_batter_runs(df))
    _print_section("Top 10 Fours-hitters", compute_boundaries(df, 4))
    _print_section("Top 10 Six-hitters", compute_boundaries(df, 6))
    _print_section("Top 10 Wicket-takers (bowler credited only)", compute_bowler_wickets(df))
    _print_section("Top 10 Batting Averages (min 3 dismissals)", compute_batting_average(df))
    _print_section("Top 10 Lowest Economy Rates (min 1 over)", compute_economy_rate(df))


if __name__ == "__main__":
    main()
