@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

call "%SCRIPT_DIR%run-server-access-manager-nobuild.bat" --https
exit /b %ERRORLEVEL%
