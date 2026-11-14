# Replay library and workspaces (design, step 3 of the structure review)

Status: **design agreed 2026-10-01; not built yet.** The user's decisions:
1. Quick imports with no project open go into **one "My Replays" workspace**.
2. It lives in **app data** (hidden); Save As… writes named projects anywhere.
3. The 31 old Untitled projects get a **one-time review list** (empties
   pre-checked, Move to Trash only what's ticked; nothing deleted automatically).
4. Changing the Replay Library folder **moves the downloaded replays** and updates
   the index (resolves Phase 3's open question). Background: `docs/structure-review.md` (findings
C9–C11, D12), clip search plan `../../../docs/clip-search.md` (Phase 3 built the
library for downloads; Phase 4 needs this).

## Problems this solves

1. **The same work is redone for every project.** Import parses each replay's
   header again; the Combo Parser re-detects every combo from scratch, in every
   project, every time it's re-run with different settings.
2. **Every quick import makes a new file.** Importing with no project open
   creates `Untitled N.lunar` in `~/Documents/Lunar Clipper/` (the user has 31,
   986 MB). "Watch one replay" costs a file, a name and a Recent entry.
3. **Clip search Phase 4 has nowhere natural to put clips.** "Add to project"
   needs a current place to land, and its downloaded games should be ordinary
   games Clipper already knows.

## What stays the same

- **One SQLite file per project/workspace** (`db.ts`, filter tables, the
  DbWorker, Compact Project). No rewrite of the project format here; slimming
  result rows is step 4.
- Named projects keep working: open, Save As, Recent, share the file.
- Filters, their chains, playback and recording don't change.

## Part A: the library knows every replay and remembers detector results

Extends Phase 3's `library.sqlite` (in the Library folder, run on the DbWorker
thread with its own connection) from "downloaded replays" to every replay
Clipper has seen.

```
games            one row per distinct recording
  id INTEGER PK
  contentHash TEXT UNIQUE   -- MD5 of the whole file: the database's fileHash
  replayId TEXT             -- Lunar Database id, when known
  size, header JSON         -- players, stage, startedAt, lastFrame, winner, valid/info
paths            where a game lives (a game can be in several places)
  path TEXT PK, size, mtime, gameId
detections       cached detector output per game
  gameId, detector, version, paramsKey, rows (compact JSON), createdAt
  PRIMARY KEY (gameId, detector, version, paramsKey)
```

(Phase 3's `replays` table becomes `games` + `paths`; it is unreleased, so no
migration is needed.)

**Import** looks each file up by path + size + mtime. Known file: copy its
header into the project, no parse. Unknown: parse the header as today and record
it. Importing the same Slippi folder into a second project becomes near-instant.

**Identity without extra reads.** Hashing needs the whole file; import today
reads only the header and metadata. So the hash is taken the first time a
detector reads the full file anyway (Combo Parser etc.), and stored then. Until
then the game is known by path. Downloaded games already arrive with their hash
(bundle manifest).

**Detector cache.**

| Detector | What changes its output | Cached |
|---|---|---|
| Combos (`detectCombos`) | combo timeout only (default 45 frames); every other Combo Parser setting filters afterwards | always, keyed by timeout |
| Edgeguards | offstage buffer, leniency, min offstage frames, lookback, … | keyed by a hash of those settings |
| Others (phantom, KO direction, …) | | later, same pattern |

A Combo Parser run then becomes: for each game, cached combos for (game,
timeout)? use them; otherwise parse, detect, store. Then apply the run's filters
as today. Re-running with different hits/characters/kill settings re-reads
nothing. `version` comes from `packages/replay-analysis` (a constant bumped when
a detector changes), so a detector change never serves stale results.

Size: about 40 raw combos per game in a compact row format ≈ 5–6 KB per game;
10k games ≈ 60 MB, the full 3.3M-game database ≈ 18 GB. Settings gets "Clear
detector cache" with its size.

