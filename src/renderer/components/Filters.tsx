/* eslint-disable react/no-array-index-key */
/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import {
  ReactElement,
  MouseEvent,
  DragEvent,
  useState,
  useRef,
  Dispatch,
  SetStateAction,
  useEffect,
} from 'react'
import { cloneDeep } from 'lodash'
import '../styles/Filters.css'
import { filtersConfig } from 'constants/config'
import ipcBridge from '../ipcBridge'
import {
  ConfigInterface,
  FilterInterface,
  ShallowArchiveInterface,
  ShallowFilterInterface,
} from '../../constants/types'

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
  const [multiOpen, setMultiOpen] = useState<string | null>(null)
  const [multiPos, setMultiPos] = useState<{
    top: number
    left: number
    width: number
    maxHeight: number
    flip: boolean
  } | null>(null)
  const [namesList, setNamesList] = useState<{ name: string; total: number }[]>(
    [],
  )
  const [expandedNthRows, setExpandedNthRows] = useState<Set<string>>(new Set())
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [parserWarning, setParserWarning] = useState<string[] | null>(null)
  const [filterError, setFilterError] = useState<{
    filterLabel: string
    errors: string[]
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
  const multiLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const removeRunningListener = window.electron.ipcRenderer.on(
      'currentlyRunningFilter',
      (event: { running: number[] }) => {
        const next = new Set(event.running)
        setRunningFilters((prev) => {
          // Find indices that stopped running and clear their messages
          const stopped: number[] = []
          prev.forEach((idx) => {
            if (!next.has(idx)) stopped.push(idx)
          })
          if (stopped.length > 0) {
            setFilterMsgs((msgs) => {
              const updated = { ...msgs }
              // Clear progress messages for stopped filters
              for (const key of Object.keys(updated)) {
                // Messages are keyed by filterId; we can't map idx→id here,
                // so just clear all progress-shaped messages (e.g. "123/456")
                if (/^\d+\/\d+$/.test(updated[key])) {
                  delete updated[key]
                }
              }
              return updated
            })
          }
          return next
        })
      },
    )

    const removeUpdateListener = window.electron.ipcRenderer.on(
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

    const removeErrorListener = window.electron.ipcRenderer.on(
      'filterError',
      (event: { filterId: string; filterLabel: string; errors: string[] }) => {
        setFilterError({
          filterLabel: event.filterLabel,
          errors: event.errors,
        })
      },
    )

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
      removeRunningListener()
      removeUpdateListener()
      removeErrorListener()
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [])

  useEffect(() => {
    if (!archive) return
    ipcBridge.getNames((names) => {
      setNamesList(names || [])
    })
  }, [archive?.files])

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
      // Clear running state immediately so results display switches to final count
      const filterIndex = archive?.filters.findIndex((f) => f.id === filter.id)
      if (filterIndex != null && filterIndex >= 0) {
        setRunningFilters((prev) => {
          const next = new Set(prev)
          next.delete(filterIndex)
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
        console.log('addFilter response error:', response.error)
        return
      }
      setArchive(response)
    })
  }

  function updateFilter(
    newFilter: ShallowFilterInterface,
    previousFilter: ShallowFilterInterface,
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
      },
    )
  }

  function deleteFilter(filter: FilterInterface) {
    if (filter.type === 'slpParser' && archive) {
      const dependentTypes = new Set(['comboFilter', 'reverse', 'edgeguard'])
      const dependents = archive.filters.filter((f) =>
        dependentTypes.has(f.type),
      )
      if (dependents.length > 0) {
        setParserWarning(dependents.map((f) => f.label))
        return
      }
      const idx = archive.filters.findIndex((f) => f.id === filter.id)
      const inputCount =
        idx > 0 ? archive.filters[idx - 1].results : archive.files
      if (
        config.warnOnParserDelete !== false &&
        inputCount >= 10000 &&
        !window.confirm(
          `This combo parser was run on ${inputCount.toLocaleString()} files. Are you sure you want to delete it?`,
        )
      ) {
        return
      }
    }
    ipcBridge.removeFilter(filter.id, (response) => {
      if (!response || response?.error) {
        console.log('removeFilter response error:', response.error)
        return
      }
      setArchive(response)
    })
  }

  const parserDependents = new Set(['comboFilter', 'reverse', 'edgeguard'])

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
        console.log('reorderFilter error:', response?.error)
      } else {
        setArchive(response)
      }
      // Clear drag state in same batch as archive update — no flash
      setDragIndex(null)
      setDropIndex(null)
    })
  }

  const positionPresets = [
    { label: 'First move', value: '0' },
    { label: 'Second move', value: '1' },
    { label: 'Third move', value: '2' },
    { label: 'Last move', value: '-1' },
    { label: 'Second to last', value: '-2' },
    { label: 'Third to last', value: '-3' },
    { label: 'Every move', value: 'e' },
  ]
  const presetValues = new Set(positionPresets.map((p) => p.value))
  presetValues.add('')

  function isCustomN(n: string) {
    if (n === '') return false
    const parts = n.split(',').map((v) => v.trim())
    return parts.includes('__custom__')
  }

  function renderPositionDropdown(
    filter: ShallowFilterInterface,
    nthMovesOption: any,
    move: any,
    index: number,
  ) {
    const key = `${filter.id}:pos:${index}`
    const isOpen = multiOpen === key
    const currentValues = move.n
      ? String(move.n).split(',').map((v: string) => v.trim()).filter(Boolean)
      : []
    const selectedSet = new Set(currentValues)
    const displayVals = currentValues.filter((v: string) => v !== '__custom__')
    const hasCustom = selectedSet.has('__custom__')
    const presetLabel = positionPresets
      .filter((p) => selectedSet.has(p.value))
      .map((p) => p.label)
      .join(', ')
    const label =
      displayVals.length === 0 && !hasCustom
        ? 'Any'
        : [presetLabel, hasCustom ? 'Custom' : ''].filter(Boolean).join(', ') || displayVals.join(', ')

    const allPosOptions = [
      ...positionPresets,
      { label: 'Custom', value: '__custom__' },
    ]

    return (
      <div className="filter-multi-wrap">
        <button
          type="button"
          className="filter-multi-select"
          onClick={(e) => {
            e.stopPropagation()
            if (isOpen) {
              setMultiOpen(null)
              setMultiPos(null)
            } else {
              const rect = e.currentTarget.getBoundingClientRect()
              const spaceBelow = window.innerHeight - rect.bottom - 28
              const spaceAbove = rect.top - 28
              const flip = spaceBelow < 120 && spaceAbove > spaceBelow
              setMultiPos({
                top: flip ? rect.top - 4 : rect.bottom + 4,
                left: rect.left,
                width: Math.max(rect.width, 160),
                maxHeight: Math.min(240, flip ? spaceAbove : spaceBelow),
                flip,
              })
              setMultiOpen(key)
            }
          }}
        >
          {label}
        </button>
        {isOpen && multiPos && (
          <>
            <div
              className="filter-multi-backdrop"
              onClick={(e) => {
                e.stopPropagation()
                setMultiOpen(null)
                setMultiPos(null)
              }}
            />
            <div
              className="filter-multi-menu"
              style={{
                position: 'fixed',
                ...(multiPos.flip
                  ? { bottom: window.innerHeight - multiPos.top }
                  : { top: multiPos.top }),
                left: multiPos.left,
                width: multiPos.width,
                maxHeight: multiPos.maxHeight,
              }}
              onMouseEnter={() => {
                if (multiLeaveTimer.current) {
                  clearTimeout(multiLeaveTimer.current)
                  multiLeaveTimer.current = null
                }
              }}
              onMouseLeave={() => {
                multiLeaveTimer.current = setTimeout(() => {
                  setMultiOpen(null)
                  setMultiPos(null)
                }, 300)
              }}
            >
              {allPosOptions.map((p) => {
                const checked = selectedSet.has(p.value)
                return (
                  <div
                    key={p.value}
                    className={`filter-multi-item${checked ? ' filter-multi-item-checked' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      let next: string[]
                      if (p.value === '__custom__') {
                        // Custom: toggle it, clear all presets
                        next = checked ? [] : ['__custom__']
                      } else {
                        // Preset: toggle it, clear custom
                        const withoutCustom = currentValues.filter((v: string) => v !== '__custom__')
                        next = checked
                          ? withoutCustom.filter((v: string) => v !== p.value)
                          : [...withoutCustom, p.value]
                      }
                      const filterClone = cloneDeep(filter)
                      filterClone.params[nthMovesOption.id][index].n =
                        next.join(',')
                      updateFilter(filterClone, filter)
                    }}
                  >
                    <span className="filter-multi-check">
                      {checked ? '\u2714' : ''}
                    </span>
                    <span>{p.label}</span>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    )
  }

  function renderNthMoves(filter: ShallowFilterInterface, nthMovesOption: any) {
    const advanced = !!config.advancedMode
    const moves = filter.params?.[nthMovesOption.id] || []

    return (
      <div className="filter-nth-moves">
        <div className="filter-nth-moves-header">
          <span
            className="filter-control-label"
            title="Filter combos by specific moves at specific positions. e.g. require a combo to start with an up-throw, end with a knee, etc."
          >
            {nthMovesOption.name}
          </span>
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
                dMode: 'min',
                tMin: '',
              })
              updateFilter(filterClone, filter)
            }}
          >
            + Add
          </button>
        </div>
        {moves.map((move: any, index: number) =>
          advanced
            ? renderNthRowAdvanced(filter, nthMovesOption, move, index)
            : renderNthRowFriendly(filter, nthMovesOption, move, index),
        )}
      </div>
    )
  }

  function renderNthRowAdvanced(
    filter: ShallowFilterInterface,
    nthMovesOption: any,
    move: any,
    index: number,
  ) {
    return (
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
          <span className="filter-nth-field-label">T Max</span>
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
          <span className="filter-nth-field-label">T Min</span>
          <input
            className="filter-control-input filter-nth-input"
            value={move.tMin || ''}
            onChange={(e) => {
              const filterClone = cloneDeep(filter)
              filterClone.params[nthMovesOption.id][index].tMin = e.target.value
              updateFilter(filterClone, filter)
            }}
          />
        </label>
        <label className="filter-nth-field">
          <span className="filter-nth-field-label">D</span>
          <div className="filter-nth-damage-row">
            <select
              className="filter-nth-select-small"
              value={move.dMode || 'min'}
              onChange={(e) => {
                const filterClone = cloneDeep(filter)
                filterClone.params[nthMovesOption.id][index].dMode =
                  e.target.value
                updateFilter(filterClone, filter)
              }}
            >
              <option value="min">Min</option>
              <option value="max">Max</option>
            </select>
            <input
              className="filter-control-input filter-nth-input"
              value={move.d}
              onChange={(e) => {
                const filterClone = cloneDeep(filter)
                filterClone.params[nthMovesOption.id][index].d = e.target.value
                updateFilter(filterClone, filter)
              }}
            />
          </div>
        </label>
        <div className="filter-nth-field filter-nth-field-move">
          <span className="filter-nth-field-label">Move</span>
          {renderMultiDropdown(
            `${filter.id}:nth:${index}`,
            'moveId',
            nthMovesOption.options || [],
            Array.isArray(move.moveId)
              ? move.moveId
              : move.moveId
                ? [move.moveId]
                : [],
            (next) => {
              const filterClone = cloneDeep(filter)
              filterClone.params[nthMovesOption.id][index].moveId = next
              updateFilter(filterClone, filter)
            },
          )}
        </div>
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
  }

  function renderNthRowFriendly(
    filter: ShallowFilterInterface,
    nthMovesOption: any,
    move: any,
    index: number,
  ) {
    const showCustomInput = isCustomN(move.n)
    const nthRowKey = `${filter.id}:${index}`
    const isNthExpanded = expandedNthRows.has(nthRowKey)
    const hasExtra = !!(move.tMin || move.t || move.d || move.dMax)

    return (
      <div key={index} className="filter-nth-row-wrap">
        <div className="filter-nth-row">
          <div className="filter-nth-field filter-nth-field-move">
            <span className="filter-nth-field-label">Position</span>
            <div className={showCustomInput ? 'filter-nth-pos-row' : undefined}>
              {renderPositionDropdown(filter, nthMovesOption, move, index)}
              {showCustomInput && (
                <input
                  className="filter-control-input filter-nth-pos-custom-input"
                  value={String(move.n || '').split(',').map((v: string) => v.trim()).filter((v: string) => v !== '__custom__' && !presetValues.has(v)).join(',')}
                  placeholder="e.g. 3,4,-4"
                  title="Move index (0-based). Positive = from start, negative = from end. Comma-separate for multiple (e.g. 0,2,-1)."
                  onChange={(e) => {
                    const kept = String(move.n || '').split(',').map((v: string) => v.trim()).filter((v: string) => v === '__custom__' || presetValues.has(v))
                    const customVals = e.target.value
                      ? e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean)
                      : []
                    const filterClone = cloneDeep(filter)
                    filterClone.params[nthMovesOption.id][index].n =
                      [...kept, ...customVals].join(',')
                    updateFilter(filterClone, filter)
                  }}
                />
              )}
            </div>
          </div>
          <div className="filter-nth-field filter-nth-field-move">
            <span className="filter-nth-field-label">Move</span>
            {renderMultiDropdown(
              `${filter.id}:nth:${index}`,
              'moveId',
              nthMovesOption.options || [],
              Array.isArray(move.moveId)
                ? move.moveId
                : move.moveId
                  ? [move.moveId]
                  : [],
              (next) => {
                const filterClone = cloneDeep(filter)
                filterClone.params[nthMovesOption.id][index].moveId = next
                updateFilter(filterClone, filter)
              },
            )}
          </div>
          <button
            type="button"
            className={`filter-nth-extra-toggle${hasExtra ? ' filter-nth-extra-toggle-active' : ''}`}
            onClick={() => {
              setExpandedNthRows((prev) => {
                const next = new Set(prev)
                if (next.has(nthRowKey)) next.delete(nthRowKey)
                else next.add(nthRowKey)
                return next
              })
            }}
            title="Gap & damage options"
          >
            &#x2699;
          </button>
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
        {isNthExpanded && (
          <div className="filter-nth-extra">
            <label
              className="filter-nth-field"
              title="Minimum frame gap between this move and the previous move"
            >
              <span className="filter-nth-field-label">Min Gap</span>
              <input
                className="filter-control-input filter-nth-input"
                value={move.tMin || ''}
                placeholder="f"
                onChange={(e) => {
                  const filterClone = cloneDeep(filter)
                  filterClone.params[nthMovesOption.id][index].tMin =
                    e.target.value
                  updateFilter(filterClone, filter)
                }}
              />
            </label>
            <label
              className="filter-nth-field"
              title="Maximum frame gap between this move and the previous move"
            >
              <span className="filter-nth-field-label">Max Gap</span>
              <input
                className="filter-control-input filter-nth-input"
                value={move.t}
                placeholder="f"
                onChange={(e) => {
                  const filterClone = cloneDeep(filter)
                  filterClone.params[nthMovesOption.id][index].t =
                    e.target.value
                  updateFilter(filterClone, filter)
                }}
              />
            </label>
            <label
              className="filter-nth-field"
              title="Minimum damage this move must deal"
            >
              <span className="filter-nth-field-label">Min Dmg</span>
              <input
                className="filter-control-input filter-nth-input"
                value={move.d || ''}
                placeholder="%"
                onChange={(e) => {
                  const filterClone = cloneDeep(filter)
                  filterClone.params[nthMovesOption.id][index].d =
                    e.target.value
                  updateFilter(filterClone, filter)
                }}
              />
            </label>
            <label
              className="filter-nth-field"
              title="Maximum damage this move can deal"
            >
              <span className="filter-nth-field-label">Max Dmg</span>
              <input
                className="filter-control-input filter-nth-input"
                value={move.dMax || ''}
                placeholder="%"
                onChange={(e) => {
                  const filterClone = cloneDeep(filter)
                  filterClone.params[nthMovesOption.id][index].dMax =
                    e.target.value
                  updateFilter(filterClone, filter)
                }}
              />
            </label>
          </div>
        )}
      </div>
    )
  }

  function renderMultiDropdown(
    filterId: string,
    optionId: string,
    options: any[],
    selected: any[],
    onChange: (_next: any[]) => void,
  ) {
    const key = `${filterId}:${optionId}`
    const isOpen = multiOpen === key
    const selectedSet = new Set(
      (Array.isArray(selected) ? selected : selected ? [selected] : []).map(
        String,
      ),
    )
    const label =
      selectedSet.size === 0
        ? 'Any'
        : [...new Set(
            options
              .filter((o) => selectedSet.has(String(o.id)))
              .map((o) => o.name || o.shortName),
          )].join(', ')

    return (
      <div className="filter-multi-wrap">
        <button
          type="button"
          className="filter-multi-select"
          onClick={(e) => {
            e.stopPropagation()
            if (isOpen) {
              setMultiOpen(null)
              setMultiPos(null)
            } else {
              const rect = e.currentTarget.getBoundingClientRect()
              const spaceBelow = window.innerHeight - rect.bottom - 28
              const spaceAbove = rect.top - 28
              const flip = spaceBelow < 120 && spaceAbove > spaceBelow
              setMultiPos({
                top: flip ? rect.top - 4 : rect.bottom + 4,
                left: rect.left,
                width: Math.max(rect.width, 160),
                maxHeight: Math.min(240, flip ? spaceAbove : spaceBelow),
                flip,
              })
              setMultiOpen(key)
            }
          }}
        >
          {label}
        </button>
        {isOpen && multiPos && (
          <>
            <div
              className="filter-multi-backdrop"
              onClick={(e) => {
                e.stopPropagation()
                setMultiOpen(null)
                setMultiPos(null)
              }}
            />
            <div
              className="filter-multi-menu"
              style={{
                position: 'fixed',
                ...(multiPos.flip
                  ? { bottom: window.innerHeight - multiPos.top }
                  : { top: multiPos.top }),
                left: multiPos.left,
                width: multiPos.width,
                maxHeight: multiPos.maxHeight,
              }}
              onMouseEnter={() => {
                if (multiLeaveTimer.current) {
                  clearTimeout(multiLeaveTimer.current)
                  multiLeaveTimer.current = null
                }
              }}
              onMouseLeave={() => {
                multiLeaveTimer.current = setTimeout(() => {
                  setMultiOpen(null)
                  setMultiPos(null)
                }, 300)
              }}
            >
              <div
                className={`filter-multi-item filter-multi-item-all${options.every((o: any) => selectedSet.has(String(o.id))) ? ' filter-multi-item-checked' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  if (options.every((o: any) => selectedSet.has(String(o.id)))) {
                    onChange([])
                  } else {
                    onChange(options.map((o: any) => o.id))
                  }
                }}
              >
                <span className="filter-multi-check">
                  {selectedSet.size === options.length ? '\u2714' : ''}
                </span>
                <span>Select All</span>
              </div>
              {(() => {
                // Group options by name so duplicates (e.g. Jab 1/2/3) show as one row
                const groups: { name: string; ids: (string | number)[] }[] = []
                const seen = new Map<string, number>()
                for (const o of options) {
                  const name = o.name || o.shortName
                  if (seen.has(name)) {
                    groups[seen.get(name)!].ids.push(o.id)
                  } else {
                    seen.set(name, groups.length)
                    groups.push({ name, ids: [o.id] })
                  }
                }
                const parseId = (v: string) => {
                  const n = Number(v)
                  return Number.isNaN(n) ? v : n
                }
                return groups.map((group) => {
                  const allChecked = group.ids.every((id) => selectedSet.has(String(id)))
                  return (
                    <div
                      key={group.ids.join(',')}
                      className={`filter-multi-item${allChecked ? ' filter-multi-item-checked' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        const groupStrs = new Set(group.ids.map(String))
                        const next = allChecked
                          ? [...selectedSet]
                              .filter((v) => !groupStrs.has(v))
                              .map(parseId)
                          : [...new Set([...selectedSet, ...group.ids.map(String)])]
                              .map(parseId)
                        onChange(next)
                      }}
                    >
                      <span className="filter-multi-check">
                        {allChecked ? '\u2714' : ''}
                      </span>
                      <span>{group.name}</span>
                    </div>
                  )
                })
              })()}
            </div>
          </>
        )}
      </div>
    )
  }

  function renderNameSelect(
    filterId: string,
    optionId: string,
    selected: string[],
    onChange: (_next: string[]) => void,
  ) {
    const key = `${filterId}:${optionId}:names`
    const isOpen = multiOpen === key
    const selectedArr = Array.isArray(selected) ? selected : []
    const selectedSet = new Set(selectedArr)
    const label =
      selectedSet.size === 0
        ? 'Any'
        : namesList
            .filter((n) => selectedSet.has(n.name))
            .map((n) => n.name)
            .join(', ') || selectedArr.join(', ')

    return (
      <div className="filter-multi-wrap">
        <button
          type="button"
          className="filter-multi-select"
          onClick={(e) => {
            e.stopPropagation()
            if (isOpen) {
              setMultiOpen(null)
              setMultiPos(null)
            } else {
              const rect = e.currentTarget.getBoundingClientRect()
              const spaceBelow = window.innerHeight - rect.bottom - 28
              const spaceAbove = rect.top - 28
              const flip = spaceBelow < 120 && spaceAbove > spaceBelow
              setMultiPos({
                top: flip ? rect.top - 4 : rect.bottom + 4,
                left: rect.left,
                width: Math.max(rect.width, 160),
                maxHeight: Math.min(240, flip ? spaceAbove : spaceBelow),
                flip,
              })
              setMultiOpen(key)
            }
          }}
        >
          {label}
        </button>
        {isOpen && multiPos && (
          <>
            <div
              className="filter-multi-backdrop"
              onClick={(e) => {
                e.stopPropagation()
                setMultiOpen(null)
                setMultiPos(null)
              }}
            />
            <div
              className="filter-multi-menu"
              style={{
                position: 'fixed',
                ...(multiPos.flip
                  ? { bottom: window.innerHeight - multiPos.top }
                  : { top: multiPos.top }),
                left: multiPos.left,
                width: multiPos.width,
                maxHeight: multiPos.maxHeight,
              }}
              onMouseEnter={() => {
                if (multiLeaveTimer.current) {
                  clearTimeout(multiLeaveTimer.current)
                  multiLeaveTimer.current = null
                }
              }}
              onMouseLeave={() => {
                multiLeaveTimer.current = setTimeout(() => {
                  setMultiOpen(null)
                  setMultiPos(null)
                }, 300)
              }}
            >
              {namesList.map((n) => {
                const checked = selectedSet.has(n.name)
                return (
                  <div
                    key={n.name}
                    className={`filter-multi-item${checked ? ' filter-multi-item-checked' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      const next = checked
                        ? selectedArr.filter((v) => v !== n.name)
                        : [...selectedArr, n.name]
                      onChange(next)
                    }}
                  >
                    <span className="filter-multi-check">
                      {checked ? '\u2714' : ''}
                    </span>
                    <span>{n.name}</span>
                    <span className="filter-autocomplete-count">{n.total}</span>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    )
  }

  function renderFilterControls(filter: ShallowFilterInterface, filterIndex: number) {
    const filterConfig = filtersConfig.find((entry) => entry.id === filter.type)
    if (
      !filterConfig ||
      !filterConfig.options ||
      filterConfig.options.length === 0
    )
      return null

    const hasParser = archive?.filters.slice(0, filterIndex).some((f) => f.type === 'slpParser')

    const allOptions = filterConfig.options as any[]
    const gridOptions = allOptions.filter(
      (o) => o.type !== 'nthMoves' && !o.group,
    )
    const positionOptions = allOptions.filter((o) => o.group === 'position')
    const nthMovesOption = allOptions.find(
      (o) => o.type === 'nthMoves',
    )

    return (
      <div className="filter-controls">
        {gridOptions.length > 0 && (
          <div className="filter-controls-grid">
            {gridOptions.map((option) => {
              if (option.showWhenCustom) {
                const comboer = filter.params?.comboerActionState || []
                const comboee = filter.params?.comboeeActionState || []
                const all = [...(Array.isArray(comboer) ? comboer : [comboer]), ...(Array.isArray(comboee) ? comboee : [comboee])]
                if (!all.some((id) => id === 'custom' || id == 'custom')) return null
              }
              if (option.showWhenCustomField) {
                const fieldVal = filter.params?.[option.showWhenCustomField] || []
                const arr = Array.isArray(fieldVal) ? fieldVal : [fieldVal]
                if (!arr.some((id) => id === 'custom' || id == 'custom')) return null
              }
              let input: ReactElement | null = null
              const value = filter.params?.[option.id] ?? ''
              const disabled = option.requiresParser && !hasParser
              switch (option.type) {
                case 'textInput':
                  if (option.autocomplete === 'names') {
                    input = renderNameSelect(
                      filter.id,
                      option.id,
                      filter.params?.[option.id] || [],
                      (next) => {
                        const filterClone = cloneDeep(filter)
                        filterClone.params[option.id] = next
                        updateFilter(filterClone, filter)
                      },
                    )
                    break
                  }
                  input = (
                    <input
                      className="filter-control-input"
                      value={disabled ? '' : value}
                      placeholder={disabled ? 'Requires combo parser' : option.placeholder || ''}
                      disabled={disabled}
                      onChange={(event) => {
                        const filterClone = cloneDeep(filter)
                        filterClone.params[option.id] = event.target.value
                        updateFilter(filterClone, filter)
                      }}
                    />
                  )
                  break
                case 'int': {
                  const posDisabled = option.id === 'startFrom' && !!filter.params?.startFromNthMove
                  const intDisabled = disabled || posDisabled
                  input = (
                    <input
                      className="filter-control-input"
                      inputMode="numeric"
                      value={intDisabled ? '' : value}
                      placeholder={disabled ? 'Requires combo parser' : posDisabled ? 'Using nth move' : option.placeholder || 'Any'}
                      disabled={intDisabled}
                      onChange={(event) => {
                        const raw = event.target.value
                        if (raw !== '' && !/^-?\d*$/.test(raw)) return
                        const filterClone = cloneDeep(filter)
                        filterClone.params[option.id] = raw
                        updateFilter(filterClone, filter)
                      }}
                    />
                  )
                  break
                }
                case 'dropdown':
                  input = disabled ? (
                    <input
                      className="filter-control-input"
                      value=""
                      placeholder="Requires combo parser"
                      disabled
                    />
                  ) : (
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
                      {option.options?.map((entry: any) => {
                        const needsParser =
                          entry.requiresParser && !hasParser
                        return (
                          <option
                            key={entry.id}
                            value={entry.id}
                            disabled={needsParser}
                          >
                            {entry.shortName || entry.name}
                            {needsParser ? ' (requires combo parser)' : ''}
                          </option>
                        )
                      })}
                    </select>
                  )
                  break
                case 'multiDropdown':
                  input = disabled ? (
                    <input
                      className="filter-control-input"
                      value=""
                      placeholder="Requires combo parser"
                      disabled
                    />
                  ) : (
                    renderMultiDropdown(
                      filter.id,
                      option.id,
                      option.options || [],
                      filter.params?.[option.id] || [],
                      (next) => {
                        const filterClone = cloneDeep(filter)
                        filterClone.params[option.id] = next
                        updateFilter(filterClone, filter)
                      },
                    )
                  )
                  break
                case 'positionDropdown': {
                  const posKey = `${filter.id}:${option.id}`
                  const posIsOpen = multiOpen === posKey
                  const posVal = String(value || '')
                  const posCurrentValues = posVal
                    ? posVal.split(',').map((v: string) => v.trim()).filter(Boolean)
                    : []
                  const posSelectedSet = new Set(posCurrentValues)
                  const posHasCustom = posSelectedSet.has('__custom__')
                  const posDisplayValues = posCurrentValues.filter((v: string) => v !== '__custom__')
                  const posPresetLabel = positionPresets
                    .filter((p) => posSelectedSet.has(p.value))
                    .map((p) => p.label)
                    .join(', ')
                  const posLabel =
                    posDisplayValues.length === 0 && !posHasCustom
                      ? 'Any'
                      : [posPresetLabel, posHasCustom ? 'Custom' : ''].filter(Boolean).join(', ') || posDisplayValues.join(', ')
                  const posAllOptions = [
                    ...positionPresets,
                    { label: 'Custom', value: '__custom__' },
                  ]
                  input = disabled ? (
                    <input
                      className="filter-control-input"
                      value=""
                      placeholder="Requires combo parser"
                      disabled
                    />
                  ) : (
                    <div className={posHasCustom ? 'filter-nth-pos-row' : undefined}>
                      <div className="filter-multi-wrap">
                        <button
                          type="button"
                          className="filter-multi-select"
                          onClick={(e) => {
                            e.stopPropagation()
                            if (posIsOpen) {
                              setMultiOpen(null)
                              setMultiPos(null)
                            } else {
                              const rect = e.currentTarget.getBoundingClientRect()
                              const spaceBelow = window.innerHeight - rect.bottom - 28
                              const spaceAbove = rect.top - 28
                              const flip = spaceBelow < 120 && spaceAbove > spaceBelow
                              setMultiPos({
                                top: flip ? rect.top - 4 : rect.bottom + 4,
                                left: rect.left,
                                width: Math.max(rect.width, 160),
                                maxHeight: Math.min(240, flip ? spaceAbove : spaceBelow),
                                flip,
                              })
                              setMultiOpen(posKey)
                            }
                          }}
                        >
                          {posLabel}
                        </button>
                        {posIsOpen && multiPos && (
                          <>
                            <div
                              className="filter-multi-backdrop"
                              onClick={(e) => {
                                e.stopPropagation()
                                setMultiOpen(null)
                                setMultiPos(null)
                              }}
                            />
                            <div
                              className="filter-multi-menu"
                              style={{
                                position: 'fixed',
                                ...(multiPos.flip
                                  ? { bottom: window.innerHeight - multiPos.top }
                                  : { top: multiPos.top }),
                                left: multiPos.left,
                                width: multiPos.width,
                                maxHeight: multiPos.maxHeight,
                              }}
                              onMouseEnter={() => {
                                if (multiLeaveTimer.current) {
                                  clearTimeout(multiLeaveTimer.current)
                                  multiLeaveTimer.current = null
                                }
                              }}
                              onMouseLeave={() => {
                                multiLeaveTimer.current = setTimeout(() => {
                                  setMultiOpen(null)
                                  setMultiPos(null)
                                }, 300)
                              }}
                            >
                              {posAllOptions.map((p) => {
                                const checked = posSelectedSet.has(p.value)
                                return (
                                  <div
                                    key={p.value}
                                    className={`filter-multi-item${checked ? ' filter-multi-item-checked' : ''}`}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      let next: string[]
                                      if (p.value === '__custom__') {
                                        next = checked ? [] : ['__custom__']
                                      } else {
                                        const withoutCustom = posCurrentValues.filter((v: string) => v !== '__custom__')
                                        next = checked
                                          ? withoutCustom.filter((v: string) => v !== p.value)
                                          : [...withoutCustom, p.value]
                                      }
                                      const filterClone = cloneDeep(filter)
                                      filterClone.params[option.id] = next.join(',')
                                      updateFilter(filterClone, filter)
                                    }}
                                  >
                                    <span className="filter-multi-check">
                                      {checked ? '\u2714' : ''}
                                    </span>
                                    <span>{p.label}</span>
                                  </div>
                                )
                              })}
                            </div>
                          </>
                        )}
                      </div>
                      {posHasCustom && (
                        <input
                          className="filter-control-input filter-nth-pos-custom-input"
                          value={posDisplayValues.filter((v: string) => !presetValues.has(v)).join(',') || ''}
                          placeholder="e.g. 3,4,-4"
                          title="Move index (0-based). Positive = from start, negative = from end. Comma-separate for multiple (e.g. 0,2,-1)."
                          onChange={(e) => {
                            const customVals = e.target.value
                              ? e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean)
                              : []
                            const filterClone = cloneDeep(filter)
                            filterClone.params[option.id] = ['__custom__', ...customVals].join(',')
                            updateFilter(filterClone, filter)
                          }}
                        />
                      )}
                    </div>
                  )
                  break
                }
                case 'checkbox':
                  input = (
                    <label className="filter-control-checkbox-wrap">
                      <input
                        type="checkbox"
                        className="filter-control-checkbox"
                        checked={
                          disabled ? false : !!filter.params?.[option.id]
                        }
                        disabled={disabled}
                        onChange={(event) => {
                          const filterClone = cloneDeep(filter)
                          filterClone.params[option.id] = event.target.checked
                          updateFilter(filterClone, filter)
                        }}
                      />
                      <span
                        className={`filter-control-checkbox-mark${disabled ? ' filter-control-checkbox-disabled' : ''}`}
                      />
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
              const isDropdownLike =
                option.type === 'multiDropdown' ||
                option.type === 'positionDropdown' ||
                (option.type === 'textInput' && option.autocomplete === 'names')
              const Wrapper = isDropdownLike ? 'div' : 'label'
              return (
                <Wrapper
                  className={`filter-control${disabled ? ' filter-control-disabled' : ''}`}
                  key={option.id}
                  title={disabled ? 'Requires combo parser' : option.tooltip || undefined}
                >
                  <span className="filter-control-label">
                    {!hasParser && option.id === 'comboerActionState' ? 'Player 1 State'
                      : !hasParser && option.id === 'comboeeActionState' ? 'Player 2 State'
                      : !hasParser && option.id === 'comboerCustomIds' ? 'Player 1 Custom IDs'
                      : !hasParser && option.id === 'comboeeCustomIds' ? 'Player 2 Custom IDs'
                      : option.name}
                  </span>
                  {input}
                </Wrapper>
              )
            })}
          </div>
        )}
        {positionOptions.length > 0 && (() => {
          const groupKey = `${filter.id}:position`
          const isExpanded = expandedGroups.has(groupKey)
          const hasActive = positionOptions.some(
            (o: any) => filter.params?.[o.id] !== '' && filter.params?.[o.id] != null && filter.params?.[o.id] !== undefined,
          )
          return (
            <div
              className={`filter-group-inline${hasActive ? ' filter-group-inline-active' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                setExpandedGroups((prev) => {
                  const next = new Set(prev)
                  if (next.has(groupKey)) next.delete(groupKey)
                  else next.add(groupKey)
                  return next
                })
              }}
              title="X/Y position filters"
            >
              <span className="filter-control-label">X/Y Position</span>
              <span className="filter-group-arrow-btn">
                {isExpanded ? '\u25B2' : '\u25BC'}
              </span>
            </div>
          )
        })()}
        {positionOptions.length > 0 && expandedGroups.has(`${filter.id}:position`) && (
          <div className="filter-controls-grid" style={{ marginTop: 8 }}>
            {positionOptions.map((option: any) => {
              const value = filter.params?.[option.id] ?? ''
              return (
                <label
                  className="filter-control"
                  key={option.id}
                  title={option.tooltip || undefined}
                >
                  <span className="filter-control-label">
                    {!hasParser && option.id.startsWith('comboer') ? option.name.replace('Comboer', 'Player 1')
                      : !hasParser && option.id.startsWith('comboee') ? option.name.replace('Comboee', 'Player 2')
                      : option.name}
                  </span>
                  <input
                    className="filter-control-input"
                    inputMode="numeric"
                    value={value}
                    placeholder="Any"
                    onChange={(event) => {
                      const raw = event.target.value
                      if (raw !== '' && !/^-?\d*$/.test(raw)) return
                      const filterClone = cloneDeep(filter)
                      filterClone.params[option.id] = raw
                      updateFilter(filterClone, filter)
                    }}
                  />
                </label>
              )
            })}
          </div>
        )}
        {nthMovesOption && renderNthMoves(filter, nthMovesOption)}
      </div>
    )
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
      positions.length > 0
        ? positions[positions.length - 1].index + 1
        : 0
    for (const pos of positions) {
      if (mouseY < pos.midY) {
        targetIndex = pos.index
        break
      }
    }

    const result = canDropAt(
      archive.filters,
      dragIndexRef.current,
      targetIndex,
    )
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

          // Compute translateY shift for live reorder preview
          let dragTransform = ''
          if (
            dragIndex !== null &&
            dropIndex !== null &&
            !isDragging
          ) {
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
            <div
              key={filter.id}
              data-filter-index={index}
              className={`filter ${isActive ? 'filter-active' : ''} ${
                isGameFilter ? 'filter-pinned' : ''
              } ${isCollapsed ? 'filter-collapsed' : ''} ${isDragging ? 'filter-dragging' : ''}`}
              style={
                dragTransform
                  ? { transform: dragTransform }
                  : undefined
              }
              draggable={!isGameFilter}
              onMouseDown={(e) => {
                const tag = (e.target as HTMLElement).tagName
                dragAllowedRef.current = tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA' && tag !== 'BUTTON'
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
                if (
                  dIdx !== null &&
                  drIdx !== null &&
                  dIdx !== drIdx
                ) {
                  const to = drIdx > dIdx ? drIdx - 1 : drIdx
                  // handleDrop clears drag state after IPC response
                  handleDrop(dIdx, to)
                } else {
                  // No valid drop — clear state immediately
                  setDragIndex(null)
                  setDropIndex(null)
                }
              }}
              onClick={(e) => {
                setActiveFilterId(filter.id)
                const rect = e.currentTarget.getBoundingClientRect()
                const clickY = e.clientY - rect.top
                if (!isCollapsed && clickY < 60) {
                  setExpandedFilters((prev) => ({
                    ...prev,
                    [filter.id]: false,
                  }))
                } else if (isCollapsed) {
                  setExpandedFilters((prev) => ({
                    ...prev,
                    [filter.id]: true,
                  }))
                }
              }}
            >
              <div className="filter-main">
                <div className="filter-title" title={filtersConfig.find((c) => c.id === filter.type)?.tooltip || ''}>{filter.label}</div>
                <div className="filter-meta">
                  <div className="filter-results">
                    Results:{' '}
                    {isRunning
                      ? (liveResults[filter.id] ?? 0).toLocaleString()
                      : resultsCount}
                  </div>
                  {filterMsg ? (
                    <div className="filterMsg">
                      {filterMsg}
                      {!/^\d+\/\d+$/.test(filterMsg) && (
                        <span
                          className="filterMsg-dismiss"
                          onClick={(e) => {
                            e.stopPropagation()
                            setFilterMsgs((prev) => {
                              const updated = { ...prev }
                              delete updated[filter.id]
                              return updated
                            })
                          }}
                        >
                          ✕
                        </span>
                      )}
                    </div>
                  ) : (
                    ''
                  )}
                </div>
                {renderFilterControls(filter, index)}
              </div>
              <div className="filter-actions">
                <button
                  type="button"
                  className={`filter-button${isRunning ? ' filter-button-stop' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    isRunning ? stopFilter(filter.id, index) : runFilter(filter)
                  }}
                >
                  {isRunning ? 'Stop' : 'Run'}
                </button>
                <button
                  type="button"
                  className="filter-toggle"
                  onClick={(event) => toggleFilterCollapse(event, filter.id)}
                  aria-label={isCollapsed ? 'Expand filter' : 'Collapse filter'}
                  title={isCollapsed ? 'Expand filter' : 'Collapse filter'}
                >
                  {isCollapsed ? '▼' : '▲'}
                </button>
                {!isGameFilter && (
                  <button
                    type="button"
                    className="filter-delete"
                    onClick={(e) => {
                      e.stopPropagation()
                      deleteFilter(filter)
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
        })}
      </div>
    )
  }

  return (
    <div className="filters">
      <div className="filters-header">
        <div className="filters-title">Filters</div>
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
                  'edgeguard',
                ])
                return filtersConfig
                  .filter((p) => p.id !== 'files')
                  .flatMap((p) => {
                    const needsParser = requiresParserId.has(p.id) && !hasParser
                    const items = [
                      <div
                        key={p.id}
                        className={`add-filter-item${needsParser ? ' add-filter-item-disabled' : ''}`}
                        title={p.tooltip || ''}
                        onClick={() => {
                          if (needsParser) return
                          addFilter({ target: { value: p.id } })
                          setDropdownOpen(false)
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
            </div>
          )}
        </div>
        {runningFilters.size > 0 ? (
          <>
            <button
              type="button"
              className="stopButton"
              onClick={stopAllFilters}
            >
              Stop All
            </button>
            <button
              type="button"
              className="cancelButton"
              onClick={cancelAllFilters}
            >
              Cancel All
            </button>
          </>
        ) : (
          ''
        )}
      </div>
      {dragWarning && (
        <div className="drag-warning-toast">{dragWarning}</div>
      )}
      {parserWarning && (
        <div className="filter-warn-overlay" onClick={() => setParserWarning(null)}>
          <div className="filter-warn-modal" onClick={(e) => e.stopPropagation()}>
            <div className="filter-warn-title">Cannot delete combo parser</div>
            <div className="filter-warn-body">
              Remove these dependent filters first:
            </div>
            <div className="filter-warn-list">
              {parserWarning.map((name) => (
                <div key={name} className="filter-warn-item">{name}</div>
              ))}
            </div>
            <button
              type="button"
              className="filter-warn-btn"
              onClick={() => setParserWarning(null)}
            >
              Got it
            </button>
          </div>
        </div>
      )}
      {filterError && (
        <div className="filter-warn-overlay" onClick={() => setFilterError(null)}>
          <div className="filter-warn-modal filter-error-modal" onClick={(e) => e.stopPropagation()}>
            <div className="filter-warn-title">
              Error in {filterError.filterLabel}
            </div>
            <div className="filter-warn-body">
              {filterError.errors.length === 1
                ? 'An error occurred while running this filter:'
                : `${filterError.errors.length} errors occurred while running this filter:`}
            </div>
            <div className="filter-error-list">
              {filterError.errors.map((err, i) => (
                <div key={i} className="filter-error-item">{err}</div>
              ))}
            </div>
            <button
              type="button"
              className="filter-warn-btn"
              onClick={() => setFilterError(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
