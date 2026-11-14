import { useEffect, useState } from 'react'
import ipcBridge from 'renderer/ipcBridge'
import type { LastFrameScanStatus } from '../../lib/lastFrame'
import '../styles/CpuScanBar.css'

const n = (v: number) => v.toLocaleString()

// A quick repair (a few games, or nothing to do) never shows.
const SHOW_AFTER_MS = 2000

/**
 * Quiet progress for the background repair that reads the length of
 * anonymized games (e.g. ranked) imported before Clipper read it from the
 * replay (main/LastFrameScanWorker.ts), with Stop and Continue. Same look as
 * the CPU players bar.
 */
export default function GameLengthBar({
  archivePath,
}: {
  archivePath?: string
}) {
  const [status, setStatus] = useState<LastFrameScanStatus | null>(null)
  const [shown, setShown] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setStatus(null)
    setShown(false)
    setDismissed(false)
    if (!archivePath) return undefined
    ipcBridge.getLastFrameScanStatus((s) => setStatus(s ?? null))
    return window.electron.ipcRenderer.on(
      'lastFrameScanStatus',
      (s: LastFrameScanStatus | null) => setStatus(s),
    )
  }, [archivePath])

  const active = status?.state === 'running' || status?.state === 'paused'
  useEffect(() => {
    if (!active) return undefined
    const t = setTimeout(() => setShown(true), SHOW_AFTER_MS)
    return () => clearTimeout(t)
  }, [active])

  if (!status || status.projectPath !== archivePath || dismissed) return null

  const act = (action: 'stop' | 'continue') => {
    setBusy(true)
    ipcBridge.lastFrameScanAction(action, (s) => {
      setBusy(false)
      if (s) setStatus(s)
    })
  }
  const left = Math.max(0, status.total - status.checked)
  const close = (
    <button
      type="button"
      className="cpu-scan-close"
      aria-label="Hide"
      title="Hide"
      onClick={() => setDismissed(true)}
    >
      ×
    </button>
  )

  let body: JSX.Element | null = null
  if (active) {
    if (!shown || status.total === 0) return null
    const filesDone = status.checked >= status.total
    const pct = Math.floor((status.checked / Math.max(1, status.total)) * 100)
    body = (
      <>
        <span
          className="cpu-scan-text"
          title="Anonymized replays (e.g. ranked) have no length in their metadata. Clipper reads it from the end of each replay imported before it did this, in the background."
        >
          {filesDone
            ? 'Adding game lengths to step results…'
            : `Reading game lengths of older anonymized games: ${n(status.checked)} of ${n(status.total)} (${pct}%)`}
          {status.state === 'paused' &&
            ' · paused while a filter or import runs'}
        </span>
        <button
          type="button"
          className="cpu-scan-btn"
          disabled={busy}
          title="Stop for now: Continue picks it up again, or it carries on the next time Clipper starts"
          onClick={() => act('stop')}
        >
          Stop
        </button>
      </>
    )
  } else if (status.state === 'stopped' && left > 0) {
    body = (
      <>
        <span className="cpu-scan-text">
          Stopped reading game lengths ({n(left)} games left; it carries on the
          next time Clipper starts).
        </span>
        <button
          type="button"
          className="cpu-scan-btn"
          disabled={busy}
          onClick={() => act('continue')}
        >
          Continue
        </button>
        {close}
      </>
    )
  } else if (status.state === 'done' && status.unreachable) {
    body = (
      <>
        <span className="cpu-scan-text">
          Couldn’t reach this project’s replays to read their game lengths. It
          tries again the next time the project opens.
        </span>
        {close}
      </>
    )
  }
  if (!body) return null
  return (
    <div className="cpu-scan-bar" role="status">
      {body}
    </div>
  )
}
