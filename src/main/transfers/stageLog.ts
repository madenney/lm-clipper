import type { TransferDeps } from './context'
import type { SavedTransfer } from './savedTransfer'

/** One console line when a download changes stage (not for every progress update). */
export function logStage(
  deps: TransferDeps,
  job: SavedTransfer,
  patch: Partial<SavedTransfer>,
) {
  const log = deps.console
  if (!log || !patch.stage || patch.stage === job.stage) return
  const name = job.title || 'Download'
  switch (patch.stage) {
    case 'downloading':
    case 'extracting':
    case 'importing':
      log.pushConsoleLog('info', `${name}: ${patch.stage}…`)
      break
    case 'completed':
      log.pushConsoleLog('info', `${name}: done`)
      break
    case 'canceled':
      log.pushConsoleLog('info', `${name}: canceled`)
      break
    case 'paused':
      log.pushConsoleLog('info', `${name}: ${patch.detail ?? 'paused'}`)
      break
    case 'failed':
      log.pushConsoleLog(
        'error',
        `${name}: ${patch.error ?? patch.detail ?? 'failed'}`,
      )
      break
    default:
  }
}
