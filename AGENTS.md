# Clipper guidance

Read the root AGENTS.md and docs/architecture.md. Existing detailed guidance is
in docs/application-guide.md (its relative paths refer to this app directory).

Electron/React 18/TypeScript, local SQLite projects, worker threads, Dolphin and
ffmpeg. Managers in src/main/managers own operations; controller registers IPC.
New renderer IPC channels must be in preload's allowlist and have replies/error paths.
Run npm run typecheck; test with npm test. Keep native dependencies in release/app
and use the existing rebuild scripts for Electron ABI compatibility.

APP_FLOW.md is the canonical onboarding lifecycle. If that flow changes, update
it and DevScreenSwitcher in the same change. Preserve playback/recording isolation
and real user Dolphin settings. Don't record, reset settings, or delete replay data
as routine verification.

The database panel/transfer/extractor work is paused, incomplete and uncommitted.
Read docs/database-integration-handoff.md before resuming; no feature work during
repository consolidation.
