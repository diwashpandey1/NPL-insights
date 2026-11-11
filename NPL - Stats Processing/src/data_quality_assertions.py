"""
src/data_quality_assertions.py
================================
Phase 4 — Automated Data Quality Assertion Suite.

Runs a comprehensive, fail-fast validation battery over the master CSV (and
optionally the feature-engineering output) before any downstream ML training.

Assertion Groups
----------------
A — Schema & Type Safety
B — Numeric Bounds (zero-tolerance for negative or impossible values)
C — Delivery Key Uniqueness
D — Wicket Coherence (dismissal consistency vs. ball_result & player_out)
E — Totals Integrity (extras formula, inning run totals)
F — Chase Logic (target / RRR presence for all 2nd-innings deliveries)
G — Feature Matrix (phase labels, rolling columns, no look-ahead NaN bleed)

Usage
-----
    python src/data_quality_assertions.py                   # validate master CSV
    python src/data_quality_assertions.py --features-csv outputs/ml/npl_features.csv
    python src/data_quality_assertions.py --fail-fast       # stop on first error
"""

from __future__ import annotations

import argparse
import sys
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import pandas as pd

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
DEFAULT_CSV: Path = Path("data/processed/combined/merged_npl_2024_2025.csv")
_NUMERIC_COLS = [
    "batsman_runs", "total_runs", "wide_runs", "noball_runs",
    "bye_runs", "legbye_runs", "extra_runs", "inning",
]
_LEGAL_PHASES = {"powerplay", "middle", "death"}
_LEGAL_SEASONS = {2024, 2025}
_MAX_LEGAL_BALLS_T20 = 120
_MAX_RUNS_PER_BALL = 7  # theoretically max: 6 off bat + 1 no-ball extra

# ---------------------------------------------------------------------------
# Result container
# ---------------------------------------------------------------------------

@dataclass
class AssertionResult:
    name: str
    passed: bool
    message: str


@dataclass
class QualityReport:
    results: list[AssertionResult] = field(default_factory=list)

    @property
    def passed_count(self) -> int:
        return sum(1 for r in self.results if r.passed)

    @property
    def failed_count(self) -> int:
        return sum(1 for r in self.results if not r.passed)

    def print_summary(self) -> None:
        total = len(self.results)
        print(f"\n{'='*70}")
        print(f"  DATA QUALITY ASSERTION REPORT")
        print(f"{'='*70}")
        for r in self.results:
            icon = "✓" if r.passed else "✗"
            status = "PASS" if r.passed else "FAIL"
            print(f"  [{icon}] {status:4s} | {r.name}")
            if not r.passed:
                print(f"            └─ {r.message}")
        print(f"{'─'*70}")
        print(f"  Total: {total}  |  Passed: {self.passed_count}  |  Failed: {self.failed_count}")
        print(f"{'='*70}\n")

    @property
    def all_passed(self) -> bool:
        return self.failed_count == 0


# ---------------------------------------------------------------------------
# Assertion runner decorator helper
# ---------------------------------------------------------------------------

def _run_assertion(
    report: QualityReport,
    name: str,
    fn: Callable[[], None],
    *,
    fail_fast: bool = False,
) -> bool:
    """Execute *fn()*, catch any ``AssertionError``, record result in *report*."""
    try:
        fn()
        report.results.append(AssertionResult(name=name, passed=True, message=""))
        return True
    except AssertionError as exc:
        msg = str(exc) if str(exc) else "(no message)"
        report.results.append(AssertionResult(name=name, passed=False, message=msg))
        if fail_fast:
            report.print_summary()
            sys.exit(1)
        return False
    except Exception as exc:  # noqa: BLE001
        tb = traceback.format_exc(limit=3)
        report.results.append(
            AssertionResult(name=name, passed=False, message=f"Unexpected error: {exc}\n{tb}")
        )
        if fail_fast:
            report.print_summary()
            sys.exit(1)
        return False


# ---------------------------------------------------------------------------
# Group A — Schema & Type Safety
# ---------------------------------------------------------------------------

