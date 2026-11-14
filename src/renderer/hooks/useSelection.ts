import { useState, useEffect, useCallback } from 'react'
import { Selection } from '../../lib/selection'

export default function useSelection(activeFilterId: string) {
  // Compact at any size (lib/selection.ts): Select All is a flag, not every id.
  const [selection, setSelection] = useState<Selection>(Selection.none)
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(
    null,
  )
  const [selectionDuration, setSelectionDuration] = useState<number | null>(
    null,
  )

  // Clear selection when filter changes
  useEffect(() => {
    setSelection(Selection.none())
    setLastSelectedIndex(null)
    setSelectionDuration(null)
  }, [activeFilterId])

  const clearSelection = useCallback(() => {
    setSelection(Selection.none())
    setLastSelectedIndex(null)
    setSelectionDuration(null)
  }, [])

  return {
    selection,
    setSelection,
    lastSelectedIndex,
    setLastSelectedIndex,
    selectionDuration,
    setSelectionDuration,
    clearSelection,
  }
}
