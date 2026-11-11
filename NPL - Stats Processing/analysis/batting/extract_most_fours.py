"""
Batter four-boundary counts across both NPL seasons.

BUG FIX (Nov 2026): previously used `total_runs == 4` which incorrectly
counted 4-wide and 4-bye extras as boundaries for the batter. Now uses
`batsman_runs == 4` per ICC rule (bat-off-bat only).
"""
import pandas as pd
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.cricket_stats import compute_boundaries
from data_provider.data_provider import load_data

all_seasons_data = load_data("data/processed/combined/merged_npl_2024_2025.csv")
df_data = pd.DataFrame(all_seasons_data)

# ICC-correct: batsman_runs == 4 only (excludes 4-wides, 4-byes)
fours_df = compute_boundaries(df_data, 4, group_by_season=False)

print(f"Total boundaries (4s): {fours_df['fours'].sum()}")
print(fours_df.head(20))

fours_df.to_csv("outputs/batting/players_fours_count.csv", index=False)

print(season_fours)

#saving the total fours count by all players in a csv file path = data/processed/combined/players_fours_count.csv
season_fours.to_csv("outputs/batting/players_fours_count.csv", index=False)