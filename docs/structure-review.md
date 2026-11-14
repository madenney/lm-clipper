# Clipper structure review (2026-09-30)

A whole-app review of how Clipper stores, processes and shows replays, done
before clip search Phase 4. Measurements are from the user's real projects in
`~/Projects/_lm-clipper-projects/` (read-only). Nothing here is decided yet:
the plan at the end is a proposal for the user.

## How it works today

```
renderer (React)  ──ipcBridge (requestId + reply, hand-rolled)──►  main process
                                                                    controller.ts + managers/
                                                                         │
             ┌───────────────────────────────┬──────────────────────────┤
             ▼                               ▼                          ▼
   DbWorker (one SQLite conn,       filter Worker threads         ImportWorker pool
   all main-process queries)        (each opens the project       (parse .slp metadata)
                                     SQLite itself, N per run)
             └──────────────► project.lunar (SQLite) ◄──────────────────┘
                              metadata  (one JSON blob: filter list, counts)
                              files     (one row per game)
                              filter_<id> tables: (id, JSON) one row per result
```

- A **project** is one SQLite file. Importing parses each `.slp`'s header into
  `files`. Each filter in the chain has its own table; running a filter reads
  the previous table in id ranges (split across worker threads) and writes
  full JSON rows into its own table.
- Filters are run by hand, one at a time (branching is optional). File-reading
  filters (12 of them) each open the `.slp` with slippi-js themselves.
- The tray pages results with `ORDER BY COALESCE(sort_order, id) LIMIT/OFFSET`.
- Recording/playback (`slpToVideo.ts`, `VideoManager.ts`) is separate, recently
  isolated (per-worker Dolphin profiles) and battle-tested; out of scope here.

**Worth keeping:** SQLite off the main thread (DbWorker), worker threads for
filters, results streaming in while a filter runs, resumable runs, the
Dolphin isolation, the hardening in the video pipeline. One file per project
is also fine as the unit of save/share/delete.

## Findings

### A. Correctness bugs

1. **Rows are silently skipped after removing games or clips.** `Filter.run3`
   takes `COUNT(*)` of the input table and slices ids `1..COUNT`
   (`createSlices`), and `Worker.getRows` reads `WHERE id BETWEEN bottom AND
   top`. Removing a game (`ClipManager.removeGame`) or a clip (`removeResult`)
   deletes rows and leaves id gaps, so the next run of the next filter never
   reads the last N rows (N = rows removed). Example: 100 games, remove game 5
   → the Game Filter processes ids 1–99 and game 100 disappears. Same for Sort
   and every chunked filter. Fix: slice by real ids (keyset: `id > last LIMIT n`,
   or split `MIN(id)..MAX(id)`), plus a regression test.
2. **Re-importing a folder duplicates games by default.** `detectDuplicatesOnImport`
   defaults to `false`, so importing the Slippi folder again adds every game a
   second time (and every later filter finds every combo twice). The check it
   skips is one indexed lookup by path per file, which also avoids re-parsing
   the file, so the "can significantly slow down imports" warning looks
   outdated. Measure, then make it always on.
3. **Two filters can run out of memory on long games.** `highlight` and
   `afkDetection` load full frame data but aren't in `Filter.ts`'s list that
   raises the worker heap to 1 GB (the list and `Worker.ts`'s "slow" list
   disagree). Symptom: a worker crash on big files.
4. **Manual clip order is lost downstream.** Dragging clips sets `sort_order`,
   which the tray and Range respect, but every other filter reads its input
   `ORDER BY id`, so the next filter's output is back in the original order.

### B. Storage: projects are 5–10x bigger than they need to be

| Project | Size | Where it goes |
|---|---|---|
| `full_db.lunar` | 57 GB | combo results 42 GB (48.7M rows), 11.9 GB empty pages |
| `full_db_only_games.lunar` | 7.8 GB | **6.1 GB empty**; real data ~1.7 GB |
| `full_db_phantom_rests.lunar` | 7.8 GB | same games imported again |
| `mura.lunar` | 0.17 GB | 186k combos |

5. **Each result row repeats the whole game.** A combo row averages 754 bytes of
   JSON: the full path, both players' names/codes/colours, stage and date are
   copied from `files` into every row. The combo itself is ~150 bytes.
6. **Every chain step copies every row.** The Game Filter table is a full JSON
   copy of `files` (1.7 GB next to 1.2 GB in `full_db`); Sort, Range, Trim and
   friends copy whole rows again.
7. **Space is never reclaimed.** No VACUUM/auto_vacuum anywhere; deleting or
   re-running a filter leaves the file at its peak size.
8. **Some queries scan everything.** Removing a game's results uses
   `JSON_EXTRACT(JSON, '$.path')` / `'$._sourceId'` (no index possible), so it
   reads all 48M rows per filter. Deep scrolling uses `OFFSET`, which also gets
   slower the further down you go.

### C. Repeated work

9. **Nothing is shared between projects.** The same games imported into three
   projects are parsed three times; the Combo Parser re-runs from scratch in
   each project.
10. **Each file-reading filter re-parses the replay.** A chain with Combo
    Parser + Edgeguards + KO Direction opens and parses every `.slp` three times.
