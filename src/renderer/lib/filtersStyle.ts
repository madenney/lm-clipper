import { useEffect, useState } from 'react'

/**
 * Which look the filter list uses (mock-up, 2026-10-03): 'compact'
 * (styles/FiltersCompact.css) or 'classic'. Switched from the dev bar and
 * remembered per machine; the compact look is the default while it's tried.
 */
export type FiltersStyle = 'compact' | 'classic'
const KEY = 'filtersStyle'
const EVENT = 'lunar:filtersStyle'

export function getFiltersStyle(): FiltersStyle {
  try {
    return window.localStorage.getItem(KEY) === 'classic'
      ? 'classic'
      : 'compact'
  } catch {
    return 'compact'
  }
}

export function setFiltersStyle(style: FiltersStyle) {
  try {
    window.localStorage.setItem(KEY, style)
  } catch {
    /* storage unavailable: this session only */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: style }))
}

export function useFiltersStyle(): FiltersStyle {
  const [style, setStyle] = useState(getFiltersStyle)
  useEffect(() => {
    const on = (e: Event) => setStyle((e as CustomEvent<FiltersStyle>).detail)
    window.addEventListener(EVENT, on)
    return () => window.removeEventListener(EVENT, on)
  }, [])
  return style
}
