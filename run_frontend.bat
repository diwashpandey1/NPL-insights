@echo off
setlocal

if not exist "%~dp0NPL-frontend\package.json" (
  echo Could not find the NPL-frontend project next to this script.
  exit /b 1
)

pushd "%~dp0NPL-frontend"
call npm run dev
set "EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %EXIT_CODE%
