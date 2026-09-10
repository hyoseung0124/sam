@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "OUTPUT_DIR=%SCRIPT_DIR%offline-exe"
set "EXE_NAME=server-access-manager.exe"
set "EXE_PATH=%OUTPUT_DIR%\%EXE_NAME%"
set "INSTALL_GUIDE=%SCRIPT_DIR%오프라인설치및실행.txt"
set "ZIP_DATE="
set "ZIP_FILE_NAME="
set "ZIP_PATH="
set "RUNNER_BAT=%OUTPUT_DIR%\run-server-access-manager-exe.bat"

cd /d "%SCRIPT_DIR%"

echo [1/7] Checking npm...
where npm >nul 2>&1
if errorlevel 1 (
    echo ERROR: npm is not available. Install Node.js first.
    exit /b 1
)

echo [2/7] Checking dependencies...
if not exist "%SCRIPT_DIR%node_modules\pkg\lib-es5\index.js" (
    call npm ci
    if errorlevel 1 (
        echo ERROR: Failed to install dependencies.
        exit /b 1
    )
)

echo [3/7] Building web app...
call npm run build:raw
if errorlevel 1 (
    echo ERROR: Failed to build dist output.
    exit /b 1
)

echo [4/7] Building exe...
if not exist "%OUTPUT_DIR%" mkdir "%OUTPUT_DIR%"
call .\node_modules\.bin\pkg.cmd "%SCRIPT_DIR%local-file-server.cjs" --targets node18-win-x64 --output "%EXE_PATH%"
if errorlevel 1 (
    echo ERROR: Failed to build exe.
    echo TIP: First pkg build may need internet to download base runtime.
    exit /b 1
)

echo [5/7] Copying runtime files...
robocopy "%SCRIPT_DIR%dist" "%OUTPUT_DIR%\dist" /E /XJ /R:1 /W:1 /NFL /NDL /NJH /NJS /NC /NS >nul
if %ERRORLEVEL% GEQ 8 (
    echo ERROR: Failed to copy dist folder.
    exit /b 1
)

if exist "%OUTPUT_DIR%\data" rd /s /q "%OUTPUT_DIR%\data"

if exist "%SCRIPT_DIR%.certs\sam-server.pfx" (
    if not exist "%OUTPUT_DIR%\.certs" mkdir "%OUTPUT_DIR%\.certs"
    copy /Y "%SCRIPT_DIR%.certs\sam-server.pfx" "%OUTPUT_DIR%\.certs\sam-server.pfx" >nul
)

if exist "%INSTALL_GUIDE%" (
    copy /Y "%INSTALL_GUIDE%" "%OUTPUT_DIR%\오프라인설치및실행.txt" >nul
)

echo [6/7] Writing launcher...
> "%RUNNER_BAT%" echo @echo off
>> "%RUNNER_BAT%" echo setlocal
>> "%RUNNER_BAT%" echo set "SCRIPT_DIR=%%~dp0"
>> "%RUNNER_BAT%" echo set "PFX_PASS=%%SAM_PFX_PASS%%"
>> "%RUNNER_BAT%" echo if "%%PFX_PASS%%"=="" set "PFX_PASS=changeit"
>> "%RUNNER_BAT%" echo if /I "%%~1"=="--http" goto HTTP_MODE
>> "%RUNNER_BAT%" echo if /I "%%~1"=="--https" goto HTTPS_MODE
>> "%RUNNER_BAT%" echo goto HTTP_MODE
>> "%RUNNER_BAT%" echo :HTTP_MODE
>> "%RUNNER_BAT%" echo "%%SCRIPT_DIR%%server-access-manager.exe" --host 127.0.0.1 --port 4173
>> "%RUNNER_BAT%" echo exit /b %%ERRORLEVEL%%
>> "%RUNNER_BAT%" echo :HTTPS_MODE
>> "%RUNNER_BAT%" echo if not exist "%%SCRIPT_DIR%%.certs\sam-server.pfx" ^(
>> "%RUNNER_BAT%" echo   echo HTTPS certificate missing: %%SCRIPT_DIR%%.certs\sam-server.pfx
>> "%RUNNER_BAT%" echo   exit /b 1
>> "%RUNNER_BAT%" echo ^)
>> "%RUNNER_BAT%" echo "%%SCRIPT_DIR%%server-access-manager.exe" --https --host 0.0.0.0 --port 4173 --pfx "%%SCRIPT_DIR%%.certs\sam-server.pfx" --pfx-pass "%%PFX_PASS%%"
>> "%RUNNER_BAT%" echo exit /b %%ERRORLEVEL%%

echo [7/7] Creating zip package...
for /f %%I in ('powershell -NoProfile -Command "(Get-Date).ToString('yyyy-MM-dd')"') do set "ZIP_DATE=%%I"
if "%ZIP_DATE%"=="" (
    echo ERROR: Failed to resolve current date for zip file name.
    exit /b 1
)
set "ZIP_FILE_NAME=offline-exe-%ZIP_DATE%.zip"
set "ZIP_PATH=%SCRIPT_DIR%%ZIP_FILE_NAME%"
if exist "%ZIP_PATH%" del /f /q "%ZIP_PATH%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path '%OUTPUT_DIR%\*' -DestinationPath '%ZIP_PATH%' -Force"
if errorlevel 1 (
    echo ERROR: Failed to create zip package.
    exit /b 1
)

echo Done.
echo Output: %OUTPUT_DIR%
echo Zip: %ZIP_PATH%
echo Run: %RUNNER_BAT% --http ^(or no arg for https^)
exit /b 0
