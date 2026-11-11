import pandas as pd 
import numpy as np 


"""
NPL Data
Season 2024 and 2025 
ball by ball data for all matches in the season 
"""
s_2024_data = pd.read_csv("data/raw/source_repositories/user_provided_archive/NPL-2024.csv")
s_2025_data = pd.read_csv("data/raw/source_repositories/user_provided_archive/NPL-2025.csv")


# print(s_2024_data.columns)  checking columns in the dataset

# print(s_2025_data.columns)  # checking columns in the dataset

# comparing the columns of both datasets to find the common columns
common_columns = set(s_2024_data.columns).intersection(set(s_2025_data.columns))

# print("Common columns in both datasets:", common_columns)


## printig number of columns in both datasets
# print("Number of columns in 2024 dataset:", len(df_s1.columns))
# print("Number of columns in 2025 dataset:", len(df_s2.columns))

# finding the number of common and different columns in both datasets
common_columns_count = len(common_columns)
# print("Number of common columns:", common_columns_count)

#printing the different columns name 
different_columns = set(s_2024_data.columns).symmetric_difference(set(s_2025_data.columns))
# print("Different columns in the datasets:", different_columns)

# Different columns in the datasets: {'player_dismissed', 'match_no', 'match_id', 'batter', 'batsman', 'player_out', 'fielder', 'fielders'}
"""
 normalizing the column names 
 player_dusmissed, player_out = player_dismissed
 match_no, match_id = match_id
 batter, batsman = batsman
"""

# normalizing the column names in both datasets
s_2024_data = s_2024_data.rename(columns={
    'player_dismissed': 'player_out',
    'match_no': 'match_id',
    'batter': 'batsman',
    'fielder': 'fielders'
})
s_2025_data = s_2025_data.rename(columns={
    'player_dismissed': 'player_out',
    'match_no': 'match_id',
    'batter': 'batsman',
    'fielder': 'fielders'
})

#now again printing the number of common columns in both datasets after normalizing the column names
# common_columns = set(s_2024_data.columns).intersection(set(s_2025_data.columns))
# print("Number of common columns after normalization:", len(common_columns))

#printing both datasets column names 
# print()
# print()
# print()
# print("Columns in 2024 dataset:", list(s_2024_data.columns))
# print("Columns in 2025 dataset:", list(s_2025_data.columns))

#printing the column name of diffent columns in both datasets after normalizing the column names
different_columns = set(s_2024_data.columns).symmetric_difference(set(s_2025_data.columns))
# print("Different columns in the datasets after normalization:", different_columns)

"""
Now both datasets have the same column names and we can merge them into a single dataset for further analysis.
But match_id is not unique in both datasets, so we will create a new column called match_id_season which will be unique for each match in both datasets.
so we replace all the match_id in 2024 dataset in fromat season_yr_match_id and in 2025 dataset in format season_yr_match_id
"""
s_2024_data['match_id'] = '1_' + '2024_' + s_2024_data['match_id'].astype(str)
s_2025_data['match_id'] = '2_' + '2025_' + s_2025_data['match_id'].astype(str)

# printing the first 5 match id of both datasets to check if the match_id is unique in both datasets
# print("First 5 match id in 2024 dataset:", s_2024_data['match_id'].head())
# print("First 5 match id in 2025 dataset:", s_2025_data['match_id'].tail())


# merging both datasets into a single dataset
df_s1 = pd.DataFrame(s_2024_data)
df_s2 = pd.DataFrame(s_2025_data)

# merging both datasets into a single dataset
merged_df = pd.concat([df_s1, df_s2], ignore_index=True)

#printing columns names of the merged dataset
print("Columns in merged dataset:", list(merged_df.columns))

# saving the merged dataset into a csv file
merged_df.to_csv("data/processed/combined/merged_npl_2024_2025.csv", index=False)