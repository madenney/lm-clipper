# Tray v2: every zoom level makes sense, down to millions of clips

The owner's ask (2026-10-11): rethink the tray's zoom levels so every size looks and
loads right, zoom out absurdly far (millions of clips, Clipper projects reach 48M rows),
and switch between a Single view and the multi-clip grid.

## Today (as reviewed)

- One number (`zoomSize`, 1–300 px) silently picks one of four renderers:
  300 = single card, 5–299 = DOM grid, 2–4 = GPU stage mosaic, <2 = GPU squares.
  Zooming in past the grid jumps into the single card without saying so.
- Data comes in pages (`numPerPage`, 10 … 10M, the ‹ 1/2 › pager). The GPU modes
  fetch `{id, stage}` objects by parsing every row's JSON in JS; millions of objects
  is gigabytes and minutes.
- Z/X in the single card stops at the end of the loaded page.
- Selection is off in the GPU modes.
- The toolbar mixes count, selection, pager, per-page and zoom in one row.

Done already: the Grid | Single switch (86520b3).

## Design

**One continuous grid, no pages.** The grid is the whole result list in order. The
view is a camera over it: tile size (zoom) + the first visible row (scroll).
Ctrl/⌘+wheel and pinch zoom around the cursor (the tile under the cursor stays under
it); the wheel scrolls; the scrollbar covers the whole list. The per-page box and
the data pager go away.

**What each size shows** (tile = one clip):

| Tile | Renderer | Shows |
| --- | --- | --- |
| 120–299 px | DOM cards | lightly dimmed stage art, both icons on one dark pill (combos/edgeguards/highlights: the arrow between them; games: a bold outlined "vs"; `CARD_LAYOUTS`), the step's lead line (hits + damage, edgeguard score, a game's players) + length, more lines from 165 / 220 px, strength meter, kill badge, Play/Record lower right on hover (`Clip/cardSummary.ts`) |
| 24–120 px | GPU | the card look: dimmed stage art, both icons (default costume) placed by the same `CARD_LAYOUTS` as the cards (per step: `cardLayoutForStep`), the empty info strip from ~56 px, from image atlases |
| 10–24 px | GPU | stage colour + the attacker's icon |
| 2–10 px | GPU | stage colour square |
| < 2 px | GPU | several clips per pixel, blended: a density map of the whole list |

DOM tiers only render what's on screen and fetch full rows for that window only
(offset/limit around the viewport, prefetching a screen either side).

**Overview data (the part that makes millions possible).** Per filter, a compact
summary: per row `stage + tone`, `char1`, `char2` (3 bytes) plus the row ids. The
first byte's low 6 bits are the stage (63 = none), its top 2 the card's tone
(kill / standout edgeguard, as cardSummary.ts decides it; stored column `ov_tone`
since 2026-10-16), so the GPU tiles draw the card's red / gold ring down to 6 px
and tint the whole tile below that, at no extra memory. Built once in
the DB worker from stored columns SQLite fills as results are written (older tables:
`json_extract`; no JS parsing either way), cached on disk next to the
project (`<project>.lunar-overview/<filterId>.bin`) and invalidated when the filter is
re-run, reordered or edited (and when its format version changes: version 2 added
the tone bits). Streamed to the renderer in chunks as ArrayBuffers, so the
far-out view fills in progressively; 48M rows = ~150 MB, held as typed arrays.

**GPU renderer.** One full-tray quad. The overview bytes are a data texture; the
fragment shader maps each screen pixel to a grid cell, the cell to a row index, the
row to its stage/characters, and colours it. Cost is per pixel, not per clip, so
48M rows draw as fast as 48. Below 1 px per clip it samples several rows per pixel and
blends. Character icons come from a texture atlas.

**Selection everywhere.** Click, Shift-click and drag-select work at every size
(index from the cursor position). A selection is "these rows" or "every row except
these" (Select All is a flag), held as bits by row id; main resolves it to rows only
when an action needs them.

**Single view.** Z/X walk the whole list (fetching the next window as needed).

**Toolbar.** Count on the left; Grid | Single and a zoom slider in the middle;
selection on the right.

