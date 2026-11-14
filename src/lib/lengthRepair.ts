/**
 * The renderer's side of the background game-length repair
 * (main/LastFrameScanWorker.ts): when lengths it holds (the tray's Select All
 * total, its loaded rows) are out of date. Kept apart from lib/lastFrame.ts,
 * which reads replays (fs, slippi-js) and doesn't belong in the renderer.
 */
import type { LastFrameScanStatus } from './lastFrame'

const isActive = (s: LastFrameScanStatus | null | undefined) =>
  s?.state === 'running' || s?.state === 'paused'

const changed = (s: LastFrameScanStatus | null | undefined) =>
  (s?.repaired ?? 0) + (s?.resultsRows ?? 0)

/**
 * What a new repair status means: 'progress' when more games got their
 * length, 'ended' when the repair stopped, finished or its project closed
 * after changing some (read them again now), else 'none'.
 */
export function lengthRepairChange(
  prev: LastFrameScanStatus | null,
  next: LastFrameScanStatus | null,
): 'none' | 'progress' | 'ended' {
  if (!next) return isActive(prev) && changed(prev) > 0 ? 'ended' : 'none'
  if (!isActive(next))
    return changed(next) > 0 && (prev === null || isActive(prev))
      ? 'ended'
      : 'none'
  if (
    changed(next) > 0 &&
    (next.repaired !== prev?.repaired || next.resultsRows !== prev?.resultsRows)
  )
    return 'progress'
  return 'none'
}
