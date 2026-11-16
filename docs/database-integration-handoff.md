# Lunar Database integration — ACTIVE (resumed 2026-09-29)

> Names: the panel's tabs are **Download games**, **Pre-parsed moments** and **Downloads**; this
> file's older "Find replays" / "Find clips" / "Transfers" are the same things (APP_FLOW.md, Names).

Paused 2026-09-23, resumed at the user's request on 2026-09-29. Implementation is
merged into main on 2026-10-03 at the user's request (it was on branch `wip/clipper-database`). The website side
(`/api/clipper`) is live; the Clipper side was released in 3.0.0 on 2026-11-13 (the sections below are the build history, written before that).

## Direct snapshot downloads — 2026-10-17 (written before the release; all of it is live and in Clipper 3.0.0)

Find replays above 24 games, and lists of more than 200 games (ticked games, clips'
games, "Download again"), no longer wait for a server bundle: `src/main/directDownload.ts`
reads the games that are in the full-DB zip (or a delta zip) straight from R2 by range.
`TransferManager.runDirect`: list the locations (`/api/clipper?action=direct-locations`,
5,000 a page, written to `<transfer>/direct/plan.bin` so the listing resumes), get signed
links (`direct-link`, renewed with the record's id+token before they expire and on 403),
download (16 range requests in flight, neighbours within 256 KiB read together, at most
8 MB / 64 games a range; each entry's local header and CRC checked, then the bundled slpz
decodes it into the library), report progress (`direct-progress`). Games in no zip, and
any it couldn't read, are left in `replayIds` for the old paths (one by one up to 24,
else a replay-list bundle); a rebuilt zip (412) or an older website/refused link falls
back the same way. The Downloads row shows games, games a second, MB/s and time left.
Up to 24 games from Find replays (200 for other lists) still come one by one. Server side and limits:
`apps/database/docs/direct-downloads.md`. Measured from home (2,000 production Fox
games, real R2): byte-identical to the archive, 378 requests per 1,000 games, 35-39 MB/s
(75-87 games a second, decoding the limit on a busy machine).

## Contract alignment — 2026-09-23 (after monorepo consolidation)

The user asked to finish the Clipper items from the cross-app contract audit.
This aligned the paused code with branch `contracts-audit-fixes`; the feature is
still paused and unshipped. Done:

- Job statuses: `DB_JOB_STATUSES` mirrors the database; the invented `expired`
  status is gone. `interpretStatus` (TransferManager) waits on active statuses,
  downloads only when `completed` + `downloadReady`, and treats completed without
  a bundle (storage cleanup), `failed` and `cancelled` as a gone export.
- Error codes: `/api/clipper` returns `{ code, error }` (database codes plus
  `grant_invalid`, `batch_invalid`). `DatabaseClient` throws
  `DatabaseRequestError` with status/code. Gone codes mark the transfer
  `exportGone`; its Resume ("Start new export") explicitly creates a new export
  with the same filters. Caps, busy storage and rate limits pause the transfer
  for a later Resume instead of failing it.
- Pause during export creation no longer loses the new job's id/grant (review
  concern 5): the create request isn't aborted; the pause is honoured after.
- Filters: normalised in `validateDatabaseFilters` (trim, drop empty/repeated,
  max 20 values like the website); callers use the returned copy.
