import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { setTimeout as delay } from 'timers/promises'
import {
  databaseExportFilter,
  ONE_BY_ONE_MAX_GAMES,
} from '../../constants/database'
import {
  DatabaseRequestError,
  ReplayTooLargeError,
  storageUrlAllowed,
} from '../databaseClient'
import { askDialog } from '../askRenderer'
import {
  describeFileSystemError,
  driveOf,
  freeBytesAt,
  retryFs,
} from '../fsRetry'
import { libraryRelativePath } from '../replayLibrary'
import type { LibraryAccess } from '../replayExtraction'
import { encodeSlpzVerified } from '../../lib/slpz'
import {
  DirectPlan,
  SnapshotChangedError,
  TransientRangeError,
  buildPlan,
  planIds,
  runDirectDownload,
  type DirectLinks,
  type LocationsPage,
} from '../directDownload'
import {
  PREBUILT_PLANS_URL,
  loadPrebuiltPlan,
  markPrebuiltStale,
} from '../prebuiltPlans'
import { formatBytes } from '../../lib/format'
import {
  RetryLaterError,
  isClientOutdatedError,
  isMaintenanceError,
  isNetworkError,
  isTransientServerError,
  serverWaitSeconds,
} from './errors'
import {
  DIRECT_DIR,
  FILE_LIST_NAME,
  notStoredText,
  preparedImportPaths,
} from './files'
import type { SavedTransfer } from './savedTransfer'
import type { TransferContext } from './context'

export const DIRECT_CONCURRENCY = 4
/** Lists that aren't from Find replays / Find clips: up to this many games one by
 *  one through the website (storage, else the Lunar server), as before 2026-10-19. */
export const LIST_ONE_BY_ONE_MAX_GAMES = 200
/** Most leftover games one replay-list bundle takes (the database's MAX_REPLAY_IDS). */
const MAX_LIST_EXPORT = 100_000
/** Attempts per game while the connection is down (fetchOne): ~2.5 min of waiting. */
const NETWORK_RETRIES = 9

/**
 * Find replays / Find clips: only stored games, only from storage. A list of up to
 * ONE_BY_ONE_MAX_GAMES comes one by one through the website's storage path
 * (storedOnly=1, which never asks the Lunar server); a search or a longer list
 * straight from storage by range (runDirect). Games in no zip are left out and
 * said so; nothing falls back to a bundle or to the Lunar server at home.
 */
export async function fetchStored(
  ctx: TransferContext,
  job: SavedTransfer,
  signal: AbortSignal,
) {
  const ids = job.replayIds?.length ?? 0
  if (
    !job.filters &&
    ids > 0 &&
    ids <= (ctx.deps.directMaxGames ?? ONE_BY_ONE_MAX_GAMES)
  )
    await fetchDirect(ctx, job, signal)
  else if (job.filters || ids > 0) await runDirect(ctx, job, signal)
}

/**
 * Download each listed game into the library (skipping ones it has), then hand
 * the import step a file list, as a bundle download would. Games the database no
 * longer has (or, for stored-only jobs, that no zip on storage holds) are skipped;
 * anything else that fails stops the transfer so Resume can try again (finished
 * games stay in the library and aren't fetched twice).
 */
