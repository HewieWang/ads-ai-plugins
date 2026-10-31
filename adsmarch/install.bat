@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Adsmarch Installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
set "CODE=%ERRORLEVEL%"
echo.
pause
exit /b %CODE%
