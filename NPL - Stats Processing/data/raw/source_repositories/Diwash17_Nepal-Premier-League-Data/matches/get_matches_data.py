import requests
import os
import zipfile

def get_data(url: str,folderpath):
    try:
        response=requests.get(url,stream=True)
        os.makedirs(folderpath,exist_ok=True)
        zip_path=os.path.join(folderpath,"npl_json.zip")
        with open(zip_path,'wb') as f:
            for chunk in response.iter_content(chunk_size=1024):
                if chunk:
                    f.write(chunk)
        print("ZIP file downloaded successfully.")

        with zipfile.ZipFile(zip_path,'r') as zip_ref:
            zip_ref.extractall(folderpath)
        print('ZIP file extracted successfully')
        os.remove(zip_path)
        print("ZIP file removed after extraction")
    except requests.exceptions.RequestException as e:
        print(f"Error getting data from source: {e}")
    except zipfile.BadZipFile:
        print("Error: The downloaded file is not a valid ZIP file.")
    except Exception as e:
        print(f"An unexpected error occurred: {e}")
        

if __name__=="__main__":
    url='https://cricsheet.org/downloads/npl_json.zip'
    folderpath = "./games/"
    get_data(url,folderpath)