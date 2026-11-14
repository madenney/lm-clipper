import fs from 'fs'
import path from 'path'
import { BrowserWindow, IpcMainEvent } from 'electron'
import {
  invalidateOverview,
  invalidateProjectOverviews,
} from '../overviewCache'
import { ArchiveInterface } from '../../constants/types'
import Archive from '../../models/Archive'
import { validateTableId } from '../db'
import {
  getMetaData,
  deleteRowsAsync,
  updateSortOrderAsync,
  selectionIdsAsync,
  getGameFilterRowInfo,
  libraryCall,
  removeGamesAsync,
  removeGamesFromProjectFileAsync,
  removeResultsCascadeAsync,
} from '../dbAsync'
import { Selection, type SelectionWire } from '../../lib/selection'
import {
  RequestEnvelope,
  unpackRequest,
  reply,
  buildShallowArchive,
} from '../ipcUtils'

/** Rows per statement: SQLite allows at most ~32k bound values. */
const CHUNK = 5000

/**
 * The row ids a removal names: a plain list, or a tray selection (lib/selection.ts)
 * resolved here, so Select All on millions of rows never crosses IPC as ids.
 */
async function idsToRemove(
  archivePath: string,
  tableId: string,
  ids: number[] | undefined,
  selection: SelectionWire | undefined,
): Promise<number[]> {
  if (!selection) return ids ?? []
  const sel = Selection.fromWire(selection)
  const explicit = sel.explicitIds()
  if (explicit) return explicit
  return Array.from(await selectionIdsAsync(archivePath, tableId, selection))
}

const samePath = (a: string, b: string) => path.resolve(a) === path.resolve(b)

/**
 * Removing games (docs/library-workspaces.md): from the Replays tray they go
 * from the project, from every step's results, from the replay library's index
 * and from My Replays. The replay files are never deleted or moved, wherever
 * they are (also the ones downloaded into the library folder).
 */
export type RemoveGamesOptions = {
  /** Also forget them in the replay library and My Replays (the Replays tray). */
  everywhere?: boolean
}

export default class ClipManager {
  private mainWindow: BrowserWindow
  private getArchive: () => ArchiveInterface | null
  private setArchive: (_archive: ArchiveInterface | null) => void
  private getLibraryFolder: () => string | null
  private getMyReplaysPath: () => string | null

  constructor(
    mainWindow: BrowserWindow,
    deps: {
      getArchive: () => ArchiveInterface | null
      setArchive: (_archive: ArchiveInterface | null) => void
      getLibraryFolder?: () => string | null
      getMyReplaysPath?: () => string | null
    },
  ) {
    this.mainWindow = mainWindow
    this.getArchive = deps.getArchive
    this.setArchive = deps.setArchive
    this.getLibraryFolder = deps.getLibraryFolder ?? (() => null)
    this.getMyReplaysPath = deps.getMyReplaysPath ?? (() => null)
  }

