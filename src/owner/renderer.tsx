// Owner-only extension points, empty in this build: every piece renders nothing.
import type { CSSProperties, ReactNode } from 'react'
import type { ClipSearchFilters, LunarClip } from '../constants/clipSearch'
import type { SelectionWire } from '../lib/selection'

export const useOwnerTools = (): boolean => false
export const useOwnerAdminView = (): boolean => false
export function OwnerDock(): JSX.Element | null {
  return null
}
export function OwnerTopButtons(): JSX.Element | null {
  return null
}
export function OwnerViewSwitch(_props: {
  style: CSSProperties
}): JSX.Element | null {
  return null
}
export function OwnerStartActions(): JSX.Element | null {
  return null
}
export function OwnerResultsActions(_props: {
  filterId: string
  filterLabel: string
  filters: {
    id: string
    type?: string
    label?: string
    inputId?: string
    params?: Record<string, unknown>
  }[]
  selectedCount: number
  getSelection: () => SelectionWire
  total: number | null
}): JSX.Element | null {
  return null
}
export function OwnerClipSearchActions(_props: {
  searched: ClipSearchFilters | null
  dirty: boolean
  total: number | null
  selected: LunarClip[]
  describeSearched: string
  describeForm: string
}): JSX.Element | null {
  return null
}
export const ownerSettingsSections: {
  key: string
  label: string
  render: (_onClose: () => void) => ReactNode
}[] = []
