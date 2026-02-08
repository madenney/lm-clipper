import { useState, useEffect, useRef, type MutableRefObject } from 'react'
import { zoomConfig } from '../zoomConfig'
import { clamp, roundNumber, type Layout } from '../lib/layoutMath'
import { perfLog } from '../perfLogger'

type DebugFns = {
  logZoomTrace: (
    _event: string,
    _meta?: Record<string, string | number | boolean | null>,
  ) => void
  updateDebugLines: (_source: string) => void
}

type ShowingCountStore = {
  set: (_value: number) => void
}

type Range = { offset: number; limit: number }

const maxVisibleItems = zoomConfig.densityMaxVisibleItems
const maxOverscanItems = 1000
const maxWebglFetchItems = zoomConfig.canvasRenderAt
const perfLogUpdateThresholdMs = 4

export type UseWindowRangeParams = {
  trayRef: MutableRefObject<HTMLDivElement | null>
  resultsRef: MutableRefObject<HTMLDivElement | null>
  resultsTopRef: MutableRefObject<number>
  layoutRef: MutableRefObject<Layout>
  displayTotalResultsRef: MutableRefObject<number>
  totalResultsRef: MutableRefObject<number>
  isZoomingRef: MutableRefObject<boolean>
  webglWantedRef: MutableRefObject<boolean>
  useWebglModeRef: MutableRefObject<boolean>
  webglDataRangeRef: MutableRefObject<Range>
  scheduleWebglDrawRef: MutableRefObject<() => void>
  debugRef: MutableRefObject<DebugFns>
  showingCountStore: ShowingCountStore
  refreshResultsTop: () => void
  // Values for effect dependencies
  layout: Layout
  displayTotalResults: number
  activeFilterId: string
  activeFilterTableId: string
  currentPage: number
  paginationEnabled: boolean
}