## Status (2026-10-11)

Built and checked (headless Chrome + real Electron, synthetic 50k–5M clip lists):
- Overview data + disk cache (phase 1): worker-check real-SQLite checks.
- GPU overview (phase 2) with selection, Single from it, adaptive texture width,
  context-loss rebuild, CPU fallback (`localStorage['lunar.overview.renderer'] = 'cpu'`
  forces it), 150% scaling; real Electron on an RTX 5080 (ANGLE/OpenGL).
- Continuous list (phases 3–5): no pages; the grid's scroll covers every result and
  loads a 2,000-row window around the screen (placeholders while it loads); the
  single view walks the whole list (Z/X) with a 200-row window; Select visible.
- Toolbar: Grid | Single, a logarithmic zoom slider (fit-all … 299 px), zoom buttons.
- Zoom-out freeze fixed (2026-10-11): the DOM grid is mounted only at 40–299 px (it
  used to stay mounted hidden under the GPU overview and build one placeholder per
  clip on screen: ~190 ms per zoom step at 10k on screen, out of memory at 21M).
  It builds at most the screen + 2 rows either side and never more than
  `limits.maxDomElements` (tiles + placeholder blocks; one block per unloaded
  stretch), and the loaded window never starts past the first row on screen
  (`lib/domGrid.ts`, `__tests__/domGrid.test.tsx`: every zoom, screen and list size
  up to 21M rows).
- Zoom once per frame (2026-10-11): wheel, pinch, slider and buttons move a live
  zoom and the tray re-renders at most once per animation frame (`lib/zoomFrame.ts`);
  the far-out view's wheel listener is attached once and sends a factor, so fast
  pinches no longer lose ticks to a stale tile. Line- and page-mode wheels (Windows
  mice) zoom like a pixel notch, and one event zooms by at most ~3 notches
  (`__tests__/zoomFrame.test.tsx`).
- Selection overlay incremental (2026-10-11): each overview chunk marks only its own
  rows and the GPU uploads only the texture rows that changed (`lib/overviewMask.ts`;
  it used to clear, re-mark and re-upload the whole mask per 250k-row chunk: ~200 ms
  each at 21M with a selection). Clicks, Ctrl-clicks and drags in the overview
  re-mark only the rows they touched; other changes clear just the band that held
  marks. The view releases its textures, program and WebGL context when it unmounts
  (crossing 40 px no longer leaks a context) (`__tests__/overviewMask.test.tsx`).
- Window reads by position (2026-10-11): the grid's and single view's window no longer
  uses OFFSET. Each table keeps a sparse position index (the sort key of every 1,024th
  row, found the first time a position is asked for, dropped when another connection
  writes) and a window seeks to the nearest key (`main/rowSeek.ts`). The reads run on
  their own read-only connection in a second worker (`main/DbReadWorker.ts`,
  `main/readLane.ts`), so they never wait behind DbWorker's writes, overview chunks or
  counts; a newer tray window supersedes older ones (skipped, or stopped mid-walk
  keeping what it found) and the tray ignores their `stale` replies. Same rows as the
  old query (worker-check `seek.js`: gaps, custom sorts with ties, files, writes from
  another connection). Synthetic 5M rows: a window at row 4,998,000 took 2.2 s by
  OFFSET; the first visit there walks once (~2.1 s), after that any window up to it
  takes 1–10 ms. Custom-sorted reads use a form of the key test that SQLite seeks on
  (the row-value form scans the index from the start).
