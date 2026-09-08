# Shared Dolphin Runner — design draft (handoff)

**Status:** DRAFT for handoff to the jungle_media side. Written from inside
lm-clipper on 2026-09-07. Nothing built yet — this is the plan + the hard-won
knowledge, so a fresh session in jungle_media can pick it up cold.

**Goal:** extract the Slippi *Playback* Dolphin "run a replay" machinery that is
currently **copy-pasted across 4-5 projects** into one small, well-tested TS
package. Consolidate existing duplication; do NOT invent a speculative layer.

---

## 1. Why (the case)

Several projects each spawn a Slippi **Playback** Dolphin to frame-dump or
mirror replays, and they've been hand-copying the same recipe. jungle_media's
own `src/lib/render/dolphin.js` header literally says its method was *"copied
from replay_archiver's,"* *"proven on the kotj side,"* and that *"MST solves
this for its live mirrors."* That's 4-5 forks of one runner, already drifting.
Every fork re-learns the same OS-level gotchas (below), usually by shipping a
bug first.

The reusable core is **narrow and coherent**: *"given a `.slp` + settings, spawn
an isolated Playback Dolphin and either dump it to `.avi`+`.wav` or mirror it
live, safely (no hangs, no leaked processes, no mutated real profile)."*

Everything each app wraps around that — ffmpeg mux, overlay compositing, X11
workspace parking, upload, UI — stays in the app. Those are NOT in scope.

---

## 2. Inventory — what exists, and which parts are best-in-class

