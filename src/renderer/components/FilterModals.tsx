/* eslint-disable react/no-array-index-key */

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
  parserWarning,
  onDismiss,
}: {
  parserWarning: string[]
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
        <div className="filter-warn-title">Cannot delete combo parser</div>
        <div className="filter-warn-body">
          Remove these dependent filters first:
        </div>
        <div className="filter-warn-list">
          {parserWarning.map((name) => (
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