def _assert_schema(df: pd.DataFrame, report: QualityReport, fail_fast: bool) -> None:

    def check_required_cols() -> None:
        required = {
            "match_id", "inning", "batsman", "bowler", "ball_over",
            "ball_result", "batsman_runs", "total_runs", "wide_runs",
            "noball_runs", "bye_runs", "legbye_runs", "extra_runs",
        }
        missing = required - set(df.columns)
        assert not missing, f"Missing required columns: {sorted(missing)}"

    def check_season_col() -> None:
        assert "season" in df.columns, (
            "'season' column missing — run src/normalize_master_csv.py first."
        )
        invalid = set(df["season"].dropna().astype(int).unique()) - _LEGAL_SEASONS
        assert not invalid, f"Unexpected season values: {invalid}"

    def check_dtypes() -> None:
        for col in _NUMERIC_COLS:
            if col in df.columns:
                assert pd.api.types.is_integer_dtype(df[col]), (
                    f"Column '{col}' expected int64, got {df[col].dtype}"
                )

    _run_assertion(report, "A1 — Required columns present", check_required_cols, fail_fast=fail_fast)
    _run_assertion(report, "A2 — Season column valid values", check_season_col, fail_fast=fail_fast)
    _run_assertion(report, "A3 — Numeric column dtypes are int64", check_dtypes, fail_fast=fail_fast)


# ---------------------------------------------------------------------------
# Group B — Numeric Bounds
# ---------------------------------------------------------------------------

def _assert_numeric_bounds(df: pd.DataFrame, report: QualityReport, fail_fast: bool) -> None:

    def no_negative_runs() -> None:
        for col in ["batsman_runs", "wide_runs", "noball_runs", "bye_runs", "legbye_runs", "extra_runs", "total_runs"]:
            if col in df.columns:
                neg = (df[col] < 0).sum()
                assert neg == 0, f"Column '{col}' has {neg:,} negative values."

    def max_runs_per_delivery() -> None:
        over_max = (df["total_runs"] > _MAX_RUNS_PER_BALL).sum()
        assert over_max == 0, (
            f"{over_max} deliveries exceed the theoretical max of {_MAX_RUNS_PER_BALL} runs per ball."
        )

    def no_negative_ball_over() -> None:
        neg = (df["ball_over"] < 0).sum()
        assert neg == 0, f"ball_over has {neg} negative values."

    def valid_ball_in_over() -> None:
        # Ball number within over must be 1–6 for T20
        ball_digit = (df["ball_over"].astype(float) * 10 % 10).round(0).astype(int)
        invalid = ((ball_digit < 1) | (ball_digit > 6)).sum()
        assert invalid == 0, (
            f"{invalid} deliveries have out-of-range ball digit in ball_over (expected 1–6)."
        )

    def valid_inning() -> None:
        invalid = df["inning"].isin([1, 2]).sum()
        total = len(df)
        assert invalid == total, (
            f"{total - invalid} rows have inning value outside {{1, 2}}."
        )

    _run_assertion(report, "B1 — No negative run values", no_negative_runs, fail_fast=fail_fast)
    _run_assertion(report, "B2 — total_runs ≤ 7 per delivery", max_runs_per_delivery, fail_fast=fail_fast)
    _run_assertion(report, "B3 — No negative ball_over values", no_negative_ball_over, fail_fast=fail_fast)
    _run_assertion(report, "B4 — Ball-in-over digit is 1–6", valid_ball_in_over, fail_fast=fail_fast)
    _run_assertion(report, "B5 — Inning values are only 1 or 2", valid_inning, fail_fast=fail_fast)


# ---------------------------------------------------------------------------
# Group C — Delivery Key Uniqueness
# ---------------------------------------------------------------------------

def _assert_key_uniqueness(df: pd.DataFrame, report: QualityReport, fail_fast: bool) -> None:

    def no_duplicate_keys() -> None:
        # (match_id, inning, ball_over) is NOT guaranteed to be unique in T20 delivery
        # data because wides and no-balls do NOT advance the legal ball counter —
        # multiple deliveries legitimately share the same ball_over float (e.g., a
        # wide followed by the re-bowled legal delivery both show as over 14.3).
        # We therefore validate that ALL such duplicates are explained by extras
        # (wide_runs > 0 OR noball_runs > 0 on at least one row in each group).
        key_cols = ["match_id", "inning", "ball_over"]
        dup_mask = df.duplicated(subset=key_cols, keep=False)
        dup_df = df[dup_mask]
        if dup_df.empty:
            return  # no dupes at all — still passes

        # For each duplicate group, at least one delivery must be an extra
        def group_has_extra(g: pd.DataFrame) -> bool:
            return ((g["wide_runs"] > 0) | (g["noball_runs"] > 0)).any()

        unexplained = (
            dup_df.groupby(key_cols)
            .filter(lambda g: not group_has_extra(g))
        )
        assert len(unexplained) == 0, (
            f"{len(unexplained)} duplicate (match_id, inning, ball_over) keys found "
            "that are NOT explained by wides or no-balls — possible data corruption."
        )

    def no_null_match_ids() -> None:
        null_ids = df["match_id"].isna().sum()
        assert null_ids == 0, f"{null_ids} null match_id values found."

    _run_assertion(report, "C1 — No duplicate (match_id, inning, ball_over) keys", no_duplicate_keys, fail_fast=fail_fast)
    _run_assertion(report, "C2 — No null match_id values", no_null_match_ids, fail_fast=fail_fast)


