# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LM Clipper is an Electron desktop app for automating clip generation from Slippi replays (Super Smash Bros. Melee). It imports .slp files, filters by metadata/combos/frame data, and generates high-quality video using Slippi Dolphin's frame-by-frame dump + ffmpeg.

## Commands

```bash
# Development
npm run start              # Start dev environment (webpack + electron)
npm run start:main         # Build and run main process only
npm run start:renderer     # Start webpack dev server for React only

# Build & Package
npm run build              # Build main + renderer for production
./build.sh                 # Full build + package with Conveyor

# Quality
npm run lint               # ESLint on .js/.jsx/.ts/.tsx
npm test                   # Run Jest tests
```

## Architecture

### Electron Multi-Process Model

```
Main Process (src/main/)
├── main.ts             # Entry: BrowserWindow, app lifecycle
├── controller.ts       # IPC registration, wires renderer ↔ managers
├── managers/           # Domain orchestrators owned by controller
│   ├── ImportManager.ts
│   ├── FilterExecutor.ts
│   ├── VideoManager.ts
│   ├── ClipManager.ts
│   ├── ConsoleManager.ts
│   └── CodeEditorManager.ts
├── db.ts               # SQLite schema & queries (better-sqlite3)
├── dbConnection.ts     # Global singleton DB connection
├── dbAsync.ts          # Async DB helpers
├── DbWorker.ts         # Background DB worker
├── ImportCountWorker.ts / NameCountWorker.ts  # Aggregation workers
├── slpToVideo.ts       # Video generation (Dolphin + ffmpeg)
├── workflow.ts         # Batch processing automation
├── menu.ts             # Application menu / accelerators
├── perfLogger.ts       # Perf instrumentation
└── logger.ts           # electron-log wrapper

Renderer Process (src/renderer/)
├── App.tsx             # Root component
├── ipcBridge.ts        # IPC request-response wrapper
├── components/
│   ├── Main.tsx        # Split layout container
│   ├── Top.tsx         # Menu bar (New/Open/Import)
│   ├── Filters.tsx + FilterCard/FilterControls/FilterModals
│   ├── Tray/           # Results display (right panel)
│   ├── Clip/           # Clip preview / playback
│   ├── SettingsModal.tsx, SetupWizard.tsx, SlpzWizard.tsx, ZipWizard.tsx
│   └── AppConsole.tsx, UpdateBanner.tsx, LoadingScreen.tsx, …
├── hooks/              # useResultsFetcher, useWebglPipeline, etc.
├── workers/            # Renderer-side web workers
└── codeEditor.tsx      # Secondary BrowserWindow for the JS code editor

Models (src/models/)
├── Archive.ts          # File collection management
├── File.ts             # Per-file model
├── Filter.ts           # Filter execution with worker pool (Filter.run3)
├── Worker.ts           # Worker thread entry (runs filter methods)
├── ImportWorker.ts     # Import-specific worker
└── methods/            # Filter implementations (slpParser, comboFilter,
                        #   comboDetection, edgeguard, koDirection, sort, …)
```

`controller.ts` is now thin: it registers IPC handlers and delegates to
the managers in `src/main/managers/`. When adding a new IPC operation,
prefer extending an existing manager over adding logic directly to
`controller.ts`.

### IPC Communication Pattern

Request-response with requestId tracking. Renderer calls `ipcBridge.someMethod(callback)`, main handles via `ipcMain.on()` and replies with matching requestId.

### Worker Thread Model

`Filter.ts` slices data across worker threads. Each `Worker.ts` instance:
- Opens dedicated SQLite connection (WAL mode)
- Runs filter method on its data slice
- Inserts results via transaction
- Reports progress to main thread

### Key Data Flows

**Import:** Files dropped → `ipcBridge.importDroppedSlpFiles()` → `ImportManager` → `Archive` + parser worker pool (`Filter.run3` on the `files` method) → SQLite

**Filter:** User configures → `ipcBridge.runFilter()` / `runFilters()` → `FilterExecutor._executeFilter` → `Filter.run3()` slices work across `Worker.ts` instances → results to SQLite → UI updates

**Video:** Clip selected → `ipcBridge.generateVideo()` → `VideoManager` → `slpToVideo.ts` spawns Dolphin + ffmpeg → `.mp4`

## Key Directories

- `.erb/configs/` - Webpack configs (main, renderer, preload)
- `src/constants/` - Types, character/stage data, filter configs
- `src/lib/` - Shared utilities (file streaming, etc.)
- `release/app/` - Packaged app deps, bundled binaries (sqlite3, ffmpeg)

## External Dependencies

Requires **Slippi Dolphin** installed and configured via `dolphinPath`. FFmpeg and SQLite binaries are bundled in `release/app/`.

## Code Style

- TypeScript with strict mode
- Prettier: single quotes, no semicolons
- ESLint: erb config base
