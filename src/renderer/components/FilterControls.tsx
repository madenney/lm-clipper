/* eslint-disable react/no-array-index-key */
/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import { ReactElement, useState, useRef, useEffect, useMemo } from 'react'
import { cloneDeep } from 'lodash'
import { filtersConfig } from 'constants/config'
import { ShallowFilterInterface, PositionZones } from '../../constants/types'
import { ZONE_STAGE_IDS } from '../../constants/stageGeometry'
import edgeRectangles from '../../constants/rectangles'
import StageZoneModal from './StageZoneModal'
import ipcBridge from '../ipcBridge'

export function DeferredInput({
  value,
  placeholder,
  disabled,
  className,
  title,
  inputMode,
  maxLength,
  validate,
  onChange,
}: {
  value: string
  placeholder?: string
  disabled?: boolean
  className?: string
  title?: string
  inputMode?: 'numeric' | 'text'
  maxLength?: number
  validate?: (_raw: string) => boolean
  onChange: (_val: string) => void
}) {
  const [local, setLocal] = useState(value)
  const committed = useRef(value)

  useEffect(() => {
    setLocal(value)
    committed.current = value
  }, [value])

  const commit = () => {
    if (local !== committed.current) {
      committed.current = local
      onChange(local)
    }
  }

  return (
    <input
      className={className}
      inputMode={inputMode}
      value={disabled ? '' : local}
      placeholder={placeholder}
      disabled={disabled}
      title={title}
      maxLength={maxLength}
      onChange={(e) => {
        const raw = e.target.value
        if (validate && !validate(raw)) return
        setLocal(raw)
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
    />
  )
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

type FilterControlsProps = {
  filter: ShallowFilterInterface
  namesList: { name: string; total: number }[]
  connectCodesList: { name: string; total: number }[]
  namesLoading: boolean
  codesLoading: boolean
  hasParser: boolean
  onUpdate: (
    _newFilter: ShallowFilterInterface,
    _previousFilter: ShallowFilterInterface,
  ) => void
}

export default function FilterControls({
  filter,
  namesList,
  connectCodesList,
  namesLoading,
  codesLoading,
  hasParser,
  onUpdate,
}: FilterControlsProps) {
  const [multiOpen, setMultiOpen] = useState<string | null>(null)
  const [multiPos, setMultiPos] = useState<{
    top: number
    left: number
    width: number
    maxHeight: number
    flip: boolean
  } | null>(null)
  const [multiSearch, setMultiSearch] = useState('')
  const [expandedNthRows, setExpandedNthRows] = useState<Set<string>>(new Set())
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [zoneModalOpen, setZoneModalOpen] = useState(false)
  const [edgeRectModalOpen, setEdgeRectModalOpen] = useState(false)
  const [edgeRectMsg, setEdgeRectMsg] = useState('')

  const filteredNames = useMemo(() => {
    if (namesLoading || (!multiSearch && !multiOpen)) return namesList
    const searchLower = multiSearch.toLowerCase()
    return searchLower
      ? namesList.filter((n) => n.name.toLowerCase().includes(searchLower))
      : namesList
  }, [namesList, namesLoading, multiSearch, multiOpen])

  const filteredCodes = useMemo(() => {
    if (codesLoading || (!multiSearch && !multiOpen)) return connectCodesList
    const searchLower = multiSearch.toLowerCase()
    return searchLower
      ? connectCodesList.filter((n) =>
          n.name.toLowerCase().includes(searchLower),
        )
      : connectCodesList
  }, [connectCodesList, codesLoading, multiSearch, multiOpen])

  function updateFilter(
    newFilter: ShallowFilterInterface,
    previousFilter: ShallowFilterInterface,
  ) {
    onUpdate(newFilter, previousFilter)
  }

  function renderPositionDropdown(
    f: ShallowFilterInterface,
    nthMovesOption: any,
    move: any,
    index: number,
  ) {
    const key = `${f.id}:pos:${index}`
    const isOpen = multiOpen === key
    const currentValues = move.n
      ? String(move.n)
          .split(',')
          .map((v: string) => v.trim())
          .filter(Boolean)
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
        : [presetLabel, hasCustom ? 'Custom' : ''].filter(Boolean).join(', ') ||
          displayVals.join(', ')

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
                        next = checked ? [] : ['__custom__']
                      } else {
                        const withoutCustom = currentValues.filter(
                          (v: string) => v !== '__custom__',
                        )
                        next = checked
                          ? withoutCustom.filter((v: string) => v !== p.value)
                          : [...withoutCustom, p.value]
                      }
                      const filterClone = cloneDeep(f)
                      filterClone.params[nthMovesOption.id][index].n =
                        next.join(',')
                      updateFilter(filterClone, f)
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
        : [
            ...new Set(
              options
                .filter((o) => selectedSet.has(String(o.id)))
                .map((o) => o.name || o.shortName),
            ),
          ].join(', ')

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
            >
              <div
                className={`filter-multi-item filter-multi-item-all${options.every((o: any) => selectedSet.has(String(o.id))) ? ' filter-multi-item-checked' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  if (
                    options.every((o: any) => selectedSet.has(String(o.id)))
                  ) {
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
                  const allChecked = group.ids.every((id) =>
                    selectedSet.has(String(id)),
                  )
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
                          : [
                              ...new Set([
                                ...selectedSet,
                                ...group.ids.map(String),
                              ]),
                            ].map(parseId)
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
    const RENDER_CAP = 100
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

    const capped =
      isOpen && !namesLoading ? filteredNames.slice(0, RENDER_CAP) : []
    const remaining =
      isOpen && !namesLoading ? filteredNames.length - capped.length : 0

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
              setMultiSearch('')
              const rect = e.currentTarget.getBoundingClientRect()
              const spaceBelow = window.innerHeight - rect.bottom - 28
              const spaceAbove = rect.top - 28
              const flip = spaceBelow < 120 && spaceAbove > spaceBelow
              setMultiPos({
                top: flip ? rect.top - 4 : rect.bottom + 4,
                left: rect.left,
                width: Math.max(rect.width, 160),
                maxHeight: Math.min(300, flip ? spaceAbove : spaceBelow),
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
            >
              {namesLoading ? (
                <div className="filter-multi-loading">
                  <span className="filter-multi-spinner" />
                  Loading names...
                </div>
              ) : namesList.length === 0 ? (
                <div className="filter-multi-loading">No names found</div>
              ) : (
                <>
                  <input
                    className="filter-multi-search"
                    placeholder="Search names..."
                    value={multiSearch}
                    autoFocus // eslint-disable-line jsx-a11y/no-autofocus
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setMultiSearch(e.target.value)}
                  />
                  {capped.map((n) => {
                    const checked = selectedSet.has(n.name)
                    return (
                      <div
                        key={n.name}
                        className={`filter-multi-item${checked ? ' filter-multi-item-checked' : ''}`}
                        title={`${n.name} (${n.total.toLocaleString()})`}
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
                        <span className="filter-multi-name">{n.name}</span>
                        <span className="filter-autocomplete-count">
                          {n.total}
                        </span>
                      </div>
                    )
                  })}
                  {remaining > 0 && (
                    <div className="filter-multi-more">
                      {remaining.toLocaleString()} more — type to narrow
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    )
  }

  function renderConnectCodeSelect(
    filterId: string,
    optionId: string,
    selected: string[],
    onChange: (_next: string[]) => void,
  ) {
    const RENDER_CAP = 100
    const key = `${filterId}:${optionId}:connectCodes`
    const isOpen = multiOpen === key
    const selectedArr = Array.isArray(selected) ? selected : []
    const selectedSet = new Set(selectedArr)
    const label =
      selectedSet.size === 0
        ? 'Any'
        : connectCodesList
            .filter((n) => selectedSet.has(n.name))
            .map((n) => n.name)
            .join(', ') || selectedArr.join(', ')

    const capped =
      isOpen && !codesLoading ? filteredCodes.slice(0, RENDER_CAP) : []
    const remaining =
      isOpen && !codesLoading ? filteredCodes.length - capped.length : 0

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
              setMultiSearch('')
              const rect = e.currentTarget.getBoundingClientRect()
              const spaceBelow = window.innerHeight - rect.bottom - 28
              const spaceAbove = rect.top - 28
              const flip = spaceBelow < 120 && spaceAbove > spaceBelow
              setMultiPos({
                top: flip ? rect.top - 4 : rect.bottom + 4,
                left: rect.left,
                width: Math.max(rect.width, 160),
                maxHeight: Math.min(300, flip ? spaceAbove : spaceBelow),
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
            >
              {codesLoading ? (
                <div className="filter-multi-loading">
                  <span className="filter-multi-spinner" />
                  Loading codes...
                </div>
              ) : connectCodesList.length === 0 ? (
                <div className="filter-multi-loading">No codes found</div>
              ) : (
                <>
                  <input
                    className="filter-multi-search"
                    placeholder="Search codes..."
                    value={multiSearch}
                    autoFocus // eslint-disable-line jsx-a11y/no-autofocus
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setMultiSearch(e.target.value)}
                  />
                  {capped.map((n) => {
                    const checked = selectedSet.has(n.name)
                    return (
                      <div
                        key={n.name}
                        className={`filter-multi-item${checked ? ' filter-multi-item-checked' : ''}`}
                        title={`${n.name} (${n.total.toLocaleString()})`}
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
                        <span className="filter-multi-name">{n.name}</span>
                        <span className="filter-autocomplete-count">
                          {n.total}
                        </span>
                      </div>
                    )
                  })}
                  {remaining > 0 && (
                    <div className="filter-multi-more">
                      {remaining.toLocaleString()} more — type to narrow
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    )
  }

  function renderNthMoves(f: ShallowFilterInterface, nthMovesOption: any) {
    const moves = f.params?.[nthMovesOption.id] || []

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
              const filterClone = cloneDeep(f)
              filterClone.params[nthMovesOption.id].push({
                moveId: '',
                n: '',
                d: '',
                t: '',
                dMode: 'min',
                tMin: '',
              })
              updateFilter(filterClone, f)
            }}
          >
            + Add
          </button>
        </div>
        {moves.map((move: any, index: number) =>
          renderNthRowFriendly(f, nthMovesOption, move, index),
        )}
      </div>
    )
  }

  function renderNthRowFriendly(
    f: ShallowFilterInterface,
    nthMovesOption: any,
    move: any,
    index: number,
  ) {
    const showCustomInput = isCustomN(move.n)
    const nthRowKey = `${f.id}:${index}`
    const isNthExpanded = expandedNthRows.has(nthRowKey)
    const hasExtra = !!(move.tMin || move.t || move.d || move.dMax)

    return (
      <div key={`${move.n}-${index}`} className="filter-nth-row-wrap">
        <div className="filter-nth-row">
          <div
            className="filter-nth-field filter-nth-field-move"
            title="Which position in the combo this move must appear at"
          >
            <span className="filter-nth-field-label">Position</span>
            <div className={showCustomInput ? 'filter-nth-pos-row' : undefined}>
              {renderPositionDropdown(f, nthMovesOption, move, index)}
              {showCustomInput && (
                <input
                  className="filter-control-input filter-nth-pos-custom-input"
                  value={String(move.n || '')
                    .split(',')
                    .map((v: string) => v.trim())
                    .filter(
                      (v: string) => v !== '__custom__' && !presetValues.has(v),
                    )
                    .join(',')}
                  placeholder="e.g. 3,4,-4"
                  title="Move index (0-based). Positive = from start, negative = from end. Comma-separate for multiple (e.g. 0,2,-1)."
                  onChange={(e) => {
                    const kept = String(move.n || '')
                      .split(',')
                      .map((v: string) => v.trim())
                      .filter(
                        (v: string) =>
                          v === '__custom__' || presetValues.has(v),
                      )
                    const customVals = e.target.value
                      ? e.target.value
                          .split(',')
                          .map((s: string) => s.trim())
                          .filter(Boolean)
                      : []
                    const filterClone = cloneDeep(f)
                    filterClone.params[nthMovesOption.id][index].n = [
                      ...kept,
                      ...customVals,
                    ].join(',')
                    updateFilter(filterClone, f)
                  }}
                />
              )}
            </div>
          </div>
          <div
            className="filter-nth-field filter-nth-field-move"
            title="Which attack move to match at this position"
          >
            <span className="filter-nth-field-label">Move</span>
            {renderMultiDropdown(
              `${f.id}:nth:${index}`,
              'moveId',
              nthMovesOption.options || [],
              Array.isArray(move.moveId)
                ? move.moveId
                : move.moveId
                  ? [move.moveId]
                  : [],
              (next) => {
                const filterClone = cloneDeep(f)
                filterClone.params[nthMovesOption.id][index].moveId = next
                updateFilter(filterClone, f)
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
            title="Remove this move rule"
            onClick={() => {
              const filterClone = cloneDeep(f)
              filterClone.params[nthMovesOption.id].splice(index, 1)
              updateFilter(filterClone, f)
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
                  const filterClone = cloneDeep(f)
                  filterClone.params[nthMovesOption.id][index].tMin =
                    e.target.value
                  updateFilter(filterClone, f)
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
                  const filterClone = cloneDeep(f)
                  filterClone.params[nthMovesOption.id][index].t =
                    e.target.value
                  updateFilter(filterClone, f)
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
                  const filterClone = cloneDeep(f)
                  filterClone.params[nthMovesOption.id][index].d =
                    e.target.value
                  updateFilter(filterClone, f)
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
                  const filterClone = cloneDeep(f)
                  filterClone.params[nthMovesOption.id][index].dMax =
                    e.target.value
                  updateFilter(filterClone, f)
                }}
              />
            </label>
          </div>
        )}
      </div>
    )
  }

  const filterConfig = filtersConfig.find((entry) => entry.id === filter.type)
  if (!filterConfig) return null
  if (!filterConfig.options || filterConfig.options.length === 0)
    return (
      <div className="filter-controls">
        <span className="filter-no-options">
          No settings — this filter runs automatically.
        </span>
      </div>
    )

  const allOptions = filterConfig.options as any[]
  const gridOptions = allOptions.filter(
    (o) => o.type !== 'nthMoves' && !o.group,
  )
  const positionOptions = allOptions.filter((o) => o.group === 'position')
  const nthMovesOption = allOptions.find((o) => o.type === 'nthMoves')

  return (
    <div className="filter-controls">
      {gridOptions.length > 0 && (
        <div className="filter-controls-grid">
          {gridOptions.map((option) => {
            if (option.showWhenCustom) {
              const comboer = filter.params?.comboerActionState || []
              const comboee = filter.params?.comboeeActionState || []
              const all = [
                ...(Array.isArray(comboer) ? comboer : [comboer]),
                ...(Array.isArray(comboee) ? comboee : [comboee]),
              ]
              if (!all.some((id) => id === 'custom' || String(id) === 'custom'))
                return null
            }
            if (option.showWhenCustomField) {
              const fieldVal = filter.params?.[option.showWhenCustomField] || []
              const arr = Array.isArray(fieldVal) ? fieldVal : [fieldVal]
              if (!arr.some((id) => id === 'custom' || String(id) === 'custom'))
                return null
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
                if (option.autocomplete === 'connectCodes') {
                  input = renderConnectCodeSelect(
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
                  <DeferredInput
                    className="filter-control-input"
                    value={value}
                    placeholder={
                      disabled
                        ? 'Requires combo parser'
                        : option.placeholder || ''
                    }
                    disabled={disabled}
                    onChange={(raw) => {
                      const filterClone = cloneDeep(filter)
                      filterClone.params[option.id] = raw
                      updateFilter(filterClone, filter)
                    }}
                  />
                )
                break
              case 'int': {
                const posDisabled =
                  option.id === 'startFrom' && !!filter.params?.startFromNthMove
                const intDisabled = disabled || posDisabled
                input = (
                  <DeferredInput
                    className="filter-control-input"
                    inputMode="numeric"
                    validate={(raw) => raw === '' || /^-?\d*$/.test(raw)}
                    value={value}
                    placeholder={
                      disabled
                        ? 'Requires combo parser'
                        : posDisabled
                          ? 'Using nth move'
                          : option.placeholder || 'Any'
                    }
                    disabled={intDisabled}
                    onChange={(raw) => {
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
                      const needsParser = entry.requiresParser && !hasParser
                      return (
                        <option
                          key={entry.id}
                          value={entry.id}
                          disabled={needsParser}
                          title={entry.tooltip || ''}
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
                  ? posVal
                      .split(',')
                      .map((v: string) => v.trim())
                      .filter(Boolean)
                  : []
                const posSelectedSet = new Set(posCurrentValues)
                const posHasCustom = posSelectedSet.has('__custom__')
                const posDisplayValues = posCurrentValues.filter(
                  (v: string) => v !== '__custom__',
                )
                const posPresetLabel = positionPresets
                  .filter((p) => posSelectedSet.has(p.value))
                  .map((p) => p.label)
                  .join(', ')
                const posLabel =
                  posDisplayValues.length === 0 && !posHasCustom
                    ? 'Any'
                    : [posPresetLabel, posHasCustom ? 'Custom' : '']
                        .filter(Boolean)
                        .join(', ') || posDisplayValues.join(', ')
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
                  <div
                    className={posHasCustom ? 'filter-nth-pos-row' : undefined}
                  >
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
                            const spaceBelow =
                              window.innerHeight - rect.bottom - 28
                            const spaceAbove = rect.top - 28
                            const flip =
                              spaceBelow < 120 && spaceAbove > spaceBelow
                            setMultiPos({
                              top: flip ? rect.top - 4 : rect.bottom + 4,
                              left: rect.left,
                              width: Math.max(rect.width, 160),
                              maxHeight: Math.min(
                                240,
                                flip ? spaceAbove : spaceBelow,
                              ),
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
                                ? {
                                    bottom: window.innerHeight - multiPos.top,
                                  }
                                : { top: multiPos.top }),
                              left: multiPos.left,
                              width: multiPos.width,
                              maxHeight: multiPos.maxHeight,
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
                                      const withoutCustom =
                                        posCurrentValues.filter(
                                          (v: string) => v !== '__custom__',
                                        )
                                      next = checked
                                        ? withoutCustom.filter(
                                            (v: string) => v !== p.value,
                                          )
                                        : [...withoutCustom, p.value]
                                    }
                                    const filterClone = cloneDeep(filter)
                                    filterClone.params[option.id] =
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
                    {posHasCustom && (
                      <DeferredInput
                        className="filter-control-input filter-nth-pos-custom-input"
                        value={
                          posDisplayValues
                            .filter((v: string) => !presetValues.has(v))
                            .join(',') || ''
                        }
                        placeholder="e.g. 3,4,-4"
                        title="Move index (0-based). Positive = from start, negative = from end. Comma-separate for multiple (e.g. 0,2,-1)."
                        onChange={(raw) => {
                          const customVals = raw
                            ? raw
                                .split(',')
                                .map((s: string) => s.trim())
                                .filter(Boolean)
                            : []
                          const filterClone = cloneDeep(filter)
                          filterClone.params[option.id] = [
                            '__custom__',
                            ...customVals,
                          ].join(',')
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
                      checked={disabled ? false : !!filter.params?.[option.id]}
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
              case 'code':
                return null
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
              (option.type === 'textInput' &&
                (option.autocomplete === 'names' ||
                  option.autocomplete === 'connectCodes'))
            const Wrapper = isDropdownLike ? 'div' : 'label'
            return (
              <Wrapper
                className={`filter-control${disabled ? ' filter-control-disabled' : ''}`}
                key={option.id}
                title={
                  disabled
                    ? 'Requires combo parser'
                    : option.tooltip || undefined
                }
              >
                <span className="filter-control-label">
                  {!hasParser && option.id === 'comboerActionState'
                    ? 'Player 1 State'
                    : !hasParser && option.id === 'comboeeActionState'
                      ? 'Player 2 State'
                      : !hasParser && option.id === 'comboerCustomIds'
                        ? 'Player 1 Custom IDs'
                        : !hasParser && option.id === 'comboeeCustomIds'
                          ? 'Player 2 Custom IDs'
                          : option.name}
                </span>
                {input}
              </Wrapper>
            )
          })}
        </div>
      )}
      {positionOptions.length > 0 &&
        (() => {
          const groupKey = `${filter.id}:position`
          const isExpanded = expandedGroups.has(groupKey)
          const hasActive = positionOptions.some(
            (o: any) =>
              filter.params?.[o.id] !== '' &&
              filter.params?.[o.id] != null &&
              filter.params?.[o.id] !== undefined,
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
      {positionOptions.length > 0 &&
        expandedGroups.has(`${filter.id}:position`) &&
        (() => {
          const zones: PositionZones = filter.params?.positionZones || {}
          const zonedCount = ZONE_STAGE_IDS.filter(
            (sid) => zones[sid]?.comboer || zones[sid]?.comboee,
          ).length
          return (
            <>
              <div className="filter-zone-row" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="filter-button filter-zone-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    setZoneModalOpen(true)
                  }}
                >
                  🎯 Draw Zone
                </button>
                <span className="filter-zone-summary">
                  {zonedCount === 0
                    ? 'no stage zones — or set X/Y below'
                    : `zones on ${zonedCount} stage${zonedCount === 1 ? '' : 's'}`}
                </span>
              </div>
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
                        {!hasParser && option.id.startsWith('comboer')
                          ? option.name.replace('Comboer', 'Player 1')
                          : !hasParser && option.id.startsWith('comboee')
                            ? option.name.replace('Comboee', 'Player 2')
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
            </>
          )
        })()}
      {nthMovesOption && renderNthMoves(filter, nthMovesOption)}
      {(filter.type === 'edgeguard' || filter.type === 'edgeguard2') && (
        <div className="filter-zone-row" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="filter-button filter-zone-btn"
            onClick={(e) => {
              e.stopPropagation()
              setEdgeRectMsg('')
              setEdgeRectModalOpen(true)
            }}
          >
            ◳ Edit Edge Rectangles
          </button>
          <span className="filter-zone-summary">
            {edgeRectMsg || 'dev: tune & save edgeguard zones'}
          </span>
        </div>
      )}
      {filter.type === 'custom' &&
        (() => {
          const customParams: {
            name: string
            type: string
            value: string
            options?: string
          }[] = filter.params?.customParams || []
          const isValidIdent = (s: string) =>
            /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(s)
          const reservedNames = new Set(['code', 'maxFiles', 'customParams'])
          return (
            <div style={{ width: '100%', marginTop: 4 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 2,
                }}
              >
                <span
                  className="filter-control-label"
                  style={{ fontSize: 11, opacity: 0.7 }}
                >
                  Custom Params
                </span>
                <button
                  type="button"
                  className="filter-button"
                  style={{ fontSize: 10, padding: '1px 6px' }}
                  onClick={(e) => {
                    e.stopPropagation()
                    const filterClone = cloneDeep(filter)
                    if (!filterClone.params.customParams)
                      filterClone.params.customParams = []
                    filterClone.params.customParams.push({
                      name: '',
                      type: 'int',
                      value: '',
                    })
                    updateFilter(filterClone, filter)
                  }}
                >
                  + Add
                </button>
              </div>
              {customParams.length > 0 && (
                <div
                  style={{
                    display: 'flex',
                    gap: 3,
                    marginBottom: 2,
                    fontSize: 10,
                    opacity: 0.5,
                  }}
                >
                  <span style={{ flex: 1 }}>name</span>
                  <span style={{ width: 72 }}>type</span>
                  <span style={{ flex: 1 }}>value</span>
                  <span style={{ width: 22 }} />
                </div>
              )}
              {customParams.map((cp, cpIdx) => (
                <div
                  key={`${cp.name}-${cpIdx}`}
                  style={{
                    display: 'flex',
                    gap: 3,
                    alignItems: 'center',
                    marginBottom: 3,
                  }}
                >
                  <DeferredInput
                    className="filter-control-input"
                    value={cp.name}
                    placeholder="name"
                    validate={(raw) =>
                      raw === '' || /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(raw)
                    }
                    onChange={(val) => {
                      if (val && (!isValidIdent(val) || reservedNames.has(val)))
                        return
                      const filterClone = cloneDeep(filter)
                      filterClone.params.customParams[cpIdx].name = val
                      updateFilter(filterClone, filter)
                    }}
                  />
                  <select
                    className="filter-control-input"
                    style={{ width: 72, fontSize: 11 }}
                    value={cp.type}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const filterClone = cloneDeep(filter)
                      filterClone.params.customParams[cpIdx].type =
                        e.target.value
                      updateFilter(filterClone, filter)
                    }}
                  >
                    <option value="int">int</option>
                    <option value="string">string</option>
                    <option value="array">array</option>
                  </select>
                  {cp.type === 'array' ? (
                    <DeferredInput
                      className="filter-control-input"
                      value={cp.value}
                      placeholder="a,b,c"
                      onChange={(val) => {
                        const filterClone = cloneDeep(filter)
                        filterClone.params.customParams[cpIdx].value = val
                        updateFilter(filterClone, filter)
                      }}
                    />
                  ) : (
                    <DeferredInput
                      className="filter-control-input"
                      value={cp.value}
                      placeholder={cp.type === 'int' ? '0' : ''}
                      inputMode={cp.type === 'int' ? 'numeric' : 'text'}
                      validate={
                        cp.type === 'int'
                          ? (raw) =>
                              raw === '' || raw === '-' || /^-?\d+$/.test(raw)
                          : undefined
                      }
                      onChange={(val) => {
                        const filterClone = cloneDeep(filter)
                        filterClone.params.customParams[cpIdx].value = val
                        updateFilter(filterClone, filter)
                      }}
                    />
                  )}
                  <button
                    type="button"
                    className="filter-button"
                    style={{
                      fontSize: 10,
                      padding: '1px 5px',
                      flexShrink: 0,
                    }}
                    onClick={(e) => {
                      e.stopPropagation()
                      const filterClone = cloneDeep(filter)
                      filterClone.params.customParams.splice(cpIdx, 1)
                      updateFilter(filterClone, filter)
                    }}
                    title="Remove parameter"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )
        })()}
      {filter.type === 'custom' &&
        (() => {
          const outputFields: { name: string; type: string }[] =
            filter.params?.outputFields || []
          return (
            <div style={{ width: '100%', marginTop: 4 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 2,
                }}
              >
                <span
                  className="filter-control-label"
                  style={{ fontSize: 11, opacity: 0.7 }}
                >
                  Output Fields
                </span>
                <button
                  type="button"
                  className="filter-button"
                  style={{ fontSize: 10, padding: '1px 6px' }}
                  onClick={(e) => {
                    e.stopPropagation()
                    const filterClone = cloneDeep(filter)
                    if (!filterClone.params.outputFields)
                      filterClone.params.outputFields = []
                    filterClone.params.outputFields.push({
                      name: '',
                      type: 'number',
                    })
                    updateFilter(filterClone, filter)
                  }}
                >
                  + Add
                </button>
              </div>
              {outputFields.length > 0 && (
                <div
                  style={{
                    display: 'flex',
                    gap: 3,
                    marginBottom: 2,
                    fontSize: 10,
                    opacity: 0.5,
                  }}
                >
                  <span style={{ flex: 1 }}>name</span>
                  <span style={{ width: 72 }}>type</span>
                  <span style={{ width: 22 }} />
                </div>
              )}
              {outputFields.map((of, ofIdx) => (
                <div
                  key={`${of.name}-${ofIdx}`}
                  style={{
                    display: 'flex',
                    gap: 3,
                    alignItems: 'center',
                    marginBottom: 3,
                  }}
                >
                  <DeferredInput
                    className="filter-control-input"
                    value={of.name}
                    placeholder="fieldName"
                    validate={(raw) =>
                      raw === '' || /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(raw)
                    }
                    onChange={(val) => {
                      const filterClone = cloneDeep(filter)
                      filterClone.params.outputFields[ofIdx].name = val
                      updateFilter(filterClone, filter)
                    }}
                  />
                  <select
                    className="filter-control-input"
                    style={{ width: 72, fontSize: 11 }}
                    value={of.type}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const filterClone = cloneDeep(filter)
                      filterClone.params.outputFields[ofIdx].type =
                        e.target.value
                      updateFilter(filterClone, filter)
                    }}
                  >
                    <option value="number">number</option>
                    <option value="string">string</option>
                    <option value="boolean">boolean</option>
                    <option value="array">array</option>
                    <option value="object">object</option>
                  </select>
                  <button
                    type="button"
                    className="filter-button"
                    style={{
                      fontSize: 10,
                      padding: '1px 5px',
                      flexShrink: 0,
                    }}
                    onClick={(e) => {
                      e.stopPropagation()
                      const filterClone = cloneDeep(filter)
                      filterClone.params.outputFields.splice(ofIdx, 1)
                      updateFilter(filterClone, filter)
                    }}
                    title="Remove field"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )
        })()}
      {zoneModalOpen && (
        <StageZoneModal
          initialZones={filter.params?.positionZones || {}}
          initialStageId={(() => {
            const zones: PositionZones = filter.params?.positionZones || {}
            return (
              ZONE_STAGE_IDS.find(
                (sid) => zones[sid]?.comboer || zones[sid]?.comboee,
              ) ?? ZONE_STAGE_IDS[0]
            )
          })()}
          hasParser={hasParser}
          onClose={() => setZoneModalOpen(false)}
          onApply={(nextZones) => {
            const filterClone = cloneDeep(filter)
            filterClone.params.positionZones = nextZones
            updateFilter(filterClone, filter)
            setZoneModalOpen(false)
          }}
        />
      )}
      {edgeRectModalOpen && (
        <StageZoneModal
          mode="edgeRects"
          initialStageId={ZONE_STAGE_IDS[0]}
          hasParser={hasParser}
          initialZones={
            ZONE_STAGE_IDS.reduce(
              (acc, sid) => {
                const r = (edgeRectangles as any)[sid]
                if (r) acc[sid] = { edge: r.edge, bz: r.bz }
                return acc
              },
              {} as Record<number, any>,
            ) as any
          }
          onClose={() => setEdgeRectModalOpen(false)}
          onApply={(nextRects) => {
            const payload: Record<number, any> = {}
            for (const sid of ZONE_STAGE_IDS) {
              const r = (edgeRectangles as any)[sid]
              if (!r) continue
              const edited = (nextRects as any)[sid] || {}
              payload[sid] = {
                name: r.name,
                bz: edited.bz || r.bz,
                edge: edited.edge || r.edge,
              }
            }
            ipcBridge.saveEdgeRectangles(payload, (res: any) => {
              if (res?.error) setEdgeRectMsg(`Save failed: ${res.error}`)
              else setEdgeRectMsg('Saved to rectangles.ts — rebuild to apply')
            })
            setEdgeRectModalOpen(false)
          }}
        />
      )}
    </div>
  )
}
