@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Adsmarch Uninstaller
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
set "CODE=%ERRORLEVEL%"
echo.
pause
exit /b %CODE%
