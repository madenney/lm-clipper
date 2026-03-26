import { MouseEvent, DragEvent, KeyboardEvent } from 'react'
import { cloneDeep } from 'lodash'
import { filtersConfig } from 'constants/config'
import { ConfigInterface, ShallowFilterInterface } from '../../constants/types'
import FilterControls, { DeferredInput } from './FilterControls'
import ipcBridge from '../ipcBridge'

type FilterCardProps = {
  filter: ShallowFilterInterface
  filterIndex: number
  isActive: boolean
  isRunning: boolean
  isCollapsed: boolean
  isGameFilter: boolean
  isDragging: boolean
  dragTransform: string
  filterMsg: string
  liveResults: number | undefined
  resultsCount: number
  config: ConfigInterface
  namesList: { name: string; total: number }[]
  connectCodesList: { name: string; total: number }[]
  namesLoading: boolean
  codesLoading: boolean
  hasParser: boolean
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
  isCollapsed,
  isGameFilter,
  isDragging,
  dragTransform,
  filterMsg,
  liveResults,
  resultsCount,
  config,
  namesList,
  connectCodesList,
  namesLoading,
  codesLoading,
  hasParser,
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
  return (
    <div
      data-filter-index={filterIndex}
      className={`filter ${isActive ? 'filter-active' : ''} ${
        isGameFilter ? 'filter-pinned' : ''
      } ${isCollapsed ? 'filter-collapsed' : ''} ${isDragging ? 'filter-dragging' : ''}`}
      style={dragTransform ? { transform: dragTransform } : undefined}
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
            {isRunning
              ? (liveResults ?? 0).toLocaleString()
              : (liveResults ?? resultsCount ?? 0).toLocaleString()}
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
        <FilterControls
          filter={filter}
          config={config}
          namesList={namesList}
          connectCodesList={connectCodesList}
          namesLoading={namesLoading}
          codesLoading={codesLoading}
          hasParser={hasParser}
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
        <button
          type="button"
          className={`filter-button${isRunning ? ' filter-button-stop' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            if (isRunning) onStop(filter.id, filterIndex)
            else onRun(filter)
          }}
        >
          {isRunning ? 'Stop' : 'Run'}
        </button>
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
    </div>
  )
}
