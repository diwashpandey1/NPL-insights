"""
src/normalize_master_csv.py
============================
Phase 1, Step 2 — Zero-error schema normalization of the master merged CSV.

Operations performed (in order)
--------------------------------
1. Load ``data/processed/combined/merged_npl_2024_2025.csv``.
2. Parse ``match_id`` → extract an explicit integer ``season`` column
   (2024 or 2025) and an integer ``match_number`` column.
3. Lowercase + strip whitespace on all categorical string columns:
   ``dismissal_kind``, ``ball_result``, ``batting_team``, ``bowling_team``,
   ``batsman``, ``bowler``, ``non_striker``, ``player_out``, ``fielders``.
4. Force integer types (``int64``) on all numeric delivery columns,
   filling any residual NaN with 0.
5. Write pristine CSV back to the same path (atomic write via tmp file).

The function ``normalize_master_csv`` is importable by other pipeline scripts.

Usage
-----
    python src/normalize_master_csv.py
    python src/normalize_master_csv.py --input path/to/input.csv --output path/to/out.csv
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
DEFAULT_INPUT: Path = Path("data/processed/combined/merged_npl_2024_2025.csv")
DEFAULT_OUTPUT: Path = DEFAULT_INPUT  # overwrites in-place

# Columns that should be cast to lowercase & stripped
_CATEGORICAL_STR_COLS: list[str] = [
    "dismissal_kind",
    "ball_result",
    "batting_team",
    "bowling_team",
    "batsman",
    "bowler",
    "non_striker",
    "player_out",
    "fielders",
    "shot_direction",
]

# Integer delivery-numeric columns (NaN → 0)
_INT_COLS: list[str] = [
    "batsman_runs",
    "total_runs",
    "wide_runs",
    "noball_runs",
    "bye_runs",
    "legbye_runs",
    "extra_runs",
    "inning",
]

# ---------------------------------------------------------------------------
# Core normalization
# ---------------------------------------------------------------------------

def _normalize_strings(df: pd.DataFrame, cols: list[str]) -> pd.DataFrame:
    """Lowercase and strip whitespace for each column in *cols* (skips missing cols)."""
    for col in cols:
        if col in df.columns:
            # Preserve NaN; convert only non-null strings
            mask = df[col].notna()
            df.loc[mask, col] = (
                df.loc[mask, col].astype(str).str.lower().str.strip()
            )
    return df


def _enforce_int_cols(df: pd.DataFrame, cols: list[str]) -> pd.DataFrame:
    """Fill NaN → 0 and cast to ``int64`` for every column in *cols*."""
    for col in cols:
        if col in df.columns:
            df[col] = df[col].fillna(0).astype("int64")
    return df


def _extract_season(df: pd.DataFrame) -> pd.DataFrame:
    """Parse ``match_id`` and add ``season`` (int) + ``match_number`` (int) columns.

    ``match_id`` format is ``{prefix}_{season}_{match_number}``
    e.g. ``1_2024_7`` → season=2024, match_number=7.
    """
    parts: pd.DataFrame = df["match_id"].str.split("_", expand=True)
    # parts[0] = source prefix, parts[1] = season year, parts[2] = match number
    df["season"] = parts[1].astype("int64")
    df["match_number"] = parts[2].astype("int64")
    return df


def normalize_master_csv(
    input_path: Path = DEFAULT_INPUT,
    output_path: Path = DEFAULT_OUTPUT,
    *,
    verbose: bool = True,
) -> pd.DataFrame:
    """Load, normalize, and save the master ball-by-ball CSV.

    Parameters
    ----------
    input_path:
        Path to the raw merged CSV.
    output_path:
        Destination path for the cleaned CSV. If equal to ``input_path`` the
        file is overwritten atomically.
    verbose:
        Print progress messages when ``True``.

    Returns
    -------
    pd.DataFrame
        The fully normalized DataFrame.

    Raises
    ------
    FileNotFoundError
        If ``input_path`` does not exist.
    ValueError
        If ``match_id`` cannot be parsed into expected season/match components.
    """
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    if verbose:
        print(f"[normalize] Loading → {input_path}")

    df: pd.DataFrame = pd.read_csv(input_path, low_memory=False)
    original_shape = df.shape

    if verbose:
        print(f"[normalize] Loaded  : {original_shape[0]:,} rows × {original_shape[1]} cols")

    # ------------------------------------------------------------------ 1. Season
    if verbose:
        print("[normalize] Extracting season and match_number from match_id …")
    df = _extract_season(df)

    season_counts = df["season"].value_counts().sort_index().to_dict()
    if verbose:
        print(f"[normalize] Season distribution (deliveries): {season_counts}")

    # ------------------------------------------------------------------ 2. Strings
    if verbose:
        print("[normalize] Lowercasing categorical string columns …")
    df = _normalize_strings(df, _CATEGORICAL_STR_COLS)

    # ------------------------------------------------------------------ 3. Int types
    if verbose:
        print("[normalize] Enforcing int64 on numeric delivery columns …")
    df = _enforce_int_cols(df, _INT_COLS)

    # ------------------------------------------------------------------ 4. Column order
    # Place season & match_number right after match_id for readability
    priority_cols = ["match_id", "season", "match_number"]
    remaining_cols = [c for c in df.columns if c not in priority_cols]
    df = df[priority_cols + remaining_cols]

    # ------------------------------------------------------------------ 5. Write
    tmp_path = output_path.with_suffix(".tmp.csv")
    df.to_csv(tmp_path, index=False)
    tmp_path.replace(output_path)

    if verbose:
        print(
            f"[normalize] ✓ Normalized CSV written → {output_path}\n"
            f"[normalize]   Final shape: {df.shape[0]:,} rows × {df.shape[1]} cols"
        )

    return df


# ---------------------------------------------------------------------------
# Entry-point
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(
        description="Normalize the NPL master ball-by-ball merged CSV."
    )
    parser.add_argument(
        "--input",
        type=Path,
        default=DEFAULT_INPUT,
        help="Input CSV path (default: %(default)s).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="Output CSV path — same as input = overwrite (default: %(default)s).",
    )
    parser.add_argument("--quiet", action="store_true", help="Suppress progress output.")
    args = parser.parse_args()

    try:
        normalize_master_csv(args.input, args.output, verbose=not args.quiet)
    except (FileNotFoundError, ValueError) as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
