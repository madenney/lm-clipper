import { shell, IpcMainEvent } from 'electron'
import path from 'path'
import fs from 'fs'
import type { ControllerCore } from './context'
import { askDialog } from '../askRenderer'
import { PlayerInterface } from '../../constants/types'
import {
  getFilterCountAsync,
  getFileByPathAsync,
  getLunarClipIdsAsync,
  insertFilterRowsAsync,
  libraryCall,
} from '../dbAsync'
import { logMain } from '../logger'
import { freeBytesAt, retryFs, describeFileSystemError } from '../fsRetry'
import { rendererConfig } from '../configStore'
import { ownerKeptPaths } from '../../owner/main'
import { touchesKeptPath } from '../keptPaths'
import {
  RequestEnvelope,
  unpackRequest,
  reply,
  buildShallowArchive,
} from '../ipcUtils'
import { formatBytes } from '../projectCompaction'
import { defaultLibraryFolder, storageConcern } from '../dataLocations'
import { LunarClip, clipToInterface } from '../../constants/clipSearch'
import { isReplayPath } from '../../lib/replayPath'
import type { Ctx as FiltersCtx } from './filters'
import { buildFilterJSON } from './filters'
import type { Ctx as CompactionCtx } from './compaction'
import { runCompactWorker } from './compaction'
import type { Ctx as MissingReplaysCtx } from './missingReplays'
import { startMissingCheck } from './missingReplays'
import { getDefaultProjectDir } from './helpers'

export type Ctx = Pick<
  ControllerCore,
  | 'archive'
  | 'config'
  | 'filterExecutor'
  | 'importManager'
  | 'library'
  | 'mainWindow'
  | 'removeFromRecentProjects'
  | 'saveConfig'
  | 'transferManager'
> &
  FiltersCtx &
  CompactionCtx &
  MissingReplaysCtx

export type MoveItem = { name: string; from: string; to: string }

/** Entries (files and folders) and bytes under `p`, to check a copy against its source. */
export async function treeStats(
  p: string,
): Promise<{ entries: number; bytes: number }> {
  const st = await fs.promises.lstat(p)
  if (!st.isDirectory()) return { entries: 1, bytes: st.size }
  let entries = 1
  let bytes = 0
  for (const name of await fs.promises.readdir(p)) {
    const sub = await treeStats(path.join(p, name))
    entries += sub.entries
    bytes += sub.bytes
  }
  return { entries, bytes }
}

/**
 * Move the library's items to their new places (launch review DL-1, WIN-2,
 * DATA-2). The order keeps a replay safe at every step:
 *  1. Same drive: rename each item; if one fails, rename the others back.
 *  2. Another drive: copy every item, then check each copy against its source
 *     (entry count and bytes). Any failure here removes only the copy (this
 *     function made it; the sources are untouched) and throws.
 *  3. `commit` (switch the setting, repoint the index and transfers) runs once
 *     the copies are verified. If it throws, the copies are removed again.
 *  4. Only then are the old items deleted, one by one, tolerating failures
 *     (a locked file, antivirus): what could not be removed is returned. The new
 *     copy is NEVER touched after step 3.
 */
