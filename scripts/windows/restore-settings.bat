@echo off
REM ============================================================================
REM  Lunar Clipper — RESTORE SETTINGS (back to your real config)
REM
REM  Restores the settings that clear-settings.bat stashed, so the next launch
REM  is your real self again (paths, recents, last-open project). Projects are
REM  never affected by either script.
REM ============================================================================
setlocal
set "CFG=%APPDATA%\lm-clipper\lm-clipper.json"
set "BAK=%APPDATA%\lm-clipper\lm-clipper.json.realbak"

if exist "%BAK%" (
    copy /y "%BAK%" "%CFG%" >nul
    echo Restored your real settings. Launch Lunar Clipper to continue as normal.
) else (
    echo No backup found at:
    echo   %BAK%
    echo Nothing to restore.
)
echo.
pause