export async function fetchDirect(
  ctx: TransferContext,
  job: SavedTransfer,
  signal: AbortSignal,
) {
  const ids = job.replayIds!
  const library = ctx.deps.getLibrary()
  const { have } = await library.lookup(ids, [])
  const todo = ids.filter((id) => !have[id])
  const files: string[] = ids.filter((id) => have[id]).map((id) => have[id])
  const unavailable: string[] = []
  // Games too large to fetch one by one: skipped and counted, never retried.
  const tooLarge: string[] = []
  let done = ids.length - todo.length
  let failure: Error | null = null
  ctx.update(job, {
    stage: 'downloading',
    detail: `Downloading ${todo.length.toLocaleString()} ${todo.length === 1 ? 'game' : 'games'}`,
    unit: 'games',
    current: done,
    total: ids.length,
  })
  const queue = [...todo]
  const worker = async () => {
    while (queue.length && !failure) {
      if (signal.aborted) throw new Error('Paused')
      const id = queue.shift()!
      try {
        const target = await fetchOne(ctx, id, library, signal, job.storedOnly)
        await library.register([{ replayId: id, fileHash: '', path: target }])
        files.push(target)
      } catch (error) {
        if (signal.aborted) throw new Error('Paused')
        if (error instanceof DatabaseRequestError && error.status === 404)
          unavailable.push(id)
        else if (error instanceof ReplayTooLargeError) tooLarge.push(id)
        else failure = error as Error
      }
      done++
      ctx.update(job, { current: done, total: ids.length }, false)
    }
  }
  await Promise.all(Array.from({ length: DIRECT_CONCURRENCY }, worker))
  if (failure) throw failure
  if (!files.length)
    throw new Error(
      job.storedOnly && unavailable.length
        ? 'None of these games are available yet: they are newer than the stored games. They appear after the next update.'
        : tooLarge.length
          ? 'These games are too large to download here.'
          : 'None of these games could be downloaded.',
    )
  const prepared = path.join(job.outputDir, FILE_LIST_NAME)
  fs.writeFileSync(prepared, JSON.stringify(files))
  ctx.update(job, {
    preparedPath: prepared,
    ...(job.storedOnly && unavailable.length
      ? { notStored: unavailable.length }
      : {}),
    ...(tooLarge.length ? { unreadable: tooLarge.length } : {}),
    detail: `${(files.length - (ids.length - todo.length)).toLocaleString()} games downloaded${ids.length - todo.length ? `, ${(ids.length - todo.length).toLocaleString()} already in your library` : ''}${unavailable.length ? ` · ${unavailable.length.toLocaleString()} ${job.storedOnly ? 'not available yet (newer than the stored games)' : 'not in the database'}` : ''}${tooLarge.length ? ` · ${tooLarge.length.toLocaleString()} too large to download here (skipped)` : ''}`,
    current: 0,
    total: null,
  })
}

/**
 * A website/database call for the direct path, waiting out a dropped connection
 * (~2.5 min), per-minute limits and busy storage before giving up.
 */
export async function directCall<T>(
  ctx: TransferContext,
  route: string,
  body: unknown,
  signal: AbortSignal,
  headers?: Record<string, string>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await ctx.client.json<T>(route, body, undefined, signal, headers)
    } catch (error) {
      if (signal.aborted || isMaintenanceError(error)) throw error
      const e = error as DatabaseRequestError
      // A busy or restarting website/database (429, 500, 502, 503, 504: the
      // home database behind a tunnel) is waited out, honouring Retry-After,
      // for about two minutes before the transfer pauses (launch review DL-7).
      const wait =
        e instanceof DatabaseRequestError
          ? isTransientServerError(e) && attempt < 6
            ? serverWaitSeconds(e, attempt)
            : null
          : isNetworkError(error) && attempt < NETWORK_RETRIES
            ? Math.min(2 ** attempt, 30)
            : null
      if (wait === null) throw error
      await delay(wait * 1000, undefined, { signal })
    }
  }
}

/** Which of these ids the library has (paths) and which it doesn't. */
export async function splitByLibrary(ctx: TransferContext, ids: string[]) {
  const library = ctx.deps.getLibrary()
  const files: string[] = []
  const missing: string[] = []
  for (let s = 0; s < ids.length; s += 2000) {
    const chunk = ids.slice(s, s + 2000)
    const { have } = await library.lookup(chunk, [])
    for (const id of chunk) (have[id] ? files : missing).push(have[id] ?? id)
  }
  return { files, missing }
}

/** The old paths only from here on, saying why (the transfer keeps going). */
export function directOff(
  ctx: TransferContext,
  job: SavedTransfer,
  why: string,
) {
  fs.rmSync(path.join(job.outputDir, DIRECT_DIR), {
    recursive: true,
    force: true,
  })
  ctx.update(job, { direct: 'off', speed: undefined, detail: why })
}

