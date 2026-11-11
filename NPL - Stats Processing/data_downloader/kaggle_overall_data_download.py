import kagglehub

# Download latest version
path = kagglehub.dataset_download("googlestha/nepal-premier-league-202526-dataset")

print("Path to dataset files:", path)