- Overview stored when results are written (2026-10-11): results tables are created
  with three stored generated columns (`ov_stage`, `ov_char1`, `ov_char2`, declared
  before `JSON`; `main/overview.ts` `RESULTS_TABLE_COLUMNS`), so SQLite fills them on
  every insert or JSON rewrite and the overview reads them instead of running
  `json_extract` over every row. Same bytes as before (worker-check `overview.js`,
  `harness.js` for every worker write path; `__tests__/storedOverview.test.ts` on
  node:sqlite). 1M rows warm: 1.5 s → 0.33 s to read (21M: ~30 s → ~7 s; the disk
  cache still serves later zoom-outs); inserts cost ~1.4 µs more per row. Tables made
  before this read with `json_extract` once and are cached as before; a re-run
  recreates them with the columns (generated columns can't be added to a table). The
  files table still reads its `players` JSON. Custom-sorted overview chunks now seek
  the sort index too (the row-value cursor scanned it from the start every chunk).
- Selection at any size (2026-10-11): a selection is "these rows" or "every row except
  these", the rows held as bits by row id in 8 KB pages, copied only where an edit
  writes (`lib/selection.ts`). Select All is a flag: instant on 21M rows, nothing read
  (it used to be a 54 s query and 21M id strings, ~2.5 GB, over IPC); a 3M-row drag in
  the overview is ~400 KB of bits. On a table the tray holds whole, Select All still
  names the ids as before. The overview's mask marks the bits and the shader inverts
  them under Select All. Nothing sends an id list for a big selection: delete, record
  and play send the selection and main resolves it in the DB worker
  (`main/selectionSql.ts`: runs of ids as one `BETWEEN`, scattered ids in `IN` lists of
  5,000, "every row except" walks the table's ids in display order), and removals and
  `getItemsByIds` now work in 5,000-id statements (more than ~32k ids used to fail).
  The duration of a selection the tray hasn't loaded is summed in SQL; under Select
  All the table's sum is asked for once and the rows left out are taken off it (it
  used to count only loaded clips for overview selections). `getAllResultIds` is
  gone. Tests: `__tests__/selection.test.ts` (against a Set model),
  `selectionSql.test.ts` (node:sqlite, against brute force), `traySelection.test.tsx`,
  `removeSelection.test.ts`. Worker-check `selection.js` (better-sqlite3): on 1M rows,
  Select All but 1,000 resolves to ids in 0.45 s and sums in 0.63 s; a 300k-row range
  sums in 0.16 s. Owner actions still take a short id list: under Select All they get
  the first clips in order, rows left out included.

- GPU tiles up to 120 px (2026-10-11): the DOM grid starts at 120 px (was 40); below,
  the GPU view draws the grid's card look (stage art cropped like the card, both
  character icons and the arrow, white border, rounded corners, blue tint + outline when
  selected or hovered; restyled 2026-10-16 with the grid cards: dimmed stage, icon chip,
  info strip, quiet edge, 3 px selection edge, `CARD_LOOK` in `lib/tileArt.ts`; again 2026-10-16: icons placed by `CARD_LAYOUTS` (arrow for clips, a bold "vs" for games), lighter dimming) from image atlases built once per session (`lib/tileArt.ts`:
  icons in one mipmapped atlas, stage pictures as texture-array layers, so shrinking
  never bleeds between them). It fades in from 24 px over the stage-colour + icon look.
  A zoom step at 40–120 px is one draw: real Electron on an RTX 5080, 200k clips,
  1500×850: 0.3–0.9 ms per step render + draw, against ~145–173 ms for the DOM cards at
  40–45 px (investigation); the CPU fallback draws stage art + icons, 17–35 ms per step.
  Crossing 120 px (either way) and closing Single keep your place: each view writes its
  scroll + geometry into a shared handoff and the other starts from the clip that was
  under the cursor (top row for the buttons and slider; Single's clip mid-screen); the
  DOM grid now also keeps the clip under the cursor across its own zooms
  (`lib/viewAnchor.ts`). Select visible works in the GPU view (up to 50,000 on
  screen); Single from there opens the clip last clicked or the first on screen. The
  tray opens at 120 px; a short list still zooms out to at least 40 px
  (`__tests__/gpuTiles.test.tsx`: no clip elements below 120 px, card uniforms and
  layers, place kept across crossings, Ctrl+wheel and Single).

- Review fixes at scale (2026-10-11):
  - Crossing 120 px keeps the GPU view: once shown it stays mounted, hidden, under the
    grid and Single (no draws, reads or range reports while hidden), so its WebGL
    context, data texture and selection marks are reused. Measured before on an RTX
    5080 at 21M: 250-540 ms per crossing re-uploading textures and 70-132 ms
    re-marking the selection; now a crossing uploads nothing and marks again only if
    the selection or table changed meanwhile. Any other table (or a re-read) uploads
    from the start (the texture tracks which overview it holds).
  - The GPU view's scroll goes to the shader as the first row on screen (int) plus the
    px into it (`lib/overviewScroll.ts`): sent as one float32 it was 16-32 px off deep in
    a 21M list (rows in the wrong place, smeared tiles, clicks picking another clip).
    `__tests__/overviewScroll.test.ts` repeats the shader maths in float32 against
    `indexAt` at 21M rows.
  - The DOM grid scrolls past Chromium's ~33.5M px limit: its scroll area stays under
    15M px and maps to a logical scroll (`lib/scrollSpace.ts`): wheel/keys 1:1, the
    scrollbar by fraction, re-based near the area's ends. At 120 px a 21M list is
    ~194M px; before, only the first ~3.6M clips could be reached in the grid and a deep
    handoff landed blank (`__tests__/scrollSpace.test.ts`, `domGrid.test.tsx`).
  - Removals: the GPU view reads the table again when main's removal reply arrives
    (it re-read when the request was sent, between main's 5,000-row deletes, and kept
    deleted clips); the disk cache is dropped before the first delete; removal and
    overview-chunk requests are never reaped at 30 s.
  - Disk cache integrity: a writer only accepts the chunk that follows the last one,
    writes its own temporary files, and is saved only with exactly the table's row
    count; a cache is served only for that count. A table replaced by a newer version
    (or pushed out of the renderer's cache) stops reading; a failed chunk is asked for
    again up to 3 times, and the error clears when loading starts again
    (`__tests__/overviewCache.test.ts`, `overviewStore.test.ts`, worker-check `overview.js`).
  - Slow sums off DbWorker: a table's and a selection's length run on a background
    read lane (a third read-only connection, `dbAsync.ts`), a newer one skipping older
    ones not yet started, so Select All's ~30 s sum at 21M no longer holds up the
    overview, counts or writes (worker-check `seek.js`: same answers as DbWorker).
  - The first zoom-out: when a filter run finishes, a table of 500k+ rows has its
    overview saved to the disk cache in the background (on that lane; stops if the tray
    starts reading it), so the first zoom below 120 px streams from disk.
  - CPU fallback that works: a shader that won't compile (or a lost context not back
    within 3 s) switches to the CPU renderer on a fresh canvas (a canvas that had a
    WebGL context can't give a 2D one; it used to say it couldn't draw). Failed GL
    objects are freed (`__tests__/overviewFallback.test.tsx`, `overviewContextLost.test.tsx`).
  - Ctrl+A in the GPU view selects the clips on screen (as Select visible); Single
    forgets the last clicked clip on a filter switch or removal.

Not yet: below 120 px the tiles show default costumes only (the overview holds stage +
two characters, not colours); no player names, length or Play/Record buttons there
(hover shows the matchup, double-click opens Single), and reordering by drag needs
the DOM grid (120 px+); a big table not run since 2026-10-11 still reads its overview
from SQLite on the first zoom below 120 px (then cached), and a custom-sorted one reads
slowly (~2.6 s per 1M rows: rows come in index order with rowid lookups; a covering
index or storing the bytes in sort order would fix it); rows are read from the top, not
from where you are; Select All's length is still a full-table sum (now in the
background, not stored); the grid card redesign for 120–300 px; Windows itself is
untested (ANGLE uses Direct3D 11 there; the CPU fallback covers machines without
WebGL2).

## Phases

1. Overview data: build + cache + stream (DB worker, IPC), tests on a big synthetic table.
2. GPU renderer v2 (shader grid, camera, density blending), replacing GpuLayer.
3. Continuous camera: wheel/pinch zoom at the cursor, scroll, scrollbar; drop paging.
4. DOM tiers windowed on the camera; card redesign for the two DOM sizes.
5. Selection at every size; Single view across the whole list.
6. Toolbar tidy; remove the old mode thresholds.