export async function moveLibraryItems(
  items: MoveItem[],
  sameDrive: boolean,
  commit: () => Promise<void> | void,
): Promise<{ leftovers: string[] }> {
  const rm = (p: string) =>
    retryFs(
      () =>
        fs.promises.rm(p, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 200,
        }),
      `rm ${p}`,
    )
  const done: MoveItem[] = []
  if (sameDrive) {
    try {
      for (const it of items) {
        // eslint-disable-next-line no-await-in-loop
        await retryFs(
          () => fs.promises.rename(it.from, it.to),
          `rename ${it.from}`,
        )
        done.push(it)
      }
      await commit()
    } catch (error) {
      // Put back what moved; the old library is complete again.
      for (const it of done.reverse()) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await fs.promises.rename(it.to, it.from)
        } catch (_) {
          /* best effort */
        }
      }
      throw error
    }
    return { leftovers: [] }
  }
  // Another drive. Everything below the copy step only removes what this call created.
  const created: string[] = []
  try {
    for (const it of items) {
      created.push(it.to)
      // eslint-disable-next-line no-await-in-loop
      await fs.promises.cp(it.from, it.to, {
        recursive: true,
        errorOnExist: true,
        force: false,
      })
    }
    for (const it of items) {
      // eslint-disable-next-line no-await-in-loop
      const [a, b] = await Promise.all([treeStats(it.from), treeStats(it.to)])
      if (a.entries !== b.entries || a.bytes !== b.bytes)
        throw new Error(
          `The copy of ${it.name} does not match the original (${b.entries} of ${a.entries} items, ${b.bytes} of ${a.bytes} bytes).`,
        )
    }
    await commit()
  } catch (error) {
    // The sources are intact: drop the (partial) copies, nothing else.
    for (const p of created.reverse()) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await rm(p)
      } catch (_) {
        /* best effort */
      }
    }
    throw error
  }
  // Committed: the new copy is the library. Remove the old items, tolerating failures.
  const leftovers: string[] = []
  for (const it of items) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await rm(it.from)
    } catch (error) {
      logMain('moveReplayLibrary: could not remove an old item', {
        path: it.from,
        error: String(error),
      })
      leftovers.push(it.from)
    }
  }
  return { leftovers }
}

/**
 * Settings > Paths > Replay Library changed: move the library (its index,
 * downloaded replays and downloads in progress) to the new folder, so nothing
 * is downloaded again (decision 4, docs/library-workspaces.md). Projects are
 * repointed by the missing-replay check when they open. Replies with the
 * config in effect afterwards (unchanged if cancelled or failed).
 */
