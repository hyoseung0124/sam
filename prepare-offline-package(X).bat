@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "LOCAL_RUNTIME_DIR=%SCRIPT_DIR%.runtime\node"

cd /d "%SCRIPT_DIR%"

echo [1/4] Checking dependencies...
if not exist "%SCRIPT_DIR%node_modules\vite\bin\vite.js" (
    where npm >nul 2>&1
    if errorlevel 1 (
        echo ERROR: npm is not available. Install Node.js first.
        exit /b 1
    )

    call npm ci
    if errorlevel 1 (
        echo ERROR: Failed to install dependencies.
        exit /b 1
    )
)

echo [2/4] Building app...
call npm run build
if errorlevel 1 (
    echo ERROR: Failed to build dist output.
    exit /b 1
)

echo [3/4] Finding node.exe...
set "NODE_EXE="
for /f "delims=" %%I in ('where node 2^>nul') do (
    set "NODE_EXE=%%I"
    goto :NODE_FOUND
)

echo ERROR: node.exe not found in PATH.
exit /b 1

:NODE_FOUND
for %%I in ("%NODE_EXE%") do set "NODE_DIR=%%~dpI"
if "%NODE_DIR:~-1%"=="\" set "NODE_DIR=%NODE_DIR:~0,-1%"

echo [4/4] Copying local runtime...
if not exist "%LOCAL_RUNTIME_DIR%" mkdir "%LOCAL_RUNTIME_DIR%"
robocopy "%NODE_DIR%" "%LOCAL_RUNTIME_DIR%" /E /XJ /R:1 /W:1 /NFL /NDL /NJH /NJS /NC /NS >nul
set "ROBOCOPY_EXIT=%ERRORLEVEL%"
if %ROBOCOPY_EXIT% GEQ 8 (
    echo ERROR: Failed to copy Node runtime. ^(robocopy exit: %ROBOCOPY_EXIT%^) 
    echo TIP: If this app/server is running, stop it first and run this script again.
    exit /b 1
)

echo Done.
echo You can now copy this folder and run run-server-access-manager.bat offline.
exit /b 0
