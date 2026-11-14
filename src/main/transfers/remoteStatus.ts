import { DB_JOB_STATUSES, formatWait } from '../../constants/database'
import { ExportGoneError } from './errors'

export type RemoteStatus = {
  status: string
  downloadReady?: boolean
  /** 1-based place in line while pending; 0 once the server is building it. */
  queuePosition?: number | null
  /** Forecast seconds until it starts (pending) ... */
  estimatedWaitSec?: number | null
  /** ... and how long building takes (or, once started, until it's ready). */
  estimatedProcessingTimeSec?: number | null
  /** Other people waiting on this same bundle. */
  sharedWith?: number
  /** Why the server's downloads are paused, when they are. */
  paused?: string | null
  progress?: { filesProcessed: number; filesTotal: number }
  error?: string
}

const num = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0

/** A waiting export in words: its place in the server queue and when it
 *  should be ready, or what the server is doing with it. */
export function describeRemoteStatus(s: RemoteStatus): string {
  if (typeof s.paused === 'string' && s.paused)
    return `Server downloads are paused. ${s.paused}`.slice(0, 300)
  const shared =
    num(s.sharedWith) && s.sharedWith > 0
      ? ` · shared with ${s.sharedWith} ${s.sharedWith === 1 ? 'other person' : 'others'}`
      : ''
  if (s.status === 'pending') {
    const place =
      num(s.queuePosition) && s.queuePosition > 0
        ? `#${s.queuePosition.toLocaleString()} in the server queue`
        : 'In the server queue'
    const ready =
      num(s.estimatedWaitSec) || num(s.estimatedProcessingTimeSec)
        ? ` · ready in ${formatWait((num(s.estimatedWaitSec) ? s.estimatedWaitSec : 0) + (num(s.estimatedProcessingTimeSec) ? s.estimatedProcessingTimeSec : 0))}`
        : ''
    return `${place}${ready}${shared}`
  }
  const step =
    s.status === 'uploading'
      ? 'The server is uploading your bundle'
      : s.status === 'bundling' || s.status === 'bundled'
        ? 'The server is packing your replays'
        : 'The server is gathering your replays'
  const left = num(s.estimatedProcessingTimeSec)
    ? ` · ready in ${formatWait(s.estimatedProcessingTimeSec)}`
    : ''
  return `${step}${left}${shared}`
}

/** When a waiting export should be ready (epoch ms), from the same estimate
 *  describeRemoteStatus words; null when the server gives none. */
export function readyAtOf(s: RemoteStatus, now = Date.now()): number | null {
  if (typeof s.paused === 'string' && s.paused) return null
  const sec =
    s.status === 'pending'
      ? (num(s.estimatedWaitSec) ? s.estimatedWaitSec : 0) +
        (num(s.estimatedProcessingTimeSec) ? s.estimatedProcessingTimeSec : 0)
      : num(s.estimatedProcessingTimeSec)
        ? s.estimatedProcessingTimeSec
        : 0
  return sec > 0 ? now + sec * 1000 : null
}

/** Decide what a status poll means: keep waiting, download, or give up. */
export function interpretStatus(status: RemoteStatus): 'wait' | 'ready' {
  if (status.status === 'completed') {
    if (status.downloadReady) return 'ready'
    // Completed but no bundle: storage cleanup removed it after its retention.
    throw new ExportGoneError(
      'This export expired on the server before it was downloaded.',
    )
  }
  if (status.status === 'failed' || status.status === 'cancelled')
    throw new ExportGoneError(
      status.error ||
        (status.status === 'cancelled'
          ? 'This export was cancelled on the server.'
          : 'The server could not prepare this batch.'),
    )
  if (!(DB_JOB_STATUSES as readonly string[]).includes(status.status))
    throw new Error(`Unexpected export status "${status.status}".`)
  return 'wait'
}
