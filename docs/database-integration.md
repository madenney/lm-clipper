# Integrated Lunar Database

**Status (2026-11-10): built and on main; Clipper v3 is not released yet.** The
design notes below are the original plan. Where they differ from the code, the
table here is right. History and how it was built:
[handoff](database-integration-handoff.md).

## Current behaviour (read this first)

| Topic | Now |
| --- | --- |
| Where games come from | Stored games only, straight from Cloudflare R2 (Find replays, Find clips, Download again). Nothing is packed on the Lunar server for v3; a server bundle is only the old fallback for lists that are not Find replays/Find clips. |
| Lists up to `ONE_BY_ONE_MAX_GAMES` (24) | One by one through the website's replay route, 4 at a time. A game over 64 MB is skipped and counted, never retried. |
| Bigger lists and searches | By range from the full-database zip / delta zips (`directDownload.ts`, plans in `<transfer>/direct`). Entries over 32 MB are skipped and counted. No maximum batch size. |
| Library and folders | Replay Library: `Documents\Lunar Clipper\Library`, or `%LOCALAPPDATA%\Lunar Clipper\Library` on a new Windows install whose Documents is synced to OneDrive (an existing Documents folder is kept). Downloads of a job: `<Library>\Downloads\Lunar-<date>-<id>`. Unpacked archives: `...\Lunar Clipper\Replays`. Settings > Paths moves the library (copy, verify, then delete the old one). |
| Free space | Checked before a direct download (asks "Start anyway"), before the whole-database file and before unpacking. A drive that fills mid-run pauses the transfer: "Your drive is full". |
| Retries | A dropped connection is waited out for about 2.5 minutes. A busy or restarting server (429, 500, 502, 503, 504) is waited out for about 2 minutes, using Retry-After; then the transfer pauses (Resume). Maintenance pauses and resumes by itself. A write refused by antivirus is retried (EPERM/EBUSY, 6 tries) before it counts as a failure. |
| Pause / Resume | Downloaded games stay in the library. A paused unpack keeps what it has extracted and carries on from there. The whole-database file continues from its `.part` (also when only the final rename had failed). |
| History file | `transfers.json` in the settings folder, one record at a time: a record that cannot be read is moved to `transfers.json.bad` and the rest load; `transfers.json.bak` is the previous copy. Never a lockout. |
| Identity | Every call sends `User-Agent: LunarClipper/<version>`, and `X-Lunar-App-Version` (no install id: the usage events carry that, and only while usage stats are on). `/api/status` may carry `clipper: { latest, minimum, message }`; a build below `minimum` shows the message. A 426 / `client_outdated` answer says to update. |
| Daily limits | Per install (the install id) with a looser per-IP ceiling, on the website side. |

## Delivery plan

1. Native database panel: matchup/player/stage/date/source filters, paginated
   results, bounded batch size, download/unpacked estimates, Add to project.
2. Main-process API client and website desktop endpoint. Export capabilities are
   signed, expire, and authorize only status/download for one job. No browser
   cookies or database service credentials are copied into the desktop app.
3. Persistent local transfer queue: prepare, download, extract, import. Pause and
   retry preserve completed downloads; interrupted work is explicitly paused on
   restart. HTTP range continuation is conditional on a matching object validator.
4. Replay extraction service shared with local ZIP import and a standalone
   extraction tool. Stream ZIP contents, reject unsafe paths/links, preserve
   sources, support nested directories and SLPZ conversion, expose cancellation.
5. Verify contracts, extraction safety, download continuation, project binding,
   UI behavior, type checking, production build, and existing tests.

## Product decisions

- Search lives inside Clipper; no embedded remote page or browser handoff.
- A batch is the first N matching replays in the chosen sort order, not the
  currently visible page. Search, estimate, and creation share a filter snapshot.
- Unpacked archives go to Lunar Clipper/Replays (see the table above); users can
  choose another folder. Each job gets its own folder. Source archives remain available.
- Add to project binds the project path when the job starts. If another project
  is open when extraction finishes, the job waits for its original project.
- Standalone extraction works without a project and never deletes source files.
- Only one local transfer runs at a time. Closing the panel does not stop
  it. Restarted jobs wait for an explicit Resume. The computer is kept awake while one runs.
- Pausing a local transfer does not cancel the server export (it can be resumed).
- No automatic deployment, live bulk exports, or changes to personal replay data
  are part of development verification.

## Server contract

Existing POST /api/getList and POST /api/download?action=estimate remain the
search/estimate APIs. New /api/clipper supports POST create and GET status/file.
Create returns {jobId, token}; status/file require a Bearer capability and jobId.
The website resolves fresh storage URLs and keeps its existing download caps.
The app streams bytes directly from approved HTTPS storage hosts.

Production integration requires deploying the companion lunar_melee endpoint.
Development may use LUNAR_DATABASE_ORIGIN=http://localhost:3001 in the main
process; packaged builds always use https://www.lunarmelee.com.

## Using it (for release notes, once shipped)

- **Lunar Database** in the top bar: pick players, characters, stages, dates and
  sources, check the estimate, then **Add to project**. The batch downloads,
  unpacks and imports into the project that was open when you started.
- **Transfers** lists batches. Pause and Resume keep downloaded bytes. If the
  server export expired or failed, the button reads **Start new export** and
  creates a fresh export with the same filters. Daily-cap or busy-storage
  problems pause the transfer; Resume later.
- Replays already downloaded by an earlier batch are reused, and replays already
  in the project are skipped. The summary says how many were added, already in
  the project, or skipped (Clipper imports only 1v1 singles of 20 seconds or more).
- **Extract** unpacks local ZIP/SLPZ files without a project, never deleting sources.

## Deployment contract

Order matters; each step is compatible with the one before it.

1. **Database service** with the bundle manifest (`lunar-manifest.json` in every
   bundle, `src/services/bundleManifest.ts`) and the error codes in
   `src/utils/apiErrors.ts`. Older bundles without a manifest still import;
   they just can't reuse earlier downloads.
2. **Website** with `/api/clipper` (`src/pages/api/clipper.ts`) and a
   non-empty server secret (the one the website already uses for sessions; it signs the 7-day desktop grants). Set
   `LUNAR_SERVICE_KEY` on the website, then on the database (see
   `apps/database/README.md`).
3. **Clipper** release. Packaged builds always call `https://www.lunarmelee.com`;
   `LUNAR_DATABASE_ORIGIN=http://localhost:3001` works only in unpackaged dev.
   Downloads go directly to the storage hosts in `storageUrlAllowed`
   (`src/main/databaseClient.ts`); update it if the database's `S3_ENDPOINT`
   changes.

The cross-app lists this depends on (job statuses, error codes, manifest name)
are pinned by `scripts/test/clipper-database.test.mjs` at the repository root.

