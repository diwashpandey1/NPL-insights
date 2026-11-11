# NPL Machine Learning

This directory is the dedicated workspace for future machine-learning workflows using Nepal Premier League cricket data. It is an initial scaffold only: **model development and training have not started here**, and no model has been selected.

The existing cricket datasets remain in `../NPL - Stats Processing/`. ML workflows should read those datasets through configurable paths; do not copy or move the source datasets into this project. Generated ML-specific data, model files, and metrics belong under this `ML/` directory.

## Workflow

1. **Data loading** — read the configured processed ball-by-ball and match datasets.
2. **Data preprocessing** — prepare input data for a future modeling workflow.
3. **Feature engineering** — define and build features for a specific prediction task.
4. **Model training** — train a model after a target and approach have been selected.
5. **Model evaluation** — evaluate the model with an appropriate, documented methodology.
6. **Artifact storage** — keep generated model files and evaluation metrics under `artifacts/`.

These are planned stages, not implemented functionality. The Python modules currently contain starter placeholders only. Existing feature engineering under `NPL - Stats Processing/src/` is part of the separate data-processing project and does not mean model training or evaluation has begun.

## Directory structure

```text
ML/
├── configs/
│   └── model_config.yaml     # Dataset paths and reserved workflow sections
├── data/
│   ├── raw/                  # ML-specific raw data, if needed in the future
│   ├── processed/            # ML-specific prepared data, if needed
│   └── external/             # External data, if needed
├── notebooks/                # Exploratory notebooks
├── src/
│   ├── data/                 # Loading and preprocessing entry points
│   ├── features/             # Future feature-building entry point
│   ├── models/               # Future model definitions and persistence
│   ├── training/             # Future training entry point
│   ├── evaluation/           # Future evaluation entry point
│   └── utils/                # Shared helper entry point
├── artifacts/
│   ├── models/               # Generated model artifacts (ignored by Git)
│   └── metrics/              # Evaluation outputs
├── scripts/                  # Future command-line workflow helpers
└── tests/                    # Tests for future ML code
```

## Setup

From this directory, create and activate a virtual environment, then install the initial dependencies:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

No environment variables or credentials are currently required. `configs/model_config.yaml` contains configurable paths to the existing processed ball-by-ball and match-level CSVs. Review and adjust those paths for the local checkout before future workflows use them.
