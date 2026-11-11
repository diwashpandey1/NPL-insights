import pandas as pd
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BALL_BY_BALL_PATH = ROOT / "data/processed/combined/merged_npl_2024_2025.csv"
MATCHES_PATH = ROOT / "data/raw/source/csv_data/NPL-matches.csv"

def load_data(file_path):
    try:
        return pd.read_csv(file_path)

    except FileNotFoundError:
        print(f"File not found: {file_path}")
        return None

    except pd.errors.EmptyDataError:
        print(f"No data: {file_path} is empty.")
        return None

    except pd.errors.ParserError:
        print(f"Parsing error: Could not parse {file_path}.")
        return None


def load_npl_datasets():
    """Load the processed delivery feed and match-level results without mutation."""
    balls = load_data(BALL_BY_BALL_PATH)
    matches = load_data(MATCHES_PATH)
    if balls is None or matches is None:
        raise FileNotFoundError("Required NPL analysis dataset could not be loaded")
    return balls, matches
