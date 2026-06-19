# Releasing Lunar Clipper

Releases and auto-updates are driven entirely by **git tags**. Pushing a tag
that matches `v*` triggers `.github/workflows/release.yml`, which builds
Windows + Linux installers, generates the auto-update manifests, and publishes a
GitHub Release that installed apps update from.

> macOS is not built right now (no Apple Developer account). Re-enable by adding
> the `mac` leg back to the workflow matrix and the mac steps; the
> `mac`/`dmg` config in `package.json` and the `afterSign` notarize hook are
> still in place.

## Channels

The channel is derived from the tag name:

| Tag             | Channel  | GitHub release | Who updates                          |
| --------------- | -------- | -------------- | ------------------------------------ |
| `v2.0.0-beta.3` | `beta`   | prerelease     | users running a `-beta` build        |
| `v2.0.0`        | `latest` | normal release | everyone (incl. beta users → stable) |

- A **beta** build (version contains `-`) reads `beta.yml`; a **stable** build
  reads `latest.yml`. `autoUpdater.allowPrerelease` in `src/main/main.ts` is set
  from the running version, so stable users are never offered a beta.
- `generateUpdatesFilesForAllChannels: true` (in `package.json` → `build`) makes
  a **stable** release also emit `beta.yml`, so beta testers roll _forward_ onto
  the next stable instead of getting stuck on beta.

## Cutting a release

1. **Bump the version in BOTH files** and keep them identical:
   - `package.json` → `version`
   - `release/app/package.json` → `version`
2. **Resync the lockfile** (required, or `npm ci` in CI fails):
   ```bash
   npm install --package-lock-only --ignore-scripts
   ```
3. Commit everything.
4. Tag and push:
   ```bash
   git tag v2.0.0-beta.3
   git push origin master --tags
   ```
5. Watch the build: `gh run watch` (or `gh run list --workflow=release.yml`).
6. When green, the GitHub Release is published automatically (prerelease for
   `-beta` tags). Installed apps detect it on next launch via the in-app
   `UpdateBanner`.

> Tag = the moment of release. There is no draft step anymore — the updater
> cannot read draft releases, so publishing is automatic. Push the tag only when
> you mean it.

## Verifying auto-update locally (no publish)

```bash
npm run build
npx electron-builder --linux --publish never -c.publish.channel=beta
ls release/build      # expect: *.AppImage, beta-linux.yml, *.blockmap
```

The presence of the `*.yml` manifest + `*.blockmap` next to the installer is what
makes auto-update work; both are uploaded to the release by the workflow.

## Code signing (TODO — currently unsigned)

Windows builds are **unsigned** today. Auto-update still works, but users see a
SmartScreen "unknown publisher" warning on first install. To fix this for free:

- **SignPath Foundation** (<https://signpath.org/>) grants free code-signing
  certificates to qualifying open-source projects — Lunar Clipper is public, so
  it should qualify. After approval:
  1. Add a signing step in `release.yml` between **Package** and the checksum
     step (submit the `.exe` to SignPath, download the signed artifact).
  2. Set `win.publisherName` in `package.json` so electron-updater can verify
     the publisher on update.
  3. No client changes needed — `verifyUpdateCodeSignature` is on by default and
     simply starts passing once builds are signed.

Until then, unsigned beta distribution is fine; add signing before a stable GA.
