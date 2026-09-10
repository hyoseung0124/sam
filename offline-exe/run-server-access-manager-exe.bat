@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "PFX_PASS=%SAM_PFX_PASS%"
if "%PFX_PASS%"=="" set "PFX_PASS=changeit"
if /I "%~1"=="--http" goto HTTP_MODE
if /I "%~1"=="--https" goto HTTPS_MODE
goto HTTP_MODE
:HTTP_MODE
"%SCRIPT_DIR%server-access-manager.exe" --host 127.0.0.1 --port 4173
exit /b %ERRORLEVEL%
:HTTPS_MODE
if not exist "%SCRIPT_DIR%.certs\sam-server.pfx" (
  echo HTTPS certificate missing: %SCRIPT_DIR%.certs\sam-server.pfx
  exit /b 1
)
"%SCRIPT_DIR%server-access-manager.exe" --https --host 0.0.0.0 --port 4173 --pfx "%SCRIPT_DIR%.certs\sam-server.pfx" --pfx-pass "%PFX_PASS%"
exit /b %ERRORLEVEL%