**What the database can and can't fill.** The database ran the same detectors
(parity verified) but its clips index keeps only combos with 4+ moves or a kill,
so it can't fill the full combo cache. Phase 4 clips go straight into the
project as a result table (below); a full per-game cache from the database's
detail files is a later option.

## Part B: workspaces instead of Untitled files

- **One default workspace, "My Replays".** Importing with no project open adds
  to it instead of creating `Untitled N`. It is a normal project file, kept in
  **app data** (`<userData>/Workspaces/My Replays.lunar`), so it never
  clutters Documents.
- **Named projects are opt-in.** File > New Project asks for a name and creates
  a workspace; "Save As…" writes a project file anywhere (today's behaviour).
  Opening a `.lunar` from anywhere works as now.
- **Start screen / Recent**: "My Replays" first, then recent projects.
- **Existing Untitled files:** nothing is deleted automatically. On
  first launch after the change, offer once: "You have 31 untitled projects (986
  MB). Review them" → a list with game counts, sizes and dates, checkboxes, and
  "Move to Trash". Empty ones (no games) pre-checked.
- `APP_FLOW.md` and the dev screen switcher change with it (first import lands
  in My Replays, no project concept for new users, as the target flow wants).

## Part D: replays that disappear from disk

Replays get deleted, moved, renamed, or live on a drive that's unplugged. Today
nothing notices until a filter or playback fails ("N files not found" after a
run). Instead:

**Check.** When a project opens, a worker checks every game's path in the
background (one `stat` per file: about a second for 10k games; a 2.8M-game
project takes longer, so it runs in chunks and never blocks). The library checks
its own `paths` the same way on lookups. Filters keep their existing per-run
missing count.