- Duplicates (concern 3): bundles now carry `lunar-manifest.json` (replayId,
  fileHash). Since clip search Phase 3 (2026-09-30) every database batch goes
  into the **replay library** (`replayLibrary.ts`, `library.sqlite` on the DB
  worker; `extractBundleIntoLibrary`): each game lives once at
  `Library/replays/<last 2 hex>/<replayId>.slp` and later batches reuse it (by
  replayId or fileHash); the ZIP is deleted once its replays are in, and the
  batch's paths are kept in `Downloads/<batch>/replays.json` for the import.
  Bundles without a manifest still extract into the batch folder. Prepared
  imports always detect duplicates. Import results report `duplicates` and
  `skipped` (games Clipper doesn't import), shown in the transfer summary.
- Estimates show `estimatedZipSize`; replays without a duration show "—".
- `/api/clipper` forwards the visitor IP; the service key is added by proxyFetch.
- Real SLPZ roundtrip test passes (it was slow because of Jest deep-equality on
  2.7 MB buffers, not the binary).
- Storage hosts (concern 8): the database presigns only its S3 endpoint
  (B2 us-east-005, path style); `PUBLIC_DOWNLOAD_BASE` is unused by the code. The
  website's Linode entry is legacy, so Clipper's narrower list is correct.

Tests: `src/__tests__/databaseTransfers.test.ts`, the existing database and
extraction tests, and the root `scripts/test/clipper-database.test.mjs`.

### Follow-up — 2026-09-24

Worked through the remaining review concerns below:

- 1: `TransferManager` end-to-end tests (full batch; expired export → explicit
  "Start new export"), `/api/clipper` route tests (website
  `src/pages/api/clipper.test.ts`), and a production webpack build of main and
  renderer (built into a scratch folder, because `release/app/dist` links into
  the preserved legacy checkout; don't build over it).
- 2: `downloadBundle` tested against a real local HTTP server: full download,
  resume with matching ETag, restart on changed ETag or ignored Range, resume
  after a truncated body, redirect allowlist. An expired presigned link (403/404
  from storage) now raises `DownloadLinkExpiredError`, keeps the partial file,
  and the transfer fetches one fresh link and continues.
- 4: local ZIP import: Cancel now stops the whole batch; a failed ZIP removes
  its own half-extracted folder and is reported in the app console.
- 6: renderer requests go through `parseDatabaseRequest`; every saved record in
  transfers.json is validated by `parseSavedTransfer` (any bad record → the
  existing "history could not be read" state); extraction source/destination
  containment compares real paths (`realPath`), so symlinked folders can't
  defeat it.
- 7: stale `replays-*` attempt folders in a transfer's own folder are removed
  before a new attempt (`removeUnfinishedAttempts`); the completed one is kept.
- 9: decompression checks free space for the expanded replay (12x the .slpz),
  not just the compressed entry; estimate responses are validated before display.
- 10: APP_FLOW.md notes the panel as a manually opened tool (not onboarding);
  `database-integration.md` has usage notes and the deployment order.

Still not done: looking at the real UI in a running app (needs a user session;
not run here to avoid touching real settings/projects), a Local ZIP import
cancellation test (ImportManager needs Electron dialogs), a real B2 download
through the deployed website, and the website still allowing a legacy Linode
host that the database never returns.

## Agreed direction

Native database controls inside Clipper, not an embedded website or browser
handoff. Search → bounded batch → Add to project → prepare/download/unzip/SLPZ
decompress/import automatically. Also provide standalone replay extraction.
See [implementation plan](database-integration.md).

## Changes written

### lm-clipper

- `src/constants/database.ts`: request/result/transfer types, filter validation,
  shared export-filter mapping. Default batch 1,000; the 100,000 maximum was removed 2026-10-13.
- `src/renderer/components/DatabasePanel.tsx` and styles: native search panel,
  player/opponent character/code/name filters, stages/dates/sources/order,
  paginated results, estimates, destination selection, Transfers and Extract tabs.
- `Top.tsx`: opens native panel instead of website; Transfers and Extract buttons.
- `src/main/managers/TransferManager.ts`: persistent job state, sequential queue,
  pause/resume/retry, server preparation polling, download/extraction/import,
  original-project binding, interrupted jobs paused after restart.
- `src/main/databaseClient.ts`: main-process JSON API client, approved storage
  hosts, streaming downloads, conditional Range/ETag continuation.
- `src/main/replayExtraction.ts`: new-output-only streaming ZIP extraction,
  path/link checks, CRC verification, disk space checks, SLPZ decompression,
  standalone file/folder extraction. Sources preserved.
- Controller/preload/ipcBridge wired through `databaseRequest` and
  `databaseTransfers`.
- `ImportManager.ts`: prepared-import entry point, archive-switch guards,
  shared ZIP extractor, recursive SLPZ detection. Needs further review (below).
- Direct dependency `yauzl` 3.4.0 and dev dependency `@types/yauzl` installed.
- Tests: `database.test.ts`, `replayExtraction.test.ts`.

### ../lunar_melee

Three NEW files installed with explicit sandbox approval:

- `src/pages/api/clipper.ts`: POST create, GET status/file. Existing creation and
  download rate-limit buckets reused. Returns signed per-job capability;
  status/file use original owner identity without browser cookies. Download
  caps stay enforced; bytes go directly to storage.
- `src/utils/clipperToken.ts`: seven-day HMAC job-scoped capabilities using
  domain separation with the website's existing server secret.
- `src/utils/clipperToken.test.ts`: scope, tamper, expiry tests.

Website search remains POST `/api/getList`; estimate remains POST
`/api/download?action=estimate`. Export creation/status/file use `/api/clipper`.
The actual export builder is a separate DATABASE_API_URL service, not inspected.
Production default is `https://www.lunarmelee.com` (matches existing telemetry).
Development-only `LUNAR_DATABASE_ORIGIN=http://localhost:3001` override supported.
The new website endpoint must be deployed before production desktop transfers
can work. Nothing was deployed or submitted as a live bulk export.

Website staging copies: `/tmp/lunar-desktop-patch/`. Approved installer:
`python3 /tmp/install-lunar-desktop.py`; checks SHA256 ledger before replacing
only files it previously installed. `/tmp` is temporary; real source files above
are already in the sibling repository.

## Verification at pause

- Clipper `npm run typecheck`: passed before the most recent small lint fixes;
  rerun after those edits.
- Website typecheck PASSED using its OWN TypeScript:
  `node ../lunar_melee/node_modules/typescript/bin/tsc --noEmit --incremental false -p ../lunar_melee/tsconfig.json`.
  Running Clipper's older TypeScript against the website fails on bundler module
  resolution; that was the wrong compiler, not a website defect.
- Website token tests: 3/3 PASS via
  `node ../lunar_melee/node_modules/vitest/vitest.mjs run --root ../lunar_melee src/utils/clipperToken.test.ts`.
- Focused Clipper tests: latest run 14 PASS, 1 FAIL. Only remaining failure was
  the real SLPZ roundtrip exceeding Jest's default 5-second timeout.
  The fixture is `assets/test.slp`; compression flag is **-x**, NOT -c.
  Next: give the real roundtrip an appropriate timeout, use hash comparison
  instead of potentially expensive full Buffer equality, and inspect subprocess
  completion. No passing real SLPZ roundtrip has been established yet.
- Initial ZIP pipeline bug fixed: Node pipeline cannot take explicit undefined
  as the final options argument; now always supplies an AbortSignal. ZIP safety,
  CRC, nested paths, existing-output protection tests passed afterward.
- First ESLint run had formatting and type-argument naming errors. Most semantic
  lint errors were edited after the run, but formatting/lint NOT rerun yet.
- Full test suite, production build, GUI smoke, download streaming integration,
  transfer recovery/project-switch tests, and website route integration tests
  have NOT been run/completed. Do not call this feature ready.

Commands to resume verification:

```bash
node node_modules/prettier/bin/prettier.cjs --write src/constants/database.ts src/main/databaseClient.ts src/main/replayExtraction.ts src/main/managers/TransferManager.ts src/main/managers/ImportManager.ts src/main/controller.ts src/renderer/components/DatabasePanel.tsx src/renderer/components/Top.tsx src/renderer/ipcBridge.ts src/__tests__/database.test.ts src/__tests__/replayExtraction.test.ts
npm run typecheck
CI=true npm test -- --runInBand src/__tests__/database.test.ts src/__tests__/replayExtraction.test.ts
```

SLPZ subprocess tests required sandbox escalation. Do not bypass permissions.
No test/build processes were identified as still active when pausing.

## Next work / review concerns

1. Finish lint/typecheck and real SLPZ test, then add meaningful manager/UI/server
   route tests and run the full suite/build. Inspect the actual UI.
2. Verify HTTP streaming continuation end-to-end (including changed ETags,
   ignored ranges, truncated bodies, expired signed links, forbidden redirects).
   Pure `downloadRange` contract tests already pass. Metadata/truncation order
   was adjusted to avoid associating a new ETag with an old partial file.
3. Test project switching and shutdown while importing. Prepared-import retries
   should force duplicate detection even if the global setting is off; currently
   runImport still uses the global setting. Ensure archive refresh never restores
   an old project, including switches during awaits.
4. Local ZIP import currently catches extraction errors and continues. Cancellation
   must stop the batch, and extraction failures need visible reporting instead
   of only console.error. Review extraction AbortController lifecycle.
5. A pause during remote POST create can lose a newly created job response.
   Preserve received job credentials before honoring pause; consider server
   idempotency for ambiguous creation failures. Never auto-create another job
   merely because a poll/download failed.
6. Harden transfer-state loading/runtime IPC input validation. Validate persisted
   record shapes; check source/destination containment through real paths too
   (symlink aliases can defeat lexical containment checks).
7. Recovery currently preserves completed ZIPs and prepared directories, but
   extraction restarts from scratch and cleans the current owned attempt on
   ordinary failure. Hard-kill orphan attempt folders need a clear policy.
8. Storage allowlist currently permits dl.lunarmelee.com and the known B2 endpoint.
   Website resolver also allows configured Linode storage; decide whether desktop
   needs that host and verify actual signed URL shapes before shipping.
9. Verify both compressed and raw size estimates against actual export format
   and extraction space requirements. Handle unknown/malformed response fields.
10. Update APP_FLOW.md to document the new manually opened database/tools surfaces
    and any actual onboarding changes; do not claim forced dev-screen coverage
    unless implemented. Add user-facing usage notes and deployment contract.

## Existing user work — preserve

Before this task, Clipper already had uncommitted picker guards in
`FilterControls.tsx` / `Filters.tsx` and a test-mode Reset Onboarding button in
`Top.tsx`. Do not revert or claim those as this task's changes.

At pause, lunar_melee also has unrelated changes in `CLAUDE.md`, `next-env.d.ts`,
`tsconfig.tsbuildinfo`, and untracked `assets/logo/exports/oauth-logo.png`.
Those are not part of this feature; preserve them.
