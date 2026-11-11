"""
src/ml_feature_engineering.py
==============================
Phase 3 — Advanced ML Feature Engineering Suite.

Transforms the NPL ball-by-ball stream into a rich, model-ready feature matrix
for predictive cricket analytics. All features are engineered on the
*normalized* master CSV produced by ``src/normalize_master_csv.py``.

Feature Groups
--------------
1. **Match Phase**
   - ``phase``       : Categorical — 'powerplay' | 'middle' | 'death'
   - ``over_int``    : Integer over number (0–19) derived from ``ball_over``

2. **Delivery Context** (ball-level within-match running state)
   - ``cumulative_runs``             : Running total runs in the innings up to and including this ball
   - ``cumulative_wickets``          : Running total wickets in the innings
   - ``balls_bowled_in_innings``     : Legal ball count within the innings (excludes wides/no-balls)
   - ``balls_remaining_in_innings``  : 120 - balls_bowled_in_innings (T20 regulation)
   - ``current_run_rate``            : CRR = cumulative_runs / (balls_bowled / 6)

3. **Second-Innings Chase Features** (populated for inning == 2)
   - ``target``                      : Total runs scored by batting team in inning 1 + 1
   - ``runs_required``               : target - cumulative_runs
   - ``required_run_rate``           : RRR = runs_required / (balls_remaining / 6)

4. **Player Rolling / Career Features** (computed up-to-but-not-including each ball)
   - ``batter_career_runs``          : Cumulative batsman_runs across ALL prior deliveries
   - ``batter_career_balls``         : Legal balls faced prior to this delivery
   - ``batter_career_sr``            : Career strike rate up to this ball
   - ``bowler_career_wickets``       : Legitimate wickets taken prior to this delivery
   - ``bowler_career_legal_balls``   : Legal balls bowled
   - ``bowler_career_runs_conceded`` : Runs conceded (bat + wide + nb) prior to this ball
   - ``bowler_career_economy``       : Economy rate up to this ball
   - ``batter_ewma_sr``              : EWMA (span=10 balls) of batter strike rate
   - ``bowler_ewma_economy``         : EWMA (span=10 balls) of bowler economy rate

Usage
-----
    python src/ml_feature_engineering.py                    # run full pipeline
    python src/ml_feature_engineering.py --output features.csv
    python src/ml_feature_engineering.py --no-rolling       # skip heavy rolling calcs
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
DEFAULT_INPUT: Path = Path("data/processed/combined/merged_npl_2024_2025.csv")
DEFAULT_OUTPUT: Path = Path("outputs/ml/npl_features.csv")

# T20 regulation: 20 overs × 6 legal deliveries per over
_T20_LEGAL_BALLS: int = 120

# Phase breakpoints (by integer over: 0–19)
_POWERPLAY_END: int = 5     # overs 0–5 inclusive (first 6 overs)
_MIDDLE_END: int = 14        # overs 6–14 inclusive

# EWMA span for rolling player metrics
_EWMA_SPAN: int = 10


# ---------------------------------------------------------------------------
# Helper: parse over integer from ball_over float notation
# ---------------------------------------------------------------------------

def _over_int(ball_over: pd.Series) -> pd.Series:
    """Extract integer over from float notation (e.g. 14.4 → 14)."""
    return ball_over.astype(float).astype(int)


def _ball_in_over(ball_over: pd.Series) -> pd.Series:
    """Extract ball-in-over digit (e.g. 14.4 → 4)."""
    return (ball_over.astype(float) * 10 % 10).round(0).astype(int)


# ---------------------------------------------------------------------------
# Phase 1 of engineering: match phase categorization
# ---------------------------------------------------------------------------

def add_phase_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add ``over_int``, ``ball_in_over``, and ``phase`` columns.

    Parameters
    ----------
    df:
        Normalized ball-by-ball DataFrame.

    Returns
    -------
    pd.DataFrame
        Input DataFrame with 3 new columns appended in-place (copy).
    """
    df = df.copy()
    df["over_int"] = _over_int(df["ball_over"])
    df["ball_in_over"] = _ball_in_over(df["ball_over"])

    conditions = [
        df["over_int"] <= _POWERPLAY_END,
        (df["over_int"] > _POWERPLAY_END) & (df["over_int"] <= _MIDDLE_END),
    ]
    choices = ["powerplay", "middle"]
    df["phase"] = np.select(conditions, choices, default="death")

    return df


# ---------------------------------------------------------------------------
# Phase 2: contextual within-innings running state
# ---------------------------------------------------------------------------

