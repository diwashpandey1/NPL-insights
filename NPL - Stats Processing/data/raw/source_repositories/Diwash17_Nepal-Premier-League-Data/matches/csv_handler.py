import pandas as pd

def sort_by_match(file_path):
    df=pd.read_csv(file_path)
    df = df.sort_values(by=["match_no", "inning", "over"]).reset_index(drop=True)
    df.to_csv("ball_by_ball.csv",index=False,encoding='utf-8')
    
if __name__=="__main__":
    file_path="ball_by_ball.csv"
    sort_by_match(file_path)
    
    
    