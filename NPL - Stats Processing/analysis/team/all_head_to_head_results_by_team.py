import pandas as pd
import numpy as np

# Load match-level data
all_matches_data = pd.read_csv(
    "data/raw/source_repositories/user_provided_archive/NPL-matches.csv"
)

all_matches_df = pd.DataFrame(all_matches_data)

# Standardize team pairs so each matchup is grouped together
team_pairs = np.sort(
    all_matches_df[['team_1', 'team_2']].astype(str).values,
    axis=1
)

all_matches_df['team_a'] = team_pairs[:, 0]
all_matches_df['team_b'] = team_pairs[:, 1]

# Count wins for each team in the matchup
all_matches_df['team_a_wins'] = (
    all_matches_df['winner'] == all_matches_df['team_a']
).astype(int)

all_matches_df['team_b_wins'] = (
    all_matches_df['winner'] == all_matches_df['team_b']
).astype(int)

# Calculate head-to-head results
head_to_head_df = (
    all_matches_df.groupby(['team_a', 'team_b'])
    .agg(
        total_matches=('id', 'count'),
        team_a_wins=('team_a_wins', 'sum'),
        team_b_wins=('team_b_wins', 'sum')
    )
    .reset_index()
)

# Calculate losses for each team
head_to_head_df['team_a_losses'] = head_to_head_df['team_b_wins']
head_to_head_df['team_b_losses'] = head_to_head_df['team_a_wins']

# Sort by total matches played
# Sort by team_a in ascending alphabetical order
head_to_head_df = head_to_head_df.sort_values(
    by='team_a',
    ascending=True
).reset_index(drop=True)

# Display results
print(head_to_head_df.to_string(index=False))

# Export results
head_to_head_df.to_csv(
    "outputs/team/all_head_to_head_results.csv",
    index=False
)

print("\nHead-to-head statistics exported successfully!")