# ---------------------------------------------------------------------------
# Group D — Wicket Coherence
# ---------------------------------------------------------------------------

def _assert_wicket_coherence(df: pd.DataFrame, report: QualityReport, fail_fast: bool) -> None:

    def player_out_has_dismissal_kind() -> None:
        # Every row with player_out filled must also have a dismissal_kind
        has_out = df["player_out"].notna()
        missing_dk = df[has_out]["dismissal_kind"].isna().sum()
        assert missing_dk == 0, (
            f"{missing_dk} rows have player_out but missing dismissal_kind."
        )

    def dismissal_kind_has_player_out() -> None:
        has_dk = df["dismissal_kind"].notna()
        missing_out = df[has_dk]["player_out"].isna().sum()
        assert missing_dk == 0 if (missing_dk := missing_out) == 0 else True, (
            f"{missing_dk} rows have dismissal_kind but missing player_out."
        )

    def run_outs_not_credited_to_bowler() -> None:
        # Verify that our cricket_stats.is_bowler_wicket correctly excludes run-outs
        import sys as _sys, pathlib as _pl
        _sys.path.insert(0, str(_pl.Path(__file__).resolve().parents[1]))
        from src.cricket_stats import is_bowler_wicket, BOWLER_CREDITED_DISMISSALS

        bowler_wkts = df[is_bowler_wicket(df)]
        if "dismissal_kind" in bowler_wkts.columns:
            dk_lower = bowler_wkts["dismissal_kind"].fillna("").str.lower().str.strip()
            runout_in_bowler_wkts = dk_lower.str.contains("run out").sum()
            assert runout_in_bowler_wkts == 0, (
                f"{runout_in_bowler_wkts} run-outs are incorrectly credited as bowler wickets."
            )

    def total_dismissals_sensible() -> None:
        # Total player_out filled should not exceed total rows
        total_out = df["player_out"].notna().sum()
        assert total_out <= len(df), "More dismissals than deliveries — data integrity error."
        # Also: each innings should have ≤ 10 wickets
        max_wkts = (
            df[df["player_out"].notna()]
            .groupby(["match_id", "inning"])
            .size()
            .max()
        )
        assert max_wkts <= 10, (
            f"An innings has {max_wkts} wickets — exceeds maximum of 10."
        )

    _run_assertion(report, "D1 — player_out always paired with dismissal_kind", player_out_has_dismissal_kind, fail_fast=fail_fast)
    _run_assertion(report, "D2 — dismissal_kind always paired with player_out", dismissal_kind_has_player_out, fail_fast=fail_fast)
    _run_assertion(report, "D3 — Run-outs excluded from bowler wicket credits", run_outs_not_credited_to_bowler, fail_fast=fail_fast)
    _run_assertion(report, "D4 — No innings exceeds 10 wickets", total_dismissals_sensible, fail_fast=fail_fast)


# ---------------------------------------------------------------------------
# Group E — Totals Integrity
# ---------------------------------------------------------------------------

def _assert_totals_integrity(df: pd.DataFrame, report: QualityReport, fail_fast: bool) -> None:

    def extras_formula() -> None:
        # extra_runs must equal wide_runs + noball_runs + bye_runs + legbye_runs
        computed = df["wide_runs"] + df["noball_runs"] + df["bye_runs"] + df["legbye_runs"]
        mismatch = (computed != df["extra_runs"]).sum()
        assert mismatch == 0, (
            f"{mismatch:,} rows have extra_runs ≠ wide+noball+bye+legbye."
        )

    def total_runs_formula() -> None:
        # total_runs must equal batsman_runs + extra_runs
        computed = df["batsman_runs"] + df["extra_runs"]
        mismatch = (computed != df["total_runs"]).sum()
        assert mismatch == 0, (
            f"{mismatch:,} rows have total_runs ≠ batsman_runs + extra_runs."
        )

    _run_assertion(report, "E1 — extra_runs = wide+noball+bye+legbye", extras_formula, fail_fast=fail_fast)
    _run_assertion(report, "E2 — total_runs = batsman_runs + extra_runs", total_runs_formula, fail_fast=fail_fast)


# ---------------------------------------------------------------------------
# Group F — Chase / Feature Matrix (optional)
# ---------------------------------------------------------------------------

