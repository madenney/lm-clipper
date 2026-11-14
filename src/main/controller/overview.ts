import { IpcMainEvent } from 'electron'
import type { ControllerCore } from './context'
import {
  getOverviewChunkAsync,
  getOverviewSignatureAsync,
  getOverviewChunkBackground,
  getOverviewSignatureBackground,
} from '../dbAsync'
import {
  CACHE_MIN_ROWS,
  OverviewCacheWriter,
  cachedCount,
  cachedOverview,
  readCachedChunk,
} from '../overviewCache'
import type { OverviewChunk, OverviewCursor } from '../overview'
import { unpackRequest, reply } from '../ipcUtils'

/** Rows per IPC message when streaming the overview from the disk cache. */
const CACHED_CHUNK = 1_000_000
/** Rows per read when warming the overview cache in the background. */
const WARM_CHUNK = 250_000

export default class OverviewService {
  /** Overview reads in progress, saving to the disk cache as they go. */
  private overviewWriters = new Map<string, OverviewCacheWriter>()

  /** The overview cache being warmed in the background (one at a time). */
  private overviewWarm: { key: string; cancelled: boolean } | null = null

  private ctx: Pick<ControllerCore, 'archive'>

  constructor(ctx: Pick<ControllerCore, 'archive'>) {
    this.ctx = ctx
  }

  /**
   * The tray's overview (docs/tray-v2.md): the next chunk of every row's id,
   * stage and characters, for the far-out GPU view. The renderer pulls chunks.
   * A fresh read (no cursor) is served from the disk cache when the table still
   * matches its fingerprint; otherwise it reads SQLite and saves as it goes.
   */
  async handleOverviewChunk(event: IpcMainEvent, data: unknown) {
    const { requestId, payload } = unpackRequest<{
      filterId: string
      cursor: { key: number; id: number; cached?: boolean } | null
      limit: number
    }>(data)
    try {
      if (!this.ctx.archive) throw new Error('No project open.')
      const p = payload
      if (!p || typeof p.filterId !== 'string') throw new Error('No filter.')
      const projectPath = this.ctx.archive.path
      const { filterId } = p
      const cursor =
        p.cursor &&
        Number.isFinite(p.cursor.key) &&
        Number.isFinite(p.cursor.id)
          ? {
              key: p.cursor.key,
              id: p.cursor.id,
              cached: p.cursor.cached === true,
            }
          : null
      const limit = Math.max(1, Math.min(Number(p.limit) || 250_000, 1_000_000))
      const key = `${projectPath}|${filterId}`

      // Following on from the disk cache: position = cursor.id.
      if (cursor?.cached) {
        const count = await cachedCount(projectPath, filterId)
        if (count == null) throw new Error('The overview cache went away.')
        const chunk = await readCachedChunk(
          projectPath,
          filterId,
          cursor.id,
          CACHED_CHUNK,
          count,
        )
        const pos = cursor.id + chunk.ids.length
        reply(event, 'getOverviewChunk', requestId, {
          ...chunk,
          next: pos < count ? { key: 0, id: pos, cached: true } : null,
        })
        return
      }
      if (!cursor) {
        // The tray reads it now: a background warm-up of the same table stops.
        if (this.overviewWarm?.key === key) this.overviewWarm.cancelled = true
        await this.overviewWriters.get(key)?.discard()
        this.overviewWriters.delete(key)
        // The fingerprint plus the result count (removals in the middle of a
        // table don't touch its first or last row). An unknown count (still
        // loading) means no cache this time.
        const count =
          filterId === 'files'
            ? this.ctx.archive.files
            : this.ctx.archive.filters.find((f) => f.id === filterId)?.results
        if (count != null) {
          const signature = `${await getOverviewSignatureAsync(projectPath, filterId)}:${count}`
          const meta = await cachedOverview(
            projectPath,
            filterId,
            signature,
            count,
          )
          if (meta) {
            const chunk = await readCachedChunk(
              projectPath,
              filterId,
              0,
              CACHED_CHUNK,
              meta.count,
            )
            reply(event, 'getOverviewChunk', requestId, {
              ...chunk,
              next:
                chunk.ids.length < meta.count
                  ? { key: 0, id: chunk.ids.length, cached: true }
                  : null,
            })
            return
          }
          this.overviewWriters.set(
            key,
            new OverviewCacheWriter(projectPath, filterId, signature, count),
          )
        }
      } else {
        // Only the read that started the writer, chunk after chunk, is saved:
        // a chunk asked for again (the renderer gave up waiting) or a stale
        // read of an older version would put rows in twice.
        const writer = this.overviewWriters.get(key)
        if (writer && !writer.follows(cursor)) {
          this.overviewWriters.delete(key)
          await writer.discard()
        }
      }
      const chunk = await getOverviewChunkAsync(
        projectPath,
        filterId,
        cursor ? { key: cursor.key, id: cursor.id } : null,
        limit,
      )
      const writer = this.overviewWriters.get(key)
      if (writer && writer.follows(cursor)) {
        writer.append(chunk.ids, chunk.packed, chunk.next)
        if (!chunk.next) {
          this.overviewWriters.delete(key)
          writer
            .finish()
            .catch((err) => console.warn('[overview] cache not saved:', err))
        }
      }
      reply(event, 'getOverviewChunk', requestId, chunk)
    } catch (err) {
      reply(event, 'getOverviewChunk', requestId, {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Save a big table's overview to the disk cache in the background (after a
   * filter run), so the first zoom below 120 px streams it from disk instead of
   * reading SQLite for seconds. Reads on the background lane (dbAsync.ts), not
   * DbWorker; stops when the tray starts reading the same table itself, another
   * warm-up starts, or the project changes.
   */
  async warmOverview(filterId: string) {
    const archive = this.ctx.archive
    if (!archive) return
    const count =
      filterId === 'files'
        ? archive.files
        : archive.filters.find((f) => f.id === filterId)?.results
    if (count == null || count < CACHE_MIN_ROWS) return
    const projectPath = archive.path
    const key = `${projectPath}|${filterId}`
    if (this.overviewWriters.has(key)) return // the tray is reading it
    if (this.overviewWarm) this.overviewWarm.cancelled = true
    const warm = { key, cancelled: false }
    this.overviewWarm = warm
    const stopped = () =>
      warm.cancelled ||
      this.ctx.archive?.path !== projectPath ||
      this.overviewWriters.has(key)
    let writer: OverviewCacheWriter | null = null
    try {
      const signature = `${await getOverviewSignatureBackground(projectPath, filterId)}:${count}`
      if (await cachedOverview(projectPath, filterId, signature, count)) return
      writer = new OverviewCacheWriter(projectPath, filterId, signature, count)
      let cursor: OverviewCursor = null
      for (;;) {
        if (stopped()) return
        // eslint-disable-next-line no-await-in-loop
        const chunk: OverviewChunk = await getOverviewChunkBackground(
          projectPath,
          filterId,
          cursor,
          WARM_CHUNK,
        )
        if (stopped()) return
        writer.append(chunk.ids, chunk.packed, chunk.next)
        if (!chunk.next) break
        cursor = chunk.next
      }
      const done = writer
      writer = null
      await done.finish()
    } catch (err) {
      console.warn('[overview] warm-up stopped:', err)
    } finally {
      if (writer) await writer.discard()
      if (this.overviewWarm === warm) this.overviewWarm = null
    }
  }
}