**Never delete on our own.** Missing games are marked (`missing` on the project's
`files` row and the library's `paths` row) and unmarked if they come back.

**Fix automatically when we can.** If the same recording (content hash) is known
at another path that still exists (e.g. its Lunar Database download in the
library), repoint the game there. Logged, no prompt.

**Otherwise one quiet warning** in the workspace, not a modal:

> 312 games in this project are missing from disk (moved or deleted).
> Locate… · Download again (40) · Remove from project

- **Locate…**: pick a folder; Clipper matches the missing games by file name +
  size (hash when known) and repoints every match.
- **Download again**: games that came from the Lunar Database (replayId known)
  are fetched back into the library.
- **Remove from project**: drops the missing games and their clips.

**Unplugged drive or moved folder.** If everything under one folder is missing and
that folder itself is gone (e.g. `/media/usb/Slippi`), say so instead:
"Folder not found: /media/usb/Slippi (1,204 games). Reconnect the drive or
Locate…", and don't lead with Remove, so an unplugged drive can't empty a
project by accident.

**Deleting from the tray (owner's call, 2026-10-15).** Delete in the Replays
step deletes the replays from Clipper: the project's files rows and every row
of every step made from them, the replay library's index (`libraryForget`: so
Find replays no longer says "In your library") and My Replays when another
project is open. The files themselves are never deleted, trashed or moved,
wherever they are (also the downloads inside the library folder). A warning
with the real count comes first (config `confirmDeleteReplays`, "Don't show
this again"; Settings › Project › "Warn before deleting replays"). Delete in a
filter step removes only those results and the rows later steps made from them
(`_sourceId`, a Sort's verbatim copies, or the same game and frames), without a
warning. Removing missing replays (above) still changes only the project. Each
delete lowers the cached counts with it (`main/removeRows.ts`); a project saved
with stale counts recounts itself when its tray reads past the real end.

## Part C: how clip search Phase 4 uses this

"Add to project" on Lunar Database clips:

1. `libraryLookup(replayIds)` → games already here vs missing.
2. Download the missing ones (`replayIds` transfer, Phase 2/3), extract into the
   library, record them in `games`/`paths` with hash and replayId.
3. Add the games to the open project, or to My Replays when none is open.
4. Create a **"Lunar Database clips"** result table holding the chosen clips
   (built from the clip search rows: frames, players, moves), and open the
   workspace on it. Downstream filters (Combo Filter, Sort, Trim) work on it as
   on Combo Parser output.

## Progress

- **Step 1 done (2026-10-02, branch `wip/clipper-database`):** `library.sqlite`
  has `games` + `paths` (Phase 3's `replays` table migrates on open; paths are
  absolute now). Import asks the library first: an unchanged file (same path,
  size, mtime) reuses its stored header instead of being parsed. On 11,673 real
  replays: 189 s to parse vs 1.7 s from the library (111x); headers identical.
- **Step 1b done (same day):** `MissingCheckWorker` checks a project's games
  when it opens (folder listings, not one stat per file: 2.8M games on the
  network archive in 62 s), marks `files.missing`, repoints games whose
  recording is still on disk at another known path (clip rows follow), and
  reports gone folders and Lunar Database games that can be downloaded again.
  The workspace shows `MissingReplaysBar` (Locate… / Download again / Remove
  from project). "Download again" is `TransferManager.downloadReplays`
  (replayIds export into the library, no import; the check re-runs when it
  finishes). Real-SQLite checks: `scripts/worker-check/missing.js`.
- **Step 2 done (same day):** combo cache. The Combo Parser reads each replay
  once (hash + parse from one buffer), caches raw combos in `detections` per
  game + `COMBO_DETECTOR.version` + timeout (`models/detectionCache.ts`; a test
  pins the version to `combos.ts`'s hash). 2,000 real replays: 500 s today, 273
  s first run, 1.0 s re-run (505x), 0.4 s with different settings; identical
  results; ~12 KB per game. Edgeguard cache and Settings "Clear detector cache"
  (functions exist: `libraryDetectionStats/Clear`) are still to do.
- **Decision 4 done:** Settings > Replay Library moves the library
  (`controller.moveReplayLibrary`): asks, refuses while transfers/imports/filters
  use it, renames (same drive) or copies then removes, rewrites `paths`, records
  `moves`; projects are repointed by the missing-replay check on open.
- **Steps 3–4 done:** My Replays (`<userData>/Workspaces/My Replays.lunar`) for
  imports/downloads with no project open; New Project asks for name and place;
  one-time offer to trash empty old Untitled projects. APP_FLOW.md updated.
- **Step 5 (clip search Phase 4) done:** see `../../../docs/clip-search.md`.
- Not yet merged to main or released; not yet clicked through in the running
  app (unit, real-SQLite and build checks only).

## Build order

1. Library schema (`games`, `paths`, `detections`) + import lookup by path
   (Part A without the detector cache). Measurable: re-import time.
1b. Missing replays (Part D): background check on open, `missing` marks,
   automatic repoint by hash, the warning with Locate / Download again / Remove.
2. Hash on first full read; combo cache in the Combo Parser path (filter
   worker opens `library.sqlite`; WAL + busy timeout for concurrent workers).
   Measurable: re-run time with changed settings.
3. Workspaces: My Replays, New Project naming, start screen, APP_FLOW.
4. Untitled cleanup offer.
5. Clip search Phase 4 on top.
6. Edgeguard cache; Settings "Clear detector cache".

Each step ships alone and is checked with `scripts/worker-check` style real
SQLite runs plus a timing on the user's real projects (read-only copies).

## Risks

- **Concurrent writers to `library.sqlite`** (DbWorker + N filter workers):
  WAL with busy timeout; writes are small batched inserts. Measure with 8 workers.
- **Cache correctness:** keyed by content hash + detector version + the exact
  detection settings; never by path alone.
- **A moved Library folder:** Clipper moves the downloaded files to the new
  folder and updates `paths` (downloads are stored library-relative, local files
  absolute). Projects reference library files by path, so their `files` rows are
  rewritten in the same step for open/recent projects; others are fixed when next
  opened (lookup by content hash). Local files that moved are re-found by hash
  when re-imported.
- **Size of the cache** for people who parse huge sets: shown in Settings with a
  clear button; only raw detector output is stored, not every filter's results.
