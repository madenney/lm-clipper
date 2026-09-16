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

### Per-worker throwaway Dolphin profile (`--user`) — RECORDING + PLAYBACK DONE (2026-09-07); Windows verify + minor cleanup remain
**STATUS:** Both the recording and playback paths are isolated. The real Slippi profile is no longer mutated by either.

Recording (commit `31aec14`): `configureDolphin()` (in-place mutation) → `buildWorkerProfile(config, userDir)`, one throwaway `--user` temp profile per worker (copy-transform real GFX.ini/Dolphin.ini so `UseFFV1`/quality is preserved + fresh GALE01/Hotkeys), created once-per-worker in `processReplays` and `rm -rf`'d in a `finally`. `processOneReplay` passes `--user`. Per-record `dtkdump.wav` cleanup DELETED. Old configureDolphin call → `setDolphinDumping(config,false)` at run start, which now HEALS the real profile (undoes dump flags left on by older in-place versions).

Playback (commit `b850e5c`): `playClipAsync` builds an isolated `--user` profile (`buildPlaybackProfile`) by copying the real profile's inis and applying only the playback overrides to the copies (EFBScale=playbackResolution, gecko toggles, dump flags OFF), then launches with `--user`. Removed now-dead `writeGeckoCodes` (slpToVideo), `updateEfbScale` + `getGfxIniPath` (util), and the play-path dtkdump cleanup. `setDolphinDumping` stays as the record-start healer only.

Verified on Linux (all): tsc 0 / eslint clean / jest 186 / webpack build. Recording spike (`scratchpad/dolphin-user-spike2.js`) → lossless FFV1 4K + wav, real profile byte-identical. Real-pipeline smoke (`scratchpad/smoke-harness.ts`, drives the actual `slpToVideo` with 2 clips / 2 workers) → valid per-clip mp4s + final concat, no temp profiles leaked, heal is idempotent (1st run heals a poisoned profile, 2nd run leaves it byte-identical). Playback spike (`scratchpad/play-spike.ts`, real `buildPlaybackProfile`) → boots + plays from the isolated profile, no framedump, real profile byte-identical.

Permanent jest coverage now exists: `src/__tests__/dolphinProfile.test.ts` (Linux layout: dump flags, aspect/res/bitrate, UseFFV1 preserved, dumps-off for playback, real profile never mutated) and `dolphinProfile.windows.test.ts` (forces `os.type()` Windows + a portable `User/Config` fixture to prove the Windows SOURCE-path resolution + build logic are correct off-Windows). Suite: 200 tests.

**STILL TODO:**
- **Verify `--user` on Windows at RUNTIME** (recording AND playback). The path-resolution/build half is now unit-tested; what remains is confirming Windows Dolphin itself honours `--user` and finds `Sys/` relative to its binary (spikes were Linux-only). Blocks shipping this in a Windows release. **Kit ready:** run `node scripts\windows\verify-dolphin-user.js` on a Windows box (zero-dep, mirrors buildWorkerProfile, records `assets\test.slp` via `--user` and checks the real profile is untouched) — steps + FAIL triage in `scripts/windows/VERIFY-DOLPHIN-USER.md`. Still also want the manual UI pass (record a batch + preview a clip).
- **Human smoke test through the real app UI** — record a small batch + preview a clip, confirm output + play window look right (spikes proved the plumbing, not the interactive UX / overlay compositing end to end).
- **Minor consistency:** the "Launch Dolphin test" setup diagnostic (`VideoManager` ~`:1263`) still spawns against the real profile with a now-unnecessary dtkdump cleanup (harmless — flags are healed). Left as-is deliberately (it's meant to test the user's real setup); could get its own `--user` profile for consistency, low priority.

<details><summary>Original proposal (kept for context)</summary>

**Problem:** recording mutates the USER'S REAL Slippi Dolphin profile and runs N workers against it. `configureDolphin()` (`slpToVideo.ts:1346`) writes `GALE01.ini`/`GFX.ini`/`Dolphin.ini` in the real install (paths from `resolveDolphinIniPaths()` ~`:949`), called once at ~`:1522` before `processReplays()` spawns `numProcesses` workers (~`:827`). Consequences, worst-first:
1. **User's Dolphin left broken.** `DumpFrames`/`DumpAudio` set True + fullscreen, never restored (verified: no `DumpFrames = False` anywhere in the repo). Open Dolphin to watch replays after a render → gets our recording rig. **The real user-facing bug.**
2. **N concurrent Dolphins share one mutable profile** Dolphin writes back on exit → races; two jobs can't run different settings.
3. **Forces defensive code that only exists because the profile is shared** — the `dtkdump.wav`/`dspdump.wav` cleanup (`slpToVideo.ts:384-395`) AND the beta.9 `setDolphinDumping(config,false)` playback fix. Both become dead code under isolation.

**Fix:** give each worker a throwaway `--user <tempdir>` profile, delete on job end. Nothing global mutated, no collisions, per-job settings possible, defensive code deleted. Reference impl that already does this: `~/Projects/sandbox/slp2mp4` (Python) — `dolphin/runner.py` (TemporaryDirectory), `dolphin/ini.py` (context-manager ini generators), `dolphin/comm.py`.

