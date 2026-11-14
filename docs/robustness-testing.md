# Robustness changes: manual test list (2026-09-30)

What automated tests can't cover for the "not responding" and filter-run fixes.
better-sqlite3 is built for Electron, so every real database path needs the
running app. Work through a dev build first, then a packaged Windows build.

Before starting: keep `main.log` open (Linux `~/.config/lm-clipper/logs/`,
Windows `%APPDATA%\lm-clipper\logs\`, dev builds `apps/clipper/logs/`). Any
`main-blocked`, `main-slow-handler`, `window-unresponsive` or
`renderer-longtask` line while testing is a finding; note what you were doing.

## 1. Freeze diagnostics (hangWatchdog.ts)

- [ ] Normal use (open project, import, run filters, play a clip): no
      `main-blocked` lines in `main.log`.
- [ ] Help → Export logs: the zip contains `main.log` with the watchdog lines.
- [ ] Temporary code editor / wizards still open and close normally (their
      listeners are intentionally not wrapped).

## 2. Database work moved off the main thread (DbWorker)

Everyday paths:
- [ ] New project; drag-drop into the start screen (auto-creates a project).
- [ ] Import files, a folder, and the same folder again ("already in this project").
- [ ] Open, open recent, close, and switch projects quickly back and forth.
- [ ] Player-name and connect-code dropdowns fill in after import.
- [ ] Add, edit, remove, reorder filters; Run, Stop, Resume, dismiss Resume.
- [ ] Play and Record clips; stitch clips; the tray pages through results.
- [ ] **Save As right after a run:** open the copy; it has the new results
      (before, the copy could miss changes still in the WAL).
- [ ] Settings → Reset App, and the dev switcher's "new user" / "restore my settings".
- [ ] Quit while a filter is running; relaunch; the project opens cleanly.

Stress (the real point):
- [ ] Big project (`full_db.lunar`): open it, re-run a parser (drops a huge
      table), delete a filter. The window stays responsive throughout.
- [ ] Edit filter settings while a big parser runs on another filter: no freeze.
- [ ] Start screen with a large Slippi folder: appears promptly, count shows up.

## 3. Filter run fixes

- [ ] **The original bug:** type a new value in a filter field, then click that
      filter's Run directly (no Enter). It runs once, and the results reflect
      the new value.
- [ ] Double-click Run quickly: one run; the button turns to Stop immediately.
- [ ] Edit a filter while it is running: the run stops, the card shows "needs
      run", running it again works.
- [ ] Edit an upstream filter while a downstream one runs: the downstream run stops.
- [ ] Remove a filter, and reorder filters, while one is running: the
      highlight/Stop stays on the right card; nothing is left stuck "running".
- [ ] Edit two different filters within a moment of each other (e.g. tab
      between fields): both edits are kept after the save.
- [ ] Custom-code filter: cancel the consent prompt; the button goes back to Run.
- [ ] 50k+ file project: cancel the "run the parser first?" prompt; button back to Run.
- [ ] Stop a long run, then Resume: it continues and finishes as done.
- [ ] First-run auto-run (dev switcher "new user" → import): combos run once by themselves.

## 4. Windows

- [ ] OneDrive-synced `Documents\Slippi`: the start screen's "Found N replays"
      matches what "Import them" actually imports; dropping that folder imports.
- [ ] Drag replays straight out of a .zip in Explorer: the "Couldn't read those
      files" notice appears.
- [ ] Run as administrator: no "Drop to import" overlay (expected Windows
      behaviour; the advice is to not run elevated).
- [ ] Collect `main.log` from a Windows user who hits "not responding" and read
      the watchdog lines.

## Known gaps

- Run All (`runFilters`) is not tracked by `stopAndWait`; no UI triggers it today.
- A run that is still starting (after Run, before the main process registers it)
  can't be stopped for that instant.
