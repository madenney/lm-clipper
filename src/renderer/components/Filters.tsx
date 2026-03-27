/* eslint-disable react/jsx-no-bind */
/* eslint-disable react/no-array-index-key */
import {
  MouseEvent,
  DragEvent,
  useState,
  useRef,
  Dispatch,
  SetStateAction,
  useEffect,
} from 'react'
import '../styles/Filters.css'
import { filtersConfig } from 'constants/config'
import ipcBridge from '../ipcBridge'
import useIpcListener from '../hooks/useIpcListener'
import {
  ConfigInterface,
  FilterInterface,
  SavedCustomFilter,
  ShallowArchiveInterface,
  ShallowFilterInterface,
} from '../../constants/types'
import TemplateCatalog from './TemplateCatalog'
import FilterCard from './FilterCard'
import {
  FilterErrorModal,
  FilterLogsModal,
  ParserWarningModal,
} from './FilterModals'

type FiltersProps = {
  archive: ShallowArchiveInterface | null
  setArchive: Dispatch<SetStateAction<ShallowArchiveInterface | null>>
  activeFilterId: string
  setActiveFilterId: Dispatch<SetStateAction<string>>
  config: ConfigInterface
}

export default function Filters({
  archive,
  setArchive,
  activeFilterId,
  setActiveFilterId,
  config,
}: FiltersProps) {
  const [runningFilters, setRunningFilters] = useState<Set<number>>(new Set())
  const [filterMsgs, setFilterMsgs] = useState<Record<string, string>>({})
  const [liveResults, setLiveResults] = useState<Record<string, number>>({})
  const [expandedFilters, setExpandedFilters] = useState<
    Record<string, boolean>
  >({})
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [namesList, setNamesList] = useState<{ name: string; total: number }[]>(
    [],
  )
  const [namesLoading, setNamesLoading] = useState(true)
  const [connectCodesList, setConnectCodesList] = useState<
    { name: string; total: number }[]
  >([])
  const [codesLoading, setCodesLoading] = useState(true)
  const [parserWarning, setParserWarning] = useState<string[] | null>(null)
  const [filterError, setFilterError] = useState<{
    filterLabel: string
    errors: string[]
  } | null>(null)
  const [filterLogs, setFilterLogs] = useState<{
    filterLabel: string
    logs: string[]
  } | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [dragWarning, setDragWarning] = useState<string | null>(null)
  const dragIndexRef = useRef<number | null>(null)
  const dropIndexRef = useRef<number | null>(null)
  const dragHeightRef = useRef(0)
  const dragWarningTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const filtersListRef = useRef<HTMLDivElement>(null)
  const cardMidYs = useRef<{ index: number; midY: number }[]>([])
  const dropdownRef = useRef<HTMLDivElement>(null)
  const dragAllowedRef = useRef(true)

  useEffect(() => {
    return () => {
      if (dragWarningTimer.current) clearTimeout(dragWarningTimer.current)
    }
  }, [])

  useIpcListener('currentlyRunningFilter', (event: { running: number[] }) => {
    const next = new Set(event.running)
    setRunningFilters((prev) => {
      const stopped: number[] = []
      prev.forEach((idx) => {
        if (!next.has(idx)) stopped.push(idx)
      })
      if (stopped.length > 0) {
        setFilterMsgs((msgs) => {
          const updated = { ...msgs }
          for (const key of Object.keys(updated)) {
            if (/^\d+\/\d+$/.test(updated[key])) {
              delete updated[key]
            }
          }
          return updated
        })
      }
      return next
    })
  })

  useIpcListener(
    'filterUpdate',
    (event: {
      filterId?: string
      filterIndex?: number
      total: number
      current: number
      results?: number
    }) => {
      const key = event.filterId || String(event.filterIndex ?? '')
      if (key) {
        setFilterMsgs((prev) => ({
          ...prev,
          [key]: `${event.current}/${event.total}`,
        }))
        if (event.results !== undefined) {
          setLiveResults((prev) => ({
            ...prev,
            [key]: event.results as number,
          }))
        }
      }
    },
  )

  useIpcListener(
    'filterError',
    (event: { filterId: string; filterLabel: string; errors: string[] }) => {
      setFilterError({
        filterLabel: event.filterLabel,
        errors: event.errors,
      })
    },
  )

  useIpcListener(
    'filterLogs',
    (event: { filterId: string; filterLabel: string; logs: string[] }) => {
      setFilterLogs({
        filterLabel: event.filterLabel,
        logs: event.logs,
      })
    },
  )

  useIpcListener('code-editor-saved', (shallowArchive: any) => {
    if (shallowArchive) setArchive(shallowArchive)
  })

  useEffect(() => {
    const handleClickOutside = (event: Event) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [])

  useEffect(() => {
    if (!archive) return
    setNamesLoading(true)
    setCodesLoading(true)
    // Queries run in a worker thread so the main process stays responsive.
    ipcBridge.getNames((names) => {
      setNamesList(names || [])
      setNamesLoading(false)
    })
    ipcBridge.getConnectCodes((codes) => {
      setConnectCodesList(codes || [])
      setCodesLoading(false)
    })
  }, [archive?.path])

  function stopFilter(filterId: string, filterIndex: number) {
    setRunningFilters((prev) => {
      const next = new Set(prev)
      next.delete(filterIndex)
      return next
    })
    ipcBridge.stopFilter(filterId)
  }

  function runFilter(filter: ShallowFilterInterface) {
    if (!archive) return
    setActiveFilterId(filter.id)
    setFilterMsgs((prev) => {
      const updated = { ...prev }
      delete updated[filter.id]
      return updated
    })

    ipcBridge.runFilter(filter.id, (response) => {
      if (!response || response?.error) {
        console.error('Error: ', response.error)
        setFilterMsgs((prev) => ({
          ...prev,
          [filter.id]: response?.error || 'Error running filter',
        }))
        return
      }

      setArchive(response)
      // Clear running state immediately so results display switches to final count
      // Use response.filters (fresh) instead of archive.filters (stale closure)
      const fIdx = response?.filters?.findIndex(
        (f: ShallowFilterInterface) => f.id === filter.id,
      )
      if (fIdx != null && fIdx >= 0) {
        setRunningFilters((prev) => {
          const next = new Set(prev)
          next.delete(fIdx)
          return next
        })
      }
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

  function resumeFilterRun(filter: ShallowFilterInterface) {
    if (!archive) return
    setFilterMsgs((prev) => {
      const updated = { ...prev }
      delete updated[filter.id]
      return updated
    })

    ipcBridge.resumeFilter(filter.id, (response) => {
      if (!response || response?.error) {
        console.error('Error: ', response.error)
        setFilterMsgs((prev) => ({
          ...prev,
          [filter.id]: response?.error || 'Error resuming filter',
        }))
        return
      }

      setArchive(response)
      // Use response.filters (fresh) instead of archive.filters (stale closure)
      const fIdx = response?.filters?.findIndex(
        (f: ShallowFilterInterface) => f.id === filter.id,
      )
      if (fIdx != null && fIdx >= 0) {
        setRunningFilters((prev) => {
          const next = new Set(prev)
          next.delete(fIdx)
          return next
        })
      }
      setLiveResults((prev) => {
        const updated = { ...prev }
        delete updated[filter.id]
        return updated
      })
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

  function dismissResume(filter: ShallowFilterInterface) {
    console.log('[dismissResume] sending for filter:', filter.id)
    ipcBridge.dismissFilterResume(filter.id, (response) => {
      console.log('[dismissResume] response:', response)
      if (!response || response?.error) {
        console.error('dismissFilterResume error:', response?.error)
        return
      }
      const stillResumable = response?.filters?.filter((f: any) => f.resumable)
      console.log(
        '[dismissResume] still resumable:',
        stillResumable?.map((f: any) => ({
          id: f.id,
          label: f.label,
          resumable: f.resumable,
        })),
      )
      setArchive(response)
    })
  }

  function toggleFilterCollapse(
    event: MouseEvent<HTMLButtonElement>,
    filterId: string,
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
        console.error('addFilter response error:', response.error)
        return
      }
      // Auto-expand the newly added filter
      const newFilter = response.filters?.[response.filters.length - 1]
      if (newFilter) {
        setExpandedFilters((prev) => ({ ...prev, [newFilter.id]: true }))
      }
      setArchive(response)
    })
  }

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function updateFilter(
    newFilter: ShallowFilterInterface,
    previousFilter: ShallowFilterInterface,
  ) {
    if (!archive) return
    const filterIndex = archive.filters.indexOf(previousFilter)

    // Optimistic local update -- instant UI, preserve results display
    const nextFilters = [...archive.filters]
    nextFilters[filterIndex] = newFilter
    setArchive({ ...archive, filters: nextFilters })

    // Debounce the IPC save
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      ipcBridge.updateFilter({ filterIndex, newFilter }, (response) => {
        if (!response || response?.error) {
          console.error('updateFilter response error:', response?.error)
          return
        }
        setArchive(response)
      })
    }, 300)
  }

  function deleteFilter(filter: FilterInterface) {
    if (filter.type === 'slpParser' && archive) {
      const dependentTypes = new Set(['comboFilter', 'reverse'])
      const dependents = archive.filters.filter((f) =>
        dependentTypes.has(f.type),
      )
      if (dependents.length > 0) {
        setParserWarning(dependents.map((f) => f.label))
        return
      }
      const idx = archive.filters.findIndex((f) => f.id === filter.id)
      const inputCount = filter.isProcessed
        ? idx > 0
          ? archive.filters[idx - 1].results
          : archive.files
        : 0
      if (
        config.warnOnParserDelete !== false &&
        inputCount >= 10000 &&
        // eslint-disable-next-line no-alert
        !window.confirm(
          `This combo parser was run on ${inputCount.toLocaleString()} files. Are you sure you want to delete it?`,
        )
      ) {
        return
      }
    }
    ipcBridge.removeFilter(filter.id, (response) => {
      if (!response || response?.error) {
        console.error('removeFilter response error:', response.error)
        return
      }
      setArchive(response)
    })
  }

  const parserDependents = new Set(['comboFilter', 'reverse'])

  function canDropAt(
    filters: ShallowFilterInterface[],
    from: number,
    to: number,
  ): string | true | false {
    // Can't drop at pinned game filter position
    if (to === 0) return false
    // No-op: dropping in same position
    if (from === to || to === from + 1) return false

    // Simulate the final order
    const types = filters.map((f) => f.type)
    const movedType = types[from]
    const [moved] = types.splice(from, 1)
    const insertAt = to > from ? to - 1 : to
    types.splice(insertAt, 0, moved)

    // Validate: every dependent must appear after the parser
    const parserPos = types.indexOf('slpParser')
    if (parserPos >= 0) {
      for (let i = 0; i < parserPos; i += 1) {
        if (parserDependents.has(types[i])) {
          if (movedType === 'slpParser') {
            return 'Combo parser must stay above dependent filters'
          }
          return 'This filter requires the combo parser above it'
        }
      }
    }

    return true
  }

  function handleDrop(from: number, to: number) {
    if (!archive || from === to) {
      setDragIndex(null)
      setDropIndex(null)
      return
    }
    ipcBridge.reorderFilter({ fromIndex: from, toIndex: to }, (response) => {
      if (!response || response?.error) {
        console.error('reorderFilter error:', response?.error)
      } else {
        setArchive(response)
      }
      // Clear drag state in same batch as archive update -- no flash
      setDragIndex(null)
      setDropIndex(null)
    })
  }

  function measureCardPositions() {
    if (!filtersListRef.current) return
    const positions: { index: number; midY: number }[] = []
    const children = filtersListRef.current.children
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i] as HTMLElement
      const idx = parseInt(child.dataset.filterIndex || '', 10)
      if (Number.isNaN(idx)) continue
      const r = child.getBoundingClientRect()
      positions.push({ index: idx, midY: r.top + r.height / 2 })
    }
    cardMidYs.current = positions
  }

  function handleContainerDragOver(e: DragEvent<HTMLDivElement>) {
    if (dragIndexRef.current === null || !archive) return
    const mouseY = e.clientY
    const positions = cardMidYs.current

    // Find insertion index based on stored original midpoints
    let targetIndex =
      positions.length > 0 ? positions[positions.length - 1].index + 1 : 0
    for (const pos of positions) {
      if (mouseY < pos.midY) {
        targetIndex = pos.index
        break
      }
    }

    const result = canDropAt(archive.filters, dragIndexRef.current, targetIndex)
    if (result === true) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      dropIndexRef.current = targetIndex
      setDropIndex(targetIndex)
    } else {
      dropIndexRef.current = null
      setDropIndex(null)
      // Show warning toast for constraint violations (string reasons)
      if (typeof result === 'string') {
        setDragWarning(result)
        if (dragWarningTimer.current) clearTimeout(dragWarningTimer.current)
        dragWarningTimer.current = setTimeout(() => {
          setDragWarning(null)
          dragWarningTimer.current = null
        }, 1500)
      }
    }
  }

  function dismissFilterMsg(filterId: string) {
    setFilterMsgs((prev) => {
      const updated = { ...prev }
      delete updated[filterId]
      return updated
    })
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
      <div
        className="filters-list"
        ref={filtersListRef}
        onDragOver={handleContainerDragOver}
      >
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
          const isDragging = dragIndex === index

          const hasParser = archive.filters
            .slice(0, index)
            .some((f) => f.type === 'slpParser')

          // Compute translateY shift for live reorder preview
          let dragTransform = ''
          if (dragIndex !== null && dropIndex !== null && !isDragging) {
            const shift = dragHeightRef.current + 10 // 10 = gap
            if (
              dropIndex > dragIndex + 1 &&
              index > dragIndex &&
              index < dropIndex
            ) {
              dragTransform = `translateY(${-shift}px)`
            } else if (
              dropIndex < dragIndex &&
              index >= dropIndex &&
              index < dragIndex
            ) {
              dragTransform = `translateY(${shift}px)`
            }
          }

          return (
            <FilterCard
              key={filter.id}
              filter={filter}
              filterIndex={index}
              isActive={isActive}
              isRunning={isRunning}
              isCollapsed={isCollapsed}
              isGameFilter={!!isGameFilter}
              isDragging={isDragging}
              dragTransform={dragTransform}
              filterMsg={filterMsg}
              liveResults={liveResults[filter.id]}
              resultsCount={resultsCount}
              config={config}
              namesList={namesList}
              connectCodesList={connectCodesList}
              namesLoading={namesLoading}
              codesLoading={codesLoading}
              hasParser={hasParser}
              onToggleCollapse={toggleFilterCollapse}
              onClick={() => setActiveFilterId(filter.id)}
              onDoubleClick={() => {
                if (!expandedFilters[filter.id]) {
                  setExpandedFilters((prev) => ({
                    ...prev,
                    [filter.id]: true,
                  }))
                }
              }}
              onRun={runFilter}
              onStop={stopFilter}
              onResume={resumeFilterRun}
              onDismissResume={dismissResume}
              onDelete={deleteFilter}
              onUpdate={updateFilter}
              onDismissMsg={dismissFilterMsg}
              draggable={!isGameFilter}
              onMouseDown={(e) => {
                const tag = (e.target as HTMLElement).tagName
                dragAllowedRef.current =
                  tag !== 'INPUT' &&
                  tag !== 'SELECT' &&
                  tag !== 'TEXTAREA' &&
                  tag !== 'BUTTON'
              }}
              onDragStart={(e: DragEvent<HTMLDivElement>) => {
                if (isGameFilter || !dragAllowedRef.current) {
                  e.preventDefault()
                  return
                }
                dragIndexRef.current = index
                dragHeightRef.current =
                  e.currentTarget.getBoundingClientRect().height
                measureCardPositions()
                setDragIndex(index)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={() => {
                const dIdx = dragIndexRef.current
                const drIdx = dropIndexRef.current
                dragIndexRef.current = null
                dropIndexRef.current = null
                if (dragWarningTimer.current) {
                  clearTimeout(dragWarningTimer.current)
                  dragWarningTimer.current = null
                }
                setDragWarning(null)
                if (dIdx !== null && drIdx !== null && dIdx !== drIdx) {
                  const to = drIdx > dIdx ? drIdx - 1 : drIdx
                  // handleDrop clears drag state after IPC response
                  handleDrop(dIdx, to)
                } else {
                  // No valid drop -- clear state immediately
                  setDragIndex(null)
                  setDropIndex(null)
                }
              }}
            />
          )
        })}
      </div>
    )
  }

  return (
    <div className="filters">
      <div className="filters-header">
        <div className="filters-title">Filters</div>
        {archive && (
          <div className="filters-file-count">
            {archive.files.toLocaleString()} SLP files
          </div>
        )}
      </div>
      {archive ? (
        renderFilters()
      ) : (
        <div className="no-archive">Import replays to start.</div>
      )}
      <div className="filters-footer">
        <div className="add-filter-dropdown-wrap" ref={dropdownRef}>
          <button
            type="button"
            className="add-filter-dropdown"
            onClick={() => setDropdownOpen((prev) => !prev)}
          >
            + Add Filter
          </button>
          {dropdownOpen && (
            <div className="add-filter-menu">
              {(() => {
                const hasParser = archive?.filters.some(
                  (f) => f.type === 'slpParser',
                )
                const requiresParserId = new Set([
                  'comboFilter',
                  'reverse',
                  'zeroToDeaths',
                ])
                const hiddenFilters = new Set(['edgeguard', 'zeroToDeaths'])
                return filtersConfig
                  .filter((p) => p.id !== 'files' && !hiddenFilters.has(p.id))
                  .flatMap((p) => {
                    const needsParser = requiresParserId.has(p.id) && !hasParser
                    const items = [
                      <div
                        key={p.id}
                        className={`add-filter-item${needsParser ? ' add-filter-item-disabled' : ''}`}
                        title={(p as any).tooltip || ''}
                        role="menuitem"
                        tabIndex={0}
                        onClick={() => {
                          if (needsParser) return
                          addFilter({ target: { value: p.id } })
                          setDropdownOpen(false)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            if (needsParser) return
                            addFilter({ target: { value: p.id } })
                            setDropdownOpen(false)
                          }
                        }}
                      >
                        {p.label}
                        {needsParser && (
                          <span className="add-filter-hint">
                            {' '}
                            - requires combo parser first
                          </span>
                        )}
                      </div>,
                    ]
                    if (p.id === 'sort') {
                      items.push(
                        <div key="divider" className="add-filter-divider" />,
                      )
                    }
                    return items
                  })
              })()}
              <div
                className="add-filter-item add-filter-item-browse"
                role="menuitem"
                tabIndex={0}
                onClick={() => {
                  setDropdownOpen(false)
                  setCatalogOpen(true)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setDropdownOpen(false)
                    setCatalogOpen(true)
                  }
                }}
              >
                Browse Templates...
              </div>
            </div>
          )}
        </div>
      </div>
      {dragWarning && <div className="drag-warning-toast">{dragWarning}</div>}
      {parserWarning && (
        <ParserWarningModal
          parserWarning={parserWarning}
          onDismiss={() => setParserWarning(null)}
        />
      )}
      {catalogOpen && (
        <TemplateCatalog
          templates={config.savedCustomFilters || []}
          hasParser={
            archive?.filters.some((f) => f.type === 'slpParser') ?? false
          }
          onClose={() => setCatalogOpen(false)}
          onSelect={(tmpl: SavedCustomFilter) => {
            setCatalogOpen(false)
            // Find the index of this template in savedCustomFilters
            const allTemplates = config.savedCustomFilters || []
            const idx = allTemplates.findIndex(
              (t) => t.name === tmpl.name && t.code === tmpl.code,
            )
            if (idx >= 0) {
              addFilter({ target: { value: `customTemplate:${idx}` } })
            } else {
              // User template or unknown -- add as plain custom with code
              addFilter({ target: { value: `customTemplate:${idx}` } })
            }
          }}
        />
      )}
      {filterError && (
        <FilterErrorModal
          filterError={filterError}
          onDismiss={() => setFilterError(null)}
        />
      )}
      {filterLogs && (
        <FilterLogsModal
          filterLogs={filterLogs}
          onDismiss={() => setFilterLogs(null)}
        />
      )}
    </div>
  )
}
