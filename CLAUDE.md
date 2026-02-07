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
├── main.ts           # Entry: BrowserWindow, app lifecycle
├── controller.ts     # IPC handlers, orchestrates all operations
├── db.ts             # SQLite schema & queries (better-sqlite3)
├── slpToVideo.ts     # Video generation (Dolphin + ffmpeg)
└── workflow.ts       # Batch processing automation

Renderer Process (src/renderer/)
├── App.tsx           # Root component
├── ipcBridge.ts      # IPC request-response wrapper
├── components/
│   ├── Main.tsx      # Split layout container
│   ├── Top.tsx       # Menu bar (New/Open/Import)
│   ├── Filters2.tsx  # Filter controls (left panel)
│   └── Tray.tsx      # Results display (right panel)
└── hooks/            # useResultsFetcher, useWebglPipeline, etc.

Models (src/models/)
├── Archive.ts        # File collection management
├── Filter.ts         # Filter execution with worker pool
├── Worker.ts         # Worker thread entry (runs filter methods)
└── methods/          # Filter implementations (slpParser2, comboFilter, etc.)
```

### IPC Communication Pattern

Request-response with requestId tracking. Renderer calls `ipcBridge.someMethod(callback)`, main handles via `ipcMain.on()` and replies with matching requestId.

### Worker Thread Model

`Filter.ts` slices data across worker threads. Each `Worker.ts` instance:
- Opens dedicated SQLite connection (WAL mode)
- Runs filter method on its data slice
- Inserts results via transaction
- Reports progress to main thread

### Key Data Flows

**Import:** Files dropped → `ipcBridge.importDroppedSlpFiles()` → `Archive.addFiles()` → worker pool parses → `db.insertFiles()`

**Filter:** User configures → `ipcBridge.runFilter()` → `Filter.run3()` → workers execute method → results to SQLite → UI updates

**Video:** Clip selected → `ipcBridge.generateVideo()` → `slpToVideo.ts` spawns Dolphin + ffmpeg → outputs .mp4

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
