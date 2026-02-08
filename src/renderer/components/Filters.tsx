/* eslint-disable react/no-array-index-key */
/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import {
  ReactElement,
  MouseEvent,
  useState,
  Dispatch,
  SetStateAction,
  useEffect,
} from 'react'
import { cloneDeep } from 'lodash'
import '../styles/Filters.css'
import { filtersConfig } from 'constants/config'
import ipcBridge from '../ipcBridge'
import {
  FilterInterface,
  ShallowArchiveInterface,
  ShallowFilterInterface,
} from '../../constants/types'

type FiltersProps = {
  archive: ShallowArchiveInterface | null
  setArchive: Dispatch<SetStateAction<ShallowArchiveInterface | null>>
  activeFilterId: string
  setActiveFilterId: Dispatch<SetStateAction<string>>
}

export default function Filters({
  archive,
  setArchive,
  activeFilterId,
  setActiveFilterId,
}: FiltersProps) {
  const [runningFilters, setRunningFilters] = useState<Set<number>>(new Set())
  const [filterMsgs, setFilterMsgs] = useState<Record<string, string>>({})
  const [liveResults, setLiveResults] = useState<Record<string, number>>({})
  // Filters start collapsed by default — toggling sets them to expanded (false)
  const [expandedFilters, setExpandedFilters] = useState<Record<string, boolean>>({})

  useEffect(() => {
    const removeRunningListener = window.electron.ipcRenderer.on(
      'currentlyRunningFilter',
      (event: { running: number[] }) => {
        setRunningFilters(new Set(event.running))
      }
    )

    const removeUpdateListener = window.electron.ipcRenderer.on(
      'filterUpdate',
      (event: { filterId?: string; filterIndex?: number; total: number; current: number; results?: number }) => {
        const key = event.filterId || String(event.filterIndex ?? '')
        if (key) {
          setFilterMsgs((prev) => ({
            ...prev,
            [key]: `${event.current}/${event.total}`,
          }))
          if (event.results !== undefined) {
            setLiveResults((prev) => ({ ...prev, [key]: event.results as number }))
          }
        }
      }
    )

    return () => {
      removeRunningListener()
      removeUpdateListener()
    }
  }, [])

  function stopFilter(filterId: string, filterIndex: number) {
    setRunningFilters((prev) => {
      const next = new Set(prev)
      next.delete(filterIndex)
      return next
    })
    ipcBridge.stopFilter(filterId)
  }

  function stopAllFilters() {
    ipcBridge.stopRunningFilters()
  }

  function cancelAllFilters() {
    ipcBridge.cancelRunningFilters()
    ipcBridge.getArchive((nextArchive) => {
      setArchive(nextArchive || null)
    })
  }

  function runFilter(filter: ShallowFilterInterface) {
    if (!archive) return
    setFilterMsgs((prev) => {
      const updated = { ...prev }
      delete updated[filter.id]
      return updated
    })

    ipcBridge.runFilter(filter.id, (response) => {
      if (!response || response?.error) {
        console.log('Error: ', response.error)
        setFilterMsgs((prev) => ({
          ...prev,
          [filter.id]: response?.error || 'Error running filter',
        }))
        return
      }

      setArchive(response)
      // Clear live results for this filter
      setLiveResults((prev) => {
        const updated = { ...prev }
        delete updated[filter.id]
        return updated
      })
      // Show message from response, or clear
      setFilterMsgs((prev) => {
        const updated = { ...prev }
        const msg = response.filterMessage?.[filter.id]
        if (msg) {
          updated[filter.id] = msg
        } else {
          delete updated[filter.id]
        }
        return updated
      })
    })
  }

  function toggleFilterCollapse(
    event: MouseEvent<HTMLButtonElement>,
    filterId: string
  ) {
    event.stopPropagation()
    setExpandedFilters((prev) => ({
      ...prev,
      [filterId]: !prev[filterId],
    }))
  }

  function addFilter(e: any) {
    if (!setArchive) return
    const nextType = e.target.value
    ipcBridge.addFilter(nextType, (response) => {
      if (!response || response?.error) {
        console.log('addFilter response error:', response.error)
        return
      }
      setArchive(response)
    })
  }

  function updateFilter(
    newFilter: ShallowFilterInterface,
    previousFilter: ShallowFilterInterface
  ) {
    if (!archive) return
    const prevFilterIndex = archive.filters.indexOf(previousFilter)
    ipcBridge.updateFilter(
      {
        filterIndex: prevFilterIndex,
        newFilter,
      },
      (response) => {
        if (!response || response?.error) {
          console.log('updateFilter response error:', response.error)
          return
        }
        setArchive(response)
      }
    )
  }

  function deleteFilter(filter: FilterInterface) {
    ipcBridge.removeFilter(filter.id, (response) => {
      if (!response || response?.error) {
        console.log('removeFilter response error:', response.error)
        return
      }
      setArchive(response)
    })
  }

  function renderFilterControls(filter: ShallowFilterInterface) {
    const config = filtersConfig.find((entry) => entry.id === filter.type)
    if (!config || !config.options || config.options.length === 0) return null

    const gridOptions = config.options.filter(
      (o) => o.type !== 'nthMoves'
    )
    const nthMovesOption = config.options.find((o) => o.type === 'nthMoves')

    return (
      <div
        className="filter-controls"
      >
        {gridOptions.length > 0 && (
          <div className="filter-controls-grid">
            {gridOptions.map((option) => {
              let input: ReactElement | null = null
              const value = filter.params?.[option.id] ?? ''
              switch (option.type) {
                case 'textInput':
                case 'int':
                  input = (
                    <input
                      className="filter-control-input"
                      value={value}
                      placeholder="Any"
                      onChange={(event) => {
                        const filterClone = cloneDeep(filter)
                        filterClone.params[option.id] = event.target.value
                        updateFilter(filterClone, filter)
                      }}
                    />
                  )
                  break
                case 'dropdown':
                  input = (
                    <select
                      value={value}
                      className="filter-control-select"
                      onChange={(event) => {
                        const filterClone = cloneDeep(filter)
                        filterClone.params[option.id] = event.target.value
                        updateFilter(filterClone, filter)
                      }}
                    >
                      {filter.type === 'sort' ? null : (
                        <option value="">Any</option>
                      )}
                      {option.options?.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.shortName || entry.name}
                        </option>
                      ))}
                    </select>
                  )
                  break
                case 'checkbox':
                  input = (
                    <label className="filter-control-checkbox-wrap">
                      <input
                        type="checkbox"
                        className="filter-control-checkbox"
                        checked={!!filter.params?.[option.id]}
                        onChange={(event) => {
                          const filterClone = cloneDeep(filter)
                          filterClone.params[option.id] = event.target.checked
                          updateFilter(filterClone, filter)
                        }}
                      />
                      <span className="filter-control-checkbox-mark" />
                    </label>
                  )
                  break
                case 'checkbox-disabled':
                  input = (
                    <label className="filter-control-checkbox-wrap">
                      <input
                        type="checkbox"
                        className="filter-control-checkbox"
                        checked={!!filter.params?.[option.id]}
                        disabled
                      />
                      <span className="filter-control-checkbox-mark filter-control-checkbox-disabled" />
                    </label>
                  )
                  break
                default:
                  return null
              }
              return (
                <label className="filter-control" key={option.id}>
                  <span className="filter-control-label">{option.name}</span>
                  {input}
                </label>
              )
            })}
          </div>
        )}
        {nthMovesOption && (
          <div className="filter-nth-moves">
            <div className="filter-nth-moves-header">
              <span className="filter-control-label">{nthMovesOption.name}</span>
              <button
                type="button"
                className="filter-nth-add"
                onClick={() => {
                  const filterClone = cloneDeep(filter)
                  filterClone.params[nthMovesOption.id].push({
                    moveId: '',
                    n: '',
                    d: '',
                    t: '',
                  })
                  updateFilter(filterClone, filter)
                }}
              >
                + Add
              </button>
            </div>
            {(filter.params?.[nthMovesOption.id] || []).map(
              (
                move: { moveId: string; n: string; d: string; t: string },
                index: number
              ) => (
                <div key={index} className="filter-nth-row">
                  <label className="filter-nth-field">
                    <span className="filter-nth-field-label">N</span>
                    <input
                      className="filter-control-input filter-nth-input"
                      value={move.n}
                      onChange={(e) => {
                        const filterClone = cloneDeep(filter)
                        filterClone.params[nthMovesOption.id][index].n = e.target.value
                        updateFilter(filterClone, filter)
                      }}
                    />
                  </label>
                  <label className="filter-nth-field">
                    <span className="filter-nth-field-label">T</span>
                    <input
                      className="filter-control-input filter-nth-input"
                      value={move.t}
                      onChange={(e) => {
                        const filterClone = cloneDeep(filter)
                        filterClone.params[nthMovesOption.id][index].t = e.target.value
                        updateFilter(filterClone, filter)
                      }}
                    />
                  </label>
                  <label className="filter-nth-field">
                    <span className="filter-nth-field-label">D</span>
                    <input
                      className="filter-control-input filter-nth-input"
                      value={move.d}
                      onChange={(e) => {
                        const filterClone = cloneDeep(filter)
                        filterClone.params[nthMovesOption.id][index].d = e.target.value
                        updateFilter(filterClone, filter)
                      }}
                    />
                  </label>
                  <label className="filter-nth-field filter-nth-field-move">
                    <span className="filter-nth-field-label">Move</span>
                    <select
                      className="filter-control-select"
                      value={move.moveId}
                      onChange={(e) => {
                        const filterClone = cloneDeep(filter)
                        filterClone.params[nthMovesOption.id][index].moveId = e.target.value
                        updateFilter(filterClone, filter)
                      }}
                    >
                      <option value="">Any</option>
                      {nthMovesOption.options?.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.shortName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="filter-nth-delete"
                    onClick={() => {
                      const filterClone = cloneDeep(filter)
                      filterClone.params[nthMovesOption.id].splice(index, 1)
                      updateFilter(filterClone, filter)
                    }}
                  >
                    ✕
                  </button>
                </div>
              )
            )}
          </div>
        )}
      </div>
    )
  }

  function renderFilters() {
    if (!archive) return ''
    const entries = archive.filters.map((filter, index) => ({
      filter,
      index,
    }))
    const gameEntry = entries.find((entry) => entry.filter.type === 'files')
    const orderedEntries = gameEntry
      ? [gameEntry, ...entries.filter((entry) => entry !== gameEntry)]
      : entries
    return (
      <div className="filters-list">
        {orderedEntries.map((entry) => {
          const { filter, index } = entry
          const isGameFilter = entry === gameEntry
          const isActive = activeFilterId === filter.id
          const isRunning = runningFilters.has(index)
          const isCollapsed = !expandedFilters[filter.id]
          const filterMsg = filterMsgs[filter.id] || ''
          const resultsCount =
            filter.type === 'files' && !filter.isProcessed && archive
              ? archive.files
              : filter.results
          return (
            <div
              key={filter.id}
              className={`filter ${isActive ? 'filter-active' : ''} ${
                isGameFilter ? 'filter-pinned' : ''
              } ${isCollapsed ? 'filter-collapsed' : ''}`}
              onClick={() => setActiveFilterId(filter.id)}
            >
              <div className="filter-main">
                <div className="filter-title">{filter.label}</div>
                <div className="filter-meta">
                  <div className="filter-results">
                    Results: {isRunning
                      ? (liveResults[filter.id] ?? 0).toLocaleString()
                      : resultsCount}
                  </div>
                  {filterMsg ? (
                    <div className="filterMsg">{filterMsg}</div>
                  ) : (
                    ''
                  )}
                </div>
                {renderFilterControls(filter)}
              </div>
              <div className="filter-actions">
                <button
                  type="button"
                  className={`filter-button${isRunning ? ' filter-button-stop' : ''}`}
                  onClick={() => isRunning ? stopFilter(filter.id, index) : runFilter(filter)}
                >
                  {isRunning ? 'Stop' : 'Run'}
                </button>
                <div
                  className={`filterIsProcessed ${
                    !isRunning && filter.isProcessed
                      ? 'greenCheck'
                      : ''
                  }`}
                >
                  &#10004;
                </div>
                {isGameFilter ? (
                  <div className="filter-chip">Core</div>
                ) : (
                  <button
                    type="button"
                    className="filter-delete"
                    onClick={() => deleteFilter(filter)}
                    aria-label={`Delete ${filter.label}`}
                  >
                    ✕
                  </button>
                )}
                <button
                  type="button"
                  className="filter-toggle"
                  onClick={(event) => toggleFilterCollapse(event, filter.id)}
                  aria-label={isCollapsed ? 'Expand filter' : 'Collapse filter'}
                  title={isCollapsed ? 'Expand filter' : 'Collapse filter'}
                >
                  <span className="filter-toggle-icon" />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="filters">
      <div className="filters-header">
        <div className="filters-title">Filters</div>
        <div className="filters-subtitle">Stack your clips</div>
      </div>
      {archive ? renderFilters() : <div className="no-archive">Import replays to start.</div>}
      <div className="filters-footer">
        <select
          value="default"
          className="add-filter-dropdown"
          onChange={addFilter}
        >
          <option key="default" value="default" disabled>
            + Add Filter
          </option>
          {filtersConfig
            .filter((p) => p.id !== 'files')
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
        </select>
        {runningFilters.size > 0 ? (
          <>
            <button type="button" className="stopButton" onClick={stopAllFilters}>
              Stop All
            </button>
            <button type="button" className="cancelButton" onClick={cancelAllFilters}>
              Cancel All
            </button>
          </>
        ) : (
          ''
        )}
      </div>
    </div>
  )
}
