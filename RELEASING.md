# Releasing Lunar Clipper

Releases and auto-updates are driven by **git tags**. Pushing a tag that matches `v*` runs
`.github/workflows/release.yml`, which checks the numbers, runs the tests, builds the Windows
and Linux installers and creates a **draft** GitHub release with the installers, the
auto-update manifests and `SHA256SUMS.txt`. Installed apps and the website's download link
read published releases only, so nothing reaches anyone until a person tries the installers
and clicks **Publish**.

> macOS is not built right now (no Apple Developer account). To bring it back, add the two
> `mac` legs to the workflow matrix (the comment in `release.yml` shows them); the `mac`/`dmg`
> config in `package.json` and the `afterSign` notarize hook are still in place.

The owner's complete release-day list (publishing the source tree, the rehearsal, the order
with the website) is the Lunar monorepo's `docs/clipper-release-runbook.md`. This file is
the part that belongs to this repository.

## Channels

The channel is derived from the tag name:

| Tag | Channel | GitHub release | Who updates |
| --- | --- | --- | --- |
| `v2.0.0-beta.3` | `beta` | prerelease | users running a `-beta` build |
| `v3.0.0` | `latest` | normal release | everyone (beta users move forward to it) |
| `v3.1.0-rc.1` | `rc` | prerelease | nobody: the app reads only `beta` and `latest`; use it to try a build |

- Any `-` in the tag makes it a prerelease and the part after it (up to the first dot) its
  channel. The website's download link should follow the newest non-prerelease; check that
  it does before tagging anything with a `-` after v3.0.0 is out (the runbook lists it).
- A **beta** build reads `beta.yml`, a **stable** build reads `latest.yml`
  (`autoUpdater.allowPrerelease` in `src/main/main.ts` follows the running version, so stable
  users are never offered a beta). electron-builder writes only the file of the channel it
  built, so the release job copies a stable release's `latest*.yml` to `beta*.yml` as well;
  without it beta users would rely on electron-updater's fallback from `beta.yml` to `latest.yml`.

## Cutting a release

1. **Version.** `scripts/bump-version.sh 3.0.1` sets `version` in `package.json` and
   `release/app/package.json` and in both lockfiles. Add the matching entry (newest first, today's
   date, written for players) to `src/constants/changelog.ts`.
2. **Check.** `npm run check:metadata` (version, lockfiles, changelog agree),
   `npm run lint`, `npm test`, `npm run typecheck:ratchet`, `npm run build`.
3. **Release notes.** Copy `docs/release-notes/TEMPLATE.md` to
   `docs/release-notes/v3.0.1.md` and fill it in. The release job uses it as the body.
4. **Commit and tag.** The commit that reaches this repository is the public tree made by the
   Lunar monorepo's `npm run deploy -- clipper` (owner tools left out, see docs/packaging.md);
   tag that commit, never a monorepo commit or a subtree split of it. Push the branch first
   and wait for CI to go green, then push **only** the tag (never `git push --tags`, which sends
   every local tag):
   ```bash
   git push <remote> deploy/clipper:master
   git tag v3.0.1 deploy/clipper
   git push <remote> refs/tags/v3.0.1
   ```
5. **Watch the build:** `gh run watch` (or `gh run list --workflow=release.yml`). The workflow
   fails early, before building anything, when the tag, the two `package.json` versions, the
   lockfiles and the newest changelog entry disagree or the tests are red.
6. **Try the draft.** Download the installers from the draft release, check them against
   `SHA256SUMS.txt`, install on a clean machine and run the checklist in the monorepo's
   `docs/release-test-plan.md`. A draft is invisible to the updater and the website.
7. **Publish** the draft (edit the notes first). Then check that the website's
   `/api/app-download` resolves to it and that an older install is offered the update.

If the build is wrong after publishing, mark the release a draft again or delete it (nobody
who has not updated yet is affected) and ship the next patch version; never replace the
files of a published version, because `latest.yml` carries their hashes.

Dependabot opens its pull requests in this repository. They do not change what is released
(releases are built from the tagged tree), but a merged one makes the repository's master
differ from the monorepo's `deploy/clipper`: the next `npm run deploy -- clipper` then needs
`--deployed <the commit master is at>`. Prefer closing those pull requests and making the
same bump in the monorepo.

## Helper binaries and locked dependencies

The installer's helper programs are never committed. CI fetches the pinned ffmpeg
(`.erb/ffmpeg-pins.json`, sha256-checked) and builds slpz from crates.io with `--locked`;
`release/app/package-lock.json` pins the native modules and the updater that ship. See
docs/packaging.md. Third-party licences and the ffmpeg source offer are in
`THIRD_PARTY_NOTICES.md`, which is installed with the app.

## Verifying auto-update locally (no publish)

```bash
npm run fetch:ffmpeg -- linux && npm run build:slpz -- linux    # once
npm run build
npx electron-builder --linux --publish never -c.publish.channel=beta
ls release/build      # expect: *.AppImage, beta-linux.yml, *.blockmap
```

The presence of the `*.yml` manifest + `*.blockmap` next to the installer is what makes
auto-update work; the workflow uploads both to the release. docs/packaging.md ("Testing an
update without publishing") describes serving a feed from a local folder.

## Code signing

**Not set up yet: releases are unsigned.** Windows builds are **unsigned** today. Auto-update still works (the updater checks the
sha512 in `latest.yml`, which comes from the same release as the installer), but users see a
SmartScreen "unknown publisher" warning on first install, and Windows 11 with Smart App
Control can block the installer outright. Until a certificate exists: say so in the release
notes and the README, publish `SHA256SUMS.txt` (the release job does), and keep two-factor
authentication and tag protection on this repository's account, because a published release
is what every installed copy downloads.

When a certificate exists (an Authenticode/EV certificate, Azure Trusted Signing, or
[SignPath Foundation](https://signpath.org/) for open source):

1. Add the repository secrets `WIN_CSC_LINK` (base64 `.pfx`) and `WIN_CSC_KEY_PASSWORD`, and the
   repository variable `WIN_PUBLISHER_NAME` (the certificate's subject name, exactly). The release
   workflow then signs the installer and app exe and passes
   `-c.win.signtoolOptions.publisherName`, which makes `electron-updater` verify the publisher
   of every later update (`verifyUpdateCodeSignature`). Never set the publisher name without
   signing: the updater would refuse every unsigned update.
2. Sign `ffmpeg-win32-x64.exe`, `slpz-win32-x64.exe` and `lunar-hidden-launcher.exe` in a step
   before **Package**, and submit the launcher to Microsoft's false-positive portal.
3. Install the first signed build over an unsigned one on a test machine and confirm
   `resources/app-update.yml` contains the publisher name and the update still arrives.
