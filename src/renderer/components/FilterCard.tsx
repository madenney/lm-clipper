import {
  MouseEvent,
  DragEvent,
  KeyboardEvent,
  useState,
  useEffect,
  useRef,
} from 'react'
import { cloneDeep } from 'lodash'
import { filtersConfig, PRODUCER_LABEL } from 'constants/config'
import { ShallowFilterInterface } from '../../constants/types'
import FilterControls, { DeferredInput } from './FilterControls'
import ipcBridge from '../ipcBridge'
import { useCountUp, useFlash } from '../lib/motion'
import { useFiltersStyle } from '../lib/filtersStyle'

type FilterCardProps = {
  filter: ShallowFilterInterface
  filterIndex: number
  isActive: boolean
  isRunning: boolean
  /** Waiting its turn in a run (only the running step gets a Stop). */
  isQueued?: boolean
  /** Told to stop; its workers are still winding down. */
  isStopping?: boolean
  /** What the queued label says (default "Queued"). */
  queuedLabel?: string
  // First-run nudge: pulse this filter's Run button + show a "click Run" chip.
  showRunHint?: boolean
  // Persist that the user has seen/dismissed the nudge (so it never returns).
  onDismissRunHint?: () => void
  // Long-parser reassurance note: gated off once the user dismisses it.
  parserNoteDisabled?: boolean
  onDismissParserNote?: () => void
  isCollapsed: boolean
  isGameFilter: boolean
  isDragging: boolean
  dragTransform: string
  filterMsg: string
  liveResults: number | undefined
  resultsCount: number | null
  /** Replays in the project: the Game Filter's pool, shown "N of total". */
  poolTotal?: number | null
  namesList: { name: string; total: number }[]
  connectCodesList: { name: string; total: number }[]
  namesLoading: boolean
  codesLoading: boolean
  hasParser: boolean
  hasEdgeguardParser: boolean
  /** The step before this one (AI Filter prompt). */
  previousType?: string
  // Branching: valid input sources for this filter (Files + filters above it)
  // and the positional default (the card directly above). `indentLevel` is the
  // filter's depth in the input tree (linear continuations inherit their source's
  // depth, so a whole branch subtree stays nested together). `isBranchPoint` =
  // this card reads from something OTHER than the card directly above it.
  inputOptions: { id: string; label: string }[]
  defaultInputId: string
  indentLevel: number
  isBranchPoint: boolean
  onToggleCollapse: (
    _event: MouseEvent<HTMLButtonElement>,
    _filterId: string,
  ) => void
  onClick: () => void
  onDoubleClick: () => void
  onRun: (_filter: ShallowFilterInterface) => void
  onStop: (_filterId: string, _filterIndex: number) => void
  onResume: (_filter: ShallowFilterInterface) => void
  /** Accept a stopped or failed run's results as they are. */
  onKeepResults: (_filter: ShallowFilterInterface) => void
  onDelete: (_filter: ShallowFilterInterface) => void
  onUpdate: (
    _newFilter: ShallowFilterInterface,
    _previousFilter: ShallowFilterInterface,
  ) => void
  onDismissMsg: (_filterId: string) => void
  draggable: boolean
  onDragStart: (_e: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
  onMouseDown: (_e: React.MouseEvent<HTMLDivElement>) => void
}

export default function FilterCard({
  filter,
  filterIndex,
  isActive,
  isRunning,
  isQueued,
  isStopping,
  queuedLabel,
  showRunHint,
  onDismissRunHint,
  parserNoteDisabled,
  onDismissParserNote,
  isCollapsed,
  isGameFilter,
  isDragging,
  dragTransform,
  filterMsg,
  liveResults,
  resultsCount,
  poolTotal,
  namesList,
  connectCodesList,
  namesLoading,
  codesLoading,
  hasParser,
  hasEdgeguardParser,
  previousType,
  inputOptions,
  defaultInputId,
  indentLevel,
  isBranchPoint,
  onToggleCollapse,
  onClick,
  onDoubleClick,
  onRun,
  onStop,
  onResume,
  onKeepResults,
  onDelete,
  onUpdate,
  onDismissMsg,
  draggable,
  onDragStart,
  onDragEnd,
  onMouseDown,
}: FilterCardProps) {
  const compact = useFiltersStyle() === 'compact'
  // An AI Filter can't run until its response (with code in it) is pasted.
  const aiBlocked =
    filter.type === 'aiFilter' && !filter.params?.code
      ? (filter.params?.response ?? '').trim()
        ? 'No code found in the response. Paste the AI’s whole answer (or the code block in it) into “Input response here”.'
        : 'Paste the AI’s response first: Copy prompt, paste it into your AI, describe the clips you want, then paste its answer into “Input response here”.'
      : null
  // Subtle run-status tint: cyan = running, green = done (results valid &
  // reusable), olive = partial (stopped mid-run, partial results still usable),
  // amber = needs run (never run, or edited since its last run).
  const statusClass = isRunning
    ? 'filter-status-running'
    : filter.isProcessed
      ? 'filter-status-done'
      : filter.resumable
        ? 'filter-status-partial'
        : 'filter-status-needsrun'

  // Counts glide to their new value after a run; a step that just finished
  // glows once.
  const shownResults = useCountUp(liveResults ?? resultsCount, {
    live: isRunning,
  })
  const justFinished = useFlash(!isRunning && !!filter.isProcessed)

  // First-run Run-button nudge. `dismissed` flips on click so the hint fades
  // out immediately (not waiting for the run state to propagate). `hintRender`
  // keeps the chip/glow mounted through the fade-out, then unmounts them.
  const [dismissed, setDismissed] = useState(false)
  const hintActive = !!showRunHint && !isRunning && !dismissed
  const [hintRender, setHintRender] = useState(false)
  useEffect(() => {
    if (hintActive) {
      setHintRender(true)
      return undefined
    }
    if (!hintRender) return undefined
    const t = setTimeout(() => setHintRender(false), 320)
    return () => clearTimeout(t)
  }, [hintActive, hintRender])

  // Reassurance while an expensive parser churns through a big set — so a
  // multi-minute first parse doesn't read as "frozen." Shown only for a parser
  // running over a meaningful number of files (total parsed from its progress).
  const parserTotal = isRunning
    ? Number(/^\d+\/(\d+)$/.exec(filterMsg)?.[1] ?? 0)
    : 0
  const parserNoteEligible =
    isRunning &&
    !parserNoteDisabled &&
    !!PRODUCER_LABEL[filter.type] &&
    parserTotal >= 1000
  // Don't pop the note instantly — let the count tick for a beat first, then
  // ease it in (before frustration sets in, but not jarringly quick).
  const parserDone = isRunning
    ? Number(/^(\d+)\/\d+$/.exec(filterMsg)?.[1] ?? 0)
    : 0
  // A live "about N min left" from the parse rate since the note became eligible.
  const progressRef = useRef({ done: 0, total: 0 })
  useEffect(() => {
    progressRef.current = { done: parserDone, total: parserTotal }
  }, [parserDone, parserTotal])
  const [parserEta, setParserEta] = useState<string | null>(null)
  useEffect(() => {
    if (!parserNoteEligible) return undefined
    const start = { done: progressRef.current.done, t: Date.now() }
    const tick = setInterval(() => {
      const { done, total } = progressRef.current
      const secs = (Date.now() - start.t) / 1000
      const rate = (done - start.done) / secs
      if (secs < 8 || !(rate > 0)) return
      const left = (total - done) / rate
      setParserEta(
        left < 60
          ? 'under a minute left'
          : `about ${Math.round(left / 60)} min left`,
      )
    }, 2000)
    return () => {
      clearInterval(tick)
      setParserEta(null)
    }
  }, [parserNoteEligible])
  const [showParserNote, setShowParserNote] = useState(false)
  useEffect(() => {
    if (!parserNoteEligible) {
      setShowParserNote(false)
      return undefined
    }
    const t = setTimeout(() => setShowParserNote(true), 1400)
    return () => clearTimeout(t)
  }, [parserNoteEligible])
  return (
    <div
      data-filter-index={filterIndex}
      className={`filter ${statusClass} ${isActive ? 'filter-active' : ''} ${
        isGameFilter ? 'filter-pinned' : ''
      } ${isCollapsed ? 'filter-collapsed' : ''}${
        !isRunning && filter.resumable ? ' filter-resumable' : ''
      } ${isDragging ? 'filter-dragging' : ''} ${
        indentLevel > 0 ? 'filter-branch' : ''
      }${justFinished ? ' filter-just-finished' : ''}`}
      style={{
        ...(dragTransform ? { transform: dragTransform } : {}),
        ...(indentLevel > 0 ? { marginLeft: indentLevel * 18 } : {}),
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      draggable={draggable}
      onMouseDown={onMouseDown}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <div className="filter-main">
        <div
          className="filter-title"
          style={
            filtersConfig
              .find((c) => c.id === filter.type)
              ?.options?.some((o) => o.type === 'code')
              ? { paddingRight: 250 }
              : undefined
          }
          title={
            (filtersConfig.find((c) => c.id === filter.type) as any)?.tooltip ||
            ''
          }
        >
          {filter.type === 'custom' ? (
            <DeferredInput
              className="filter-title-input"
              value={filter.label}
              placeholder="Custom Code"
              maxLength={24}
              onChange={(val) => {
                const filterClone = cloneDeep(filter)
                filterClone.label = val || 'Custom Code'
                onUpdate(filterClone, filter)
              }}
            />
          ) : compact && isGameFilter ? (
            'Replays'
          ) : (
            filter.label
          )}
        </div>
        <div className="filter-meta">
          {!isRunning && filter.resumable && filter.resumeProgress && (
            // Own line under the name, in the row's existing space (CSS
            // positions it), so the row keeps its height.
            <div
              className="filter-stopped-at"
              title={`Stopped at ${filter.resumeProgress.processed.toLocaleString()} of ${filter.resumeProgress.totalInput.toLocaleString()}`}
            >
              stopped at {filter.resumeProgress.processed.toLocaleString()}/
              {filter.resumeProgress.totalInput.toLocaleString()}
            </div>
          )}
          {compact && isGameFilter ? (
            // The starting pool, not a step: "1,203 of 1,682" once narrowed.
            <div className="filter-results">
              {(() => {
                const kept = isRunning ? (liveResults ?? 0) : shownResults
                if (!filter.isProcessed && !isRunning)
                  return poolTotal != null
                    ? `${poolTotal.toLocaleString()} replays`
                    : ''
                if (kept == null)
                  return (
                    <span
                      className="filter-results-spinner"
                      title="Counting…"
                      aria-label="Counting"
                    />
                  )
                return poolTotal != null && kept !== poolTotal
                  ? `${kept.toLocaleString()} of ${poolTotal.toLocaleString()}`
                  : `${kept.toLocaleString()} ${kept === 1 ? 'replay' : 'replays'}`
              })()}
            </div>
          ) : (
            <div className="filter-results">
              {compact ? '' : 'Results: '}
              {isRunning ? (
                (liveResults ?? 0).toLocaleString()
              ) : (liveResults ?? resultsCount) == null ? (
                <span
                  className="filter-results-spinner"
                  title="Counting…"
                  aria-label="Counting"
                />
              ) : (
                (shownResults ?? 0).toLocaleString()
              )}
              {compact &&
                ((isRunning
                  ? (liveResults ?? 0)
                  : (liveResults ?? resultsCount)) === 1
                  ? ' result'
                  : ' results')}
            </div>
          )}
        </div>
        {filterMsg && !/^\d+\/\d+$/.test(filterMsg) ? (
          <div
            className={`filterMsg filterMsg--note${/failed|error|couldn.t/i.test(filterMsg) ? ' filterMsg--bad' : ''}`}
            role="status"
          >
            <span className="filterMsg-text">{filterMsg}</span>
            <span
              className="filterMsg-dismiss"
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation()
                onDismissMsg(filter.id)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  e.stopPropagation()
                  onDismissMsg(filter.id)
                }
              }}
            >
              ✕
            </span>
          </div>
        ) : (
          ''
        )}

        {filter.locked && (
          <p
            className="filter-locked-note"
            title="Locked steps are never re-run or reset by runs above them."
          >
            Locked: these results are fixed. Add steps under it to narrow them
            down.
          </p>
        )}
        {!isGameFilter && !filter.locked && inputOptions.length > 1 && (
          <div
            className="filter-input-source"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="presentation"
          >
            <span className="filter-input-source-label">
              {isBranchPoint ? '⑂ reads from' : 'Input'}
            </span>
            <select
              className="filter-input-source-select"
              value={filter.inputId ?? defaultInputId}
              onChange={(e) => {
                const val = e.target.value
                const filterClone = cloneDeep(filter)
                // Picking the positional default clears inputId so the filter
                // keeps following the card above it through reorders.
                if (val === defaultInputId) delete filterClone.inputId
                else filterClone.inputId = val
                onUpdate(filterClone, filter)
              }}
            >
              {inputOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {!filter.locked && (
          <FilterControls
            filter={filter}
            namesList={namesList}
            connectCodesList={connectCodesList}
            namesLoading={namesLoading}
            codesLoading={codesLoading}
            hasParser={hasParser}
            hasEdgeguardParser={hasEdgeguardParser}
            previousType={previousType}
            onEditCode={() => ipcBridge.openCodeEditor({ filterIndex, filter })}
            onUpdate={onUpdate}
          />
        )}
      </div>
      <div className="filter-actions">
        {!isRunning && filter.resumable && (
          // Stopped partway: carry on, or Restart (the Run button) from the
          // beginning. How far it got shows next to the result count.
          <button
            type="button"
            className="filter-button filter-button-resume"
            title="Carry on from where it stopped"
            onClick={(e) => {
              e.stopPropagation()
              onResume(filter)
            }}
          >
            Resume
          </button>
        )}
        {!isRunning && filter.resumable && (resultsCount ?? 0) > 0 && (
          // The run stopped or failed but its results are good: keep them as
          // they are (nothing is re-run or removed).
          <button
            type="button"
            className="filter-button filter-button-keep"
            title={`Keep the ${(resultsCount ?? 0).toLocaleString()} results found so far and count this step as done. Nothing is re-run or removed.`}
            onClick={(e) => {
              e.stopPropagation()
              onKeepResults(filter)
            }}
          >
            Keep results
          </button>
        )}
        {filter.type !== 'aiFilter' &&
          filtersConfig
            .find((c) => c.id === filter.type)
            ?.options?.some((o) => o.type === 'code') && (
            <button
              type="button"
              className="filter-button"
              onClick={(e) => {
                e.stopPropagation()
                ipcBridge.openCodeEditor({
                  filterIndex,
                  filter,
                })
              }}
            >
              Edit Code
            </button>
          )}
        {isRunning && filterMsg && /^\d+\/\d+$/.test(filterMsg) && (
          <span className="filter-progress-pill">{filterMsg}</span>
        )}
        <span
          className="filter-run-wrap"
          // A disabled button shows no tooltip of its own on some systems.
          title={!isRunning && aiBlocked ? aiBlocked : undefined}
        >
          {hintRender && (
            <span
              className={`filter-run-hint${hintActive ? '' : ' filter-run-hint--leaving'}`}
            >
              Click Run to find your combos
              <button
                type="button"
                className="filter-run-hint-close"
                aria-label="Dismiss"
                onClick={(e) => {
                  e.stopPropagation()
                  setDismissed(true)
                  onDismissRunHint?.()
                }}
              >
                ×
              </button>
            </span>
          )}
          {filter.locked ? (
            <span
              className="filter-source-note"
              title="Locked: its results are fixed and it never runs."
            >
              🔒 Locked
            </span>
          ) : filter.type === 'lunarClips' ? (
            <span
              className="filter-source-note"
              title="Added from Lunar Database › Pre-parsed moments"
            >
              Lunar Database
            </span>
          ) : isStopping ? (
            <span className="filter-queued" title="Saving partial results">
              Stopping…
            </span>
          ) : isQueued ? (
            <span
              className="filter-queued"
              title={
                queuedLabel
                  ? 'Starts by itself when your replays finish importing'
                  : 'Runs after the step above'
              }
            >
              {queuedLabel ?? 'Queued'}
            </span>
          ) : (
            <button
              type="button"
              className={`filter-button${isRunning ? ' filter-button-stop' : ''}${
                hintActive ? ' filter-button-hint' : ''
              }${hintRender && !hintActive ? ' filter-button-hint-leaving' : ''}`}
              disabled={!isRunning && !!aiBlocked}
              title={!isRunning && aiBlocked ? aiBlocked : undefined}
              onClick={(e) => {
                e.stopPropagation()
                if (isRunning) {
                  onStop(filter.id, filterIndex)
                } else {
                  if (hintActive) onDismissRunHint?.()
                  setDismissed(true)
                  onRun(filter)
                }
              }}
            >
              {isRunning ? 'Stop' : filter.resumable ? 'Restart' : 'Run'}
            </button>
          )}
        </span>
        <button
          type="button"
          className="filter-toggle"
          onClick={(event) => onToggleCollapse(event, filter.id)}
          aria-label={isCollapsed ? 'Expand filter' : 'Collapse filter'}
          title={isCollapsed ? 'Expand filter' : 'Collapse filter'}
        >
          {isCollapsed ? '\u25BC' : '\u25B2'}
        </button>
        {!isGameFilter && (
          <button
            type="button"
            className="filter-delete"
            onClick={(e) => {
              e.stopPropagation()
              onDelete(filter)
            }}
            aria-label={`Delete ${filter.label}`}
            title="Delete filter"
          >
            ✕
          </button>
        )}
      </div>
      {showParserNote && (
        <div className="filter-parser-note">
          <span className="filter-parser-note-main">
            <strong>
              Reading all {parserTotal.toLocaleString()} replays
              {parserEta ? ` · ${parserEta}` : ''}
            </strong>
            <span className="filter-parser-note-sub">
              This only happens once. The steps after it work from what it
              finds, so they&apos;re quick.
            </span>
          </span>
          {onDismissParserNote && (
            <button
              type="button"
              className="filter-parser-note-dismiss"
              onClick={(e) => {
                e.stopPropagation()
                onDismissParserNote()
              }}
            >
              Don&apos;t show this again
            </button>
          )}
        </div>
      )}
    </div>
  )
}
