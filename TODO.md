# TODO

## Known Bugs

### Games with stripped metadata have no duration data
Files imported from replays with removed metadata (e.g. ranked anonymized) store `lastFrame = -123` (the Melee start frame default) because `metadata.lastFrame` doesn't exist. This means the footer duration display shows nothing when selecting these games.

**Possible solutions:**
- Capture `lastFrame` as a side effect during the combo parser step (frames are already being parsed there)
- Add a one-time migration/repair tool that re-reads `lastFrame` for files where it's `-123`
- Accept the limitation for metadata-stripped files

### ~~Filter completion lock can deadlock~~ FIXED
### ~~Divider resize leaks event listeners~~ FIXED
### ~~`removeListener` in preload.ts is dead code~~ FIXED
### ~~Worker errors silently resolve~~ FIXED
### ~~Missing useEffect dependencies (eslint-disabled)~~ FIXED (Main.tsx)

---

## Needs Testing

### Unified App Console
Just implemented — per-worker status for import/filter/recording, log zone. Needs testing with real data.

### .slpz import support
Wizard, decompression, settings all implemented. Need slpz binary in `release/app/slpz/` for prod builds. Needs end-to-end testing.

### .zip import support
Zip wizard, extraction, chained slpz wizard if zip contains .slpz. Needs a status indicator during extraction (silent gap between wizard close and import start).

---

## Structural / Refactoring

### ~~Split controller.ts~~ DONE — extracted ConsoleManager, ImportManager, FilterExecutor, VideoManager into `src/main/managers/`

### ~~Split Filters.tsx~~ DONE — extracted FilterCard, FilterControls, FilterModals

### ~~Split Top.tsx~~ DONE — extracted SettingsModal.tsx + GeckoModal.tsx

### Selection state lives in Main but only Tray uses it
`selectedIds`, `lastSelectedIndex`, `selectionDuration` defined in Main, passed as props. Move to Tray or a shared hook. (Note: Main does use `selectedIds.size` for button disabling and sends IDs to play/record IPC — a hook that shares state would work, but current pattern is acceptable.)

### ~~Dead state: `_isImporting`~~ FIXED

---

## Type Safety

### ~~Pervasive `any` usage~~ MOSTLY FIXED — typed filter params, Worker.ts, Archive.ts. Remaining: ConfigInterface `[key: string]: any` (needed by dynamic config access), ipcBridge ResponseHandler<any>

### ~~No typed filter parameters~~ FIXED — 14 typed param interfaces in types.ts, all filter methods use them

---

## Code Duplication

### ~~Player/character filtering duplicated 3x~~ FIXED — `matchesPlayer()` in `src/lib/filterHelpers.ts`

### ~~`getWorkerExecArgv()` duplicated~~ FIXED — moved to `src/lib/`

### ~~String/array param parsing repeated~~ FIXED — `parseSemicolonParam()` in `src/lib/filterHelpers.ts`

---

## Performance / Memory

### ~~Sort filter loads all data~~ FIXED — chunked at 50K rows per INSERT with progress reporting

### ~~Synchronous file I/O in logger~~ FIXED — uses `fs.promises.appendFile()` now

### ~~No log rotation~~ FIXED — rotates at 10MB, keeps one `.old` backup

### ~~Tray fetch effect has 13 dependencies~~ FIXED — removed `totalClips` dep (tracked via ref), down to 11

### ~~db.ts COUNT(*) on every filter table~~ FIXED — cached in metadata `extra.cachedCounts`, only recounts unprocessed filters

### ~~db.ts PRAGMA on every getItems()~~ FIXED — schema cache with invalidation on create/delete/close

---

## Validation / Safety

### ~~Filter parameters never validated~~ FIXED — `safeInt()` on comboTimeout, nthMove t/d/dMax/tMin; maxFiles validated in actionStateFilter, reverse, custom

### ~~No IPC channel whitelist in preload~~ FIXED — `SEND_CHANNELS` whitelist in preload.ts

### ~~SQL interpolation in Worker.ts sort~~ FIXED — slice bounds now use parameterized query

---

## Nice-to-Have

### ~~Auto-play video after recording~~ FIXED — auto-opens output folder via `shell.openPath` on successful completion

### Stage rectangles visualizer
`notes/stage-rectangles.html` — could be expanded for tuning edgeguard rectangle values.

### ~~Hardcoded magic numbers~~ FIXED — named constants with comments at top of Worker.ts

### ~~Accessibility~~ PARTIAL — removed file-level a11y disables from FilterCard, FilterModals, Filters, Top, GeckoModal. Added role/tabIndex/onKeyDown to interactive elements. Remaining: Tray, SettingsModal, TemplateCatalog, CodeEditorPage, SetupWizard.