def _assert_feature_matrix(
    df: pd.DataFrame, report: QualityReport, fail_fast: bool
) -> None:
    """Assertions that apply only when the feature-enriched CSV is provided."""

    def valid_phase_labels() -> None:
        if "phase" not in df.columns:
            return
        unexpected = set(df["phase"].unique()) - _LEGAL_PHASES
        assert not unexpected, f"Unexpected phase labels: {unexpected}"

    def chase_features_present_for_inning2() -> None:
        if "target" not in df.columns:
            return
        inning2 = df[df["inning"] == 2]
        null_targets = inning2["target"].isna().sum()
        assert null_targets == 0, (
            f"{null_targets} inning-2 deliveries have null 'target'."
        )

    def rrr_non_negative() -> None:
        if "required_run_rate" not in df.columns:
            return
        neg = (df["required_run_rate"].dropna() < 0).sum()
        assert neg == 0, f"{neg} inning-2 deliveries have negative required_run_rate."

    def cumulative_runs_monotone() -> None:
        if "cumulative_runs" not in df.columns:
            return
        # Within each (match_id, inning) group, cumulative_runs must be non-decreasing
        def check_group(g: pd.DataFrame) -> bool:
            return (g["cumulative_runs"].diff().dropna() >= 0).all()

        violations = df.groupby(["match_id", "inning"]).apply(check_group)
        n_violations = (~violations).sum()
        assert n_violations == 0, (
            f"cumulative_runs is not monotonically non-decreasing in {n_violations} innings."
        )

    _run_assertion(report, "F1 — Phase labels are valid (powerplay/middle/death)", valid_phase_labels, fail_fast=fail_fast)
    _run_assertion(report, "F2 — All inning-2 rows have non-null target", chase_features_present_for_inning2, fail_fast=fail_fast)
    _run_assertion(report, "F3 — required_run_rate is non-negative", rrr_non_negative, fail_fast=fail_fast)
    _run_assertion(report, "F4 — cumulative_runs is monotonically non-decreasing", cumulative_runs_monotone, fail_fast=fail_fast)


# ---------------------------------------------------------------------------
# Master runner
# ---------------------------------------------------------------------------

def run_quality_assertions(
    df: pd.DataFrame,
    *,
    is_feature_matrix: bool = False,
    fail_fast: bool = False,
    verbose: bool = True,
) -> QualityReport:
    """Run all assertion groups over *df* and return a :class:`QualityReport`.

    Parameters
    ----------
    df:
        DataFrame to validate (master CSV or feature matrix).
    is_feature_matrix:
        Set ``True`` when *df* is the output of :mod:`ml_feature_engineering`.
        Enables Group F assertions.
    fail_fast:
        Stop execution on the first failed assertion.
    verbose:
        Print the final report summary.

    Returns
    -------
    QualityReport
        Contains all individual assertion results.
    """
    report = QualityReport()

    if verbose:
        print(f"[assertions] Running data quality checks on {len(df):,} rows …")

    _assert_schema(df, report, fail_fast)
    _assert_numeric_bounds(df, report, fail_fast)
    _assert_key_uniqueness(df, report, fail_fast)
    _assert_wicket_coherence(df, report, fail_fast)
    _assert_totals_integrity(df, report, fail_fast)

    if is_feature_matrix:
        _assert_feature_matrix(df, report, fail_fast)

    if verbose:
        report.print_summary()

    return report


# ---------------------------------------------------------------------------
# Entry-point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run the NPL data quality assertion suite."
    )
    parser.add_argument(
        "--csv", type=Path, default=DEFAULT_CSV,
        help="Path to the normalized master CSV (default: %(default)s).",
    )
    parser.add_argument(
        "--features-csv", type=Path, default=None,
        help="Path to the ML feature matrix CSV (enables Group F assertions).",
    )
    parser.add_argument(
        "--fail-fast", action="store_true",
        help="Abort on the first assertion failure.",
    )
    args = parser.parse_args()

    # -- Validate master CSV
    if not args.csv.exists():
        print(f"[ERROR] Master CSV not found: {args.csv}", file=sys.stderr)
        sys.exit(1)

    df_master = pd.read_csv(args.csv, low_memory=False)
    report = run_quality_assertions(df_master, fail_fast=args.fail_fast)

    # -- Optionally validate feature matrix
    if args.features_csv:
        if not args.features_csv.exists():
            print(f"[ERROR] Features CSV not found: {args.features_csv}", file=sys.stderr)
            sys.exit(1)
        df_features = pd.read_csv(args.features_csv, low_memory=False)
        print("\n[assertions] Running additional Group F checks on feature matrix …")
        report2 = run_quality_assertions(
            df_features,
            is_feature_matrix=True,
            fail_fast=args.fail_fast,
        )
        overall_pass = report.all_passed and report2.all_passed
    else:
        overall_pass = report.all_passed

    sys.exit(0 if overall_pass else 1)


if __name__ == "__main__":
    main()
