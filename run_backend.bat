@echo off
setlocal

if not exist "%~dp0NPL-Backend\package.json" (
  echo Could not find the NPL-Backend project next to this script.
  exit /b 1
)

pushd "%~dp0NPL-Backend"
call npm run dev
set "EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %EXIT_CODE%
