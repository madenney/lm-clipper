# Where the bundled assets come from

Every file in `assets/` goes into the installer (see `build.extraResources` in
`package.json`) and into the public repository. This is the record of where each one comes
from and the terms it is used under. **"To confirm"** marks what is not documented yet and
needs the project owner to supply the source or the permission; nothing here is guessed.

| Path | What | Source and terms |
| --- | --- | --- |
| `fonts/LiberationMono-Bold.ttf` | Overlay text font | Liberation Mono Bold 2.1.5, <https://github.com/liberationfonts/liberation-fonts>. SIL Open Font License 1.1 (text in `fonts/LiberationMono-LICENSE.txt`); may be bundled and redistributed with the app. Replaced a Courier Bold font (Digital Typeface Corp, commercial) in November 2026. |
| `icon.png`, `icon.ico`, `icon.icns`, `icons/*` | App icon | Lunar's own logo. To confirm: the owner made or owns it. |
| `zips/*.zip` (about 88 MB, 26 files) | Character animation data the replay viewer (`@gcpreston/slippi-viewer`, MIT) draws characters from | Same files the website serves from `public/zips`. To confirm: the exact upstream (Slippi Lab / slippi-viewer project) and its licence for these data files. |
| `Melee_HD_Textures/` (about 300 MB) | The "Definitive Melee HD" Dolphin texture pack (Melee HD team; credits in `Melee_HD_Textures/GALE01/credits.txt`), used only when "HD textures" is switched on in Settings | Community re-skin of Nintendo art, distributed through the Melee HD community (<https://www.reddit.com/r/SSBM/comments/niqgf9/definitive_melee_hd_dolphin_and_slippi_texture/>). **To confirm: the team's permission to redistribute it inside an installer.** Until then the pack is the first thing to take out of the installer and offer as a separate download (docs/packaging.md, "Installer size"). |
| `test.slp` | A short replay used by the tests and the release checks | Recorded by the project; both players are the anonymous default "Diamond Player". |
| `entitlements.mac.plist`, `assets.d.ts` | Build configuration | Original. |

Removed in November 2026: `fd_static_background/GrNLa_static.dat` (an extracted Melee stage
file nothing used), `fonts/cour_bold.ttf` (commercial font).

Super Smash Bros. Melee characters, stages and textures are Nintendo's. Lunar is an
unofficial fan project; see `../THIRD_PARTY_NOTICES.md`.

## When you add or change an asset

Add a row here in the same commit: where it came from, the licence or permission, and who
confirmed it. An asset without a row does not go into a release.
