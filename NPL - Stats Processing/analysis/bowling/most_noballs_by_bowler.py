import pandas as pd

# Load data
all_seasons_data = pd.read_csv("data/processed/combined/merged_npl_2024_2025.csv")
df_data = pd.DataFrame(all_seasons_data)

# Filter deliveries containing no-balls
no_balls_df = df_data[df_data['noball_runs'] > 0].copy()

# Calculate no-ball statistics for each bowler
noball_stats = (
    no_balls_df.groupby('bowler')
    .agg(
        noball_count=('noball_runs', 'size'),
        noball_runs_conceded=('noball_runs', 'sum'),
        total_runs_conceded=('total_runs', 'sum')
    )
    .reset_index()
    .sort_values('noball_count', ascending=False)
    .reset_index(drop=True)
)

# Display results
print(noball_stats.to_string(index=False))

# Export statistics
noball_stats.to_csv(
    "outputs/bowling/bowler_noball_stats.csv",
    index=False
)

print("\nNo-ball statistics exported successfully!")