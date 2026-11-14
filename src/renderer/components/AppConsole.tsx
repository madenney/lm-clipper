import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ConsoleSnapshot,
  ConsoleLogEntry,
  ConsoleOperation,
} from '../../constants/types'
import ipcBridge from '../ipcBridge'
import {
  consoleText,
  formatConsoleTime,
  formatElapsed,
  visibleConsoleEntries,
  type ConsoleLevelFilter,
} from '../../lib/consoleView'

type AppConsoleProps = {
  consoleHeight: number
  setConsoleHeight: (_h: number) => void
  onClose: () => void
  logEntries: ConsoleLogEntry[]
  /** Older lines that were dropped to keep the list small (they are in main.log). */
  droppedCount: number
  onClearLogs: () => void
  snapshot: ConsoleSnapshot | null
  level: ConsoleLevelFilter
  setLevel: (_l: ConsoleLevelFilter) => void
}

/** Lines drawn at once: the list can hold thousands, and every batch of new lines re-draws what is
 *  drawn. Older ones are one click away ("Show earlier lines"). */
export const CONSOLE_DOM_LINES = 400

const LEVELS: { key: ConsoleLevelFilter; label: string; title: string }[] = [
  { key: 'all', label: 'All', title: 'Every line' },
  { key: 'problems', label: 'Warnings', title: 'Warnings and errors' },
  { key: 'errors', label: 'Errors', title: 'Errors only' },
]

function Operation({ op, now }: { op: ConsoleOperation; now: number }) {
  const { current, total } = op.aggregate
  const pct = total > 0 ? Math.min(100, (current / total) * 100) : null
  return (
    <div className="console-op">
      <div className="console-op-head">
        <span className="console-op-label">{op.label}</span>
        {total > 0 && (
          <span className="console-aggregate">
            {current.toLocaleString()} / {total.toLocaleString()}
          </span>
        )}
        <span className="console-op-time">
          {formatElapsed(now - op.startedAt)}
        </span>
      </div>
      {pct !== null && (
        <div className="console-op-bar">
          <div className="console-op-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
      {op.workers.length > 0 && (
        <div className="console-workers">
          {op.workers.map((w) => (
            <div
              key={w.id}
              className={`console-worker-row${w.label ? '' : ' console-worker-row--idle'}`}
            >
              <span className="console-worker-id">Worker {w.id + 1}</span>
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
    </div>
  )
}

export default function AppConsole({
  consoleHeight,
  setConsoleHeight,
  onClose,
  logEntries,
  droppedCount,
  onClearLogs,
  snapshot,
  level,
  setLevel,
}: AppConsoleProps) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  const [query, setQuery] = useState('')
  const [copied, setCopied] = useState(false)
  // Follow new lines only while the reader is at the bottom.
  const [atBottom, setAtBottom] = useState(true)
  const [now, setNow] = useState(() => Date.now())

  const operations = snapshot?.operations ?? []
  const running = operations.length > 0

  // Tick the elapsed times while something runs.
  useEffect(() => {
    if (!running) return undefined
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])

  const shown = useMemo(
    () => visibleConsoleEntries(logEntries, level, query),
    [logEntries, level, query],
  )
  const [domLimit, setDomLimit] = useState(CONSOLE_DOM_LINES)
  useEffect(() => setDomLimit(CONSOLE_DOM_LINES), [level, query])
  const drawn =
    shown.length > domLimit ? shown.slice(shown.length - domLimit) : shown
  const earlier = shown.length - drawn.length

  useEffect(() => {
    const el = bodyRef.current
    if (el && atBottom) el.scrollTop = el.scrollHeight
  }, [drawn, atBottom])

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

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(consoleText(shown))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard blocked: nothing to do
    }
  }

  const jumpToLatest = () => {
    setAtBottom(true)
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  const filtering = level !== 'all' || query.trim() !== ''

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
        <span className="footer-console-title">Console</span>
        <div className="console-levels" role="group" aria-label="Show">
          {LEVELS.map((l) => (
            <button
              key={l.key}
              type="button"
              title={l.title}
              className={`console-level${level === l.key ? ' is-on' : ''}`}
              aria-pressed={level === l.key}
              onClick={() => setLevel(l.key)}
            >
              {l.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="console-search"
          placeholder="Search"
          aria-label="Search the console"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="footer-console-actions">
          <button
            type="button"
            className="footer-console-clear"
            title={filtering ? 'Copy the lines shown' : 'Copy every line'}
            disabled={shown.length === 0}
            onClick={copy}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            className="footer-console-clear"
            title="Open the folder with Clipper's log files"
            onClick={() => ipcBridge.openLogsFolder()}
          >
            Log files
          </button>
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
            aria-label="Close the console"
            onClick={onClose}
          >
            &#10005;
          </button>
        </div>
      </div>

      {running && (
        <div className="console-ops">
          {operations.map((op) => (
            <Operation key={op.id} op={op} now={now} />
          ))}
        </div>
      )}

      <div
        className="footer-console-body"
        ref={bodyRef}
        // Not announced line by line: the unread badge and the error dock say when to look.
        role="log"
        aria-live="off"
        aria-label="Console output"
        onScroll={(e) => {
          const el = e.currentTarget
          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
        }}
      >
        {droppedCount > 0 && (
          <div className="footer-console-empty">
            {droppedCount.toLocaleString()} older lines are not shown (they are
            in the log files).
          </div>
        )}
        {earlier > 0 && (
          <button
            type="button"
            className="console-jump console-earlier"
            onClick={() => setDomLimit((n) => n + CONSOLE_DOM_LINES)}
          >
            Show earlier lines ({earlier.toLocaleString()})
          </button>
        )}
        {shown.length === 0 ? (
          <div className="footer-console-empty">
            {logEntries.length === 0
              ? running
                ? 'Nothing logged yet.'
                : 'No activity yet.'
              : 'No lines match.'}
          </div>
        ) : (
          drawn.map((entry) => (
            <div
              key={entry.id}
              className={`footer-console-line${entry.level === 'error' ? ' footer-console-line--error' : entry.level === 'warn' ? ' footer-console-line--warn' : ''}`}
            >
              <span className="console-log-ts">
                {formatConsoleTime(entry.ts)}
              </span>
              {entry.message}
            </div>
          ))
        )}
      </div>
      {!atBottom && shown.length > 0 && (
        <button type="button" className="console-jump" onClick={jumpToLatest}>
          Jump to latest
        </button>
      )}
    </div>
  )
}
