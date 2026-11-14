import { IpcMainEvent } from 'electron'
import type { ControllerCore } from './context'
import { isStaleRead } from '../readLane'
import {
  getTableCountAsync,
  getFilterCountAsync,
  getTableDurationAsync,
  selectionFramesAsync,
} from '../dbAsync'
import {
  RequestEnvelope,
  unpackRequest,
  reply,
  buildShallowArchive,
} from '../ipcUtils'
import type { SelectionWire } from '../../lib/selection'

export type Ctx = Pick<
  ControllerCore,
  'archive' | 'ensureNameCountWorker' | 'mainWindow'
>

export async function getResults(
  ctx: Ctx,
  event: IpcMainEvent,
  data: RequestEnvelope<{
    filterId: string
    currentPage?: number
    numPerPage?: number
    offset?: number
    limit?: number
    lite?: boolean
    lane?: string
  }>,
) {
  const { requestId, payload } = unpackRequest<{
    filterId: string
    currentPage?: number
    numPerPage?: number
    offset?: number
    limit?: number
    lite?: boolean
    lane?: string
  }>(data)
  if (!ctx.archive || !ctx.archive.getItems || !payload) {
    return reply(event, 'getResults', requestId, { items: [], total: 0 })
  }
  const { filterId, numPerPage, currentPage, offset, limit, lite, lane } =
    payload
  console.log('Selected filter: ', filterId)

  try {
    // Use the already-known cached count instead of a fresh COUNT(*). On a
    // 48M-row table that scan is ~30s and was running on EVERY page fetch,
    // blocking the whole tray. The count is already in the in-memory archive
    // (hydrated on open); only fall back to a live count if it's unknown.
    const cachedTotal =
      filterId === 'files'
        ? ctx.archive.files
        : ctx.archive.filters.find((f) => f.id === filterId)?.results
    const [items, total] = await Promise.all([
      ctx.archive.getItems({
        filterId,
        numPerPage,
        currentPage,
        offset,
        limit,
        lite,
        lane,
      }),
      typeof cachedTotal === 'number'
        ? Promise.resolve(cachedTotal)
        : getTableCountAsync(ctx.archive.path, filterId),
    ])
    // A window shorter than asked for reaches the table's end. A cached
    // count past that end is stale (a project saved by a build whose deletes
    // didn't lower it): the tray would draw placeholder tiles for rows that
    // aren't there, for good. Count again (every table: the same delete left
    // the other steps' counts stale too), save and tell the renderer.
    if (
      typeof offset === 'number' &&
      typeof limit === 'number' &&
      Array.isArray(items) &&
      items.length < limit &&
      typeof cachedTotal === 'number' &&
      cachedTotal > offset + items.length
    ) {
      const count = await recountStaleTotals(ctx, filterId)
      return reply(event, 'getResults', requestId, { items, total: count })
    }
    reply(event, 'getResults', requestId, { items, total })
  } catch (error) {
    // A newer read on the same lane (the tray scrolled or zoomed on): the
    // renderer ignores this reply.
    if (isStaleRead(error)) {
      return reply(event, 'getResults', requestId, {
        items: [],
        total: 0,
        stale: true,
      })
    }
    console.error('Error fetching results:', error)
    reply(event, 'getResults', requestId, { items: [], total: 0 })
  }
}

