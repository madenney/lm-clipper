import { useEffect, useRef } from 'react'
import { ConsoleSnapshot, ConsoleLogEntry } from '../../constants/types'

type AppConsoleProps = {
  consoleHeight: number
  setConsoleHeight: (_h: number) => void
  onClose: () => void
  logEntries: ConsoleLogEntry[]
  onClearLogs: () => void
  snapshot: ConsoleSnapshot | null
}

export default function AppConsole({
  consoleHeight,
  setConsoleHeight,
  onClose,
  logEntries,
  onClearLogs,
  snapshot,
}: AppConsoleProps) {
  const logEndRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)

  // Auto-scroll log to bottom
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logEntries])

  // Console resize drag
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      const delta = dragRef.current.startY - e.clientY
      const newH = Math.min(Math.max(80, dragRef.current.startH + delta), 500)
      setConsoleHeight(newH)
    }
    const onMouseUp = () => {
      dragRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [setConsoleHeight])

  const isActive = snapshot && snapshot.operation !== 'idle'
  const hasWorkers = isActive && snapshot.workers && snapshot.workers.length > 0

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
  }

  return (
    <div className="footer-console" style={{ height: consoleHeight }}>
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- resize drag handle */}
      <div
        className="footer-console-drag"
        onMouseDown={(e) => {
          dragRef.current = {
            startY: e.clientY,
            startH: consoleHeight,
          }
          document.body.style.cursor = 'ns-resize'
          document.body.style.userSelect = 'none'
        }}
      />
      <div className="footer-console-header">
        <span className="footer-console-title">
          {isActive ? snapshot.operationLabel : 'Console'}
        </span>
        {isActive && snapshot.aggregate.total > 0 && (
          <span className="console-aggregate">
            {snapshot.aggregate.current.toLocaleString()} /{' '}
            {snapshot.aggregate.total.toLocaleString()}
          </span>
        )}
        <div className="footer-console-actions">
          <button
            type="button"
            className="footer-console-clear"
            onClick={onClearLogs}
          >
            Clear
          </button>
          <button
            type="button"
            className="footer-console-close"
            onClick={onClose}
          >
            &#10005;
          </button>
        </div>
      </div>

      {/* Worker Status Zone */}
      {hasWorkers && (
        <div className="console-workers">
          {snapshot.workers.map((w) => (
            <div
              key={w.id}
              className={`console-worker-row${w.label ? '' : ' console-worker-row--idle'}`}
            >
              <span className="console-worker-id">Worker {w.id}</span>
              <span className="console-worker-label">
                {w.label || '(idle)'}
              </span>
              {w.progress && (
                <span className="console-worker-progress">{w.progress}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Log Zone */}
      <div className="footer-console-body">
        {logEntries.length === 0 && !isActive ? (
          <div className="footer-console-empty">No activity yet.</div>
        ) : (
          logEntries.map((entry, i) => (
            <div
              key={i} // eslint-disable-line react/no-array-index-key
              className={`footer-console-line${entry.level === 'error' ? ' footer-console-line--error' : entry.level === 'warn' ? ' footer-console-line--warn' : ''}`}
            >
              <span className="console-log-ts">{formatTime(entry.ts)}</span>
              {entry.message}
            </div>
          ))
        )}
        <div ref={logEndRef} />
      </div>
    </div>
  )
}
