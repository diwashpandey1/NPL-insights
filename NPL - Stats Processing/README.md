# NPL Cricket Analytics

![Python](https://img.shields.io/badge/Python-used-3776AB?logo=python&logoColor=white)
![Pandas](https://img.shields.io/badge/Pandas-used-150458?logo=pandas&logoColor=white)
![NumPy](https://img.shields.io/badge/NumPy-used-013243?logo=numpy&logoColor=white)

An evolving data project to collect, standardize, and analyze Nepal Premier League (NPL) cricket data. The current work is centered on ball-by-ball data for the 2024 and 2025 seasons, with early batting and bowling summaries. The longer-term goal is a complete NPL analytics platform, with an interactive statistics dashboard and, eventually, carefully evaluated match prediction models.

> **Current stage:** data collection, preprocessing, and initial statistical analysis. A dashboard and machine learning models are future goals; neither is currently implemented.

## Why Am I Building This?

The Nepal Premier League is an important cricket competition in Nepal, and I want to explore its statistics through data science, analytics, and machine learning. I am starting by building a dependable historical dataset instead of jumping directly to prediction models. Any later analysis will only be as useful as the data behind it, so understanding and checking the source data is a necessary first step.

This project is also a way to work through the broader data science process:

**Data collection → data cleaning → preprocessing → exploratory analysis → feature engineering → statistical analysis → machine learning → visualization**

It is a personal, evolving project that brings together cricket, Python, and applied data analysis. The first priority is to make the available data consistent and traceable; the dashboard and predictive work can build on that foundation over time.

## Project Goals

### 1. Build a consistent NPL dataset — current focus

Collect ball-by-ball and related NPL data from multiple sources, compare their schemas, normalize compatible fields, and consolidate seasons into a usable dataset. The current preprocessing script combines 2024 and 2025 ball-by-ball CSVs. The repository also contains 2026 source material, but it has not been incorporated into that consolidated dataset.

### 2. Develop a statistical dashboard — future work

The intended dashboard could present batting, bowling, team, and match statistics, with filters for player, team, match, and season. Candidate statistics include runs, boundaries, averages, strike rates, wickets, economy, match summaries, and season comparisons. These are planned capabilities, not features of the current repository.

### 3. Explore match prediction — long-term work

Once there is enough reliable historical data, the project may explore outcome probabilities, match results, and player performance forecasts. Possible future work includes exploratory data analysis, feature engineering, classification and regression experiments, historical validation, and model comparison. **No prediction model has been trained or deployed in this project.**

## Current Implementation

The repository currently contains:

- A preprocessing script that compares the 2024 and 2025 column names, maps known aliases to common names, prefixes match IDs with season information, concatenates the datasets, and writes a combined CSV.
- A centralized `load_data()` helper and several analysis scripts.
- Existing batting output CSVs for fours, sixes, and batter run totals, plus bowling output CSVs for wickets and wides.
- Raw data and source material from several sources, including a Cricsheet ZIP, 2024 API and repository files, 2026 captured pages, and archived source datasets.

The current code does not demonstrate systematic data quality validation, duplicate-delivery detection, or completeness checks. The existing summary scripts are early analyses; their presence and output files should not be taken as proof that every cricket statistic has been independently validated.

## Repository Structure

This tree reflects the directories and files currently present. The raw-source repositories are shown in an abbreviated form to keep the tree readable; their contents remain under `data/raw/source_repositories/`.

```text
NPL - Stats Processing/
├── analysis/
│   ├── __init__.py
│   ├── batting/
│   │   ├── __init__.py
│   │   ├── extract_most_fours.py
│   │   ├── extract_most_sixes.py
│   │   └── total_runs_cross_season_by_players.py
│   ├── bowling/
│   │   ├── __init__.py
│   │   ├── most_wides_by_bowler.py
│   │   └── total_wickets_cross_season_by_player.py
│   └── team/                         # package exists; currently no analysis script
│       └── __init__.py
├── data/
│   ├── interim/                      # currently empty
│   ├── processed/
│   │   └── combined/
│   │       └── merged_npl_2024_2025.csv
│   └── raw/
│       ├── cricsheet/
│       │   └── npl_json.zip
│       ├── season_2024/
│       │   ├── api/                  # matches.json, ranking.json, teams.json
│       │   └── github/               # preserved source repository files
│       ├── season_2025/              # directory exists; currently empty
│       ├── season_2026/
│       │   ├── cricsheet/            # currently empty
│       │   └── pages/                # captured source pages and access manifest
│       ├── source_manifest.json
│       └── source_repositories/
│           ├── Diwash17_Nepal-Premier-League-Data/
│           │   ├── ball_by_ball.csv
│           │   ├── Nepal_Premier_League.csv
│           │   ├── NPL_Season2_ball_by_ball_data.csv
│           │   ├── matches/           # source Python files
│           │   └── notebooks and README
│           ├── thebinodd_data-analysis-of-NPL/
│           │   └── fastapi-backend/datasets/  # npl_dataset.csv, NPL-2024.csv, NPL-2025.csv
│           └── user_provided_archive/
│               ├── NPL-2024.csv
│               ├── NPL-2025.csv
│               ├── NPL matches.csv
│               └── archive.zip
├── data_provider/
│   ├── __init__.py
│   └── data_provider.py
├── outputs/
│   ├── batting/
│   │   ├── players_fours_count.csv
│   │   ├── players_sixes_count.csv
│   │   └── players_total_runs_count.csv
│   ├── bowling/
│   │   ├── bowler_wide_stats.csv
│   │   └── players_wickets_count.csv
│   └── team/
│       └── total_runs_cross_season_by_players.py  # draft file; no summary is generated here
└── preprocessing/
    ├── __init__.py
    ├── all_season_data_normalized.py
    └── tempCodeRunnerFile.py          # editor scratch file
```

Python package directories also contain empty `__init__.py` files. There is no root `main.py` or dependency manifest (`requirements.txt`, `pyproject.toml`, or equivalent) in the current project.

| Location | Current responsibility |
| --- | --- |
| `data/raw/` | Original and collected data, captured pages, source manifests, and preserved source repositories. Treat raw sources as inputs and leave them unchanged. |
| `data/interim/` | Reserved for intermediate files; currently empty. |
| `data/processed/combined/` | Contains the merged 2024–2025 ball-by-ball CSV. |
| `data_provider/` | Provides a reusable CSV loading helper. |
| `preprocessing/` | Contains the current season schema normalization and merge script. |
| `analysis/batting/` | Early batter run, four, and six summaries. |
| `analysis/bowling/` | Early bowler wicket and wide summaries. |
| `analysis/team/` | Package directory exists; no team analysis script is present yet. |
| `outputs/` | Existing CSV summary outputs, grouped by batting and bowling. `outputs/team/` currently contains a draft script rather than a generated team result. |

## Current Data and Schema

The consolidated file, `data/processed/combined/merged_npl_2024_2025.csv`, has the following 20 columns:

```text
match_id, inning, batting_team, bowling_team, ball_over, ball_result,
bowler, batsman, non_striker, shot_direction, player_out, dismissal_kind,
fielders, batsman_runs, wide_runs, bye_runs, legbye_runs, noball_runs,
extra_runs, total_runs
```

The preprocessing script reads `NPL-2024.csv` and `NPL-2025.csv` from `data/raw/source_repositories/user_provided_archive/`. It maps known naming differences such as `match_no` to `match_id`, `batter` to `batsman`, `player_dismissed` to `player_out`, and `fielder` to `fielders`. It adds season-prefixed match identifiers before concatenating the rows. Other source files have different schemas; they are preserved as source material and are not all normalized by this script.

| Field | Meaning |
| --- | --- |
| `match_id` | Match identifier with a season prefix added by the current merge script. |
| `inning` | Innings number. |
| `batting_team`, `bowling_team` | Teams batting and bowling for the delivery. |
| `ball_over` | Ball or over notation provided by the source dataset. |
| `ball_result` | Source delivery result marker, used by current scripts to identify outcomes such as wickets and wides. |
| `batsman`, `non_striker`, `bowler` | Players involved in the delivery. |
| `shot_direction` | Shot direction value supplied by the source. |
| `player_out`, `dismissal_kind`, `fielders` | Dismissed player, dismissal type, and recorded fielders, where available. |
| `batsman_runs` | Runs credited to the batter. |
| `wide_runs`, `bye_runs`, `legbye_runs`, `noball_runs`, `extra_runs` | Extra-run fields provided by the dataset. |
| `total_runs` | Total runs recorded for the delivery. |

Ball-by-ball records support analysis at several levels: aggregating deliveries for player performance, following scoring and dismissals through an innings, comparing team contributions, and building match-level summaries. With appropriate validation and additional match context, they can also inform features for future outcome or performance models. They do not by themselves guarantee that a prediction will be reliable.

## Current Processing Workflow

The implemented 2024–2025 path is:

1. Keep collected and archived source data under `data/raw/`.
2. Read the 2024 and 2025 CSVs from `user_provided_archive/`.
3. Compare their columns and rename the known aliases to a common schema.
4. Prefix match IDs with season information to distinguish seasons.
5. Concatenate the two datasets and write `data/processed/combined/merged_npl_2024_2025.csv`.
6. Load the combined CSV either through `data_provider.load_data()` or directly with Pandas.
7. Run the existing batting or bowling summary scripts, which write CSVs under `outputs/`.

The repository contains additional source files and 2026 captured pages, but the current merge script does not include them. The process will need to evolve as more seasons and sources are assessed and incorporated.

## Technology

| Technology | Current evidence |
| --- | --- |
| Python | Preprocessing, data loading, and analysis scripts. |
| Pandas | CSV reading, column operations, concatenation, grouping, and output writing. |
| NumPy | Imported by some current scripts; no project dependency manifest or pinned version is present. |
| CSV | Used for source, consolidated, and summary datasets. |

Visualization libraries, scikit-learn, notebooks as an active workflow, and dashboard frameworks such as Streamlit or React are possible future choices, not dependencies of the current Python scripts.

## Setup and Usage

Use Python 3 and run commands from the project root. The repository does not currently include a dependency manifest, so install the libraries imported by the current scripts in your virtual environment:

```bash
python -m venv .venv
```

Activate the environment:

```powershell
# Windows PowerShell
.venv\Scripts\Activate.ps1
```

```bash
# macOS / Linux
source .venv/bin/activate
```

Install the current script dependencies:

```bash
python -m pip install pandas numpy
```

After cloning or opening the repository, change to its root directory. Replace `<repository-url>` with the clone URL for your copy of the project:

```bash
git clone <repository-url>
cd "NPL - Stats Processing"
```

Run the existing preprocessing script from the root to regenerate the merged file:

```bash
python -m preprocessing.all_season_data_normalized
```

Then run the current analyses as needed:

```bash
python -m analysis.batting.extract_most_fours
python -m analysis.batting.extract_most_sixes
python -m analysis.batting.total_runs_cross_season_by_players
python -m analysis.bowling.most_wides_by_bowler
python -m analysis.bowling.total_wickets_cross_season_by_player
```

These scripts read and write paths relative to the project root. The outputs currently include batter four, six, and run counts, plus bowler wide and wicket summaries. The file `outputs/team/total_runs_cross_season_by_players.py` is a draft and is not part of the commands above.

## Roadmap

### Phase 1: Data Collection and Preparation

- [x] Collect initial NPL ball-by-ball datasets for 2024 and 2025.
- [x] Keep source material and source repositories organized under `data/raw/`.
- [x] Compare 2024 and 2025 schemas in the preprocessing script.
- [x] Normalize the known column aliases used by those two files.
- [x] Add season information to match IDs in the merge script.
- [x] Create an initial merged 2024–2025 dataset.
- [ ] Expand and incorporate additional seasons and sources, including validated 2026 ball-by-ball data.
- [ ] Validate dataset completeness and document source coverage.
- [ ] Detect and resolve duplicate deliveries.
- [ ] Add repeatable data quality checks.

### Phase 2: Cricket Statistical Analysis

- [x] Generate a basic batter fours summary.
- [x] Generate a basic batter sixes summary.
- [x] Generate a batter total-runs summary from the merged data.
- [x] Generate basic bowler wicket and wide summaries.
- [x] Add and validate batting averages, strike rates, and highest scores.
- [x] Add team statistics and season-wise player comparisons.
- [x] Add match-level summaries and innings analysis.
- [x] Conduct and document exploratory data analysis.

### Complete analysis export

The current analysis layer can generate 88 non-empty CSV summaries across batting, bowling, fielding, team, match, innings, extras, head-to-head, and advanced categories. From the project root, run:

```powershell
python -m analysis.run_all
```

Results are written beneath `outputs/`; the source datasets and preprocessing implementation are not rewritten. See [`docs/statistics_feasibility.md`](docs/statistics_feasibility.md) for metric coverage and [`docs/analysis_methodology.md`](docs/analysis_methodology.md) for formulas, validation, and limitations. The 2026 Cricsheet files are partial-season data and are not combined with 2024–2025 exports.

### Phase 3: NPL Statistical Dashboard

- [ ] Choose a dashboard architecture.
- [ ] Add interactive player and team statistics.
- [ ] Add season comparison and match statistics.
- [ ] Add data visualizations.

### Phase 4: Machine Learning

- [ ] Prepare and validate a modeling dataset.
- [ ] Engineer and examine candidate features.
- [ ] Establish historical validation and evaluation methods.
- [ ] Experiment with match outcome and player performance models.
- [ ] Compare and evaluate models before considering any prediction interface.
- [ ] Visualize model results and limitations.

### Phase 5: Integration

- [ ] Integrate statistical outputs with the dashboard.
- [ ] Integrate any adequately evaluated machine learning models.
- [ ] Build an end-to-end NPL analytics experience.

## Data Integrity and Contributions

- Preserve original source datasets in `data/raw/`; create derived data in the appropriate processed or output location.
- Record schema changes and the source files used when adding or normalizing a dataset.
- Apply consistent season naming and match identifier conventions, and check that identifiers remain unique across seasons.
- Keep statistical outputs traceable to their input data and scripts.
- Check data coverage, missing values, duplicate deliveries, and source disagreements before using the data for analysis or machine learning.
- Treat summary calculations and model results as provisional until their assumptions and data quality have been reviewed.

## Long-Term Direction

The goal is to grow this data foundation into a complete NPL cricket analytics platform: a reliable multi-season dataset, useful player, team, and match statistics, an interactive dashboard, and machine learning experiments evaluated against historical data. The project is still at the preparation and early analysis stage, and each later phase depends on improving the quality and coverage of the data first.
