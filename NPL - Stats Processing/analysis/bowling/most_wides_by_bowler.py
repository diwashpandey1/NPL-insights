import pandas as pd

# Load data
all_seasons_data = pd.read_csv("data/processed/combined/merged_npl_2024_2025.csv")
df_data = pd.DataFrame(all_seasons_data)

# Filter deliveries containing wides
wides_df = df_data[df_data['wide_runs'] > 0].copy()

# Group by bowler and calculate wide statistics
bowler_wides_summary = (
    wides_df.groupby('bowler')
    .agg(
        wide_counts=('wide_runs', 'size'),
        wide_run_counts=('wide_runs', 'sum')
    )
    .reset_index()
    .sort_values(by='wide_counts', ascending=False)
    .reset_index(drop=True)
)

# Display results
print(bowler_wides_summary.head(20).to_string(index=False))

# Export results
bowler_wides_summary.to_csv(
    'outputs/bowling/bowler_wide_stats.csv',
    index=False
)

print("\nBowler wide statistics exported successfully!")