11. **Lunar Database replays are already analysed.** The database ran the same
    detectors (`packages/replay-analysis`, parity verified) on all 3.35M games;
    Clipper re-detects them after download. Clip search Phase 4 can hand
    Clipper the results instead.

### D. Project model

12. **Every quick import creates an `Untitled N.lunar`** in Documents (the user
    had 31). Already in `TODO.md` ("one library + workspaces"): the fix is one
    replay library (Phase 3's `library.sqlite`, extended to local replays) and
    lightweight workspaces, with named `.lunar` files opt-in via "Save as
    project…".

### E. Code structure

13. **Filter types are special-cased in five places**: `Filter.ts` (single-thread
    types, heap list), `Worker.ts` (sort/randomSample/range branches, parser
    set, emitter set, slow set, custom chunk size). They already disagree (A3).
    One filter registry — each type declares reads-replay, single-threaded,
    chunk size, heap, output kind — removes that class of bug and makes new
    filter types (e.g. Phase 4's "Lunar Database clips") a one-place change.
14. **IPC is hand-rolled request/reply** (`ipcBridge.ts`: request ids, a stale
    reaper, a list of long-running channels that must not time out; 104 call
    sites). Electron's `invoke`/`handle` does this natively with promises and
    real errors. Worth migrating channel by channel, not in one go.
15. **`controller.ts` is still 1,900 lines** (project open/save/recent, filter
    CRUD, results paging, config, dev tools). Splitting out a ProjectManager and
    FilterManager like the existing managers would help.
16. **Renderer state is spread across big components** (`Main.tsx` and
    `Filters.tsx` each hold ~24 `useState`s; App + two contexts). Lower priority
    than the data layer; revisit when the workspace model changes the screens.
17. **Project settings live in one JSON blob** (`metadata.extra`) written from
    two connections with read-merge-write; the comments show past races. A small
    `filters` table (one row per filter) would remove that.

## Proposed plan

Order chosen so each step is useful alone and later steps build on earlier ones.

**Step 1: quick fixes — DONE 2026-10-01** (main). A1–A4 fixed, plus a fifth bug
found on the way: Combo Parser rows didn't record their game (`_sourceId`), so
Resume re-added every combo already found. Shared `models/filterTraits.ts` for
the replay-reading list (A3); manual order passes through `main/manualOrder.ts`
(the tray's existing `idx_<table>_sortorder` index marks ordered tables); duplicate
detection is always on (0.1 ms per file on a 2.8M-game project) and the setting
is gone. File > Compact Project… (`main/projectCompaction.ts`, `CompactWorker.ts`):
in place for incremental-vacuum projects (all new projects), otherwise `VACUUM
INTO` a copy that is checked and swapped in. A copy of `full_db_only_games` went
7.8 GB -> 1.7 GB in 3 s. Real-SQLite worker checks: `scripts/worker-check/run.sh`
(fails 7 of 8 on the old worker). Original plan:
- A1 id-gap bug (+ regression test), A2 duplicate import default on (after a
  timing check), A3 heap list, A4 downstream order.
- B7 compaction: `auto_vacuum = INCREMENTAL` for new projects, a
  "Compact project" action, and compaction after big deletes/re-runs. Frees
  ~18 GB on the user's disk today.

**Step 2: filter registry (E13) — DONE 2026-10-02** (branch `wip/clipper-database`):
`models/filterTraits.ts` `FILTER_TRAITS`; Filter.ts and Worker.ts read it; a test
covers every configured type and method. Steps 3 (library, workspaces, caches,
missing replays) are done there too: see `library-workspaces.md`. Original plan:
- One table of filter traits used by `Filter.ts` and `Worker.ts`. Pure refactor
  with tests; prerequisite for adding new filter types cleanly.

**Step 3: the library becomes the home of replays (C9, C10, C11, D12)**
- Extend `library.sqlite`: every replay Clipper knows (local or downloaded),
  keyed by content hash, with its header info and cached detector results
  (`detector, version → rows`). Import = look up, parse only unknown files.
  Parsers = look up, run only on unknown (replay, detector version) pairs.
  Downloaded Lunar DB games arrive with their detector results.
- Workspaces instead of Untitled projects: quick imports land in a default
  workspace; "Save as project…" writes a named file.
- This is also what clip search Phase 4 needs ("Add to project" = add library
  replays + their clips to the current workspace), so do it before Phase 4.

**Step 4: slim results (B5, B6, B8, E17)**
- Results reference games by id (`file_id`, frames, clip fields; moves compact);
  path/players/stage are joined when read. Game Filter stores ids, not copies.
  Typed columns for what filters and deletes query (`file_id`, `sort_order`)
  with indexes; keyset paging in the tray. Migration for existing projects
  (convert on open, keep a backup). Roughly 5x smaller results and indexed
  deletes. The biggest change here: every filter method reads and writes rows.

**Step 5: code structure (E14–E16)**
- Move IPC to `invoke`/`handle` channel by channel; split `controller.ts`;
  tidy renderer state as screens change for workspaces.

Not in this review: the video pipeline internals, custom-filter sandboxing, the
slippi-js 6 → 9 upgrade (tracked in `TODO.md`).
