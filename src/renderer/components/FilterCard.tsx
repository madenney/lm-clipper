import {
  MouseEvent,
  DragEvent,
  KeyboardEvent,
  useState,
  useEffect,
} from 'react'
import { cloneDeep } from 'lodash'
import { filtersConfig, PRODUCER_LABEL } from 'constants/config'
import { ShallowFilterInterface } from '../../constants/types'
import FilterControls, { DeferredInput } from './FilterControls'
import ipcBridge from '../ipcBridge'

type FilterCardProps = {
  filter: ShallowFilterInterface
  filterIndex: number
  isActive: boolean
  isRunning: boolean
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
  namesList: { name: string; total: number }[]
  connectCodesList: { name: string; total: number }[]
  namesLoading: boolean
  codesLoading: boolean
  hasParser: boolean
  hasEdgeguardParser: boolean
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
  onDismissResume: (_filter: ShallowFilterInterface) => void
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
  namesList,
  connectCodesList,
  namesLoading,
  codesLoading,
  hasParser,
  hasEdgeguardParser,
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
  onDismissResume,
  onDelete,
  onUpdate,
  onDismissMsg,
  draggable,
  onDragStart,
  onDragEnd,
  onMouseDown,
}: FilterCardProps) {
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
      } ${isCollapsed ? 'filter-collapsed' : ''} ${isDragging ? 'filter-dragging' : ''} ${
        indentLevel > 0 ? 'filter-branch' : ''
      }`}
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
          ) : (
            filter.label
          )}
        </div>
        <div className="filter-meta">
          <div className="filter-results">
            Results:{' '}
            {isRunning ? (
              (liveResults ?? 0).toLocaleString()
            ) : (liveResults ?? resultsCount) == null ? (
              <span
                className="filter-results-spinner"
                title="Counting…"
                aria-label="Counting"
              />
            ) : (
              (liveResults ?? resultsCount)!.toLocaleString()
            )}
          </div>
          {filterMsg && !/^\d+\/\d+$/.test(filterMsg) ? (
            <div className="filterMsg">
              {filterMsg}
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
        </div>
        {!isGameFilter && inputOptions.length > 1 && (
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
        <FilterControls
          filter={filter}
          namesList={namesList}
          connectCodesList={connectCodesList}
          namesLoading={namesLoading}
          codesLoading={codesLoading}
          hasParser={hasParser}
          hasEdgeguardParser={hasEdgeguardParser}
          onUpdate={onUpdate}
        />
      </div>
      <div className="filter-actions">
        {!isRunning && filter.resumable && (
          <div className="filter-resume-wrap">
            <button
              type="button"
              className="filter-button filter-button-resume"
              onClick={(e) => {
                e.stopPropagation()
                onResume(filter)
              }}
            >
              Resume
              {filter.resumeProgress && (
                <span className="filter-resume-progress">
                  {' '}
                  {filter.resumeProgress.processed.toLocaleString()}
                  {' / '}
                  {filter.resumeProgress.totalInput.toLocaleString()}
                </span>
              )}
            </button>
            <button
              type="button"
              className="filter-resume-dismiss"
              onClick={(e) => {
                e.stopPropagation()
                onDismissResume(filter)
              }}
            >
              ✕
            </button>
          </div>
        )}
        {filtersConfig
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
        <span className="filter-run-wrap">
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
          <button
            type="button"
            className={`filter-button${isRunning ? ' filter-button-stop' : ''}${
              hintActive ? ' filter-button-hint' : ''
            }${hintRender && !hintActive ? ' filter-button-hint-leaving' : ''}`}
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
            {isRunning ? 'Stop' : 'Run'}
          </button>
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
            This only runs once — it reads every replay, so it can take a few
            minutes. Hang tight; there&apos;s no faster way.
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
