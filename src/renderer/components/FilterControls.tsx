/* eslint-disable react/no-array-index-key */
/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import { ReactElement, useState, useRef, useEffect, useMemo } from 'react'
import { cloneDeep } from 'lodash'
import { FiX } from 'react-icons/fi'
import { filtersConfig } from 'constants/config'
import { ShallowFilterInterface, PositionZones } from '../../constants/types'
import {
  ZONE_STAGE_IDS,
  DEFAULT_OFFSTAGE_BUFFER,
} from '../../constants/stageGeometry'
import StageZoneModal from './StageZoneModal'
import AiFilterControls from './AiFilterControls'
import { useFiltersStyle } from '../lib/filtersStyle'
import EdgeguardZoneModal from './EdgeguardZoneModal'
import CharacterSelect from './CharacterSelect'
import StageSelect from './StageSelect'
import { sortedCharacters } from '../../constants/characters'
import { legalStages } from '../../constants/stages'

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

type Chip = { value: string; label: string }

// One selected value + its ×. NB: the class is `filter-val-chip`, not
// `filter-chip` — that name was already taken by the muted UPPERCASE results
// pill (.filter-results / .filterMsg), which leaked its casing in here.
function ValueChip({
  chip,
  onRemove,
}: {
  chip: Chip
  onRemove: (_value: string) => void
}) {
  return (
    <span className="filter-val-chip">
      <span className="filter-val-chip-label">{chip.label}</span>
      <span
        className="filter-val-chip-x"
        role="button"
        tabIndex={0}
        aria-label={`Remove ${chip.label}`}
        title={`Remove ${chip.label}`}
        onClick={(e) => {
          e.stopPropagation()
          onRemove(chip.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            onRemove(chip.value)
          }
        }}
      >
        <FiX />
      </span>
    </span>
  )
}

// The chips shown INSIDE the 32px field. Height is fixed, so they can't wrap —
// they sit on one line and scroll sideways. Two things make that bearable:
//   - a fade on the right edge whenever there's more off-screen, so overflow is
//     visible rather than silently truncated;
//   - vertical wheel mapped to horizontal scroll (React's onWheel is passive, so
//     preventDefault needs a manually-attached non-passive listener).
// For a long selection you shouldn't be fighting this at all — open the menu and
// use the Selected panel, which can grow freely because it floats.
function SelectChips({
  chips,
  placeholder,
  onRemove,
}: {
  chips: Chip[]
  placeholder: string
  onRemove: (_value: string) => void
}) {
  const rowRef = useRef<HTMLSpanElement>(null)
  const [overflowing, setOverflowing] = useState(false)

  useEffect(() => {
    const el = rowRef.current
    if (!el) return undefined
    const measure = () => setOverflowing(el.scrollWidth > el.clientWidth + 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return
      e.preventDefault()
      el.scrollLeft += e.deltaY + e.deltaX
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('scroll', measure)
    return () => {
      ro.disconnect()
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('scroll', measure)
    }
  }, [chips.length])

  if (chips.length === 0)
    return <span className="filter-multi-placeholder">{placeholder}</span>
  return (
    <span
      className={`filter-val-chips${overflowing ? ' filter-val-chips-overflow' : ''}`}
      ref={rowRef}
    >
      {chips.map((c) => (
        <ValueChip key={c.value} chip={c} onRemove={onRemove} />
      ))}
    </span>
  )
}

type MultiPos = {
  top: number
  left: number
  width: number
  maxHeight: number
  flip: boolean
}

// Fixed-position dropdown menu (with a click-away backdrop) for multi-selects.
function MultiMenu({
  pos,
  onClose,
  children,
}: {
  pos: MultiPos
  onClose: () => void
  children: React.ReactNode
}) {
  // Keyboard: the menu's rows are plain divs with click handlers (in several places), so give
  // them option roles here, once; arrows move between them, Enter or Space picks, Esc closes,
  // and focus goes back to the control that opened it.
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    menuRef.current?.focus()
    return () => {
      if (before && before.isConnected) before.focus()
    }
  }, [])
  useEffect(() => {
    const items =
      menuRef.current?.querySelectorAll<HTMLElement>('.filter-multi-item')
    items?.forEach((item) => {
      item.setAttribute('role', 'option')
      item.setAttribute('tabindex', '-1')
      item.setAttribute(
        'aria-selected',
        String(item.classList.contains('filter-multi-item-checked')),
      )
    })
  })
  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('.filter-multi-item') ??
        [],
    )
    const at = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = e.key === 'ArrowDown' ? at + 1 : at <= 0 ? 0 : at - 1
      items[Math.max(0, Math.min(items.length - 1, next))]?.focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      items[e.key === 'Home' ? 0 : items.length - 1]?.focus()
    } else if ((e.key === 'Enter' || e.key === ' ') && at >= 0) {
      e.preventDefault()
      items[at].click()
    } else if (e.key === 'Tab') {
      onClose()
    }
  }

  return (
    <>
      <div
        className="filter-multi-backdrop"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
      />
      <div
        ref={menuRef}
        className="filter-multi-menu"
        role="listbox"
        aria-multiselectable="true"
        tabIndex={-1}
        onKeyDown={onMenuKey}
        style={{
          position: 'fixed',
          ...(pos.flip
            ? { bottom: window.innerHeight - pos.top }
            : { top: pos.top }),
          left: pos.left,
          width: pos.width,
          maxHeight: pos.maxHeight,
        }}
      >
        {children}
      </div>
    </>
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
  hasEdgeguardParser: boolean
  /** The step before this one (the AI Filter's prompt describes its rows). */
  previousType?: string
  /** Opens the filter's code in the editor (AI Filter's Edit code). */
  onEditCode?: () => void
  onUpdate: (
    _newFilter: ShallowFilterInterface,
    _previousFilter: ShallowFilterInterface,
  ) => void
}

