import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import '../styles/CharacterSelect.css'

export type SelectItem = {
  id: number
  name: string
  shortName?: string
}

type Props = {
  /** Selected character ids as strings. Single mode uses at most one. */
  value: string[]
  onChange: (_next: string[]) => void
  /** 'single' picks one (or Any); 'multi' toggles several. */
  mode?: 'single' | 'multi'
  /** Text for "nothing picked" (also the first option in single mode). */
  anyLabel?: string
  ariaLabel?: string
  /** Multi mode: the most that can be picked. */
  maxValues?: number
  /** Multi mode: show Select all / Clear in the menu. */
  selectAll?: boolean
  /** The choices, in display order. */
  items: SelectItem[]
  /** Image URL for an item (shown beside its name). */
  iconFor: (_id: number) => string | null | undefined
  /** Plural noun for ARIA labels, e.g. "characters". */
  noun?: string
  /** 'stage' shows wide thumbnails instead of square icons. */
  variant?: 'character' | 'stage'
  className?: string
  disabled?: boolean
}

type Pos = {
  top: number
  left: number
  width: number
  maxHeight: number
  up: boolean
}

export default function OptionSelect({
  value,
  onChange,
  mode = 'single',
  anyLabel = 'Any',
  ariaLabel,
  maxValues,
  selectAll = false,
  items: characters,
  iconFor,
  noun = 'options',
  variant = 'character',
  className = '',
  disabled = false,
}: Props) {
  const multi = mode === 'multi'
  const uid = useId()
  const listId = `${uid}-list`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState<Pos | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const selected = useMemo(() => new Set(value.map(String)), [value])

  // Rows: Any (single mode) then the characters matching the typed text.
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = characters.filter(
      (c) =>
        !q ||
        c.name.toLowerCase().includes(q) ||
        (c.shortName ?? '').toLowerCase().includes(q),
    )
    const out: { id: string; label: string; icon?: string }[] = []
    if (!multi && (!q || anyLabel.toLowerCase().includes(q))) {
      out.push({ id: '', label: anyLabel })
    }
    list.forEach((c) =>
      out.push({
        id: String(c.id),
        label: c.name,
        icon: iconFor(c.id) || undefined,
      }),
    )
    return out
  }, [characters, query, multi, anyLabel])

  const close = useCallback((refocus: boolean) => {
    setOpen(false)
    setQuery('')
    if (refocus) triggerRef.current?.focus()
  }, [])

  const place = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const below = window.innerHeight - rect.bottom - 12
    const above = rect.top - 12
    const up = below < 280 && above > below
    const room = up ? above : below
    setPos({
      top: up ? rect.top - 4 : rect.bottom + 4,
      left: rect.left,
      width: Math.max(rect.width, 200),
      maxHeight: Math.max(120, Math.min(340, room)),
      up,
    })
  }, [])

  const openMenu = () => {
    if (disabled || !triggerRef.current) return
    place()
    const first = value[0]
    const idx = first
      ? characters.findIndex((c) => String(c.id) === String(first)) +
        (multi ? 0 : 1)
      : 0
    setActive(Math.max(0, idx))
    setQuery('')
    setOpen(true)
  }

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const el = listRef.current?.children[active] as HTMLElement | undefined
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [active, open])

  // Click outside closes; so does anything that would leave the menu adrift.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t))
        return
      close(false)
    }
    // The menu is fixed: follow the field when the page or a panel scrolls.
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return
      place()
    }
    const onResize = () => place()
    // Esc closes from anywhere while open (focus can sit on the page after a pick).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      close(true)
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open, close, place])

  const choose = (id: string) => {
    if (!multi) {
      onChange(id ? [id] : [])
      close(true)
      return
    }
    if (selected.has(id)) onChange(value.filter((v) => String(v) !== id))
    else if (!maxValues || value.length < maxValues) onChange([...value, id])
    // A re-render of the surrounding panel can drop focus; keep typing and keys working.
    inputRef.current?.focus()
  }

  const lastRow = Math.max(0, rows.length - 1)
  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(lastRow, a + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(0, a - 1))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActive(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActive(lastRow)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (rows[active]) choose(rows[active].id)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      // Keep a surrounding panel (a filter card) from also reacting to Esc.
      e.nativeEvent.stopImmediatePropagation()
      close(true)
    } else if (e.key === 'Tab') {
      close(false)
    }
  }

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault()
      if (!open) openMenu()
    }
  }

  const picked = characters.filter((c) => selected.has(String(c.id)))
  const single = !multi ? picked[0] : undefined
  const singleIcon = single ? iconFor(single.id) || undefined : undefined
  const activeRow = Math.min(active, lastRow)

  return (
    // Clicks stay inside the picker: a surrounding card or label must not react
    // (React bubbles portal events through the component tree too).
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      className={`char-select${variant === 'stage' ? ' char-select-stage' : ''} ${className}`.trim()}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        ref={triggerRef}
        type="button"
        className="char-select-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={onTriggerKey}
      >
        {multi ? (
          picked.length === 0 ? (
            <span className="char-select-any">{anyLabel}</span>
          ) : (
            <span className="char-select-chips">
              {picked.map((c) => {
                const icon = iconFor(c.id)
                return (
                  <span key={c.id} className="char-select-chip" title={c.name}>
                    {icon && <img src={icon} alt="" />}
                    {c.shortName || c.name}
                  </span>
                )
              })}
            </span>
          )
        ) : single ? (
          <span className="char-select-value">
            {singleIcon && <img src={singleIcon} alt="" />}
            {single.name}
          </span>
        ) : (
          <span className="char-select-any">{anyLabel}</span>
        )}
        <span className="char-select-caret" aria-hidden="true">
          &#9662;
        </span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="char-select-menu"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              ...(pos.up
                ? { bottom: window.innerHeight - pos.top }
                : { top: pos.top }),
              left: pos.left,
              width: pos.width,
              maxHeight: pos.maxHeight,
            }}
          >
            <input
              ref={inputRef}
              className="char-select-search"
              type="text"
              placeholder="Type to filter"
              value={query}
              role="searchbox"
              aria-label={`Filter ${noun}`}
              aria-controls={listId}
              aria-activedescendant={
                rows[activeRow]
                  ? `${uid}-opt-${rows[activeRow].id || 'any'}`
                  : undefined
              }
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
              onKeyDown={onInputKey}
              autoComplete="off"
              spellCheck={false}
            />
            {multi && selectAll && (
              <div className="char-select-actions">
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() =>
                    onChange(
                      (maxValues
                        ? characters.slice(0, maxValues)
                        : characters
                      ).map((c) => String(c.id)),
                    )
                  }
                >
                  Select all
                </button>
                <button
                  type="button"
                  tabIndex={-1}
                  disabled={value.length === 0}
                  onClick={() => onChange([])}
                >
                  Clear
                </button>
              </div>
            )}
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              aria-multiselectable={multi || undefined}
              aria-label={
                ariaLabel || noun.charAt(0).toUpperCase() + noun.slice(1)
              }
              className="char-select-list"
            >
              {rows.map((r, i) => {
                const on = r.id ? selected.has(r.id) : selected.size === 0
                return (
                  <li
                    key={r.id || 'any'}
                    id={`${uid}-opt-${r.id || 'any'}`}
                    role="option"
                    aria-selected={on}
                    className={`char-select-option${i === activeRow ? ' active' : ''}${on ? ' on' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(r.id)}
                  >
                    {multi && (
                      <span className="char-select-check" aria-hidden="true">
                        {on ? '✔' : ''}
                      </span>
                    )}
                    <span className="char-select-icon">
                      {r.icon && <img src={r.icon} alt="" />}
                    </span>
                    <span>{r.label}</span>
                  </li>
                )
              })}
              {rows.length === 0 && (
                <li className="char-select-empty" aria-hidden="true">
                  No match
                </li>
              )}
            </ul>
          </div>,
          document.body,
        )}
    </div>
  )
}
