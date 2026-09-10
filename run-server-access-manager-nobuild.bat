@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "LOG_FILE=%SCRIPT_DIR%server-access-manager-startup.log"
set "LOCAL_NODE=%SCRIPT_DIR%.runtime\node\node.exe"
set "SERVER_SCRIPT=%SCRIPT_DIR%local-file-server.mjs"
set "DIST_INDEX=%SCRIPT_DIR%dist\index.html"
set "HTTPS_PFX=%SCRIPT_DIR%.certs\sam-server.pfx"
set "PFX_PASS=%SAM_PFX_PASS%"

if "%PFX_PASS%"=="" set "PFX_PASS=changeit"

if /I "%~1"=="--http" goto HTTP_MODE
if /I "%~1"=="-http" goto HTTP_MODE
if /I "%~1"=="--https" goto HTTPS_MODE
if /I "%~1"=="-https" goto HTTPS_MODE
goto HTTPS_MODE

:HTTP_MODE
cd /d "%SCRIPT_DIR%"
echo [%date% %time%] Starting server-access-manager without build...>>"%LOG_FILE%"

netstat -ano | findstr /R /C:":4173 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
	echo [%date% %time%] INFO: Port 4173 is already in use. Skip starting duplicate process.>>"%LOG_FILE%"
	echo Port 4173 is already in use. If you changed source, stop existing process and run again.
	exit /b 0
)

if not exist "%SERVER_SCRIPT%" (
	echo [%date% %time%] ERROR: Missing %SERVER_SCRIPT%>>"%LOG_FILE%"
	echo local-file-server.mjs is missing.
	exit /b 1
)

if not exist "%DIST_INDEX%" (
	echo [%date% %time%] ERROR: Missing %DIST_INDEX%>>"%LOG_FILE%"
	echo dist output is missing. Run prepare-offline-package.bat first.
	exit /b 1
)

if exist "%LOCAL_NODE%" (
	set "NODE_EXE=%LOCAL_NODE%"
) else (
	where node >nul 2>&1
	if errorlevel 1 (
		echo [%date% %time%] ERROR: node.exe not found in PATH and no local runtime found.>>"%LOG_FILE%"
		echo node.exe not found. Run prepare-offline-package.bat on this PC first.
		exit /b 1
	)
	set "NODE_EXE=node"
)

echo Server Access Manager starting at http://127.0.0.1:4173/
"%NODE_EXE%" "%SERVER_SCRIPT%" --host 127.0.0.1 --port 4173
set "EXIT_CODE=%ERRORLEVEL%"
echo [%date% %time%] Process exited with code %EXIT_CODE%.>>"%LOG_FILE%"
exit /b %EXIT_CODE%

:HTTPS_MODE
cd /d "%SCRIPT_DIR%"
echo [%date% %time%] Starting server-access-manager HTTPS mode without build...>>"%LOG_FILE%"

netstat -ano | findstr /R /C:":4173 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
	echo [%date% %time%] INFO: Port 4173 is already in use. Stop existing process before HTTPS start.>>"%LOG_FILE%"
	echo Port 4173 is already in use. Run npm run stop:server first, then retry with --https.
	exit /b 1
)

if not exist "%SERVER_SCRIPT%" (
	echo [%date% %time%] ERROR: Missing %SERVER_SCRIPT%>>"%LOG_FILE%"
	echo local-file-server.mjs is missing.
	exit /b 1
)

if not exist "%DIST_INDEX%" (
	echo [%date% %time%] ERROR: Missing %DIST_INDEX%>>"%LOG_FILE%"
	echo dist output is missing. Run prepare-offline-package.bat first.
	exit /b 1
)

if not exist "%HTTPS_PFX%" (
	echo [%date% %time%] ERROR: Missing %HTTPS_PFX%>>"%LOG_FILE%"
	echo HTTPS certificate is missing. Run: npm run cert:generate:internal
	exit /b 1
)

if exist "%LOCAL_NODE%" (
	set "NODE_EXE=%LOCAL_NODE%"
) else (
	where node >nul 2>&1
	if errorlevel 1 (
		echo [%date% %time%] ERROR: node.exe not found in PATH and no local runtime found.>>"%LOG_FILE%"
		echo node.exe not found. Run prepare-offline-package.bat on this PC first.
		exit /b 1
	)
	set "NODE_EXE=node"
)

echo Server Access Manager HTTPS started
echo   - Local:   https://localhost:4173/
set "FOUND_NETWORK_IP="
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$ifs=[System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces(); $ips=@(); foreach($ni in $ifs){ if($ni.OperationalStatus -ne 'Up'){ continue }; $props=$ni.GetIPProperties(); foreach($ua in $props.UnicastAddresses){ $addr=$ua.Address; if($addr.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork){ $ip=$addr.IPAddressToString; if($ip -ne '127.0.0.1' -and -not $ip.StartsWith('169.254.')){ $ips += $ip } } } }; $ips | Sort-Object -Unique"`) do (
	set "FOUND_NETWORK_IP=1"
	echo   - Network: https://%%I:4173/
)
if "%FOUND_NETWORK_IP%"=="" echo   - Network: https://127.0.0.1:4173/
"%NODE_EXE%" "%SERVER_SCRIPT%" --https --host 0.0.0.0 --port 4173 --pfx "%HTTPS_PFX%" --pfx-pass "%PFX_PASS%"
set "EXIT_CODE=%ERRORLEVEL%"
echo [%date% %time%] HTTPS process exited with code %EXIT_CODE%.>>"%LOG_FILE%"
exit /b %EXIT_CODE%
