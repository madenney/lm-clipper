// Every "Lunar Database" button opens the in-app panel, hosted at the app root
// by DatabaseDock.tsx. (Falls back to the website only if nothing hosts it.)
import type { ClipSearchFilters } from '../../constants/clipSearch'

export const OPEN_DATABASE_EVENT = 'lunar-open-database'

export type OpenDatabaseDetail = {
  tab: 'search' | 'clips' | 'transfers'
  /** Find clips opens on this search (e.g. the welcome's Surprise me). */
  clipSearch?: ClipSearchFilters
}

export function openLunarDatabase(
  tab: 'search' | 'clips' | 'transfers' = 'search',
  clipSearch: ClipSearchFilters | undefined = undefined,
) {
  const detail: OpenDatabaseDetail = { tab, clipSearch }
  const handled = !window.dispatchEvent(
    new CustomEvent(OPEN_DATABASE_EVENT, { cancelable: true, detail }),
  )
  if (!handled) window.open('https://www.lunarmelee.com')
}
