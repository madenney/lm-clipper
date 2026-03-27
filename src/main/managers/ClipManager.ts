import { BrowserWindow, IpcMainEvent } from 'electron'
import { ArchiveInterface } from '../../constants/types'
import Archive from '../../models/Archive'
import { getMetaData, validateTableId } from '../db'
import {
  deleteRowsByFilePathsAsync,
  deleteFilesAsync,
  getFilePathsByIdsAsync,
  deleteRowsAsync,
  updateSortOrderAsync,
} from '../dbAsync'
import {
  RequestEnvelope,
  unpackRequest,
  reply,
  buildShallowArchive,
} from '../ipcUtils'

export default class ClipManager {
  private mainWindow: BrowserWindow
  private getArchive: () => ArchiveInterface | null
  private setArchive: (_archive: ArchiveInterface | null) => void

  constructor(
    mainWindow: BrowserWindow,
    deps: {
      getArchive: () => ArchiveInterface | null
      setArchive: (_archive: ArchiveInterface | null) => void
    },
  ) {
    this.mainWindow = mainWindow
    this.getArchive = deps.getArchive
    this.setArchive = deps.setArchive
  }

  async removeGame(
    event: IpcMainEvent,
    data: RequestEnvelope<{ fileIds: number[] }>,
  ) {
    const { requestId, payload } = unpackRequest<{ fileIds: number[] }>(data)
    const archive = this.getArchive()
    if (!archive || !payload?.fileIds?.length) {
      return reply(event, 'removeGame', requestId, { error: 'invalid request' })
    }
    try {
      const archivePath = archive.path
      const filePaths = await getFilePathsByIdsAsync(
        archivePath,
        payload.fileIds,
      )
      await deleteFilesAsync(archivePath, payload.fileIds)

      if (filePaths.length > 0) {
        await Promise.all(
          archive.filters.map((f) =>
            deleteRowsByFilePathsAsync(archivePath, f.id, filePaths),
          ),
        )
      }

      const metadata = await getMetaData(archivePath)
      const newArchive = new Archive(metadata)
      this.setArchive(newArchive)

      this.mainWindow.webContents.send(
        'archiveUpdated',
        buildShallowArchive(newArchive as any),
      )
      return reply(event, 'removeGame', requestId, {
        removed: payload.fileIds.length,
      })
    } catch (error: any) {
      console.error('[removeGame] error:', error)
      return reply(event, 'removeGame', requestId, { error: error.message })
    }
  }

  async removeResult(
    event: IpcMainEvent,
    data: RequestEnvelope<{ filterId: string; rowIds: number[] }>,
  ) {
    const { requestId, payload } = unpackRequest<{
      filterId: string
      rowIds: number[]
    }>(data)
    const archive = this.getArchive()
    if (!archive || !payload?.filterId || !payload?.rowIds?.length) {
      return reply(event, 'removeResult', requestId, {
        error: 'invalid request',
      })
    }
    try {
      const archivePath = archive.path
      validateTableId(payload.filterId)
      const filter = archive.filters.find((f) => f.id === payload.filterId)

      if (filter?.type === 'files') {
        const { getGameFilterRowInfo } = await import('../dbAsync')
        const rows = await getGameFilterRowInfo(
          archivePath,
          payload.filterId,
          payload.rowIds,
        )
        const fileIds = rows
          .map((r: any) => r.fileId)
          .filter((id: number) => id > 0)
        const filePaths = rows
          .map((r: any) => r.filePath)
          .filter((p: string) => p && p.length > 0)
        if (fileIds.length > 0) {
          await deleteFilesAsync(archivePath, fileIds)
        }
        if (filePaths.length > 0) {
          await Promise.all(
            archive.filters
              .filter((f) => f.id !== payload.filterId)
              .map((f) =>
                deleteRowsByFilePathsAsync(archivePath, f.id, filePaths),
              ),
          )
        }
      }

      await deleteRowsAsync(archivePath, payload.filterId, payload.rowIds)

      const metadata = await getMetaData(archivePath)
      const newArchive = new Archive(metadata)
      this.setArchive(newArchive)

      this.mainWindow.webContents.send(
        'archiveUpdated',
        buildShallowArchive(newArchive as any),
      )
      return reply(event, 'removeResult', requestId, {
        removed: payload.rowIds.length,
      })
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
      return reply(event, 'reorderClips', requestId, { success: true })
    } catch (error: any) {
      console.error('[reorderClips] error:', error)
      return reply(event, 'reorderClips', requestId, { error: error.message })
    }
  }
}
