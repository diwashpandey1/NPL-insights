import numpy as np
import pandas as pd

# Load match data
all_matches_df = pd.read_csv(
    'data/raw/source_repositories/user_provided_archive/NPL-matches.csv'
)

# Create a separate record for each team's participation
team_1_df = all_matches_df[['team_1', 'winner']].rename(
    columns={'team_1': 'team'}
)

team_2_df = all_matches_df[['team_2', 'winner']].rename(
    columns={'team_2': 'team'}
)

teams_df = pd.concat([team_1_df, team_2_df], ignore_index=True)

# Identify wins, losses, and no-result matches
teams_df['result'] = np.select(
    [
        teams_df['winner'].eq(teams_df['team']),
        teams_df['winner'].isna() |
        teams_df['winner'].astype(str).str.strip().str.lower().isin(
            ['no result', 'nan', 'none', '']
        )
    ],
    ['win', 'no_result'],
    default='loss'
)

# Calculate overall team statistics
team_stats = (
    teams_df.groupby('team')
    .agg(
        wins=('result', lambda x: (x == 'win').sum()),
        losses=('result', lambda x: (x == 'loss').sum()),
        no_results=('result', lambda x: (x == 'no_result').sum()),
        total_matches=('result', 'size')
    )
    .reset_index()
    .sort_values('team', ascending=True)
    .reset_index(drop=True)
)

# Display results
print(team_stats.to_string(index=False))

# Export statistics
team_stats.to_csv(
    'outputs/team/team_overall_win_loss_stats.csv',
    index=False
)

print("\nTeam statistics exported successfully!")