/** A tray selection's length in frames and its row count (lib/selection.ts). */
export async function getSelectionDuration(
  ctx: Ctx,
  event: IpcMainEvent,
  data: RequestEnvelope<{ filterId: string; selection: SelectionWire }>,
) {
  const { requestId, payload } = unpackRequest<{
    filterId: string
    selection: SelectionWire
  }>(data)
  if (!ctx.archive || !payload?.filterId || !payload.selection) {
    return reply(event, 'getSelectionDuration', requestId, {
      error: 'invalid request',
    })
  }
  try {
    const result = await selectionFramesAsync(
      ctx.archive.path,
      payload.filterId,
      payload.selection,
    )
    return reply(event, 'getSelectionDuration', requestId, result)
  } catch (error) {
    // A newer selection's length was asked for: the tray ignores this one.
    if (isStaleRead(error))
      return reply(event, 'getSelectionDuration', requestId, { stale: true })
    console.error('[getSelectionDuration] error:', error)
    return reply(event, 'getSelectionDuration', requestId, {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function getTableDuration(
  ctx: Ctx,
  event: IpcMainEvent,
  data: RequestEnvelope<{ filterId: string }>,
) {
  const { requestId, payload } = unpackRequest<{ filterId: string }>(data)
  if (!ctx.archive || !payload?.filterId) {
    return reply(event, 'getTableDuration', requestId, 0)
  }
  try {
    const total = await getTableDurationAsync(
      ctx.archive.path,
      payload.filterId,
    )
    return reply(event, 'getTableDuration', requestId, total)
  } catch (error) {
    if (isStaleRead(error))
      return reply(event, 'getTableDuration', requestId, null)
    console.error('[getTableDuration] error:', error)
    return reply(event, 'getTableDuration', requestId, 0)
  }
}

/**
 * Count every table of the project again (getFilterCountAsync saves each in
 * the metadata cache), patch the archive and send it; returns `filterId`'s.
 */
export async function recountStaleTotals(
  ctx: Ctx,
  filterId: string,
): Promise<number> {
  const archive = ctx.archive
  if (!archive) return 0
  const tables = ['files', ...archive.filters.map((f) => f.id)]
  const counts = new Map<string, number>()
  for (const id of tables) {
    try {
      // eslint-disable-next-line no-await-in-loop
      counts.set(id, await getFilterCountAsync(archive.path, id))
    } catch (err) {
      console.warn('[getResults] recount failed for', id, err)
    }
  }
  if (ctx.archive !== archive) return counts.get(filterId) ?? 0
  let changed = false
  const files = counts.get('files')
  if (files !== undefined && archive.files !== files) {
    archive.files = files
    changed = true
  }
  for (const f of archive.filters) {
    const n = counts.get(f.id)
    if (n !== undefined && f.results !== n) {
      f.results = n
      changed = true
    }
  }
  if (changed && !ctx.mainWindow.isDestroyed()) {
    console.log('[getResults] stale cached counts corrected')
    ctx.mainWindow.webContents.send(
      'archiveUpdated',
      buildShallowArchive(archive),
    )
  }
  return counts.get(filterId) ?? 0
}

// Lazy count hydration: the renderer calls this per-filter after a project
// opens to fill in the result counts that getMetadata intentionally left null
// (so open never blocks on a full-table COUNT(*)). Runs in the DbWorker thread
// and caches the result for instant subsequent opens.
export async function getFilterCount(
  ctx: Ctx,
  event: IpcMainEvent,
  data: RequestEnvelope<{ filterId: string }>,
) {
  const { requestId, payload } = unpackRequest<{ filterId: string }>(data)
  if (!ctx.archive || !payload?.filterId) {
    return reply(event, 'getFilterCount', requestId, {
      filterId: payload?.filterId,
      count: 0,
    })
  }
  try {
    const count = await getFilterCountAsync(ctx.archive.path, payload.filterId)
    // Keep the in-memory archive's count in sync so getResults can use it
    // instead of a fresh COUNT(*) on subsequent fetches.
    if (ctx.archive) {
      if (payload.filterId === 'files') {
        ctx.archive.files = count
      } else {
        const f = ctx.archive.filters.find((x) => x.id === payload.filterId)
        if (f) f.results = count
      }
    }
    return reply(event, 'getFilterCount', requestId, {
      filterId: payload.filterId,
      count,
    })
  } catch (error) {
    console.error('[getFilterCount] error:', error)
    return reply(event, 'getFilterCount', requestId, {
      filterId: payload.filterId,
      count: 0,
    })
  }
}

export async function getNames(
  ctx: Ctx,
  event: IpcMainEvent,
  data?: RequestEnvelope<null>,
) {
  const { requestId } = unpackRequest<null>(data)
  if (!ctx.archive) return reply(event, 'getNames', requestId, [])

  try {
    const worker = ctx.ensureNameCountWorker()
    const t0 = Date.now()
    const result = await new Promise<{ name: string; total: number }[]>(
      (resolve, reject) => {
        const handler = (msg: any) => {
          if (msg.type === 'names') {
            worker.off('message', handler)
            resolve(msg.data)
          } else if (msg.type === 'error') {
            worker.off('message', handler)
            reject(new Error(msg.error))
          }
        }
        worker.on('message', handler)
        worker.postMessage({ type: 'getNames' })
      },
    )
    console.log(
      `[perf] getNames: ${Date.now() - t0}ms (${result.length} names)`,
    )
    return reply(event, 'getNames', requestId, result)
  } catch (error) {
    console.error('[NameCountWorker] getNames error:', error)
    return reply(event, 'getNames', requestId, [])
  }
}

export async function getConnectCodes(
  ctx: Ctx,
  event: IpcMainEvent,
  data?: RequestEnvelope<null>,
) {
  const { requestId } = unpackRequest<null>(data)
  if (!ctx.archive) return reply(event, 'getConnectCodes', requestId, [])

  try {
    const worker = ctx.ensureNameCountWorker()
    const t0 = Date.now()
    const result = await new Promise<{ name: string; total: number }[]>(
      (resolve, reject) => {
        const handler = (msg: any) => {
          if (msg.type === 'connectCodes') {
            worker.off('message', handler)
            resolve(msg.data)
          } else if (msg.type === 'error') {
            worker.off('message', handler)
            reject(new Error(msg.error))
          }
        }
        worker.on('message', handler)
        worker.postMessage({ type: 'getConnectCodes' })
      },
    )
    console.log(
      `[perf] getConnectCodes: ${Date.now() - t0}ms (${result.length} codes)`,
    )
    return reply(event, 'getConnectCodes', requestId, result)
  } catch (error) {
    console.error('[NameCountWorker] getConnectCodes error:', error)
    return reply(event, 'getConnectCodes', requestId, [])
  }
}
