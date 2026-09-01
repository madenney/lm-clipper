# Lunar Clipper — Clip Manifest (`manifest.json`)

> **Audience:** anyone building overlays, montages, or post-processing on top of
> a batch of clips Lunar Clipper produced — typically on **another machine** than
> the one that recorded them. This document is the source of truth for the file's
> shape and guarantees. The writer lives in `src/main/manifestWriter.ts`; the
> per-clip data is assembled in `src/main/managers/VideoManager.ts`
> (`buildManifestWriter`). Keep this doc and those in sync.

## Overview

When **Settings → Video → "Write manifest.json"** is enabled, each recording run
writes a single `manifest.json` into that run's output folder (next to the clip
files and `failures.json`). It maps every clip file to the full metadata behind
it — source replay, frame ranges, players/characters, combo and edgeguard stats,
and ready-to-use overlay tokens — so a downstream tool can render on top of each
clip without re-parsing any `.slp`.

The option is **off by default**. It is purely additive: nothing else in the
recording pipeline changes when it is on.

### Write strategy (why you can trust a partial file)

1. **Written up front.** The complete skeleton — every clip, all metadata,
   `status: "pending"` — is written *before the first clip records*. An
   interrupted or crashed run therefore still leaves a manifest that lists every
   intended clip with full data; only some `status` fields may be stale.
2. **Updated incrementally.** As each clip finishes it flips to `"done"` (and
   gains `fileSize` + `durationFrames`); a clip that fails every retry flips to
   `"failed"`. The top-level `counts` track totals.
3. **Atomic + coalesced.** Writes go to `manifest.json.tmp` then `rename()` (so a
   write can never corrupt the file), and are coalesced to at most once per
   second (so thousands of completions don't mean thousands of full rewrites). A
   hard process kill loses at most ~1s of *status* updates — never clip data.

## Location

```
<outputPath>/<run folder>/manifest.json
```

The run folder is the timestamped output directory Lunar Clipper creates per
recording. `manifest.json` sits alongside the clip files it describes.

## Top-level shape

```jsonc
{
  "manifestVersion": 1,               // bump on breaking schema changes
  "project": "m2k",                   // project (archive) name, may be omitted
  "createdAt": "2026-08-25T16:33:00.000Z",
  "outputDir": "/abs/path/to/run folder",
  "recording": {                      // the settings this run used
    "resolution": 4,
    "bitrateKbps": 50000,
    "widescreen": false,
    "convertToMp4": true,
    "addStartFrames": 0,
    "addEndFrames": 0,
    "outputFilenamePattern": "{index}",
    "numProcesses": 8
  },
  "counts": { "total": 5205, "done": 5205, "failed": 0, "pending": 0 },
  "concatenatedInto": "final.mp4",    // present only if auto-concat produced it
  "clips": [ /* one entry per clip, in record order — see below */ ]
}
```

## Per-clip shape

Key each clip by **`outputFile`** (relative to `outputDir`). `clips` is ordered
by `index` (record order), which is also the auto-concat order.

```jsonc
{
  "outputFile": "0001.mp4",           // relative path of the rendered clip file
  "index": 1,                         // 0-based position in the record queue
  "status": "done",                   // "pending" | "done" | "failed"

  "source": {
    "slpPath": "/path/Game_2024...slp",
    "startFrame": 3050,               // the clip's logical start (nullable)
    "endFrame": 3302,                 // logical end (nullable)
    "recordedStartFrame": 3050,       // actual recorded window (incl. lead-in / pad)
    "recordedEndFrame": 3302
  },

  "startedAt": 1732785000,            // game start, unix seconds (nullable)
  "stage": { "id": 3, "name": "Pokémon Stadium" },

  "players": [                        // every player in the game
    {
      "playerIndex": 0, "port": 1,
      "characterId": 9, "characterName": "Marth", "characterColor": 3,
      "displayName": "type !HelpM2K", "connectCode": "KOTU#737", "nametag": ""
    }
    /* ... */
  ],
  "attacker": { /* same player shape */ },  // comboer, null if not applicable
  "victim":   { /* same player shape */ },  // comboee, null if not applicable

  "combo": {                          // null unless the clip came from a combo parser
    "startPercent": 12, "endPercent": 98, "damage": 86,
    "moves": 7, "didKill": true
  },

  "edgeguard": {                      // null unless from the Edgeguards Parser
    "hits": 3, "recoveryAttempts": 2, "minLedgeDist": 8.1,
    "edgeguarderDepth": 41.2, "stageTouches": 1, "diedOffstage": true,
    /* ...all EdgeguardMetrics fields... */
    "score": 47.3
  },

  "overlayTokens": {                  // resolved, ready to drop into overlay text
    "character1": "Marth", "character2": "Fox",
    "player1": "type !HelpM2K", "player2": "viaSunny",
    "stage": "Pokémon Stadium", "date": "2024-09-08", "time": "0501",
    "index": "0001", "source": "...", /* ... */
  },

  "fileSize": 3123456,                // bytes, added on completion (may be absent)
  "durationFrames": 252              // recorded span, added on completion
}
```

Fields are `null` when not applicable (e.g. `combo` on an edgeguard clip,
`edgeguard` on a combo clip). `overlayTokens` mirrors the app's own overlay
system (`src/lib/overlayTokens.ts`) so text like `"{player1} vs {player2}"`
resolves the same way downstream.

## Consuming it

- **Match a clip file to its metadata** by `outputFile`. `outputFile` is the
  *predicted* name from `recording.outputFilenamePattern`; with the default
  `{index}` pattern (zero-padded to 4 digits) it always matches the file on disk.
- **Skip incomplete work** by filtering `status === "done"`. `"pending"` after a
  run means that clip never finished (interrupted); `"failed"` means it exhausted
  retries — cross-reference `failures.json`.
- **Order** is `index` ascending, which equals the alphabetical file order for
  the default padded pattern and the auto-concat order.

## Caveats

- **Size.** Tens–hundreds of clips → a few KB. A very large run (e.g. ~5,000
  clips with full players + metrics + tokens) → roughly **5–10 MB**. Still one
  small JSON, written atomically.
- **Custom filename patterns.** A non-padded or non-unique
  `outputFilenamePattern` can make `outputFile` collide or sort out of numeric
  order — the same caveat that affects the auto-concat. The default `{index}`
  pattern avoids both.
- **`manifestVersion`.** Treat unknown future fields as additive; a breaking
  change bumps `manifestVersion`.
