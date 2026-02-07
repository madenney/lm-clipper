# TODO

## Ingestion scalability checklist

- [ ] Replace sync recursive file discovery with async streaming (no giant in-memory list).
- [ ] Remove double traversal on drop/import; single scan path.
- [ ] Add worker pool for Slippi parsing with bounded concurrency + backpressure.
- [ ] Batch inserts in a single SQLite transaction using a persistent connection.
- [ ] Add `files.path` index/unique and use `INSERT OR IGNORE` when dedupe is on.
- [ ] Throttle IPC progress updates (time- or count-based).
- [ ] Make import cancellable and resilient to partial failures.
- [ ] Avoid full-table loads in UI (never `SELECT *` on massive tables).
- [ ] Optional: two-phase ingest (index paths first, parse metadata later).

## General

- [ ] Parallelize replay import using worker threads with safe batching to avoid SQLite contention.
- [ ] Zoom tuning is temporarily hardcoded in `src/renderer/zoomConfig.ts`; replace with proper config/UI once the zoom behavior is finalized.
