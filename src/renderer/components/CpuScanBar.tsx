import { useEffect, useState } from 'react'
import ipcBridge from 'renderer/ipcBridge'
import type { CpuScanStatus } from '../../lib/cpuPlayers'
import '../styles/CpuScanBar.css'

const n = (v: number) => v.toLocaleString()

// A quick check (a small project, or nothing to do) never shows.
const SHOW_AFTER_MS = 2000

/**
 * Quiet progress for the background check that finds CPU players in games
 * imported before Clipper recorded them (main/CpuScanWorker.ts), with Stop and
 * Continue. The Game Filter treats games not checked yet as having no CPU.
 */
export default function CpuScanBar({ archivePath }: { archivePath?: string }) {
  const [status, setStatus] = useState<CpuScanStatus | null>(null)
  const [shown, setShown] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setStatus(null)
    setShown(false)
    setDismissed(false)
    if (!archivePath) return undefined
    ipcBridge.getCpuScanStatus((s) => setStatus(s ?? null))
    return window.electron.ipcRenderer.on(
      'cpuScanStatus',
      (s: CpuScanStatus | null) => setStatus(s),
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
    ipcBridge.cpuScanAction(action, (s) => {
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
    const pct = Math.floor((status.checked / Math.max(1, status.total)) * 100)
    body = (
      <>
        <span
          className="cpu-scan-text"
          title="Games imported before Clipper recorded CPU players are read in the background. Until a game is checked, the Game Filter treats it as a game without a CPU."
        >
          Checking older games for CPU players: {n(status.checked)} of{' '}
          {n(status.total)} ({pct}%)
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
          Stopped checking for CPU players ({n(left)} games left; it carries on
          the next time Clipper starts).
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
          Couldn’t reach this project’s replays to check them for CPU players.
          It tries again the next time the project opens.
        </span>
        {close}
      </>
    )
  } else if (status.state === 'done' && status.cpuGames > 0) {
    body = (
      <>
        <span className="cpu-scan-text">
          Found {n(status.cpuGames)} {status.cpuGames === 1 ? 'game' : 'games'}{' '}
          with a CPU player. Run the Game Filter again to leave{' '}
          {status.cpuGames === 1 ? 'it' : 'them'} out (Include CPU games keeps
          them).
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