**STEP 0 — SPIKE FIRST (gates everything). ✅ PASSED 2026-09-07.** Proved Slippi *playback* Dolphin boots + framedumps from a **minimal generated** profile with **our short-form flags** (`-i -o --output-directory= -b -e --cout`, NOT slp2mp4's long-form) + `--user`, on Linux, one clip end-to-end. Spike script: `scratchpad/dolphin-user-spike.js` (dependency-free Node; re-runnable). Findings:
- **Boots + framedumps cleanly** from a temp `--user` dir containing ONLY `Config/Dolphin.ini` + `Config/GFX.ini` + `Config/Hotkeys.ini` + `GameSettings/GALE01.ini`. Output = valid 4K mpeg4 `.avi` (3755×2112, 600 frames / 10s at target bitrate) + `.wav`, verified real gameplay (not black; YAVG mean-luma ~30, min0/max255).
- **`Sys/` is NOT needed in the profile.** On this install Sys lives next to the AppImage (`…/playback/Sys`) and Dolphin finds it relative to its own binary — so the copy-real-profile fallback is NOT required on Linux. (Windows still to be verified separately.)
- **Real `~/.config/SlippiPlayback` byte-identical before/after** (sha256 of Dolphin.ini/GFX.ini/GALE01.ini unchanged) — full isolation confirmed.
- Dump flags belong in `[Movie]` (DumpFrames/DumpFramesSilent/DumpAudio/DumpAudioSilent) and `[DSP]` (DumpAudio/DumpAudioSilent/Backend=ALSA); GFX dump keys (`InternalResolutionFrameDumps`, `BitrateKbps`, `EFBScale`, `AspectRatio`) in `[Settings]`. `Hotkeys1.Device=/0/` avoids grabbing real input devices.
- NOTE: recording currently leaves the real profile with `DumpFrames = True` still set in [Movie]/[DSP] (observed live) — bug #1 confirmed present, not hypothetical.

**If spike passes:** (1) profile builder → temp user dir with Dolphin/GFX/GALE01(gecko)/Hotkeys ini, reuse `buildGeckoSettings()`; (2) move profile creation once-per-run → once-per-WORKER in `processReplays`, pass `--user`; (3) delete the dump-cleanup + `setDolphinDumping` defensive code; (4) DECIDE deliberately whether the playback/"play this clip" path (`playClipAsync`, also mutates the real profile) moves to its own `--user` profile too (probably yes → fully isolates + deletes my beta.9 fix).

**DO NOT BREAK:** overlay compositing, libx264 re-encode, concat, output naming; the hardening (`DOLPHIN_BOOT_STALE_MS`, stall detection, length-scaled ffmpeg timeouts, `taskkill /T /F`, ENOENT/EAGAIN/EMFILE/ENOMEM handling — real scar tissue); Windows path handling (builder must work on both; spike Linux-only; verify `--user` on Windows separately).

**VERIFY:** one-clip + multi-clip concat byte-comparable before/after; confirm real `~/.config/SlippiPlayback` UNCHANGED after a render.

_Note: this is the most battle-hardened code in the app and it currently works — worth the risk ONLY because #1 is a real bug and the fix is architecturally correct. Its own focused effort; do NOT bundle with other work._

</details>

### ~~Split controller.ts~~ DONE — extracted ConsoleManager, ImportManager, FilterExecutor, VideoManager into `src/main/managers/`

### ~~Split Filters.tsx~~ DONE — extracted FilterCard, FilterControls, FilterModals

### ~~Split Top.tsx~~ DONE — extracted SettingsModal.tsx + GeckoModal.tsx

### ~~Selection state lives in Main but only Tray uses it~~ FIXED — extracted to `useSelection` hook in `src/renderer/hooks/`

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

## Dependencies

### Upgrade @slippi/slippi-js (6.7.0 → 9.x)
Currently pinned to `^6.6.1` (installed 6.7.0); latest is 9.1.2 — **three major versions behind** (7.x, 8.x, 9.x). Not urgent: all fields the parsers use (`hitlagRemaining`, `selfInducedSpeeds`, `lastHitBy`, `percent`, `actionStateId`, `getFrames`/`getStats`/`computeStocks`) work on 6.7.0 and parse current (2026) replays fine. Risk of staying: missing bug fixes + eventually newer Slippi replay-format versions may not fully parse. Risk of upgrading: 6→9 = breaking API changes that could break every `.slp`-parsing filter (slpParser, edgeguard, phantom, koDirection, stageCenter, afkDetection, reverse, removeStarKOFrames, earlyQuitOut).

**Do it as a deliberate task:** read the 7.0/8.0/9.0 changelogs for breaking changes, bump, then regression-test each parser against `test_replays/`. slippi-js is pure JS (bundled via webpack, not in `release/app/node_modules`), so it's an `npm`/webpack change, no native rebuild.

---

## Nice-to-Have

### "Find Slippi Playback" tutorial
A proper guided walkthrough for locating the **Playback build** of Slippi Dolphin — the #1 new-user stumbling block (it's a separate download from the online-play Dolphin, must be fetched via the Slippi Launcher first, and its path differs per OS). Today there's only a small collapsible "How to find the Playback build" in `SetupWizard.tsx` (~line 277) with per-OS default paths. Expand it into a step-by-step tutorial (Launcher → download Playback → where the folder lands per OS → point Lunar Clipper at the executable), ideally with screenshots. Tie into the welcome-screen / onboarding work. Preview it live via the dev screen switcher (`setup-play` / `setup-record`).

### ~~Auto-play video after recording~~ FIXED — recording completion modal with Play, Show Folder, and auto-open toggle

### Stage rectangles visualizer
`notes/stage-rectangles.html` — could be expanded for tuning edgeguard rectangle values.

### ~~Hardcoded magic numbers~~ FIXED — named constants with comments at top of Worker.ts

### ~~Accessibility~~ PARTIAL — removed file-level a11y disables from FilterCard, FilterModals, Filters, Top, GeckoModal. Added role/tabIndex/onKeyDown to interactive elements. Remaining: Tray, SettingsModal, TemplateCatalog, CodeEditorPage, SetupWizard.