export async function moveReplayLibrary(
  ctx: Ctx,
  event: IpcMainEvent,
  data?: RequestEnvelope<string>,
) {
  const { requestId, payload } = unpackRequest<string>(data)
  const done = (extra: Record<string, unknown> = {}) =>
    reply(event, 'moveReplayLibrary', requestId, {
      config: rendererConfig(ctx.config),
      ...extra,
    })
  const win = ctx.mainWindow
  const notice = (
    type: 'info' | 'warning' | 'error',
    message: string,
    detail?: string,
  ) =>
    askDialog(win, {
      type,
      title: 'Replay Library',
      message,
      detail,
    })
  const oldFolder = path.resolve(ctx.library().folder)
  const newFolder = path.resolve(payload || defaultLibraryFolder())
  const previousSetting = ctx.config.replayLibraryPath
  const apply = () => {
    ctx.config.replayLibraryPath = payload || ''
    ctx.saveConfig()
  }
  if (newFolder === oldFolder) {
    apply()
    return done()
  }
  // A synced or network folder is a bad home for a database and 10^5 small
  // files (launch review DL-4, WIN-4, WIN-15).
  const concern = payload ? storageConcern(newFolder) : null
  if (concern?.kind === 'network') {
    await notice(
      'warning',
      'Clipper can’t keep the Replay Library on a network share.',
      `${concern.message}\n\nChoose a folder on a local drive.`,
    )
    return done({ cancelled: true })
  }
  if (concern) {
    const { response } = await askDialog(win, {
      type: 'warning',
      title: 'Replay Library',
      message: `Use a ${concern.provider} folder for the Replay Library?`,
      detail: concern.message,
      buttons: ['Choose another folder', 'Use it anyway'],
      defaultId: 0,
      cancelId: 0,
    })
    if (response !== 1) return done({ cancelled: true })
  }
  const inside = (a: string, b: string) => a.startsWith(`${b}${path.sep}`)
  if (inside(newFolder, oldFolder) || inside(oldFolder, newFolder)) {
    await notice(
      'warning',
      'Choose a folder outside the current Replay Library (and not one that contains it).',
    )
    return done({ cancelled: true })
  }
  const items = [
    'library.sqlite',
    'library.sqlite-wal',
    'library.sqlite-shm',
    'replays',
    'Downloads',
  ]
    .map((name) => ({
      name,
      from: path.join(oldFolder, name),
      to: path.join(newFolder, name),
    }))
    .filter((it) => fs.existsSync(it.from))
  if (!items.some((it) => it.name === 'library.sqlite')) {
    // Nothing there yet: just use the new folder.
    apply()
    return done()
  }
  // Nothing of the new folder may be in the way: the copy would otherwise mix
  // with it, and undoing a failed move must only ever remove what it made.
  if (items.some((it) => fs.existsSync(it.to))) {
    await notice(
      'warning',
      'That folder already has a Replay Library, or one of its folders.',
      'Choose an empty folder to move this one into.',
    )
    return done({ cancelled: true })
  }
  if (
    ctx.transferManager.busy ||
    ctx.filterExecutor.runningFilterIds.size > 0 ||
    ctx.importManager.importInProgress
  ) {
    await notice(
      'warning',
      'Finish or pause downloads, imports and running filters first.',
      'They use the Replay Library while they run.',
    )
    return done({ cancelled: true })
  }
  // What moves, for the question.
  let files = 0
  let bytes = 0
  const walk = async (p: string): Promise<void> => {
    const st = await fs.promises.lstat(p)
    if (st.isDirectory()) {
      for (const e of await fs.promises.readdir(p)) await walk(path.join(p, e))
    } else {
      files += isReplayPath(p) ? 1 : 0
      bytes += st.size
    }
  }
  for (const it of items) await walk(it.from)
  const { response } = await askDialog(win, {
    type: 'question',
    title: 'Replay Library',
    message: `Move your Replay Library (${files.toLocaleString()} replays, ${formatBytes(bytes)}) to the new folder?`,
    detail: `From ${oldFolder}\nTo ${newFolder}\n\nProjects that use these replays keep working; nothing is downloaded again.`,
    buttons: ['Move', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  })
  if (response !== 0) return done({ cancelled: true })

  try {
    fs.mkdirSync(newFolder, { recursive: true })
  } catch (error) {
    logMain('moveReplayLibrary: new folder not made', error)
    await notice(
      'error',
      'Clipper can’t use that folder.',
      friendlyFsMessage(error, newFolder),
    )
    return done({ cancelled: true })
  }
  const sameDrive = fs.statSync(oldFolder).dev === fs.statSync(newFolder).dev
  if (!sameDrive) {
    // Unknown free space (a network drive, no statfs) does not block the move.
    const free = await freeBytesAt(newFolder)
    if (free !== null && free < bytes * 1.05 + 256 * 1024 * 1024) {
      await notice(
        'warning',
        'Not enough free space in the new folder.',
        `It needs ${formatBytes(bytes)}; ${formatBytes(free)} is free.`,
      )
      return done({ cancelled: true })
    }
  }
  // Nothing may hold the library open while its files move.
  await libraryCall('libraryClose')
  if (!win.isDestroyed()) win.setProgressBar(2)
  let leftovers: string[] = []
  try {
    ;({ leftovers } = await moveLibraryItems(items, sameDrive, async () => {
      // The copies are checked: from here the new folder is the library.
      apply()
      await libraryCall('libraryRelocated', newFolder, oldFolder)
      ctx.transferManager.relocate(oldFolder, newFolder)
    }))
  } catch (error) {
    if (!win.isDestroyed()) win.setProgressBar(-1)
    logMain('moveReplayLibrary failed', error)
    // commit() may have switched the setting before it failed: undo that.
    if (path.resolve(ctx.library().folder) !== oldFolder) {
      ctx.config.replayLibraryPath = previousSetting
      ctx.saveConfig()
    }
    await notice(
      'error',
      'Moving the Replay Library failed. It is still in its old folder.',
      friendlyFsMessage(error, newFolder),
    )
    return done({ cancelled: true })
  }
  if (!win.isDestroyed()) win.setProgressBar(-1)
  logMain('moveReplayLibrary', {
    oldFolder,
    newFolder,
    files,
    bytes,
    leftovers,
  })
  if (leftovers.length)
    await notice(
      'info',
      'The Replay Library moved. The old folder could not be removed completely.',
      `Everything is in the new folder. You can delete what is left of ${oldFolder} by hand once nothing (antivirus, OneDrive) holds it.`,
    )
  // The open project finds its replays at the new place right away.
  startMissingCheck(ctx)
  return done({ moved: files })
}

/**
 * Once, after My Replays replaced Untitled N projects: offer to tidy the old
 * ones up (docs/library-workspaces.md, Part B). Only empty projects can be
 * trashed from here; anything with games is the user's to look at.
 */
export async function offerUntitledCleanup(ctx: Ctx) {
  if (ctx.config.untitledCleanupOffered) return
  const dir = getDefaultProjectDir()
  let names: string[] = []
  try {
    names = (await fs.promises.readdir(dir)).filter((n) =>
      /^Untitled( \d+)?\.lunar$/.test(n),
    )
  } catch {
    /* no projects folder */
  }
  const done = () => {
    ctx.config.untitledCleanupOffered = true
    ctx.saveConfig()
  }
  if (names.length === 0) return done()
  const projects: { file: string; games: number; bytes: number }[] = []
  for (const n of names) {
    const file = path.join(dir, n)
    if (file === ctx.archive?.path) continue
    try {
      const info = await runCompactWorker(ctx, file, 'games')
      projects.push({
        file,
        games: info.games ?? 0,
        bytes: fs.statSync(file).size,
      })
    } catch {
      /* unreadable: leave it alone */
    }
  }
  if (projects.length === 0) return done()
  const empty = projects.filter((p) => p.games === 0)
  const bytes = projects.reduce((a, p) => a + p.bytes, 0)
  const buttons = [
    ...(empty.length ? [`Move ${empty.length} empty to Trash`] : []),
    'Show in Folder',
    'Keep Them',
  ]
  const { response } = await askDialog(ctx.mainWindow, {
    type: 'question',
    title: 'Untitled projects',
    message:
      projects.length === 1
        ? `Quick imports now go into one place, “My Replays”. You have an untitled project from before (${formatBytes(bytes)}).`
        : `Quick imports now go into one place, “My Replays”. You have ${projects.length} untitled projects from before (${formatBytes(bytes)}).`,
    detail:
      projects.length === 1
        ? empty.length
          ? 'It has no games in it.'
          : 'It has games in it, so it is kept. Open it from the folder to look through it.'
        : empty.length
          ? `${empty.length === 1 ? '1 of them has' : `${empty.length} of them have`} no games in ${empty.length === 1 ? 'it' : 'them'}. Projects with games are kept; open them from the folder to look through them.`
          : 'They all have games in them, so they are kept. Open them from the folder to look through them.',
    buttons,
    defaultId: buttons.length - 1,
    cancelId: buttons.length - 1,
  })
  const choice = buttons[response]
  if (choice.startsWith('Move')) {
    const kept = ownerKeptPaths(ctx.config)
    for (const p of empty) {
      if (touchesKeptPath(p.file, kept)) continue
      for (const f of [p.file, `${p.file}-wal`, `${p.file}-shm`])
        if (fs.existsSync(f)) await shell.trashItem(f).catch(() => {})
      ctx.removeFromRecentProjects(p.file)
    }
    logMain('untitled cleanup', { trashed: empty.length })
  } else if (choice === 'Show in Folder') {
    shell.openPath(dir)
  }
  return done()
}

/**
 * Find clips › Add to project, last step (TransferManager): the clips' games
 * are in the project; add the clips as rows of its "Lunar Database clips"
 * result (created at the end of the chain the first time), skip ones already
 * there, and open it.
 */
export async function addLunarClips(
  ctx: Ctx,
  projectPath: string,
  clips: LunarClip[],
  pathByReplayId: Record<string, string>,
): Promise<{ added: number; unavailable: number }> {
  const archive = ctx.archive
  if (!archive || archive.path !== projectPath || !archive.addFilter)
    throw new Error('Open the project to add the clips.')
  // Each game's own players (colours, nametags), as the parsers use them.
  const playersByPath = new Map<string, PlayerInterface[] | undefined>()
  for (const p of new Set(Object.values(pathByReplayId))) {
    const row = (await getFileByPathAsync(projectPath, p)) as {
      players?: string | PlayerInterface[]
    } | null
    let players: PlayerInterface[] | undefined
    try {
      players =
        typeof row?.players === 'string'
          ? JSON.parse(row.players)
          : row?.players
    } catch {
      players = undefined
    }
    playersByPath.set(p, players)
  }
  let filter = archive.filters.find((f) => f.type === 'lunarClips')
  if (!filter) {
    const json = buildFilterJSON(
      'lunarClips',
      new Set(archive.filters.map((f) => f.id)),
    )
    json.isProcessed = true
    await archive.addFilter(json)
    filter = archive.filters.find((f) => f.id === json.id)!
  }
  const already = new Set(await getLunarClipIdsAsync(projectPath, filter.id))
  const seen = new Set<string>()
  let unavailable = 0
  const rows: string[] = []
  for (const c of clips) {
    const p = pathByReplayId[c.replayId]
    if (!p) {
      unavailable++
      continue
    }
    if (already.has(c.id) || seen.has(c.id)) continue
    seen.add(c.id)
    rows.push(JSON.stringify(clipToInterface(c, p, playersByPath.get(p))))
  }
  await insertFilterRowsAsync(projectPath, filter.id, rows)
  filter.isProcessed = true
  filter.results = await getFilterCountAsync(projectPath, filter.id)
  await archive.saveMetaData?.()
  if (!ctx.mainWindow.isDestroyed()) {
    ctx.mainWindow.webContents.send(
      'archiveUpdated',
      buildShallowArchive(ctx.archive),
    )
    ctx.mainWindow.webContents.send('selectFilter', filter.id)
  }
  return { added: rows.length, unavailable }
}

/** Settings › Detector cache: its size, or clear it. */
export async function detectorCache(
  ctx: Ctx,
  event: IpcMainEvent,
  data?: RequestEnvelope<{ action: 'stats' | 'clear' }>,
) {
  const { requestId, payload } = unpackRequest<{ action: 'stats' | 'clear' }>(
    data,
  )
  const folder = ctx.library().folder
  try {
    if (payload?.action === 'clear') {
      if (ctx.filterExecutor.runningFilterIds.size > 0)
        return reply(event, 'detectorCache', requestId, {
          error: 'Stop running filters first.',
          stats: await libraryCall('libraryDetectionStats', folder),
        })
      await libraryCall('libraryDetectionClear', folder)
    }
    const stats = fs.existsSync(path.join(folder, 'library.sqlite'))
      ? await libraryCall('libraryDetectionStats', folder)
      : { entries: 0, bytes: 0 }
    return reply(event, 'detectorCache', requestId, { stats })
  } catch (error) {
    return reply(event, 'detectorCache', requestId, {
      error: (error as Error).message,
    })
  }
}

/** File › Extract Replays…: progress shows in the Lunar Database panel's
 *  Transfers view, which opens when an extraction starts. */
export async function extractReplays(ctx: Ctx, kind: 'files' | 'folder') {
  try {
    const started = await ctx.transferManager.extractFromMenu(kind)
    if (started && !ctx.mainWindow.isDestroyed())
      ctx.mainWindow.webContents.send('openLunarDatabase', 'transfers')
  } catch (error) {
    askDialog(ctx.mainWindow, {
      type: 'error',
      title: 'Extract replays',
      message: 'Couldn’t start the extraction.',
      detail: (error as Error).message,
    })
  }
}

/** A failed file operation in words where we know them, else the error's own text. */
function friendlyFsMessage(error: unknown, folder: string): string {
  return (
    describeFileSystemError(error, folder)?.message ??
    (error as Error)?.message ??
    String(error)
  )
}