export const useWindowRange = (params: UseWindowRangeParams) => {
  const {
    trayRef,
    resultsRef: _resultsRef,
    resultsTopRef,
    layoutRef,
    displayTotalResultsRef,
    totalResultsRef,
    isZoomingRef,
    webglWantedRef,
    useWebglModeRef,
    webglDataRangeRef,
    scheduleWebglDrawRef,
    debugRef,
    showingCountStore,
    refreshResultsTop,
    layout,
    displayTotalResults,
    activeFilterId,
    activeFilterTableId,
    currentPage,
    paginationEnabled,
  } = params

  const [windowRange, setWindowRange] = useState<Range>({ offset: 0, limit: 0 })
  const [visibleRange, setVisibleRange] = useState<Range>({
    offset: 0,
    limit: 0,
  })
  const windowRangeRef = useRef(windowRange)
  const visibleRangeRef = useRef(visibleRange)
  const visibleCountRef = useRef(0)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    visibleRangeRef.current = visibleRange
  }, [visibleRange])

  const updateWindowRange = () => {
    const updateStart = performance.now()
    const node = trayRef.current
    const scrollTop = node ? node.scrollTop : 0
    const rTop = resultsTopRef.current
    const scrollOffset = Math.max(0, scrollTop - rTop)
    const { columns, totalRows, cell, padding, availableHeight } =
      layoutRef.current
    const total = displayTotalResultsRef.current

    if (total === 0 || columns <= 0 || totalRows === 0) {
      const cleared = { offset: 0, limit: 0 }
      if (
        cleared.offset !== windowRangeRef.current.offset ||
        cleared.limit !== windowRangeRef.current.limit
      ) {
        windowRangeRef.current = cleared
        setWindowRange(cleared)
      }
      if (visibleCountRef.current !== 0) {
        visibleCountRef.current = 0
        showingCountStore.set(0)
      }
      if (
        visibleRangeRef.current.offset !== 0 ||
        visibleRangeRef.current.limit !== 0
      ) {
        const clearedVisible = { offset: 0, limit: 0 }
        visibleRangeRef.current = clearedVisible
        setVisibleRange(clearedVisible)
      }
      const dur = performance.now() - updateStart
      if (dur >= perfLogUpdateThresholdMs) {
        perfLog.duration('window_range', dur, { total, columns, totalRows })
      }
      return
    }

    const overscanRows = Math.max(
      1,
      Math.ceil(Math.min(maxOverscanItems, maxVisibleItems * 0.25) / columns),
    )
    const startRow = clamp(
      Math.floor((scrollOffset - padding) / cell) - overscanRows,
      0,
      totalRows,
    )
    const endRow = clamp(
      Math.ceil((scrollOffset + availableHeight - padding) / cell) +
        overscanRows,
      0,
      totalRows,
    )
    const visibleStartRow = clamp(
      Math.floor((scrollOffset - padding) / cell),
      0,
      totalRows,
    )
    const visibleEndRow = clamp(
      Math.ceil((scrollOffset + availableHeight - padding) / cell),
      0,
      totalRows,
    )
    const visibleOffset = visibleStartRow * columns
    const visibleLimit = Math.min(
      total - visibleOffset,
      Math.max(0, visibleEndRow - visibleStartRow) * columns,
    )

    const offset = startRow * columns
    let limit = Math.min(
      total - offset,
      Math.max(0, endRow - startRow) * columns,
    )
    let next = { offset, limit }

    if (webglWantedRef.current && limit > maxWebglFetchItems) {
      const center = Math.floor(visibleOffset + visibleLimit / 2)
      const maxStart = Math.max(0, total - maxWebglFetchItems)
      const clampedOffset = clamp(
        center - Math.floor(maxWebglFetchItems / 2),
        0,
        maxStart,
      )
      limit = Math.min(maxWebglFetchItems, total - clampedOffset)
      next = { offset: clampedOffset, limit }
    }

    if (!isZoomingRef.current) {
      if (
        next.offset !== windowRangeRef.current.offset ||
        next.limit !== windowRangeRef.current.limit
      ) {
        windowRangeRef.current = next
        setWindowRange(next)
      }
    }

    const actualVisible = Math.min(totalResultsRef.current, visibleLimit)
    if (actualVisible !== visibleCountRef.current) {
      visibleCountRef.current = actualVisible
      showingCountStore.set(actualVisible)
    }

    if (
      visibleOffset !== visibleRangeRef.current.offset ||
      visibleLimit !== visibleRangeRef.current.limit
    ) {
      const nextVisible = { offset: visibleOffset, limit: visibleLimit }
      visibleRangeRef.current = nextVisible
      setVisibleRange(nextVisible)
    }

    if (useWebglModeRef.current) {
      scheduleWebglDrawRef.current()
    }

    const dur = performance.now() - updateStart
    debugRef.current.updateDebugLines('window_range')
    debugRef.current.logZoomTrace('window_range', {
      durationMs: roundNumber(dur, 2),
      visibleStartRow,
      visibleEndRow,
      startRow,
      endRow,
      overscanRows,
    })
    if (dur >= perfLogUpdateThresholdMs) {
      perfLog.duration('window_range', dur, {
        total,
        columns,
        totalRows,
        visibleLimit,
        cell: Math.round(cell),
      })
    }
  }

  const scheduleWindowUpdate = () => {
    if (rafRef.current != null) return
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null
      updateWindowRange()
    })
  }

  const handleScroll = () => {
    scheduleWindowUpdate()
    debugRef.current.logZoomTrace('scroll')
  }

  // Schedule update when layout/results change
  useEffect(() => {
    scheduleWindowUpdate()
  }, [
    layout.columns,
    layout.cell,
    layout.totalRows,
    layout.availableHeight,
    displayTotalResults,
    activeFilterId,
    activeFilterTableId,
  ])

  // Reset on filter/page change
  useEffect(() => {
    const node = trayRef.current
    if (node) node.scrollTop = 0
    refreshResultsTop()
    const reset = { offset: 0, limit: 0 }
    windowRangeRef.current = reset
    setWindowRange(reset)
    visibleRangeRef.current = reset
    setVisibleRange(reset)
    visibleCountRef.current = 0
    showingCountStore.set(0)
    webglDataRangeRef.current = reset
    scheduleWindowUpdate()
  }, [activeFilterId, activeFilterTableId, currentPage, paginationEnabled])

  return {
    windowRange,
    visibleRange,
    windowRangeRef,
    visibleRangeRef,
    visibleCountRef,
    rafRef,
    scheduleWindowUpdate,
    handleScroll,
  }
}
