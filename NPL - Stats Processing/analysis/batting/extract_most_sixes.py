"""
Batter six-boundary counts across both NPL seasons.

BUG FIX (Nov 2026): previously used `total_runs == 6` which could include
6-runs off no-ball extras as a batter boundary. Now uses `batsman_runs == 6`
per ICC rule (bat-off-bat only).
"""
import pandas as pd
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.cricket_stats import compute_boundaries

all_seasons_data = pd.read_csv("data/processed/combined/merged_npl_2024_2025.csv")
df_data = pd.DataFrame(all_seasons_data)

# ICC-correct: batsman_runs == 6 only
sixes_df = compute_boundaries(df_data, 6, group_by_season=False)

print(f"Total boundaries (6s): {sixes_df['sixes'].sum()}")
print(sixes_df.head(20))

sixes_df.to_csv("outputs/batting/players_sixes_count.csv", index=False)

#saving the total sixes count by all players in a csv file path = data/processed/combined/players_sixes_count.csv
season_sixes.to_csv("outputs/batting/players_sixes_count.csv", index=False)