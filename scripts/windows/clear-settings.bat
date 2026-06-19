@echo off
REM ============================================================================
REM  Lunar Clipper — CLEAR SETTINGS (force a fresh "new user" first-run)
REM
REM  Deletes the production config so the next launch behaves like a brand-new
REM  install (Start screen, no recents, no paths set). Your PROJECTS are NOT
REM  touched — only the settings file. The first time it runs it stashes your
REM  current settings to .realbak so restore-settings.bat can bring them back.
REM
REM  Double-click this, then launch Lunar Clipper from the Start menu.
REM ============================================================================
setlocal
set "CFG=%APPDATA%\lm-clipper\lm-clipper.json"
set "BAK=%APPDATA%\lm-clipper\lm-clipper.json.realbak"

if exist "%CFG%" (
    if not exist "%BAK%" (
        copy /y "%CFG%" "%BAK%" >nul
        echo Saved your current settings to:
        echo   %BAK%
    )
    del /q "%CFG%"
    echo.
    echo Settings cleared. Launch Lunar Clipper for a fresh first-run.
) else (
    echo No settings file found - already in a fresh state.
)
echo.
pause
