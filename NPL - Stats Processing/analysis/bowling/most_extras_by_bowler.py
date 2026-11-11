import pandas as pd
import numpy as np

# Load data
all_seasons_data = pd.read_csv("data/processed/combined/merged_npl_2024_2025.csv")
df_data = pd.DataFrame(all_seasons_data)

# Filter deliveries containing extras
extras_df = df_data[df_data['extra_runs'] > 0].copy()

# Count extras and calculate total extra runs conceded by each bowler
extras_stats = (
    extras_df.groupby('bowler')
    .agg(
        extras_count=('extra_runs', 'size'),
        total_extra_runs=('extra_runs', 'sum')
    )
    .reset_index()
    .sort_values('total_extra_runs', ascending=False)
)

# Display results
print(extras_stats.to_string(index=False))

# Export results
extras_stats.to_csv(
    "outputs/bowling/bowler_extras_stats.csv",
    index=False
)

print("\nBowler extras statistics exported successfully!")