def add_contextual_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add cumulative runs, wickets, ball counts, CRR per innings.

    Parameters
    ----------
    df:
        DataFrame with phase features added (from :func:`add_phase_features`).

    Returns
    -------
    pd.DataFrame
        New columns added.

    Notes
    -----
    The sort order within each (match_id, inning) group must be chronological
    (ascending ``ball_over``). The function enforces this internally.
    """
    df = df.copy()
    df = df.sort_values(["match_id", "inning", "ball_over"]).reset_index(drop=True)

    # --- Cumulative runs (uses total_runs which includes extras)
    df["cumulative_runs"] = (
        df.groupby(["match_id", "inning"])["total_runs"].cumsum()
    )

    # --- Cumulative wickets (using ICC bowler + run-out wickets = player_out not null)
    df["_is_wicket"] = df["player_out"].notna().astype(int)
    df["cumulative_wickets"] = (
        df.groupby(["match_id", "inning"])["_is_wicket"].cumsum()
    )

    # --- Legal ball counter (wides and no-balls do NOT count as legal deliveries)
    df["_is_legal"] = ((df["wide_runs"] == 0) & (df["noball_runs"] == 0)).astype(int)
    df["balls_bowled_in_innings"] = (
        df.groupby(["match_id", "inning"])["_is_legal"].cumsum()
    )
    df["balls_remaining_in_innings"] = (
        _T20_LEGAL_BALLS - df["balls_bowled_in_innings"]
    ).clip(lower=0)

    # --- Current Run Rate (CRR): avoid divide-by-zero on the very first ball
    overs_bowled = df["balls_bowled_in_innings"] / 6
    df["current_run_rate"] = np.where(
        overs_bowled > 0,
        (df["cumulative_runs"] / overs_bowled).round(2),
        0.0,
    )

    return df


# ---------------------------------------------------------------------------
# Phase 3: 2nd-innings chase features (target, RRR)
# ---------------------------------------------------------------------------

def add_chase_features(df: pd.DataFrame) -> pd.DataFrame:
    """Compute ``target``, ``runs_required``, and ``required_run_rate`` for inning 2.

    Parameters
    ----------
    df:
        DataFrame with contextual features (from :func:`add_contextual_features`).

    Returns
    -------
    pd.DataFrame
        New chase-specific columns (NaN for inning 1 rows).
    """
    df = df.copy()

    # Build inning-1 totals indexed by match_id
    inning1_totals: pd.Series = (
        df[df["inning"] == 1]
        .groupby("match_id")["total_runs"]
        .sum()
    )
    # target = inning_1_total + 1  (the extra run needed to WIN)
    target_map: pd.Series = inning1_totals + 1

    df["target"] = np.where(
        df["inning"] == 2,
        df["match_id"].map(target_map),
        np.nan,
    )
    df["runs_required"] = np.where(
        df["inning"] == 2,
        (df["target"] - df["cumulative_runs"]).clip(lower=0),
        np.nan,
    )

    # Required Run Rate — guard against 0 balls remaining
    balls_rem = df["balls_remaining_in_innings"]
    df["required_run_rate"] = np.where(
        (df["inning"] == 2) & (balls_rem > 0),
        (df["runs_required"] / (balls_rem / 6)).round(2),
        np.nan,
    )

    return df


# ---------------------------------------------------------------------------
# Phase 4: player rolling / career (up-to-this-ball) metrics
# ---------------------------------------------------------------------------

def add_player_rolling_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add cumulative career and EWMA rolling player statistics.

    All metrics are computed **up to but not including** the current delivery
    (look-ahead contamination prevention) using the ``shift(1)`` pattern on
    per-player cumulative columns.

    Parameters
    ----------
    df:
        DataFrame sorted chronologically by (match_id, inning, ball_over).

    Returns
    -------
    pd.DataFrame
        Player rolling feature columns appended.

    Warnings
    --------
    This function performs large GroupBy + cumsum operations. For the full NPL
    dataset (~15k rows) it runs in a few seconds. For much larger datasets
    consider chunking or Dask.
    """
    df = df.copy()

    # ---------------------------------------------------------------- Batter features
    # Cumulative runs — shift to get "before this ball" value
    df["_batter_cum_runs"] = (
        df.groupby("batsman")["batsman_runs"].cumsum().shift(1).fillna(0)
    )
    df["batter_career_runs"] = df["_batter_cum_runs"].astype(int)

    # Legal balls faced (wides don't count per ICC Rule 18.5)
    df["_legal_faced"] = ((df["wide_runs"] == 0)).astype(int)
    df["batter_career_balls"] = (
        df.groupby("batsman")["_legal_faced"].cumsum().shift(1).fillna(0).astype(int)
    )

    # Career strike rate up to this ball (guard div-by-zero)
    df["batter_career_sr"] = np.where(
        df["batter_career_balls"] > 0,
        (df["batter_career_runs"] / df["batter_career_balls"] * 100).round(2),
        np.nan,
    )

    # EWMA strike rate — per ball, on the binary outcome (run or not, per legal ball)
    df["_batter_ball_score"] = np.where(
        df["wide_runs"] == 0,
        df["batsman_runs"].astype(float),
        np.nan,
    )
    df["batter_ewma_sr"] = (
        df.groupby("batsman")["_batter_ball_score"]
        .transform(lambda s: s.ewm(span=_EWMA_SPAN, adjust=False).mean() * 100)
        .shift(1)
        .round(2)
    )

    # ---------------------------------------------------------------- Bowler features
    # Wickets taken
    import sys as _sys, pathlib as _pl
    _sys.path.insert(0, str(_pl.Path(__file__).resolve().parents[1]))
    from src.cricket_stats import is_bowler_wicket  # local import to avoid circularity

    df["_bwkts"] = is_bowler_wicket(df).astype(int)
    df["bowler_career_wickets"] = (
        df.groupby("bowler")["_bwkts"].cumsum().shift(1).fillna(0).astype(int)
    )

    # Legal balls bowled
    df["_legal_bowled"] = ((df["wide_runs"] == 0) & (df["noball_runs"] == 0)).astype(int)
    df["bowler_career_legal_balls"] = (
        df.groupby("bowler")["_legal_bowled"].cumsum().shift(1).fillna(0).astype(int)
    )

    # Runs conceded = batsman_runs + wide_runs + noball_runs
    df["_runs_conceded_ball"] = df["batsman_runs"] + df["wide_runs"] + df["noball_runs"]
    df["bowler_career_runs_conceded"] = (
        df.groupby("bowler")["_runs_conceded_ball"]
        .cumsum()
        .shift(1)
        .fillna(0)
        .astype(int)
    )

    # Career economy rate
    df["bowler_career_economy"] = np.where(
        df["bowler_career_legal_balls"] > 0,
        (df["bowler_career_runs_conceded"] / (df["bowler_career_legal_balls"] / 6)).round(2),
        np.nan,
    )

    # EWMA economy per ball (on runs conceded per legal delivery)
    df["_bowler_economy_ball"] = np.where(
        df["_legal_bowled"] == 1,
        df["_runs_conceded_ball"].astype(float) * 6,  # scale to per-over
        np.nan,
    )
    df["bowler_ewma_economy"] = (
        df.groupby("bowler")["_bowler_economy_ball"]
        .transform(lambda s: s.ewm(span=_EWMA_SPAN, adjust=False).mean())
        .shift(1)
        .round(2)
    )

    # ---------------------------------------------------------------- Drop working cols
    work_cols = [c for c in df.columns if c.startswith("_")]
    df = df.drop(columns=work_cols)

    return df