/**
 * The games of this search or list that are in the full-DB snapshot (or a delta
 * zip), straight from storage by range (directDownload.ts). When it's over, the
 * games no zip holds, and any it couldn't read, are left in job.replayIds for the
 * one-by-one or bundle paths; the ones it brought in are merged into the import.
 */
export async function runDirect(
  ctx: TransferContext,
  job: SavedTransfer,
  signal: AbortSignal,
) {
  const dir = path.join(job.outputDir, DIRECT_DIR)
  const plan = DirectPlan.open(dir)
  const spec = job.replayIds?.length
    ? { replayIds: job.replayIds }
    : { filter: databaseExportFilter(job.filters!) }
  const wanted = job.replayIds?.length ?? job.filters?.maxFiles ?? null
  const listed = () => plan.meta.count + plan.meta.other
  ctx.update(job, {
    stage: 'preparing',
    detail: 'Finding where the games are stored',
    unit: 'games',
    current: listed(),
    total: wanted,
    readyAt: null,
  })
  try {
    // The big common selections ("every Fox game") have a prebuilt plan on
    // storage: far quicker, and none of it comes over the Lunar server's uplink.
    if (plan.meta.prebuilt && !plan.meta.prebuilt.loaded) plan.reset()
    if (spec.filter && !plan.meta.prebuilt) {
      const used = await loadPrebuiltPlan(plan, {
        manifestUrl:
          ctx.deps.direct?.plansUrl === undefined
            ? PREBUILT_PLANS_URL
            : ctx.deps.direct.plansUrl,
        filter: spec.filter,
        signal,
        allowUrl: ctx.deps.direct?.allowUrl
          ? ctx.deps.direct.allowUrl
          : undefined,
      })
      if (used)
        ctx.update(
          job,
          {
            detail: `Finding where the games are stored: ${listed().toLocaleString()} from the ready-made list, now the newest`,
            current: listed(),
          },
          false,
        )
    }
    await buildPlan(
      plan,
      spec,
      (body) =>
        directCall<LocationsPage>(
          ctx,
          '/api/clipper?action=direct-locations',
          body,
          signal,
        ),
      signal,
      () =>
        ctx.update(
          job,
          {
            detail: `Finding where the games are stored: ${listed().toLocaleString()} so far`,
            current: listed(),
            total: wanted && wanted >= listed() ? wanted : null,
          },
          false,
        ),
    )
  } catch (error) {
    if (
      signal.aborted ||
      isMaintenanceError(error) ||
      !(error instanceof DatabaseRequestError)
    )
      throw error
    // Find replays / Find clips: storage or nothing. The transfer stops (busy or a
    // limit: paused, Resume to try again; anything else: needs attention).
    if (job.storedOnly) throw error
    // An older website, or the database said no: the old paths, as before.
    directOff(
      ctx,
      job,
      'Packing on the Lunar server instead (direct download unavailable).',
    )
    return
  }
  const others = plan.others()
  let files: string[] = []
  let leftover: string[] = others
  let note = ''
  if (plan.meta.count > 0) {
    await checkDiskSpace(ctx, job, plan.meta.bytes)
    let links: DirectLinks
    const appHeaders = { 'X-Lunar-App-Version': app.getVersion() }
    const newLink = () =>
      directCall<DirectLinks & { downloadId: string; token?: string }>(
        ctx,
        '/api/clipper?action=direct-link',
        {
          games: plan.meta.count,
          bytes: plan.meta.bytes,
          ...(job.filters ? { filter: databaseExportFilter(job.filters) } : {}),
        },
        signal,
        appHeaders,
      )
    const keep = (l: DirectLinks & { downloadId: string; token?: string }) => {
      if (
        /^[a-f0-9]{24}$/.test(l.downloadId) &&
        (l.token || l.downloadId === job.fullDbDownloadId)
      ) {
        const fresh = l.downloadId !== job.fullDbDownloadId
        job.fullDbDownloadId = l.downloadId
        if (l.token) job.fullDbToken = l.token
        if (fresh) ctx.save()
      }
      if (!Array.isArray(l.links) || !l.links.length)
        throw new Error('The database sent no download links.')
      return { links: l.links, expiresAt: l.expiresAt }
    }
    const renewed = async () => {
      if (job.fullDbDownloadId && job.fullDbToken) {
        try {
          return keep(
            await directCall(
              ctx,
              '/api/clipper?action=direct-link',
              {},
              signal,
              {
                ...appHeaders,
                'X-Full-Db-Download': `${job.fullDbDownloadId}.${job.fullDbToken}`,
              },
            ),
          )
        } catch (error) {
          // That record can't be continued (finished, too old, out of links): a new one.
          if (
            !(error instanceof DatabaseRequestError) ||
            isMaintenanceError(error)
          )
            throw error
        }
      }
      return keep(await newLink())
    }
    try {
      links = await renewed()
    } catch (error) {
      if (
        signal.aborted ||
        isMaintenanceError(error) ||
        !(error instanceof DatabaseRequestError)
      )
        throw error
      // Find replays / Find clips: no link, no download (a limit or busy: paused).
      if (job.storedOnly) throw error
      directOff(
        ctx,
        job,
        `${error.message.replace(/[.\s]*$/, '')}. Packing on the Lunar server instead.`,
      )
      return
    }
    let renewing: Promise<DirectLinks> | null = null
    const linkSource = {
      current: () => links,
      renew: () => {
        renewing ??= renewed()
          .then((l) => {
            links = l
            return l
          })
          .finally(() => {
            renewing = null
          })
        return renewing
      },
    }
    const size = formatBytes(plan.meta.bytes)
    const after = !others.length
      ? ''
      : job.storedOnly
        ? ` · ${notStoredText(others.length)}`
        : ` · ${others.length.toLocaleString()} newer ${others.length === 1 ? 'game comes' : 'games come'} after`
    ctx.update(job, {
      stage: 'downloading',
      detail: `Straight from storage: ${plan.meta.count.toLocaleString()} games (${size})${after}`,
      unit: 'games',
      current: 0,
      total: plan.meta.count,
    })
    let lastSent = { at: 0, games: 0 }
    let sending = false
    const sendProgress = (
      gamesDone: number,
      bytesDone: number,
      requests: number,
      done: boolean,
    ) => {
      if (!job.fullDbDownloadId || !job.fullDbToken) return Promise.resolve()
      return ctx.client
        .json('/api/clipper?action=direct-progress', {
          downloadId: job.fullDbDownloadId,
          token: job.fullDbToken,
          gamesDone,
          bytesDone,
          requests,
          done,
        })
        .catch(() => {})
    }
    try {
      const result = await runDirectDownload({
        plan,
        library: ctx.deps.getLibrary(),
        slpzBinary: ctx.deps.getSlpzBinary(),
        links: linkSource,
        signal,
        concurrency: ctx.deps.direct?.concurrency,
        decoders: ctx.deps.direct?.decoders,
        coalesce: ctx.deps.direct?.coalesce,
        backoffMs: ctx.deps.direct?.backoffMs,
        allowUrl: ctx.deps.direct?.allowUrl ?? storageUrlAllowed,
        onProgress: (p) => {
          ctx.update(
            job,
            {
              current: p.done,
              total: p.total,
              speed: p.bytesPerSec ?? undefined,
            },
            false,
          )
          // Lunar's record of it: every 5% or 5 minutes, best effort.
          const due =
            p.done - lastSent.games >= p.total * 0.05 ||
            Date.now() - lastSent.at > 5 * 60_000
          if (due && !sending) {
            lastSent = { at: Date.now(), games: p.done }
            sending = true
            sendProgress(p.done, p.bytes, p.requests, false).finally(() => {
              sending = false
            })
          }
        },
      })
      files = result.files
      leftover = [...others, ...result.failed]
      await sendProgress(
        result.files.length,
        result.bytes,
        result.requests,
        true,
      )
      if (result.failed.length) {
        note = ` · ${result.failed.length.toLocaleString()} couldn't be read from storage`
        // Kept on the transfer: the final line (after the import) still says so.
        ctx.update(job, { unreadable: result.failed.length }, false)
      }
    } catch (error) {
      if (
        error instanceof TransientRangeError &&
        error.network &&
        !signal.aborted
      )
        throw new Error(
          `Can't reach storage (${error.message.replace(/[.\s]*$/, '')}). Check your internet connection, then Resume: games already downloaded are kept.`,
        )
      if (!(error instanceof SnapshotChangedError)) throw error
      if (job.storedOnly) {
        // Find replays / Find clips: plan again from where the games are now (the
        // games already in the library are skipped on Resume). A ready-made plan
        // that named the old zip is not used again for a while.
        if (plan.meta.prebuilt) markPrebuiltStale()
        plan.reset()
        throw new RetryLaterError(
          'The stored games were just updated on storage. Resume to continue: games already downloaded are kept.',
        )
      }
      // The zip changed on storage (rebuilt): the rest the old way.
      const split = await splitByLibrary(ctx, planIds(plan))
      files = split.files
      leftover = [...others, ...split.missing]
      note =
        ' · the snapshot changed on storage, so the rest come from the Lunar server'
    }
  }
  fs.writeFileSync(path.join(dir, 'files.json'), JSON.stringify(files))
  for (const f of [plan.binPath, plan.otherPath]) fs.rmSync(f, { force: true })
  if (job.storedOnly) {
    // Storage or nothing: games in no zip are left out (they appear after the next
    // update), ones storage couldn't give are counted; nothing goes to the server.
    if (others.length) note += ` · ${notStoredText(others.length)}`
    if (!files.length)
      throw new Error(
        others.length
          ? 'None of these games are available yet: they are newer than the stored games. They appear after the next update.'
          : 'None of these games could be downloaded from storage. Resume to try again.',
      )
    const prepared = path.join(job.outputDir, FILE_LIST_NAME)
    fs.writeFileSync(prepared, JSON.stringify(files))
    ctx.update(job, {
      direct: 'done',
      preparedPath: prepared,
      speed: undefined,
      notStored: others.length || undefined,
      detail: `${files.length.toLocaleString()} games straight from storage${note}`,
      current: 0,
      total: null,
    })
    return
  }
  const extra =
    leftover.length > MAX_LIST_EXPORT ? leftover.length - MAX_LIST_EXPORT : 0
  if (extra)
    note += ` · ${extra.toLocaleString()} more newer games weren't fetched: start the download again later for them`
  const got = `${files.length.toLocaleString()} games straight from storage${note}`
  if (!leftover.length) {
    const prepared = path.join(job.outputDir, FILE_LIST_NAME)
    fs.writeFileSync(prepared, JSON.stringify(files))
    ctx.update(job, {
      direct: 'done',
      preparedPath: prepared,
      speed: undefined,
      detail: got,
      current: 0,
      total: null,
    })
    return
  }
  ctx.update(job, {
    direct: 'done',
    directFiles: path.join(dir, 'files.json'),
    replayIds: leftover.slice(0, MAX_LIST_EXPORT),
    speed: undefined,
    detail: `${got}; ${Math.min(leftover.length, MAX_LIST_EXPORT).toLocaleString()} more from the Lunar server`,
    current: 0,
    total: null,
  })
}

