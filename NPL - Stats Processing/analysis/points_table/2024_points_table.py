import pandas as pd 
import numpy as np 

# Load json data
points_table_json = pd.read_json('data/raw/source/json_data/2024_points_table.json')

# Convert json into df 
points_table_df = pd.DataFrame(points_table_json)

# 1. Calculate 'nr' (No Result): matches played minus wins and losses
nr_values = points_table_df['matches_played'] - (points_table_df['wins'] + points_table_df['losses'])

# 2. Find the index position of the 'losses' column
losses_index = points_table_df.columns.get_loc('losses')

# 3. Insert the 'nr' column right after the 'losses' column
points_table_df.insert(losses_index + 1, 'nr', nr_values)

# Descending order by points, and secondarily descending by NRR if points are tied
points_table_df = points_table_df.sort_values(
    by=['points', 'nrr'], 
    ascending=[False, False]
).reset_index(drop=True)

print(points_table_df.head(10))

# Save df as csv
points_table_df.to_csv('outputs/points_table/2024_points_table.csv', index=False)