  /** The games a Replays-tray removal names: file ids, from the files table or
   *  the game filter's own rows (whose JSON names the file). */
  private async gamesFor(
    archive: ArchiveInterface,
    tableId: string,
    ids: number[] | undefined,
    selection: SelectionWire | undefined,
    filesTable: boolean,
  ): Promise<{ fileIds: number[]; rowIds: number[] }> {
    const rowIds = await idsToRemove(archive.path, tableId, ids, selection)
    if (filesTable) return { fileIds: rowIds, rowIds: [] }
    const fileIds = new Set<number>()
    for (let i = 0; i < rowIds.length; i += CHUNK) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await getGameFilterRowInfo(
        archive.path,
        tableId,
        rowIds.slice(i, i + CHUNK),
      )
      for (const r of rows) if (r.fileId > 0) fileIds.add(r.fileId)
    }
    return { fileIds: [...fileIds], rowIds }
  }

  /** How many replays a Replays-tray removal would delete (for its warning). */
  async previewRemoveGames(
    event: IpcMainEvent,
    data: RequestEnvelope<{
      filterId: string
      ids?: number[]
      selection?: SelectionWire
    }>,
  ) {
    const { requestId, payload } = unpackRequest<{
      filterId: string
      ids?: number[]
      selection?: SelectionWire
    }>(data)
    const archive = this.getArchive()
    if (!archive || !payload?.filterId || (!payload.ids && !payload.selection))
      return reply(event, 'previewRemoveGames', requestId, {
        error: 'invalid request',
      })
    try {
      if (payload.filterId !== 'files') validateTableId(payload.filterId)
      // 'files': the unprocessed Replays step reads the files table itself.
      const filesTable = payload.filterId === 'files'
      const { fileIds, rowIds } = await this.gamesFor(
        archive,
        payload.filterId,
        payload.ids,
        payload.selection,
        filesTable,
      )
      return reply(event, 'previewRemoveGames', requestId, {
        games: filesTable ? fileIds.length : rowIds.length,
      })
    } catch (error: any) {
      console.error('[previewRemoveGames] error:', error)
      return reply(event, 'previewRemoveGames', requestId, {
        error: error.message,
      })
    }
  }

  async removeGame(
    event: IpcMainEvent,
    data: RequestEnvelope<{ fileIds?: number[]; selection?: SelectionWire }>,
  ) {
    const { requestId, payload } = unpackRequest<{
      fileIds?: number[]
      selection?: SelectionWire
    }>(data)
    const archive = this.getArchive()
    if (!archive || (!payload?.fileIds?.length && !payload?.selection)) {
      return reply(event, 'removeGame', requestId, { error: 'invalid request' })
    }
    try {
      const fileIds = await idsToRemove(
        archive.path,
        'files',
        payload.fileIds,
        payload.selection,
      )
      const removed = fileIds.length
        ? await this.removeGames(fileIds, { everywhere: true })
        : 0
      return reply(event, 'removeGame', requestId, { removed })
    } catch (error: any) {
      console.error('[removeGame] error:', error)
      return reply(event, 'removeGame', requestId, { error: error.message })
    }
  }

  /**
   * Remove games and every row made from them in every step, then refresh the
   * project. In chunks: SQLite allows at most ~32k bound values per statement.
   * `everywhere`: also from the replay library's index and My Replays. Files
   * on disk are never touched.
   */
  async removeGames(
    fileIds: number[],
    opts: RemoveGamesOptions = {},
  ): Promise<number> {
    const archive = this.getArchive()
    if (!archive) throw new Error('No project open.')
    await this.removeGamesFrom(archive, fileIds, opts)
    await this.refresh(archive.path)
    return fileIds.length
  }

  private async removeGamesFrom(
    archive: ArchiveInterface,
    fileIds: number[],
    opts: RemoveGamesOptions,
  ) {
    const archivePath = archive.path
    const filterIds = archive.filters.map((f) => f.id)
    // Removed games disappear from every filter: the cached overviews are stale.
    await invalidateProjectOverviews(archivePath)
    const library = opts.everywhere ? this.getLibraryFolder() : null
    const myReplays = opts.everywhere ? this.getMyReplaysPath() : null
    const otherProject =
      myReplays && !samePath(myReplays, archivePath) && fs.existsSync(myReplays)
        ? myReplays
        : null
    if (otherProject) await invalidateProjectOverviews(otherProject)
    for (let i = 0; i < fileIds.length; i += CHUNK) {
      // eslint-disable-next-line no-await-in-loop
      const paths = await removeGamesAsync(
        archivePath,
        fileIds.slice(i, i + CHUNK),
        filterIds,
      )
      if (paths.length === 0) continue
      if (library) {
        // eslint-disable-next-line no-await-in-loop
        await libraryCall('libraryForget', library, paths)
      }
      if (otherProject) {
        // eslint-disable-next-line no-await-in-loop
        await removeGamesFromProjectFileAsync(otherProject, paths)
      }
    }
    if (otherProject) await invalidateProjectOverviews(otherProject)
  }

  /** Read the project's counts again and send it to the renderer. */
  private async refresh(archivePath: string) {
    await invalidateProjectOverviews(archivePath)
    const metadata = await getMetaData(archivePath)
    const newArchive = new Archive(metadata)
    this.setArchive(newArchive)
    this.mainWindow.webContents.send(
      'archiveUpdated',
      buildShallowArchive(newArchive as any),
    )
  }

  /**
   * Remove rows from a step's tray. The Replays step (a game filter): the games
   * go (as removeGames, everywhere). Any other step: only those results, and
   * what the steps after it made from them; no replay is touched.
   */
  async removeResult(
    event: IpcMainEvent,
    data: RequestEnvelope<{
      filterId: string
      rowIds?: number[]
      selection?: SelectionWire
    }>,
  ) {
    const { requestId, payload } = unpackRequest<{
      filterId: string
      rowIds?: number[]
      selection?: SelectionWire
    }>(data)
    const archive = this.getArchive()
    if (
      !archive ||
      !payload?.filterId ||
      (!payload?.rowIds?.length && !payload?.selection)
    ) {
      return reply(event, 'removeResult', requestId, {
        error: 'invalid request',
      })
    }
    try {
      const archivePath = archive.path
      validateTableId(payload.filterId)
      const index = archive.filters.findIndex((f) => f.id === payload.filterId)
      const filter = index >= 0 ? archive.filters[index] : undefined
      let removed = 0
      if (filter?.type === 'files') {
        const { fileIds, rowIds } = await this.gamesFor(
          archive,
          payload.filterId,
          payload.rowIds,
          payload.selection,
          false,
        )
        await this.removeGamesFrom(archive, fileIds, { everywhere: true })
        // Rows naming no game in the project (gone already): just the rows.
        for (let i = 0; i < rowIds.length; i += CHUNK) {
          // eslint-disable-next-line no-await-in-loop
          await deleteRowsAsync(
            archivePath,
            payload.filterId,
            rowIds.slice(i, i + CHUNK),
          )
        }
        removed = rowIds.length
      } else {
        const rowIds = await idsToRemove(
          archivePath,
          payload.filterId,
          payload.rowIds,
          payload.selection,
        )
        // Stale from the first statement on (an overview read meanwhile must
        // not be served from it); refresh drops any saved since.
        await invalidateProjectOverviews(archivePath)
        const downstream =
          index >= 0
            ? archive.filters
                .slice(index + 1)
                .map((f) => ({ id: f.id, type: f.type }))
            : []
        const counts = await removeResultsCascadeAsync(
          archivePath,
          payload.filterId,
          rowIds,
          downstream,
        )
        removed = counts[payload.filterId] ?? 0
      }
      await this.refresh(archivePath)
      return reply(event, 'removeResult', requestId, { removed })
    } catch (error: any) {
      console.error('[removeResult] error:', error)
      return reply(event, 'removeResult', requestId, { error: error.message })
    }
  }

  async reorderClips(
    event: IpcMainEvent,
    data: RequestEnvelope<{
      filterId: string
      updates: { id: number; sort_order: number }[]
    }>,
  ) {
    const { requestId, payload } = unpackRequest<{
      filterId: string
      updates: { id: number; sort_order: number }[]
    }>(data)
    const archive = this.getArchive()
    if (!archive || !payload?.filterId || !payload?.updates?.length) {
      return reply(event, 'reorderClips', requestId, {
        error: 'invalid request',
      })
    }
    try {
      await updateSortOrderAsync(
        archive.path,
        payload.filterId,
        payload.updates,
      )
      // The tray's cached overview has the old order.
      await invalidateOverview(archive.path, payload.filterId)
      return reply(event, 'reorderClips', requestId, { success: true })
    } catch (error: any) {
      console.error('[reorderClips] error:', error)
      return reply(event, 'reorderClips', requestId, { error: error.message })
    }
  }
}
