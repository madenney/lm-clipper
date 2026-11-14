# Packaging and installing Clipper

How the installers are built, which helper binaries they carry, and what
users on each OS may need to do. Releasing (tags, update channels, the draft
release) is in RELEASING.md; the owner's full release-day list is in the Lunar monorepo's
docs/clipper-release-runbook.md. Third-party licences and the ffmpeg source offer:
THIRD_PARTY_NOTICES.md. Asset sources: assets/PROVENANCE.md.

## Public and owner builds

**Every build is public unless `LUNAR_OWNER_BUILD=1` is set.** Production webpack
builds (`npm run build`, `npm run package`, CI's release workflow) compile the empty
stand-ins in `src/owner-off` in place of `src/owner`
(`.erb/configs/ownerTools.ts`, a `NormalModuleReplacementPlugin`), so the owner's
private tools are not in the bundle at all, not merely hidden. `npm run build` then
runs `npm run check:release` (`scripts/check-release-clean.js`), which fails the build
if any text listed in `src/owner/release-check.json` appears in `release/app/dist`.
Release source maps carry no source text (`nosources-source-map`).

| Build | Owner tools |
| --- | --- |
| `npm start` (development) | in |
| `npm run build` / `npm run package` | out (checked) |
| `LUNAR_OWNER_BUILD=1 npm run build` / `package` | in (check skipped); never publish it |

The published source (madenney/lm-clipper) has no private tools: the root
`npm run deploy -- clipper` publishes `src/owner-off` as `src/owner` and refuses a
tree that contains private text. In that tree there is no `src/owner-off`, nothing is
swapped and the check has nothing to look for, so CI builds are public by construction.

## Helper binaries

Clipper ships its own ffmpeg and slpz. electron-builder copies them from
`release/app/` into the app's `resources/` (package.json `build.<os>.extraResources`),
and `src/main/util.ts` (`bundledBinaryName`) finds them at run time:

| OS | ffmpeg | slpz | Where it comes from |
| --- | --- | --- | --- |
| Linux x64 | `release/app/ffmpeg/ffmpeg-linux-x64` | `release/app/slpz/slpz-linux-x64` | ffmpeg 7.0.2: johnvansickle.com static build, pinned |
| Windows x64 | `release/app/ffmpeg/ffmpeg-win32-x64.exe` | `release/app/slpz/slpz-win32-x64.exe` | ffmpeg 9.0.2: gyan.dev "essentials" build (the GitHub mirror of it), pinned |
| macOS arm64 / x64 (not built yet) | `release/app/ffmpeg/ffmpeg-darwin-<arch>` | `release/app/slpz/slpz-darwin-<arch>` | ffmpeg 8.0: osxexperts.net, pinned |

**None of these binaries is committed.** Each is produced the same way on every OS, in CI
and on a developer machine:

```sh
npm run fetch:ffmpeg -- <linux|win|mac> [arch]   # downloads the pinned file, checks its sha256, extracts ffmpeg
npm run build:slpz -- <linux|win|mac> [arch]     # cargo install slpz 1.3.0 --locked (needs Rust: https://rustup.rs)
```

`.erb/ffmpeg-pins.json` holds each ffmpeg's version, versioned URL and sha256: a download
that does not match stops the build, so what ships is always the file that was checked.
To change a pin: download the new file, compare it with the publisher's own checksum,
update the json and `THIRD_PARTY_NOTICES.md` (ffmpeg is GPL: the notices carry the source
offer), run the codec check below. `FFMPEG_MIRROR_BASE` (CI: the repository variable of that
name) names a URL prefix holding copies of the same files, tried first; the sha256 still
decides. slpz is built from crates.io with `--locked` at the version in
`.erb/scripts/build-slpz.js` (it matches the in-process port in `src/lib/slpz.ts`); Linux
builds run on Ubuntu 22.04 so the helpers need no newer glibc than 2.35, which CI checks.
The Windows `lunar-hidden-launcher.exe` comes from the runner package; its SHA256SUMS is
checked against the file by `check-bundled-binaries.js`.

`<arch>` is `arm64` or `x64` (Node's `process.arch`; the package.json entries
use electron-builder's `${arch}` macro, which gives the same names).

**Windows also ships `lunar-hidden-launcher.exe`** (slippi-dolphin-runner's,
from `node_modules/slippi-dolphin-runner/native/win/bin/`, so `npm ci` is all it
needs) as `resources/hidden-launcher/lunar-hidden-launcher.exe`. "Hide Recording
Windows" (on by default) runs each recording Dolphin on a never-shown desktop
through it. It must be a real file outside `app.asar` (Windows can't run an exe
from inside an archive), so it is an extraResources entry, and
`src/main/hideLauncher.ts` passes its path to `record()` (`hideLauncherPath`):
`resources/hidden-launcher/` when packaged, the runner's own copy in
`node_modules` in a dev run. Without it every recording would open visibly
(`hide-desktop-unavailable`), so the binary check below refuses a Windows build
whose extraResources leave it out. Webpack is told not to follow the runner's
own `new URL(..., import.meta.url)` lookup (`parser: { url: false }` in
`.erb/configs/webpack.config.base.ts`), which would otherwise copy the exe and
its SHA256SUMS into `dist/`, inside the asar.

**Packaging fails if one is missing.** electron-builder silently skips an
extraResources file that doesn't exist, which is how an installer could ship
without ffmpeg. `.erb/scripts/check-bundled-binaries.js` runs as the
`beforePack` hook for every platform/arch being packaged and stops the build if
a file is missing, empty, or built for the wrong OS/CPU (it reads the ELF / PE /
Mach-O header), or if a Windows build doesn't list the hidden launcher. Run it
by hand with:

```sh
node .erb/scripts/check-bundled-binaries.js linux        # or win, mac; arch defaults to this machine
node .erb/scripts/check-bundled-binaries.js mac arm64
```

CI runs the same check before building, then runs ffmpeg to make sure it
decodes what Dolphin dumps (UT Video, FFV1, MPEG-4) and encodes H.264/AAC,
round-trips `assets/test.slp` through slpz with the arguments the import uses
(`-d -q -o <out> <in>`), and on macOS checks that ffmpeg/slpz link no Homebrew
libraries.

The .slpz import itself (wizard choices replace / extract / skip, a ZIP of
.slpz files, re-imports, a folder holding both X.slp and X.slpz, a different
replay already named X.slp) runs end to end against this OS's bundled slpz in
`scripts/worker-check/slpzimport.js` (part of `scripts/worker-check/run.sh`).

**Local packaging note:** `release/app/ffmpeg` and `release/app/slpz` are ignored folders. If
yours is an old link into a legacy checkout, delete it and run the two commands above.
`release/app/package-lock.json` is committed: it pins the native modules (better-sqlite3,
@napi-rs/canvas) and the updater that actually ship. Change them only with
`cd release/app && npm install <pkg>@<version>` and the Windows rig run that RELEASING.md asks for.

## Installer size

Every installer carries `assets/` whole: about 300 MB of Melee HD textures (switched off by
default) and 88 MB of character animation packs, all already compressed, so the Windows
installer, AppImage and .deb are each several hundred MB and every update re-downloads
what changed in the blockmap. The HD pack's redistribution permission is not on record
(`assets/PROVENANCE.md`); moving it to an optional first-use download (`hdTexturesEnabled`
already gates it) removes about 300 MB. Measure the real size from a CI build and put it on
the Software page.

## Linux

Two installers: `Lunar-Clipper-<version>.deb` and `Lunar-Clipper-<version>.AppImage`.

**The .deb is the one to recommend on Ubuntu/Debian.** It installs to
`/opt/Lunar Clipper`, and its install script handles Electron's sandbox: on
Ubuntu 24.04+ it installs an AppArmor profile that allows the app to use
unprivileged user namespaces (on systems without them it makes `chrome-sandbox`
setuid instead). Install with:

```sh
sudo apt install ./Lunar-Clipper-<version>.deb
```

**The AppImage** runs anywhere but needs two things on newer distros:

1. **FUSE 2.** AppImages built by electron-builder 26 (the version here) use
   the classic AppImage runtime, which needs `libfuse.so.2`. Ubuntu 22.04+ only
   installs FUSE 3 by default. Error: `dlopen(): error loading libfuse.so.2`.
   - Ubuntu 22.04: `sudo apt install libfuse2`
   - Ubuntu 24.04+: `sudo apt install libfuse2t64`
   - Or run without FUSE: `./Lunar-Clipper-<version>.AppImage --appimage-extract-and-run`

   electron-builder 26.7 has no option for the newer static runtime that
   doesn't need FUSE 2, so this can't be fixed in the config.

2. **The sandbox (Ubuntu 23.10+ / 24.04+).** Ubuntu's AppArmor blocks
   unprivileged user namespaces for apps without a profile, and an AppImage
   can't carry the setuid `chrome-sandbox` fallback, so Electron exits with
   `The SUID sandbox helper binary was found, but is not configured correctly`
   (or `FATAL:setuid_sandbox_host.cc`). Either:
   - run it with `--no-sandbox` (what the AppImage's own desktop entry already
     does): `./Lunar-Clipper-<version>.AppImage --no-sandbox`, or
   - allow user namespaces for everyone (system-wide, weakens the protection):
     `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`
     (add it to `/etc/sysctl.d/` to keep it after a reboot), or
   - use the .deb, which installs a proper AppArmor profile.

Auto-update: the AppImage updates itself. electron-updater 6 can also update a
.deb install (it installs the new .deb through `pkexec`), but that path has not
been tried with Clipper yet; until it is, .deb users may need to install new
versions by hand.

## macOS

**Not built yet: the release workflow's macOS legs are off** (no Apple Developer account, never run on the
runners). Everything below describes the setup that is in place for when they are switched on
(RELEASING.md says how). Two DMGs (plus zips for auto-update): `Lunar-Clipper-<version>-mac-arm64.dmg`
(Apple Silicon) and `Lunar-Clipper-<version>-mac-x64.dmg` (Intel). They are
separate builds, not one universal app, because the native modules
(better-sqlite3, @napi-rs/canvas) and the helper binaries are per CPU. CI
builds them on `macos-15` (arm64) and `macos-15-intel` (x64). Minimum macOS 12
(the arm64 ffmpeg needs it).

Each arch job writes its own `latest-mac.yml`; CI renames them to
`latest-mac-<arch>.yml` and the release job merges them into one
(`.erb/scripts/merge-mac-update-yml.js`), so electron-updater finds the arm64
zip on Apple Silicon and the x64 zip on Intel.

**Signing and notarization** are optional. The config has `hardenedRuntime`
and `assets/entitlements.mac.plist` (JIT, unsigned executable memory, disabled
library validation, which Electron and its native modules need). The
`afterSign` hook `.erb/scripts/notarize.js` notarizes with notarytool and staples
the ticket only when the app is signed with a Developer ID certificate and the
Apple credentials are set; otherwise it skips with a message. electron-builder's
built-in notarize step is off (`mac.notarize: false`) so it doesn't run twice.

CI secrets (all optional; without them the macOS build is unsigned):

| Secret | What |
| --- | --- |
| `MAC_CSC_LINK` | Developer ID Application certificate, .p12 as base64 (becomes `CSC_LINK`) |
| `MAC_CSC_KEY_PASSWORD` | Its password (becomes `CSC_KEY_PASSWORD`) |
| `APPLE_ID` | Apple ID email of the developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that Apple ID (appleid.apple.com) |
| `APPLE_TEAM_ID` | 10-character team id |

**Unsigned builds:** macOS says the app "is damaged and can't be opened" (Apple
Silicon) or "can't be opened because the developer cannot be verified" (Intel).
After dragging it to Applications, clear the quarantine flag once:

```sh
xattr -dr com.apple.quarantine "/Applications/Lunar Clipper.app"
```

Auto-update does not work for unsigned macOS apps (Squirrel.Mac requires a
signature); users download new DMGs by hand until the app is signed.

## Windows

`Lunar-Clipper-Setup-<version>.exe` (NSIS, x64, one-click, per user, installed under
`%LOCALAPPDATA%\Programs\lm-clipper`). The desktop shortcut is created on the first install only,
and uninstalling keeps the user's data: settings and logs in `%APPDATA%\lm-clipper`, the library
and projects in `Documents\Lunar Clipper`.

Unsigned: SmartScreen shows "unknown publisher"; **More info → Run anyway**. On Windows 11 with
Smart App Control on, an unsigned installer can be blocked with no "Run anyway": the README and
the release notes say so and publish SHA256SUMS.txt.

**Signing** is wired but needs a certificate. In the repository set the secrets `WIN_CSC_LINK`
(base64 .pfx) and `WIN_CSC_KEY_PASSWORD` and the variable `WIN_PUBLISHER_NAME` (the certificate's
subject name, exactly); the release workflow then signs the installer and the app exe and passes
`-c.win.signtoolOptions.publisherName`, which makes the updater verify the publisher of every
later update. Never set `publisherName` without signing: the updater would refuse every unsigned
update. Not signed by this: `ffmpeg-win32-x64.exe`, `slpz-win32-x64.exe` and
`lunar-hidden-launcher.exe` inside the installer; sign them with the same certificate in a step
before Package once it exists, and submit the launcher to Microsoft's false-positive portal. For
Azure Trusted Signing use `win.azureSignOptions` instead of the secrets (electron-builder docs).

## Changelog and "What's new"

Every release needs an entry in `src/constants/changelog.ts` (newest first; `version` must equal
`package.json`, a test fails otherwise). Write it for players: what they can do now, one plain
sentence each, no owner-only tools. After an update, Clipper opens a "What's new" window once with
everything since the version the user last saw (`lastSeenVersion` in the config; a fresh install
starts at its own version and sees nothing old). The full history is in Settings > About >
What's new and Help > What's New. A dev build whose version has no entry shows nothing.

## Testing an update without publishing

Updates come from the GitHub releases of `madenney/lm-clipper` (electron-updater; only packaged
builds check). To try a real update on a machine without releasing anything: build two installers
with `--publish never` (the old version, and a newer one with its own changelog entry), serve the
newer one's `latest.yml` + installer from any folder (`npx http-server` or `python3 -m http.server`),
install the old one, and start it with `LUNAR_UPDATE_FEED_URL=http://<this-computer>:<port>`
(accepted only for localhost and home-network addresses). The banner offers the update, Download
shows progress, Restart installs it, and the new version opens the "What's new" window. Check
`lm-clipper` logs for `updater-test-feed` to see the feed was used.

## What has only been checked locally

- Config schema (electron-builder's own validator), workflow YAML parsing, the binary check
  against the real Linux and Windows ffmpeg downloads (sha256 and ELF/PE headers, 2026-11-10)
  and the update-file merge on sample files (all now in `npm test`: releaseScripts.test.ts).
- Not yet run: the whole release workflow in a public repository (the scratch-repository
  rehearsal in the monorepo's docs/clipper-release-runbook.md is the first run), slpz built by
  `cargo install --locked` on the Windows and Linux runners, a real macOS build, the .deb build
  on CI, and a Windows package from CI.
