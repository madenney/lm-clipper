<!--
Release notes template. Copy to docs/release-notes/v<version>.md before tagging: the release
job uses that file as the body of the draft release. Delete this comment and every line that
does not apply. Write for players. No owner-only tools, no internal infrastructure.
-->

## Lunar Clipper <version>

<One or two sentences: what this release is about.>

### What's new

- <What a player can do now, one plain sentence each. Same wording as src/constants/changelog.ts.>
- <...>

### Fixed

- <...>

### Install

| System | File |
| --- | --- |
| Windows 10 / 11 (64-bit) | `Lunar-Clipper-Setup-<version>.exe` |
| Ubuntu / Debian | `Lunar-Clipper-<version>.deb` (recommended) |
| Other Linux | `Lunar-Clipper-<version>.AppImage` (needs `libfuse2`; see the README) |

Compare a download with `SHA256SUMS.txt` (`sha256sum` on Linux, `Get-FileHash` in Windows PowerShell).

**Windows will warn you the first time.** This installer is not code-signed yet. SmartScreen
shows "Windows protected your PC": click **More info, then Run anyway**. On Windows 11 with
**Smart App Control** on, Windows may block it with no "Run anyway": check the SHA-256, then
either turn Smart App Control off for the install or wait for the signed build.

**Requirements:** Windows 10 or 11 (64-bit; only Windows 11 with an NVIDIA GPU has been tested),
a Slippi Dolphin install and a Melee NTSC 1.02 ISO. Linux is experimental.

### Updating from 2.0.0-beta.9 (or any 2.x beta)

Your projects and settings are kept. Run the new installer over the old one, or use
**Help > Check for Updates** in the app. If the update banner does not appear on its own
(older betas could miss it), download the installer above and run it: it installs over the old
version. Projects made by a 2.x beta open in 3.x. Keep a copy of projects you care about
before updating, in case you want to go back to the beta.

### Known issues

- <Anything a player is likely to hit and what to do about it.>

---

Full list of changes since the previous release: <link to the compare view>.
Third-party licences and the ffmpeg source offer: `THIRD_PARTY_NOTICES.md`.