/** Compact look: setting names in plain words and sentence case ("Comboer CC"
 *  -> "Player code", "Comboee Char" -> "Opponent character"). */
const WORDS: Record<string, string> = {
  comboer: 'player',
  attacker: 'player',
  comboee: 'opponent',
  victim: 'opponent',
  cc: 'code',
  char: 'character',
  files: 'replays',
}
export function plainLabel(name: string): string {
  const out = name
    .split(' ')
    .map((w) => WORDS[w.toLowerCase()] ?? w.toLowerCase())
    .join(' ')
  return out.charAt(0).toUpperCase() + out.slice(1)
}

export default function FilterControls({
  filter,
  namesList,
  connectCodesList,
  namesLoading,
  codesLoading,
  hasParser,
  hasEdgeguardParser,
  previousType,
  onEditCode,
  onUpdate,
}: FilterControlsProps) {
  const nameOf = useFiltersStyle() === 'compact' ? plainLabel : (n: string) => n
  const [multiOpen, setMultiOpen] = useState<string | null>(null)
  const [multiPos, setMultiPos] = useState<MultiPos | null>(null)
  const [multiSearch, setMultiSearch] = useState('')
  const [expandedNthRows, setExpandedNthRows] = useState<Set<string>>(new Set())
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [zoneModalOpen, setZoneModalOpen] = useState(false)
  const [edgeRectModalOpen, setEdgeRectModalOpen] = useState(false)

  const filteredNames = useMemo(() => {
    // Defensive: the prop should always be an array, but never let a bad value
    // crash the render (see filteredNames.filter usage below).
    const list = Array.isArray(namesList) ? namesList : []
    if (namesLoading || (!multiSearch && !multiOpen)) return list
    const searchLower = multiSearch.toLowerCase()
    return searchLower
      ? list.filter((n) => n.name.toLowerCase().includes(searchLower))
      : list
  }, [namesList, namesLoading, multiSearch, multiOpen])

  const filteredCodes = useMemo(() => {
    const list = Array.isArray(connectCodesList) ? connectCodesList : []
    if (codesLoading || (!multiSearch && !multiOpen)) return list
    const searchLower = multiSearch.toLowerCase()
    return searchLower
      ? list.filter((n) => n.name.toLowerCase().includes(searchLower))
      : list
  }, [connectCodesList, codesLoading, multiSearch, multiOpen])

  function closeMulti() {
    setMultiOpen(null)
    setMultiPos(null)
  }

  // Open (or close, when already open) the multi-select menu under `e`'s element.
  function toggleMulti(
    e: React.MouseEvent<HTMLElement>,
    key: string,
    isOpen: boolean,
    maxMenuHeight: number,
    clearSearch = false,
  ) {
    e.stopPropagation()
    if (isOpen) {
      closeMulti()
      return
    }
    if (clearSearch) setMultiSearch('')
    const rect = e.currentTarget.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom - 28
    const spaceAbove = rect.top - 28
    const flip = spaceBelow < 120 && spaceAbove > spaceBelow
    setMultiPos({
      top: flip ? rect.top - 4 : rect.bottom + 4,
      left: rect.left,
      width: Math.max(rect.width, 160),
      maxHeight: Math.min(maxMenuHeight, flip ? spaceAbove : spaceBelow),
      flip,
    })
    setMultiOpen(key)
  }

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
          onClick={(e) => toggleMulti(e, key, isOpen, 240)}
        >
          {label}
        </button>
        {isOpen && multiPos && (
          <MultiMenu pos={multiPos} onClose={() => closeMulti()}>
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
          </MultiMenu>
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
    if (options === sortedCharacters) {
      const ids = Array.isArray(selected)
        ? selected
        : selected
          ? [selected]
          : []
      return (
        <CharacterSelect
          mode="multi"
          selectAll
          value={ids.map(String)}
          onChange={(next) => onChange(next.map(Number))}
          anyLabel="Any"
          ariaLabel="Characters"
          className="char-select-filter"
        />
      )
    }
    if (options === legalStages) {
      const ids = Array.isArray(selected)
        ? selected
        : selected
          ? [selected]
          : []
      return (
        <StageSelect
          mode="multi"
          selectAll
          value={ids.map(String)}
          onChange={(next) => onChange(next.map(Number))}
          anyLabel="Any"
          ariaLabel="Stages"
          className="char-select-filter"
        />
      )
    }
    const key = `${filterId}:${optionId}`
    const isOpen = multiOpen === key
    const selectedSet = new Set(
      (Array.isArray(selected) ? selected : selected ? [selected] : []).map(
        String,
      ),
    )
    // Selected ids -> chips: keep the id as the value, show the display name.
    const selArr = Array.isArray(selected)
      ? selected
      : selected
        ? [selected]
        : []
    const chips = [...selectedSet].map((id) => {
      const opt = options.find((o) => String(o.id) === id)
      return { value: id, label: opt ? opt.name || opt.shortName : id }
    })
    const removeChip = (v: string) =>
      onChange(selArr.filter((x) => String(x) !== v))

    return (
      <div className="filter-multi-wrap">
        <div
          role="button"
          tabIndex={0}
          className="filter-multi-select"
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              ;(e.currentTarget as HTMLElement).click()
            }
          }}
          onClick={(e) => toggleMulti(e, key, isOpen, 240)}
        >
          <SelectChips chips={chips} placeholder="Any" onRemove={removeChip} />
        </div>
        {isOpen && multiPos && (
          <MultiMenu pos={multiPos} onClose={() => closeMulti()}>
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
          </MultiMenu>
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
    // Selected values sort to the TOP of the same list — one list, ordered.
    // NOT a second panel repeating the pills already visible in the field.
    // Shown regardless of the search box, so a value you've picked is never
    // something you have to go hunting for again.
    const selectedRows = selectedArr.map(
      (v) => namesList.find((n) => n.name === v) ?? { name: v, total: 0 },
    )
    const rest =
      isOpen && !namesLoading
        ? filteredNames.filter((n) => !selectedSet.has(n.name))
        : []
    const capped = rest.slice(0, RENDER_CAP)
    const remaining = rest.length - capped.length

    return (
      <div className="filter-multi-wrap">
        <div
          role="button"
          tabIndex={0}
          className="filter-multi-select"
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              ;(e.currentTarget as HTMLElement).click()
            }
          }}
          onClick={(e) => toggleMulti(e, key, isOpen, 300, true)}
        >
          <SelectChips
            chips={selectedArr.map((v) => ({ value: v, label: v }))}
            placeholder="Any"
            onRemove={(v) => onChange(selectedArr.filter((x) => x !== v))}
          />
        </div>
        {isOpen && multiPos && (
          <MultiMenu pos={multiPos} onClose={() => closeMulti()}>
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
                {selectedRows.map((n) => (
                  <div
                    key={`sel-${n.name}`}
                    className="filter-multi-item filter-multi-item-checked"
                    title={`${n.name} — click to remove`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onChange(selectedArr.filter((v) => v !== n.name))
                    }}
                  >
                    <span className="filter-multi-check">{'\u2714'}</span>
                    <span className="filter-multi-name">{n.name}</span>
                    <span className="filter-autocomplete-count">{n.total}</span>
                  </div>
                ))}
                {selectedRows.length > 0 && (
                  <div className="filter-multi-divider">
                    <span className="filter-multi-divider-line" />
                    {selectedRows.length > 1 && (
                      <button
                        type="button"
                        className="filter-multi-clear"
                        onClick={(e) => {
                          e.stopPropagation()
                          onChange([])
                        }}
                      >
                        Clear all
                      </button>
                    )}
                    <span className="filter-multi-divider-line" />
                  </div>
                )}
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
          </MultiMenu>
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
    // Selected values sort to the TOP of the same list — one list, ordered.
    // NOT a second panel repeating the pills already visible in the field.
    // Shown regardless of the search box, so a value you've picked is never
    // something you have to go hunting for again.
    const selectedRows = selectedArr.map(
      (v) =>
        connectCodesList.find((n) => n.name === v) ?? { name: v, total: 0 },
    )
    const rest =
      isOpen && !codesLoading
        ? filteredCodes.filter((n) => !selectedSet.has(n.name))
        : []
    const capped = rest.slice(0, RENDER_CAP)
    const remaining = rest.length - capped.length

    return (
      <div className="filter-multi-wrap">
        <div
          role="button"
          tabIndex={0}
          className="filter-multi-select"
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              ;(e.currentTarget as HTMLElement).click()
            }
          }}
          onClick={(e) => toggleMulti(e, key, isOpen, 300, true)}
        >
          <SelectChips
            chips={selectedArr.map((v) => ({ value: v, label: v }))}
            placeholder="Any"
            onRemove={(v) => onChange(selectedArr.filter((x) => x !== v))}
          />
        </div>
        {isOpen && multiPos && (
          <MultiMenu pos={multiPos} onClose={() => closeMulti()}>
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
                {selectedRows.map((n) => (
                  <div
                    key={`sel-${n.name}`}
                    className="filter-multi-item filter-multi-item-checked"
                    title={`${n.name} — click to remove`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onChange(selectedArr.filter((v) => v !== n.name))
                    }}
                  >
                    <span className="filter-multi-check">{'\u2714'}</span>
                    <span className="filter-multi-name">{n.name}</span>
                    <span className="filter-autocomplete-count">{n.total}</span>
                  </div>
                ))}
                {selectedRows.length > 0 && (
                  <div className="filter-multi-divider">
                    <span className="filter-multi-divider-line" />
                    {selectedRows.length > 1 && (
                      <button
                        type="button"
                        className="filter-multi-clear"
                        onClick={(e) => {
                          e.stopPropagation()
                          onChange([])
                        }}
                      >
                        Clear all
                      </button>
                    )}
                    <span className="filter-multi-divider-line" />
                  </div>
                )}
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
          </MultiMenu>
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

  if (filter.type === 'aiFilter')
    return (
      <div className="filter-controls">
        <AiFilterControls
          filter={filter}
          previousType={previousType}
          onEditCode={onEditCode}
          onUpdate={onUpdate}
        />
      </div>
    )
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
                      // An edgeguard parser also satisfies sorts that only read
                      // comboer/comboee (character matchup) — see satisfiedByEdgeguard.
                      const edgeguardSatisfies =
                        entry.satisfiedByEdgeguard && hasEdgeguardParser
                      const needsParser =
                        entry.requiresParser &&
                        !hasParser &&
                        !edgeguardSatisfies
                      const reqLabel = entry.satisfiedByEdgeguard
                        ? ' (requires combo or edgeguard parser)'
                        : ' (requires combo parser)'
                      return (
                        <option
                          key={entry.id}
                          value={entry.id}
                          disabled={needsParser}
                          title={entry.tooltip || ''}
                        >
                          {entry.shortName || entry.name}
                          {needsParser ? reqLabel : ''}
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
                        onClick={(e) => toggleMulti(e, posKey, posIsOpen, 240)}
                      >
                        {posLabel}
                      </button>
                      {posIsOpen && multiPos && (
                        <MultiMenu pos={multiPos} onClose={() => closeMulti()}>
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
                        </MultiMenu>
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
                          : nameOf(option.name)}
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
                            : nameOf(option.name)}
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
      {filter.type === 'edgeguard' && (
        <div className="filter-zone-row" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="filter-button filter-zone-btn"
            onClick={(e) => {
              e.stopPropagation()
              setEdgeRectModalOpen(true)
            }}
          >
            ◳ Offstage Line
          </button>
          <span className="filter-zone-summary">
            {`${filter.params?.offstageBuffer ?? DEFAULT_OFFSTAGE_BUFFER} inside the ledge`}
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
        <EdgeguardZoneModal
          initialBuffer={
            filter.params?.offstageBuffer ?? DEFAULT_OFFSTAGE_BUFFER
          }
          onClose={() => setEdgeRectModalOpen(false)}
          onApply={(offstageBuffer) => {
            const filterClone = cloneDeep(filter)
            filterClone.params.offstageBuffer = offstageBuffer
            updateFilter(filterClone, filter)
            setEdgeRectModalOpen(false)
          }}
        />
      )}
    </div>
  )
}
