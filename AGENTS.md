# Clipper guidance

Read the root AGENTS.md and docs/architecture.md. Existing detailed guidance is
in docs/application-guide.md (its relative paths refer to this app directory).

Electron/React 18/TypeScript, local SQLite projects, worker threads, Dolphin and
ffmpeg. Managers in src/main/managers own operations; controller registers IPC.
New renderer IPC channels must be in preload's allowlist and have replies/error paths.
Run npm run typecheck; test with npm test. Jest can't load better-sqlite3 (Electron ABI);
`scripts/worker-check/run.sh` runs the real filter worker on real SQLite under Electron. src/vendor/ is a generated copy of
packages/ (combo/edgeguard/phantom detectors, stage geometry): edit the package. Keep native dependencies in release/app
and use the existing rebuild scripts for Electron ABI compatibility.

The main process must never run SQLite itself (better-sqlite3 blocks its thread;
a locked or busy project froze the app as "not responding"). Main-process code
uses src/main/dbAsync.ts, which runs everything in DbWorker in order; to add a
query, add the function to db.ts `WORKER_SYNC_FNS` or a DbWorker method. The tray's
window reads are the exception: they run on a read-only connection in DbReadWorker
(readLane.ts, rowSeek.ts), which dbAsync closes before DbWorker's connection. Avoid
other synchronous work in IPC handlers too. Hangs are logged to main.log by
src/main/hangWatchdog.ts (main-slow-handler, main-blocked, window-unresponsive,
renderer-longtask): check it first when someone reports a freeze.

Every Dolphin launch (recording in src/main/slpToVideo.ts, clip preview and Test
Dolphin in VideoManager.ts) goes through slippi-dolphin-runner (madenney/dolphin_runner,
pinned tag in package.json): buildProfile + record()/play(). Never vendor or patch a
copy, and don't reintroduce a stall timer, end-frame string match, ini rewriter or
process-tree kill here; a missing option goes upstream, then bump the tag. ESM-only:
webpack aliases it (.erb/configs/webpack.config.base.ts), Jest maps it (package.json),
types come through src/slippi-dolphin-runner.d.ts. The dump codec is chosen in
diskSpace.ts dumpPlanFor (Recording Format): above native UT Video on Linux/macOS (only where the
dump width is even: dumpWidthFor has the measured widths; an odd one records nothing in UT Video, so it gets MPEG-4 at 150 Mb/s as Windows does),
MPEG-4 at 150 Mb/s on Windows (its Dolphin has only FFV1 and MPEG-4); FFV1 at native
and for Lossless; Fast draft is MPEG-4. Never dumpCodec h264. "Hide Recording Windows"
(config hideRecordingWindows, default on) passes the runner's `hide` to buildProfile
and record() on Windows/Linux (not macOS: unverified there); Windows needs the
unpacked lunar-hidden-launcher.exe (src/main/hideLauncher.ts, docs/packaging.md).

Video Tools (the film button in the top bar, always shown) combines recorded clips into one video
and compresses videos, on the files already in the output folder. What it lists, what it accepts
from the window, where a result goes and the ffmpeg arguments are in src/main/videoTools.ts (no
Electron, tested); the run is slpToVideo.concatClips; the window is VideoToolsModal.tsx with its
logic in src/renderer/lib/videoTools.ts. A result is written as `<name>.partial<ext>` and renamed
when whole, never overwrites, and a cancelled or failed job leaves nothing; only video files inside
the output root are accepted. The button's name and the window's words say "combine", not "stitch".

The video overlay (Settings > Overlay) can use a font the user imported: Clipper copies the file
into `<userData>/overlay-fonts` after checking the canvas library loads it (src/main/overlayFonts.ts),
the list is what is in that folder, and the config stores only the file name (`overlayFont`, '' =
the bundled Liberation Mono Bold). Resolve it with overlayFontPath, which never leaves that folder;
a missing or broken font falls back to the bundled one, so it can never stop a recording. The
Settings preview is drawn by the recording's own renderer (overlayRenderer.renderOverlayPreview).
The text size is `overlayFontSize`, pixels on a 1080p video (src/lib/overlayStyle.ts, 10 to 120, 24
by default): another size is the same label zoomed about its corner, and text too wide for the
video is drawn smaller until it fits. Layout rules (the owner's, 2026-11-15; overlayLayout.test.ts
checks them on pixels): the capitals are centred in the box (as much room above them as below),
measured from the font and never from the words, so the box is the same height for every clip; and
the box touches the video's edges on the sides it is anchored to (it runs past them: no gap).

Replays can be .slpz (the library keeps downloads compressed by default, config
keepDownloadsCompressed; imports keep .slpz as they are, slpzMode 'keep'). Read
replays only through src/lib/slippiGame.ts (SlippiGame that opens .slpz too;
openReplayHeader for settings/metadata) and src/lib/slpz.ts (readReplayBytes, the
in-process codec on Node's zstd): never `new SlippiGame` from '@slippi/slippi-js'
on a path, never `.slp$`-only checks. Anything that hands a file to Dolphin (or
another program) goes through src/main/slpCache.ts playableSlp(), a decoded copy in
Clipper's own temp cache. Never compress or replace a user's .slp in place.

Renderer dialogs use one frame, `src/renderer/components/Modal.tsx` (role, focus trap, Esc for the
top one, focus back; `hooks/useModal.ts`): never write a bare overlay div. Window-wide key handlers
must call `lib/keyboardScope.ts` `shortcutsBlocked`. A failed open/import reply goes through
`lib/openNotice.ts` into `showNotice`, never a silent return. Dev-only tools (the screen switcher,
the reset helpers) show only when `process.env.NODE_ENV === 'development'`.
APP_FLOW.md is the canonical onboarding lifecycle. If that flow changes, update
it and DevScreenSwitcher in the same change. Preserve playback/recording isolation
and real user Dolphin settings. Don't record, reset settings, or delete replay data
as routine verification.

The Lunar Database panel, Find clips, transfers and replay library are on main
since 2026-10-03 (docs/database-integration-handoff.md, root docs/clip-search.md,
docs/library-workspaces.md). Not released as a Clipper build yet.

Owner-only tools live in src/owner (private: never publish it, never name what's in it
outside that folder). The rest of Clipper reaches them only through
src/owner/{channels,main,renderer}; src/owner-off has the same exports, empty. Release
builds compile owner-off instead (.erb/configs/ownerTools.ts) and `npm run build` fails
if private names reach release/app/dist (scripts/check-release-clean.js). Keep both
folders' exports in step (src/owner/__tests__/ownerOff.test.tsx). Publishing source:
only through the root `npm run deploy -- clipper`, which leaves src/owner out, publishes
owner-off as src/owner and refuses a tree with private text (src/owner/README.md);
never push main or a subtree of this app.

Downloads: docs/database-integration.md has a "Current behaviour" table (limits,
folders, retries, history file); keep it in step with the code. File work that
Windows antivirus/OneDrive can interrupt goes through src/main/fsRetry.ts
(retryFs, describeFileSystemError), never a bare rename/write. Default data folders
and the cloud/network folder warnings are src/main/dataLocations.ts. Custom Code and
AI Filter code only runs when its SHA-256 is approved (src/main/customCodeApproval.ts,
enforced in FilterExecutor and the Code Editor's Test run). Settings > Reset App
changes the config only; wiping data is dev/testMode only.
