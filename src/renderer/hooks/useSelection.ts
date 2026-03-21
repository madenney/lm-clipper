import { useState, useEffect, useCallback } from 'react'

export default function useSelection(activeFilterId: string) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(
    null,
  )
  const [selectionDuration, setSelectionDuration] = useState<number | null>(
    null,
  )

  // Clear selection when filter changes
  useEffect(() => {
    setSelectedIds(new Set())
    setLastSelectedIndex(null)
    setSelectionDuration(null)
  }, [activeFilterId])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
    setLastSelectedIndex(null)
    setSelectionDuration(null)
  }, [])

  return {
    selectedIds,
    setSelectedIds,
    lastSelectedIndex,
    setLastSelectedIndex,
    selectionDuration,
    setSelectionDuration,
    clearSelection,
  }
}