# ---------------------------------------------------------------------------
# Master pipeline
# ---------------------------------------------------------------------------

def build_feature_matrix(
    input_path: Path = DEFAULT_INPUT,
    output_path: Path = DEFAULT_OUTPUT,
    *,
    include_rolling: bool = True,
    verbose: bool = True,
) -> pd.DataFrame:
    """Run the full feature engineering pipeline and save the result.

    Parameters
    ----------
    input_path:
        Path to the normalized master ball-by-ball CSV.
    output_path:
        Destination path for the feature-enriched CSV.
    include_rolling:
        When ``False``, skip the computationally heavy rolling/EWMA features.
    verbose:
        Print progress messages.

    Returns
    -------
    pd.DataFrame
        Feature-enriched DataFrame.
    """
    if not input_path.exists():
        raise FileNotFoundError(f"Master CSV not found: {input_path}")

    t0 = time.perf_counter()

    if verbose:
        print(f"[features] Loading → {input_path}")
    df: pd.DataFrame = pd.read_csv(input_path, low_memory=False)

    if "season" not in df.columns:
        raise ValueError(
            "'season' column missing — run src/normalize_master_csv.py first."
        )

    if verbose:
        print(f"[features] Loaded   : {len(df):,} deliveries")

    if verbose:
        print("[features] Step 1/4 — Match phase features …")
    df = add_phase_features(df)

    if verbose:
        print("[features] Step 2/4 — Contextual innings state features …")
    df = add_contextual_features(df)

    if verbose:
        print("[features] Step 3/4 — 2nd-innings chase features …")
    df = add_chase_features(df)

    if include_rolling:
        if verbose:
            print("[features] Step 4/4 — Player rolling/EWMA features (may take a moment) …")
        df = add_player_rolling_features(df)
    else:
        if verbose:
            print("[features] Step 4/4 — Rolling features SKIPPED (--no-rolling).")

    # ---------------------------------------------------------------- Save
    output_path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(output_path, index=False)
    elapsed = time.perf_counter() - t0

    if verbose:
        print(
            f"[features] ✓ Feature matrix saved → {output_path}\n"
            f"[features]   Shape  : {df.shape[0]:,} rows × {df.shape[1]} cols\n"
            f"[features]   Elapsed: {elapsed:.1f}s"
        )

    return df


# ---------------------------------------------------------------------------
# Entry-point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build the NPL ML feature matrix from the normalized ball-by-ball CSV."
    )
    parser.add_argument(
        "--input", type=Path, default=DEFAULT_INPUT,
        help="Path to normalized master CSV (default: %(default)s).",
    )
    parser.add_argument(
        "--output", type=Path, default=DEFAULT_OUTPUT,
        help="Destination path for feature CSV (default: %(default)s).",
    )
    parser.add_argument(
        "--no-rolling", action="store_true",
        help="Skip rolling/EWMA player features (faster run, fewer columns).",
    )
    parser.add_argument("--quiet", action="store_true", help="Suppress progress output.")
    args = parser.parse_args()

    try:
        build_feature_matrix(
            args.input,
            args.output,
            include_rolling=not args.no_rolling,
            verbose=not args.quiet,
        )
    except (FileNotFoundError, ValueError) as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