/** The games the direct part brought in, added to the import list of the rest. */
export function mergeDirectFiles(ctx: TransferContext, job: SavedTransfer) {
  if (!job.directFiles || !job.preparedPath || !fs.existsSync(job.directFiles))
    return
  const direct = JSON.parse(
    fs.readFileSync(job.directFiles, 'utf8'),
  ) as string[]
  const rest = preparedImportPaths(job.preparedPath)
  const merged = path.join(job.outputDir, FILE_LIST_NAME)
  fs.writeFileSync(merged, JSON.stringify([...new Set([...direct, ...rest])]))
  ctx.update(job, { preparedPath: merged, directFiles: undefined })
}

/** One game into the library: write a .part, check it's a replay, rename. Waits out "busy" answers. */
/** One game from the website into the library; returns where it was put. */
export async function fetchOne(
  ctx: TransferContext,
  id: string,
  library: LibraryAccess,
  signal: AbortSignal,
  storedOnly = false,
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const bytes = await ctx.client.replay(id, signal, { storedOnly })
      if (bytes.length < 16 || bytes.toString('latin1', 0, 6) !== '{U\x03raw')
        throw new Error('The download was not a replay file.')
      // The website sends the .slp: stored as .slpz when kept compressed
      // and the round trip gives the same bytes (lib/slpz.ts).
      const slpz = library.compress ? encodeSlpzVerified(bytes) : null
      const target = path.join(
        library.folder,
        libraryRelativePath(id, slpz ? '.slpz' : '.slp'),
      )
      await fs.promises.mkdir(path.dirname(target), { recursive: true })
      const part = `${target}.part`
      // A momentary lock by antivirus/OneDrive is retried, not a failed game.
      await retryFs(
        () => fs.promises.writeFile(part, slpz ?? bytes),
        `write ${part}`,
      )
      await retryFs(() => fs.promises.rename(part, target), `rename ${part}`)
      return target
    } catch (error) {
      if (signal.aborted) throw error
      const e = error as DatabaseRequestError
      const busy =
        e instanceof DatabaseRequestError && isTransientServerError(e)
      if (e instanceof DatabaseRequestError && e.status === 404) throw error
      // Too large to fetch one by one (skipped and counted, never retried), an
      // old build the server refuses, a full or protected drive: no point in
      // trying again; the caller says why.
      if (
        error instanceof ReplayTooLargeError ||
        isClientOutdatedError(error) ||
        describeFileSystemError(error)
      )
        throw error
      // Maintenance can last hours: stop now; the transfer waits and resumes.
      if (isMaintenanceError(e)) throw error
      // No connection at all: wait it out for about 2.5 minutes (2, 4, 8,
      // 16, then 30 s apart) before the transfer stops for a Resume.
      const offline = isNetworkError(error)
      if (attempt >= (busy ? 8 : offline ? NETWORK_RETRIES : 3)) throw error
      const waitSec = busy
        ? serverWaitSeconds(e, attempt)
        : offline
          ? Math.min(2 ** attempt, 30)
          : attempt * 2
      await delay(waitSec * 1000, undefined, { signal })
    }
  }
}

