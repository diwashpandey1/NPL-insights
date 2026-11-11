import json
import os
import pandas as pd
import random

def get_file_list(folder_path):
    json_file_list = []
    try:
        for file_name in os.listdir(folder_path):
            if file_name.endswith(".json"):
                file_path = os.path.join(folder_path, file_name)
                json_file_list.append(file_path)
    except Exception as e:
        print(f"Error: {e}")
    return json_file_list

def parse_json(json_file_list):
    
    columns = {
        "match_no":[], "inning": [], "date": [], "batting_team": [], "bowling_team": [],
        "over": [], "ball": [], "batter": [], "bowler": [], "non_striker": [],
        "batsman_runs": [], "extra_runs": [], "total_runs": [], "extras_type": [],
        "is_wicket": [], "player_dismissed": [], "dismissal_kind": [], "fielder": []
    }
    for _, file in enumerate(json_file_list):
        with open(file, 'r') as f:
            data = json.load(f)
            match_date = data["info"]["dates"][0]  
            teams = data["info"]["teams"]
            try:
                match_no=data["info"]["event"]["match_number"]
            except KeyError as e:
                match_type= data["info"]["event"]["stage"]
                if match_type=="Qualifier 1":
                    match_no=30
                elif match_type=="Eliminator":
                    match_no=29
                elif match_type=="Qualifier 2":
                    match_no=31
                elif match_type=="Final":
                    match_no=32
            for inning_index, inning in enumerate(data["innings"], start=1):
                batting_team = inning["team"]
                bowling_team = teams[1] if teams[0] == batting_team else teams[0]

                for over_data in inning["overs"]:
                    over_number = over_data["over"]

                    for ball_index, delivery in enumerate(over_data["deliveries"], start=1):
                        batter = delivery["batter"]
                        bowler = delivery["bowler"]
                        non_striker = delivery["non_striker"]
                        batsman_runs = delivery["runs"]["batter"]
                        extra_runs = delivery["runs"]["extras"]
                        total_runs = delivery["runs"]["total"]
                        extras_type = ",".join(delivery.get("extras", {}).keys())  # Join list as string

                        is_wicket = "wickets" in delivery
                        player_dismissed = None
                        dismissal_kind = None
                        fielder = None
                        if is_wicket:
                            wicket_details = delivery["wickets"][0]
                            player_dismissed = wicket_details["player_out"]
                            dismissal_kind = wicket_details["kind"]
                            fielder_lists = wicket_details.get("fielders", None)
                            if isinstance(fielder_lists, list):
                                fielders_list = [item.get('name', '') for item in fielder_lists if isinstance(item, dict)]
                                fielder = ", ".join(fielders_list)
                            elif isinstance(fielder_lists, str):
                                fielder = fielder_lists
                            else:
                                fielder = None


                        columns["match_no"].append(match_no)
                        columns["date"].append(match_date)
                        columns["inning"].append(inning_index)
                        columns["batting_team"].append(batting_team)
                        columns["bowling_team"].append(bowling_team)
                        columns["over"].append(over_number)
                        columns["ball"].append(ball_index)
                        columns["batter"].append(batter)
                        columns["bowler"].append(bowler)
                        columns["non_striker"].append(non_striker)
                        columns["batsman_runs"].append(batsman_runs)
                        columns["extra_runs"].append(extra_runs)
                        columns["total_runs"].append(total_runs)
                        columns["extras_type"].append(extras_type)
                        columns["is_wicket"].append(is_wicket)
                        columns["player_dismissed"].append(player_dismissed)
                        columns["dismissal_kind"].append(dismissal_kind)
                        columns["fielder"].append(fielder)

    return columns

def save_to_csv(data, output_file):
    try:
        df = pd.DataFrame(data)
        df.to_csv(output_file, index=False, encoding='utf-8')
        print(f"Data successfully saved to {output_file}")
    except Exception as e:
        print(f"Error saving data to CSV: {e}")

if __name__ == "__main__":
    folder_path = "./games"
    json_data_list = get_file_list(folder_path)
    data = parse_json(json_data_list)
    output_file = "ball_by_ball.csv"
    save_to_csv(data, output_file)
