"""
Batter career run totals across both NPL seasons.

BUG FIX (Nov 2026): previously used `total_runs` which inflated batter
tallies with wides, no-balls, byes, and leg-byes. Now uses `batsman_runs`
exclusively per ICC statistical convention.
"""
import pandas as pd
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.cricket_stats import compute_batter_runs

all_seasons_data = pd.read_csv("data/processed/combined/merged_npl_2024_2025.csv")

# ICC-correct: aggregate batsman_runs only (extras excluded from personal tally)
total_runs_df = compute_batter_runs(all_seasons_data, group_by_season=False)

print(total_runs_df)

total_runs_df.to_csv("outputs/batting/players_total_runs_count.csv", index=False)

