# Windows `--user` verification — checklist

The Dolphin `--user` profile isolation (recording + playback) is verified on
Linux and its Windows path logic is unit-tested, but **no one has confirmed a
real Windows Slippi Playback Dolphin honors `--user` at runtime**. This is the
one thing blocking the isolation from shipping in a Windows build.

`verify-dolphin-user.js` confirms it end-to-end in ~30 seconds, without touching
the app or your real profile.

## Prereqs (on the Windows machine)
- **Node.js** installed (`node --version`).
- **lm-clipper configured at least once** — its Dolphin path + Melee ISO must be
  set, so `%APPDATA%\lm-clipper\lm-clipper.json` exists.
- **Open Slippi Playback Dolphin once and close it**, so it has written its
  profile under `<dolphinDir>\User\Config` (the script reads GFX.ini/Dolphin.ini
  from there). If that folder is empty the script tells you.
- A copy of this repo (or at minimum this script + `assets\test.slp`).

## Run it
```bat
node scripts\windows\verify-dolphin-user.js
```
Optional — use your own replay instead of the bundled `assets\test.slp`:
```bat
node scripts\windows\verify-dolphin-user.js "C:\Users\you\Documents\Slippi\Game_xxxx.slp"
```
It records ~8 seconds headless, so a Dolphin window may flash briefly.

## Read the verdict
The script prints:
```
=============== WINDOWS --user VERDICT ===============
  booted from temp --user profile : YES
  valid video dumped              : YES (+wav)
  real profile untouched          : YES
  RESULT: PASS — Windows --user is safe to ship
=====================================================
```
- **PASS** → Windows Dolphin honors `--user` + finds `Sys/` next to its binary.
  The isolation is cleared for a Windows release. Tell Claude "Windows verify
  passed" and we mark the TODO done.
- **FAIL** → copy the whole output (it prints the last stderr + the temp profile
  path) and send it back. The likely culprits, in order:
  1. **No video dumped** → Windows Dolphin may need `Sys/` seeded into the
     `--user` dir, or a different flag. (The Linux fallback is "copy the real
     profile once"; we'd decide then.)
  2. **Real profile changed** → the builder resolved the wrong source path on
     Windows; send the two `sha` lines.

## What this does NOT cover (the other open TODO item)
This proves the *plumbing*. It does **not** exercise the app's UI, overlay
compositing, or the interactive **play** window. For that, do the 2-minute
manual pass:
1. In lm-clipper, record a small batch (2–3 clips) and preview one.
2. Confirm the clips look right and the play window opens normally.
3. Confirm `<dolphinDir>\User\Config\Dolphin.ini` still has
   `DumpFrames = False` afterward (open Dolphin directly to watch a replay — it
   should NOT framedump). `restore-settings.bat` / `clear-settings.bat` in this
   folder are the old manual reset helpers if you need them.