/**
 * Before a big download: is there room on the Replay Library's drive? A direct
 * download knows its size up front (plan.meta.bytes); kept decompressed it takes
 * about 9 times that. Below it the user is asked once; the answer is kept on the
 * transfer. An unknown free size (no statfs, a network drive) skips the check.
 * (Launch review DL-3 / UX-4.)
 */
export async function checkDiskSpace(
  ctx: TransferContext,
  job: SavedTransfer,
  planBytes: number,
) {
  if (job.spaceOk) return
  const library = ctx.deps.getLibrary()
  const free = await freeBytesAt(library.folder)
  if (free === null) return
  const need = planBytes * (library.compress ? 1 : 9) + 512 * 1024 * 1024
  if (free >= need) return
  const drive = driveOf(library.folder)
  const { response } = await askDialog(ctx.window, {
    type: 'warning',
    title: 'Not enough space',
    message: `This download needs about ${formatBytes(need)}; ${drive} has ${formatBytes(free)} free.`,
    detail:
      'Free some space, or move the Replay Library to a bigger drive (Settings > Paths), then Resume. Or start anyway and free up space before it fills.',
    buttons: ['Start anyway', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  })
  if (response !== 0)
    throw new RetryLaterError(
      `This download needs about ${formatBytes(need)} but ${drive} has ${formatBytes(free)} free. Free some space or move the Replay Library in Settings > Paths.`,
    )
  ctx.update(job, { spaceOk: true })
}
