/* eslint-disable react/no-array-index-key */
import { useState } from 'react'

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`
  return `${s}s`
}

export type ResetWarnSeverity = 'low' | 'medium' | 'high'

// Per-severity copy for the reset confirmation. `time` is the formatted last-run
// duration, injected into every variant so the user sees exactly what's at risk.
function resetCopy(
  severity: ResetWarnSeverity,
  filterLabel: string,
  time: string,
  mode: 'rerun' | 'edit' = 'rerun',
) {
  const name = <strong>{filterLabel}</strong>
  const dur = <strong>{time}</strong>
  if (mode === 'edit') {
    switch (severity) {
      case 'high':
        return {
          title: 'Edit and discard a long computation?',
          body: (
            <>
              ⚠️ {name} last took {dur} to run. Editing it permanently throws
              away that computation (and anything downstream) — you won&apos;t
              get those {time} back, and you&apos;ll have to run it again. Are
              you sure?
            </>
          ),
        }
      case 'medium':
        return {
          title: 'Edit — this one took a while',
          body: (
            <>
              Heads up: {name} last took {dur} to run. Editing it deletes all of
              those results (and anything downstream). Make sure you want to.
            </>
          ),
        }
      default:
        return {
          title: 'Edit this filter?',
          body: (
            <>
              {name} last took {dur} to run. Editing it clears those results
              (and anything downstream) — you&apos;ll need to run it again.
            </>
          ),
        }
    }
  }
  switch (severity) {
    case 'high':
      return {
        title: 'Re-run a long computation?',
        body: (
          <>
            ⚠️ {name} last took {dur} to run. Re-running it permanently throws
            away that entire computation and rebuilds the results from scratch —
            you won&apos;t get those {time} back. Are you sure?
          </>
        ),
      }
    case 'medium':
      return {
        title: 'Re-run — this one took a while',
        body: (
          <>
            Heads up: {name} last took {dur} to run. Re-running deletes all of
            those results and starts over from zero. Make sure you really want
            to redo it.
          </>
        ),
      }
    default:
      return {
        title: 'Re-run this filter?',
        body: (
          <>
            {name} last took {dur} to run. Re-running clears those results and
            computes them again from scratch.
          </>
        ),
      }
  }
}

// Confirmation before re-running a filter (which discards its results) when the
// last run was expensive. Three independent severity tiers (≥60s, ≥10m, ≥1h);
// the caller passes whichever tier matched. The "Don't warn me again" checkbox
// silences only this tier (`thresholdLabel`).
export function ConfirmResetModal({
  filterLabel,
  durationMs,
  severity,
  thresholdLabel,
  mode = 'rerun',
  onConfirm,
  onCancel,
}: {
  filterLabel: string
  durationMs: number
  severity: ResetWarnSeverity
  thresholdLabel: string
  mode?: 'rerun' | 'edit'
  onConfirm: (_dontAskAgain: boolean) => void
  onCancel: () => void
}) {
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const { title, body } = resetCopy(
    severity,
    filterLabel,
    formatDuration(durationMs),
    mode,
  )
  return (
    <div className="filter-warn-overlay" role="presentation" onClick={onCancel}>
      <div
        className={`filter-warn-modal filter-warn-${severity}`}
        role="presentation"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="filter-warn-title">{title}</div>
        <div className="filter-warn-body">{body}</div>
        <label className="filter-warn-checkbox">
          <input
            type="checkbox"
            checked={dontAskAgain}
            onChange={(e) => setDontAskAgain(e.target.checked)}
          />
          Don&apos;t warn me again for {mode === 'edit' ? 'edits' : 're-runs'}{' '}
          over {thresholdLabel}
        </label>
        <div className="filter-warn-actions">
          <button
            type="button"
            className="filter-warn-btn filter-warn-btn-secondary"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="filter-warn-btn filter-warn-btn-danger"
            onClick={() => onConfirm(dontAskAgain)}
          >
            {mode === 'edit' ? 'Edit anyway' : 'Reset & re-run'}
          </button>
        </div>
      </div>
    </div>
  )
}

// Shown when running a filter requires running an expensive upstream parser
// first (one that re-parses every replay). Cheap prerequisites run silently;
// only parsers get this heads-up so a long job is never started by surprise.
export function ParserRunModal({
  targetLabel,
  parserLabel,
  count,
  onConfirm,
  onCancel,
}: {
  targetLabel: string
  parserLabel: string
  count: number | null
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="filter-warn-overlay" role="presentation" onClick={onCancel}>
      <div
        className="filter-warn-modal filter-warn-medium"
        role="presentation"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="filter-warn-title">Run the {parserLabel} first?</div>
        <div className="filter-warn-body">
          Running <strong>{targetLabel}</strong> needs the{' '}
          <strong>{parserLabel}</strong> to run first
          {typeof count === 'number' && count > 0 ? (
            <>
              {' '}
              — that parses {count.toLocaleString()} replays and can take a
              while.
            </>
          ) : (
            <> — it parses every replay and can take a while.</>
          )}
        </div>
        <div className="filter-warn-actions">
          <button
            type="button"
            className="filter-warn-btn filter-warn-btn-secondary"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="filter-warn-btn filter-warn-btn-danger"
            onClick={onConfirm}
          >
            Run it
          </button>
        </div>
      </div>
    </div>
  )
}

// Shown before running a custom-code filter whose code the user hasn't approved
// this install. Custom filters execute arbitrary JS with full machine access,
// so running one from an opened project / imported template is a deliberate,
// informed choice — never silent. "Always trust" remembers the code by hash.
export function CustomCodeConsentModal({
  filterLabels,
  onCancel,
  onRunOnce,
  onAlwaysTrust,
}: {
  filterLabels: string[]
  onCancel: () => void
  onRunOnce: () => void
  onAlwaysTrust: () => void
}) {
  const many = filterLabels.length > 1
  return (
    <div className="filter-warn-overlay" role="presentation" onClick={onCancel}>
      <div
        className="filter-warn-modal"
        role="presentation"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="filter-warn-title">Run custom code?</div>
        <div className="filter-warn-body">
          {many ? (
            <>
              <strong>{filterLabels.length} custom filters</strong> in this run
              ({filterLabels.join(', ')}) contain code that runs
            </>
          ) : (
            <>
              <strong>{filterLabels[0]}</strong> contains custom code that runs
            </>
          )}{' '}
          with <strong>full access to your computer</strong> — your files,
          network, everything. Only run code you wrote yourself or got from
          someone you trust.
        </div>
        <div className="filter-warn-actions">
          <button
            type="button"
            className="filter-warn-btn filter-warn-btn-secondary"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button type="button" className="filter-warn-btn" onClick={onRunOnce}>
            Run once
          </button>
          <button
            type="button"
            className="filter-warn-btn filter-warn-btn-danger"
            onClick={onAlwaysTrust}
          >
            Always trust
          </button>
        </div>
      </div>
    </div>
  )
}

export function FilterErrorModal({
  filterError,
  onDismiss,
}: {
  filterError: { filterLabel: string; errors: string[] }
  onDismiss: () => void
}) {
  return (
    <div
      className="filter-warn-overlay"
      role="presentation"
      onClick={onDismiss}
    >
      <div
        className="filter-warn-modal filter-error-modal"
        role="presentation"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="filter-warn-title">
          Error in {filterError.filterLabel}
        </div>
        <div className="filter-warn-body">
          {filterError.errors.length === 1
            ? 'An error occurred while running this filter.'
            : `${filterError.errors.length} errors occurred while running this filter.`}
          <br />
          Check the console for details (terminal icon in the footer).
        </div>
        <button type="button" className="filter-warn-btn" onClick={onDismiss}>
          OK
        </button>
      </div>
    </div>
  )
}

export function FilterLogsModal({
  filterLogs,
  onDismiss,
}: {
  filterLogs: { filterLabel: string; logs: string[] }
  onDismiss: () => void
}) {
  return (
    <div
      className="filter-warn-overlay"
      role="presentation"
      onClick={onDismiss}
    >
      <div
        className="filter-warn-modal filter-logs-modal"
        role="presentation"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="filter-warn-title">
          Console Output — {filterLogs.filterLabel}
        </div>
        <div className="filter-logs-list">
          {filterLogs.logs.map((log, i) => (
            <div key={i} className="filter-logs-item">
              {log}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button
            type="button"
            className="filter-warn-btn"
            onClick={() => {
              navigator.clipboard.writeText(filterLogs.logs.join('\n'))
            }}
          >
            Copy Logs
          </button>
          <button type="button" className="filter-warn-btn" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  )
}

export function ParserWarningModal({
  producer,
  dependents,
  onDismiss,
}: {
  producer: string
  dependents: string[]
  onDismiss: () => void
}) {
  return (
    <div
      className="filter-warn-overlay"
      role="presentation"
      onClick={onDismiss}
    >
      <div
        className="filter-warn-modal"
        role="presentation"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="filter-warn-title">Cannot delete {producer}</div>
        <div className="filter-warn-body">
          Remove these dependent filters first:
        </div>
        <div className="filter-warn-list">
          {dependents.map((name) => (
            <div key={name} className="filter-warn-item">
              {name}
            </div>
          ))}
        </div>
        <button type="button" className="filter-warn-btn" onClick={onDismiss}>
          Got it
        </button>
      </div>
    </div>
  )
}