| Project | File | Mode | Strength to harvest |
|---|---|---|---|
| **jungle_media** (TS) | `src/lib/render/dolphin.js` `recordReplay()` | framedump | **Best runtime.** AbortSignal cancel; `pidTree` kill (AppImage execs → window pid isn't ours); stall watchdog w/ `.stall.log` diagnostic; **drains stderr** (unread 64KB pipe → Dolphin blocks & hangs); **buffers partial stdout lines**; numeric `>= end` frame compare; finite `endFrame` in comm; "a stall is a silence, not a verdict" → fall through to a duration guard; reads `lastFrame` by scanning `.slp` UBJSON directly (**no slippi-js dep**). |
| **lm-clipper** (TS) | `src/main/slpToVideo.ts` | framedump **+** interactive play | **Best profile handling.** Throwaway per-instance `--user` profile *builder* (`buildWorkerProfile`/`buildPlaybackProfile`), cross-platform path resolution (`resolveDolphinIniPaths`: Linux `~/.config/SlippiPlayback`, Windows portable `<dolphinDir>/User/Config`), Sys-relative-to-binary (no Sys seeding needed), profile "heal", and jest tests (`src/__tests__/dolphinProfile*.test.ts`). Also has the interactive `playClipAsync` (realtime-ish preview). |
| **replay_archiver** (TS) | — | framedump | Origin of the `DOLPHIN_TIMEOUT_MS` idea jungle_media copied. Cross-check its watchdog + comm details when porting. |
| **kotj** (TS) | — | framedump | Earlier proving ground referenced by jungle_media. Likely another near-dup. |
| **MST** (TS) | `scripts/slippi_capture.cjs` (WS spectator capture, NOT a spawner) + live **mirror** Dolphin (`isRealTimeMode`, `src/types/overlay.ts`) | realtime mirror | The realtime/broadcast mode + `dolphin_workspace` parking. Different mode; informs the `mirror()` half of the API. |
| **slp2mp4** (Python) | `src/slp2mp4/dolphin/{runner,ini,comm}.py` | framedump | The Python sibling. Stays separate (can't consume an npm lib); keep it aligned via this doc, not code. Uses `TemporaryDirectory` + `--user` (same throwaway idea). |

**Extraction base = jungle_media's `recordReplay` runtime + lm-clipper's profile
builder.** Neither alone is the whole thing; together they are.

---

## 3. Proposed package

- **Name (bikeshed later):** `@lunar/dolphin-runner` (or `slippi-dolphin-runner`).
- **Home (DECISION NEEDED):** candidates seen on disk — `~/Projects/lib`,
  `~/Projects/vb_shared`, a standalone repo, or a private npm package. Pick the
  one that other TS projects already import from.
- **Deps:** aim for **zero heavy deps.** No slippi-js (use jungle_media's UBJSON
  `lastFrame` scan). ffmpeg is the consumer's problem.
- **Runtime:** Node ESM, TS. No Electron dependency (lm-clipper's `getAppDataPath`
  already degrades gracefully when `electron.app` is absent — replicate that so
  non-Electron consumers like jungle_media work).

### Scope

**IN:** profile builder (throwaway `--user`), comm.json writer (finite endFrame),
Dolphin spawn (correct flags per platform), stdout frame-watch (partial-line
buffered), stderr drain, stall watchdog + kill-tree/pidTree, AbortSignal cancel,
cross-platform Sys/`--user`/Windows-`User/Config` resolution, optional real-profile
"heal".

**OUT:** ffmpeg mux/re-encode/concat, overlay compositing, X11 workspace parking,
uploads, progress UI, clip selection/filtering. (Each app keeps its own.)

---

## 4. Proposed API surface (sketch — refine tomorrow)

```ts
// --- config / detection -------------------------------------------------
interface DolphinPaths {
  dolphinPath: string   // Slippi PLAYBACK build (NOT netplay)
  isoPath: string       // Melee ISO
}
function dolphinStatus(p: DolphinPaths): string | null   // human reason or null
function dolphinConfigured(p: DolphinPaths): boolean

// --- profile ------------------------------------------------------------
interface ProfileOptions {
  dumpFrames: boolean          // true = record, false = mirror/play
  efbScale: number             // internal-res multiplier
  aspectRatio?: 5 | 6          // 6 = Force16:9 widescreen (record); omit = copy source
  bitrateKbps?: number
  gecko?: GeckoToggles         // hide HUD, screenshake, game music, crowd, chants…
}
// Builds a throwaway --user dir by COPYING the real profile's inis and applying
// overrides to the copies. Never mutates the real profile. Returns the dir.
// Caller deletes it (or pass { autocleanup } / return a disposable).
async function buildProfile(
  realProfile: RealProfileLocation,   // resolved per-OS (see §5)
  userDir: string,
  opts: ProfileOptions,
): Promise<void>

// --- run ----------------------------------------------------------------
interface RecordOptions {
  outDir: string                       // where Dolphin dumps <base>.avi/.wav
  userDir: string                      // this instance's --user profile (per worker!)
  onFrame?: (current: number, end: number) => void
  signal?: AbortSignal
  stallMs?: number                     // default ~120s; watchdog resets per [CURRENT_FRAME]
  display?: string                     // DISPLAY for the GL context (default :1 / env)
}
// Frame-dumps one replay. Resolves with dump paths even on a stall (a stall is a
// silence, not a verdict — let the caller's duration guard judge the footage).
async function record(slpPath: string, o: RecordOptions):
  Promise<{ avi: string; wav: string | null; stalled: boolean }>

interface MirrorOptions {              // realtime / broadcast (MST-style)
  userDir: string
  isRealTimeMode: true
  signal?: AbortSignal
  display?: string
  // NO dump; window stays on screen. Workspace parking stays in the consumer.
}
async function mirror(slpPath: string, o: MirrorOptions): Promise<void>
```

**Notes baked into the shape:**
- `record` vs `mirror` = the two modes. Both share spawn/comm/kill/watchdog; they
  differ in `dumpFrames`, `isRealTimeMode`, and output handling.
- **Per-instance `userDir` is mandatory, not optional.** The dump path is a
  property of the user dir, not the invocation — two Dolphins on one profile
  overwrite each other's frames *silently*. (jungle_media's comment; lm-clipper
  independently hit the same wall → per-worker profiles.)
- Profile strategy is pluggable but **defaults to throwaway** (lm-clipper style).
  jungle_media's current persistent `data/dolphin-user` becomes optional legacy;
  moving it onto throwaway profiles is a real upgrade (no hand-populate, no drift).

---

## 5. The hard-won knowledge (carry this verbatim — it's the actual value)

1. **Which Dolphin:** the **Playback** build (from the Slippi Launcher), never the
   netplay build. Different binary.
2. **`Sys/` is found relative to the binary** — it ships next to the AppImage
   (`…/playback/Sys`). A `--user` profile does NOT need Sys seeded. (Verified on
   Linux; Windows ships Sys next to the exe too but `--user` runtime behavior is
   still UNVERIFIED on Windows — see §7.)
3. **`--user` layout:** Dolphin reads `<userDir>/Config/{Dolphin,GFX,Hotkeys}.ini`
   and `<userDir>/GameSettings/GALE01.ini`. The `--user`/`-u` root is those dirs
   directly — no `User/` segment. (The `User/` you see in a Windows *real* profile
   is because the portable install's user-root IS `<dolphinDir>/User`.)
4. **Dump flags live in specific ini sections:** `Dolphin.ini` `[Movie]`
   `DumpFrames`/`DumpFramesSilent`/`DumpAudio`/`DumpAudioSilent` and `[DSP]`
   `DumpAudio`/`DumpAudioSilent`/`Backend=ALSA`. GFX dump keys in `GFX.ini`
   `[Settings]`: `InternalResolutionFrameDumps=True`, `BitrateKbps`, `EFBScale`,
   `AspectRatio` (6 = Force16:9). **Preserve `UseFFV1`** from the source GFX — it
   keeps the lossless intermediate that feeds the app's re-encode; dropping it
   silently degrades quality.
5. **Cross-platform real-profile location:** Linux `~/.config/SlippiPlayback`
   (`XDG_CONFIG_HOME`); Windows portable `<dolphinDir>/User`. See lm-clipper
   `resolveDolphinIniPaths()`.
6. **comm.json needs a finite `endFrame`** (= the `.slp`'s `lastFrame`), else
   Dolphin reports `[PLAYBACK_END_FRAME] INT_MAX` and idles on "waiting for game"
   forever. Shape: `{ mode:"normal", replay, startFrame:-123, endFrame:lastFrame,
   isRealTimeMode:false, commandId:<hex> }`.
7. **Read `lastFrame` cheaply** from the `.slp` UBJSON footer (scan for
   `"lastFrame"` + int32) — no slippi-js needed. (jungle_media `lastFrameOf`.)
8. **Batch mode alone does not exit at a replay's end.** Watch stdout and kill on
   `[CURRENT_FRAME] >= end`. **Compare NUMERICALLY with `>=`, not `==`/substring**
   — substring `845` matches inside `8454` (early kill → truncation); an exact `==`
   on a frame Dolphin never prints → never kills → hang.
9. **SIGTERM at end-of-replay** (lets `.avi`/`.wav` finalize), **SIGKILL for
   stalls/aborts.**
10. **Buffer partial stdout lines.** Node delivers stdout in arbitrary chunks; a
    split like `"[CURRENT_FRA"|"ME] 8454"` matches neither half → the end kill
    never fires → hang. Keep a `tail` across chunks.
11. **DRAIN STDERR.** spawn pipes all three streams; if you read stdout but not
    stderr, once Dolphin writes ~64KB to the unread stderr pipe the write BLOCKS
    and the process stops dead — high CPU, no frames, never exits. This is *the*
    classic "random stall." Read (and keep a tail of) stderr.
12. **Stall watchdog keyed on frame progress**, not file size — reset the timer on
    each `[CURRENT_FRAME]`. Window must exceed Dolphin boot+ISO load (~30s);
    ~120s is the tuned default. lm-clipper additionally splits boot-stale (90s)
    from frame-stale (30s).
13. **A stall is a silence, not a verdict.** Measured dumps at stall were 27/43/70/94%
    complete — some were done but hadn't announced it. Don't reject; resolve and let
    a duration/size guard judge the footage.
14. **Kill the whole tree.** An AppImage execs, so the window's pid isn't the one
    you spawned. POSIX: `pgrep -P` tree then SIGTERM→SIGKILL. Windows: `taskkill
    /T /F` (no real signals). (jungle_media `pidTree`; lm-clipper `killTree`.)
15. **Never mutate the real profile.** Build a throwaway `--user` profile from a
    copy. Optionally **heal** the real profile once (force dump flags `False`) to
    undo damage from older in-place versions — after which opening Dolphin to just
    watch a replay never inherits a framedump rig.
16. **Flags differ slightly between forks; pick one canonical set.** lm-clipper:
    `-i comm -o <base> --output-directory=<dir> -b -e <iso> --user <dir> --cout`.
    jungle_media adds `-u`(=`--user`) short form and `--hide-seekbar`. Recommend
    the canonical record set include `--hide-seekbar`. Mirror mode drops `-o`/
    `--output-directory` and sets `isRealTimeMode:true`.

---

## 6. Migration order (dogfood-first, lowest risk)

1. Stand up the package; port lm-clipper's `buildWorkerProfile`/`buildPlaybackProfile`
   + `resolveDolphinIniPaths` and jungle_media's `recordReplay` runtime into it.
   Bring the jest tests (`dolphinProfile*.test.ts`) along.
2. **Dogfood in lm-clipper first** (it already has the tested profile half + a
   green smoke harness — `scratchpad/dolphin-user-spike*.js`, `smoke-harness.ts`).
   Byte-compare output before/after.
3. Port **jungle_media** to consume `record()` (drop its private copy; keep its
   ffmpeg mux + workspace parking + upload). This is the main event.
4. Then replay_archiver, then MST's `mirror()`.
5. Keep **slp2mp4** (Python) aligned via §5, not code.

---

## 7. Open decisions / unknowns for tomorrow

- **Package home + name** (§3).
- **Windows `--user` at RUNTIME is unverified.** lm-clipper unit-tests the Windows
  path *resolution* (`dolphinProfile.windows.test.ts`), but no one has confirmed a
  Windows Playback Dolphin honors `--user` + Sys-relative-to-binary live. Verify on
  a Windows box before the package claims Windows support.
- **Profile strategy default:** confirm throwaway-by-default is acceptable for
  jungle_media's batch renderer (it currently relies on a persistent, hand-tuned
  `data/dolphin-user`). Provide a "use existing userDir" escape hatch.
- **Mirror mode surface:** MST's realtime needs are only sketched here — pull its
  actual spawn before finalizing the `mirror()` signature.
- **DISPLAY / headless:** framedump needs a live GL context. jungle_media pins
  `DISPLAY=:1`; decide whether the package owns that or the caller does (lean:
  caller passes `display`, package doesn't manage X).

---

## 8. Source pointers (exact, for the port)

- lm-clipper: `src/main/slpToVideo.ts` → `resolveDolphinIniPaths`, `buildGeckoSettings`,
  `buildWorkerProfile`, `buildPlaybackProfile`, `setDolphinDumping` (heal),
  `processOneReplay` (spawn+watchdog), `monitorDolphinRecording`, `killTree`.
  Tests: `src/__tests__/dolphinProfile.test.ts`, `dolphinProfile.windows.test.ts`.
  Manual spikes: `scratchpad/dolphin-user-spike*.js`, `smoke-harness.ts`,
  `play-spike.ts` (in the lm-clipper session scratchpad).
- jungle_media: `src/lib/render/dolphin.js` → `recordReplay`, `lastFrameOf`,
  `pidTree`, `parkOnWorkspace`, `dolphinStatus`.
- MST: `scripts/slippi_capture.cjs` (WS capture, reference only), mirror Dolphin
  via `src/types/overlay.ts` (`isRealTimeMode`) + `dolphin_workspace`.
- slp2mp4: `src/slp2mp4/dolphin/{runner,ini,comm}.py` (Python sibling).
