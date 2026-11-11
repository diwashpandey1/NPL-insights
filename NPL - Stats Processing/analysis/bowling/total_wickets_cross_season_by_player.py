"""
Bowler wicket tallies across both NPL seasons.

BUG FIX (Nov 2026): previously filtered strictly on `ball_result == 'W'`,
silently dropping 3 legitimate stumpings recorded on `ball_result == '1W'`
deliveries. Now uses `src.cricket_stats.compute_bowler_wickets` which
evaluates dismissal_kind membership in the ICC bowler-credited set across
ALL composite ball_result codes.
"""
import pandas as pd
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.cricket_stats import compute_bowler_wickets

all_seasons_data = pd.read_csv("data/processed/combined/merged_npl_2024_2025.csv")
df_data = pd.DataFrame(all_seasons_data)

# ICC-correct: all bowler-credited dismissals, run-outs excluded
bowler_wickets = compute_bowler_wickets(df_data, group_by_season=False)

print("Top 20 wicket-takers:")
print(bowler_wickets.head(20).to_string(index=False))

bowler_wickets.to_csv("outputs/bowling/players_wickets_count.csv", index=False)

bowler_wickets.to_csv('outputs/bowling/players_wickets_count.csv', index=False)