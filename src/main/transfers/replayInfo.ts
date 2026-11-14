import { DatabaseRequestError } from '../databaseClient'
import { libraryReplayIdForPath } from '../replayLibrary'
import { parseReplayInfo, type ReplayInfo } from '../../constants/replayInfo'
import type { TransferContext } from './context'

/** The database's record + stats for a replay (null: not linked to it). */
export async function replayInfo(
  ctx: TransferContext,
  cache: Map<string, ReplayInfo | null>,

  replayId?: string,
  filePath?: string,
): Promise<ReplayInfo | null> {
  let id = replayId ?? null
  if (!id && filePath) {
    try {
      id = libraryReplayIdForPath(ctx.deps.getLibrary().folder, filePath)
    } catch {
      id = null
    }
  }
  if (!id) return null
  if (cache.has(id)) return cache.get(id)!
  const notFound = (err: unknown) => {
    if (
      err instanceof DatabaseRequestError &&
      (err.status === 404 || err.status === 400)
    )
      return null
    throw err
  }
  const [replay, stats] = await Promise.all([
    ctx.client.json(`/api/getReplay?id=${id}`).catch(notFound),
    // Stats are extra: a game without them (or a hiccup) still shows its record.
    ctx.client.json(`/api/gameStats?id=${id}`).catch(() => null),
  ])
  const info = replay ? parseReplayInfo(id, replay, stats) : null
  cache.set(id, info)
  if (cache.size > 50) cache.delete(cache.keys().next().value as string)
  return info
}
