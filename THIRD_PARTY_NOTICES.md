# Third-party notices

Lunar Clipper is free software under the GNU General Public License, version 3 only
(`LICENSE`). It ships with, and is built from, the third-party software below. This file is
installed with the app (the `resources` folder) and kept in the source repository.

## ffmpeg (GPL, source offer)

Clipper bundles an unmodified, statically linked **ffmpeg** build to turn Dolphin's frame
dumps into video. These builds are licensed under the **GNU GPL version 3 or later**
(they include libx264). The exact build in each installer is pinned in
[`.erb/ffmpeg-pins.json`](.erb/ffmpeg-pins.json) (version, download URL and SHA-256):

| Installer | ffmpeg | Build | Corresponding source |
| --- | --- | --- | --- |
| Windows x64 | 9.0.2 | "essentials" build by Gyan Doshi, <https://www.gyan.dev/ffmpeg/builds/> | <https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz> |
| Linux x64 | 7.0.2 | static build by John Van Sickle, <https://johnvansickle.com/ffmpeg/> | <https://johnvansickle.com/ffmpeg/release-source/ffmpeg-7.0.2.tar.xz> |
| macOS (not released yet) | 8.0 | static build from <https://www.osxexperts.net/> | <https://ffmpeg.org/releases/ffmpeg-8.0.tar.xz> |

The binary's own `ffmpeg -version` output shows its full build configuration. The bundled
program is the upstream project's, not modified by Lunar. ffmpeg is a trademark of Fabrice
Bellard; see <https://ffmpeg.org/legal.html>.

**Written offer.** For at least three years from the date of a release, anyone who received a
Lunar Clipper installer may ask for the complete corresponding source code of the ffmpeg
build in it, on a physical medium or by download, for the cost of providing it, by writing to
the email address in [`SECURITY.md`](SECURITY.md) or by opening an
issue at <https://github.com/madenney/lm-clipper/issues>. The links above are the places the
source is published today.

## Components shipped in the installer

| Component | Version | Licence | Source |
| --- | --- | --- | --- |
| slpz (the `.slpz` replay format tool; the app reads `.slpz` in process and bundles the command-line tool for compressing) | 1.3.0, built from source in CI (`cargo install slpz --locked`) | MIT OR Apache-2.0 | <https://crates.io/crates/slpz> |
| slippi-dolphin-runner (starts Dolphin to play and record) | see `package.json` | MIT | <https://github.com/madenney/dolphin_runner> |
| lunar-hidden-launcher.exe (Windows: runs Dolphin on a hidden desktop; built from `hidden_launcher.c` in the runner repository) | with the runner | MIT | <https://github.com/madenney/dolphin_runner> |
| Electron (and Chromium, Node.js) | 35.x | MIT; Chromium and its dependencies under their own licences, listed in `LICENSES.chromium.html` and `LICENSE.electron.txt` inside the installed app | <https://www.electronjs.org/> |
| @slippi/slippi-js (replay parser, compiled into the app) | 6.x | LGPL-3.0-or-later | <https://github.com/project-slippi/slippi-js> |
| @gcpreston/slippi-viewer (the 2D replay viewer) | 0.1.16 | MIT | <https://github.com/gcpreston/slippi-viewer> |
| better-sqlite3 | locked in `release/app/package-lock.json` | MIT | <https://github.com/WiseLibs/better-sqlite3> |
| @napi-rs/canvas | locked in `release/app/package-lock.json` | MIT | <https://github.com/Brooooooklyn/canvas> |
| electron-updater | locked in `release/app/package-lock.json` | MIT | <https://github.com/electron-userland/electron-builder> |
| React, React DOM, lodash, yauzl, CodeMirror and the other npm libraries compiled into the app bundle | locked in `package-lock.json` | MIT, ISC, BSD or Apache-2.0 each (every package's licence is in its own `package.json` / `LICENSE`) | <https://www.npmjs.com/> |

The LGPL component (slippi-js) is linked into the app bundle, and the complete source of
Lunar Clipper is public under the GPL, so anyone can rebuild the app with another version of
it.

## Assets

Clipper also ships images, fonts and game-art packs. Where each one comes from, and under
what terms, is recorded in [`assets/PROVENANCE.md`](assets/PROVENANCE.md). In short:

- **Liberation Mono Bold** (overlay text): SIL Open Font License 1.1, copyright the Liberation
  Fonts authors (Google Corporation / Red Hat); the licence text is `assets/fonts/LiberationMono-LICENSE.txt`.
- **Character animation packs** (`assets/zips`): the data the Slippi replay viewer draws
  characters from.
- **Definitive Melee HD texture pack** (`assets/Melee_HD_Textures`): a community texture pack
  made by the Melee HD team (credits in `assets/Melee_HD_Textures/GALE01/credits.txt`).
  Switched off by default. See the provenance file for the terms and what is still to be
  confirmed.

Super Smash Bros. Melee and its characters and stages belong to Nintendo; Lunar is an
unofficial fan project and is not affiliated with or endorsed by Nintendo, HAL Laboratory,
Creatures, Game Freak, or the Slippi project.
