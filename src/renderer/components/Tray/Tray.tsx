/**
 * Tray - Clip Display System
 *
 * Prioritizes UI responsiveness:
 * - Zoom changes are instant (layout only)
 * - Data fetching is debounced and non-blocking
 * - Spinner shows while loading, but UI never freezes
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { FiZoomIn, FiZoomOut } from 'react-icons/fi'
import useIpcListener from '../../hooks/useIpcListener'

import { DomLayer } from './DomLayer'
import { GpuLayer } from './GpuLayer'
import { FullCard } from '../Clip'
import { useClipMode } from '../../hooks/useClipMode'
import { clipDisplayConfig } from '../../config/clipDisplay'
import type { ClipData } from '../Clip'
import type { ClipMode } from '../../config/clipDisplay'
import type {
  ShallowArchiveInterface,
  ClipInterface,
  FileInterface,
  LiteItem,
} from '../../../constants/types'
import ipcBridge from '../../ipcBridge'
import './Tray.css'
import { debugLog } from '../../debugLog'

type TrayProps = {
  archive: ShallowArchiveInterface | null
  activeFilterId: string
  selectedIds: Set<string>
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>
  lastSelectedIndex: number | null
  setLastSelectedIndex: React.Dispatch<React.SetStateAction<number | null>>
  setSelectionDuration: React.Dispatch<React.SetStateAction<number | null>>
  addStartFrames: number
  addEndFrames: number
  onClipPlay?: (_payload: {
    path: string
    startFrame?: number
    endFrame?: number
    lastFrame?: number
  }) => void
  onClipRecord?: (_clipId: string) => void
  onImport?: () => void
  onImportFolder?: (_dir: string) => void
  onOpenFolder?: (_dir: string) => void
}

// Zoom nudge step - increases at larger sizes
const ZOOM_STEP_SMALL = 1
const ZOOM_STEP_MEDIUM = 2
const ZOOM_STEP_LARGE = 4
const ZOOM_STEP_XLARGE = 8
const ZOOM_STEP_THRESHOLD_MEDIUM = 40 // Switch to medium step
const ZOOM_STEP_THRESHOLD_LARGE = 100 // Switch to large step
const ZOOM_STEP_THRESHOLD_XLARGE = 200 // Switch to xlarge step

// Debounce delay for fetching (ms)
const FETCH_DEBOUNCE_MS = 150

export function Tray({
  archive,
  activeFilterId,
  selectedIds,
  setSelectedIds,
  lastSelectedIndex,
  setLastSelectedIndex,
  setSelectionDuration,
  addStartFrames,
  addEndFrames,
  onClipPlay,
  onClipRecord,
  onImport,
  onImportFolder,
  onOpenFolder,
}: TrayProps) {
  // If the user has a Slippi replay folder, offer to import it straight from
  // the empty import zone. Detected once, lazily, when that zone is relevant.
  const [slippiReplays, setSlippiReplays] = useState<{
    dir: string
    count: number
  } | null>(null)
  const slippiFetchedRef = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // Track which filters are currently running
  const [runningFilterIndices, setRunningFilterIndices] = useState<Set<number>>(
    new Set(),
  )
  // Bumped on a timer while viewing a running filter to trigger re-fetches
  const [previewTick, setPreviewTick] = useState(0)

  useIpcListener('currentlyRunningFilter', (event: { running: number[] }) => {
    setRunningFilterIndices(new Set(event.running))
  })

  // Tray dimensions
  const [trayWidth, setTrayWidth] = useState(800)
  const [trayHeight, setTrayHeight] = useState(600)

  // Zoom state - this updates instantly
  const [zoomSize, setZoomSize] = useState<number>(100)

  // Clip data - this updates after debounced fetch
  const [clips, setClips] = useState<ClipData[]>([])
  const [lightData, setLightData] = useState<{ id: string; stage: number }[]>(
    [],
  )
  const [isLoading, setIsLoading] = useState(false)
  // Real total count from DB (returned alongside items)
  const [fetchedTotal, setFetchedTotal] = useState(0)

  // Num per page (max items to fetch/display)
  const [numPerPage, setNumPerPage] = useState(1000)
  const [dataPage, setDataPage] = useState(0)

  // Pagination for full mode
  const [currentPage, setCurrentPage] = useState(0)

  // Saved zoom state for returning from full mode (double-click → Escape/close)
  const [savedZoom, setSavedZoom] = useState<number | null>(null)

  // Track pending fetch to cancel stale ones
  const fetchIdRef = useRef(0)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevFilterIdRef = useRef(activeFilterId)

  // Detect if the active filter is the core game filter (type === 'files')
  const activeFilter = useMemo(
    () => archive?.filters.find((f) => f.id === activeFilterId),
    [archive, activeFilterId],
  )
  const isGameFilter = activeFilter?.type === 'files'
  const activeFilterIndex =
    archive?.filters.findIndex((f) => f.id === activeFilterId) ?? -1
  const comboFilterTypes = new Set([
    'slpParser',
    'comboFilter',
    'actionStateFilter',
    'reverse',
    'edgeguard',
    'edgeguard2',
    'edgeguardFilter',
  ])
  const isClips = useMemo(() => {
    if (!archive || activeFilterIndex < 0) return false
    return archive.filters
      .slice(0, activeFilterIndex + 1)
      .some((f) => comboFilterTypes.has(f.type))
  }, [archive, activeFilterIndex])

  // Check if the active filter is one of the currently running filters
  const isActiveFilterRunning =
    activeFilterIndex >= 0 && runningFilterIndices.has(activeFilterIndex)

  // Auto-refresh while viewing a running filter
  useEffect(() => {
    if (!isActiveFilterRunning) return
    const interval = setInterval(() => {
      setPreviewTick((t) => t + 1)
    }, 2000)
    return () => clearInterval(interval)
  }, [isActiveFilterRunning])

  // Total count from archive
  const totalClips = useMemo(() => {
    if (!archive) return 0
    // For unprocessed game filter, show files table count
    if (isGameFilter && !activeFilter?.isProcessed) return archive.files ?? 0
    if (activeFilter) return activeFilter.results ?? 0
    return 0
  }, [archive, activeFilterId, isGameFilter, activeFilter])

  // Whether the active total is actually known yet. While a count is still
  // hydrating (null), we fetch a page optimistically rather than gating on a
  // total of 0 — so the clips show immediately and only the total spins.
  // Plain derived value (no hook) to keep the hook list stable.
  let totalKnown = true
  if (archive) {
    if (isGameFilter && !activeFilter?.isProcessed) {
      totalKnown = archive.files != null
    } else if (activeFilter) {
      totalKnown = activeFilter.results != null
    }
  }

  const prevTotalClipsRef = useRef(totalClips)

  // Measure content area - debounced to avoid thrashing
  useEffect(() => {
    const content = contentRef.current
    if (!content) return

    let rafId: number | null = null
    const measure = () => {
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        setTrayWidth(content.clientWidth)
        setTrayHeight(content.clientHeight)
      })
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    return () => {
      observer.disconnect()
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [])

  // Calculate mode and layout - this is instant, no data fetch
  const modeInfo = useClipMode({
    zoomSize,
    totalClips,
    trayWidth,
    trayHeight,
  })

  const {
    mode,
    isDom,
    isGpu,
    clipSize,
    clipHeight: _clipHeight,
    gap,
    columns,
    visibleCount,
  } = modeInfo

  // Pagination for full mode — one card per page since it fills the tray
  const itemsPerPage = useMemo(() => {
    if (mode !== 'full') return 0
    return 1
  }, [mode])

  const totalPages = useMemo(() => {
    if (mode !== 'full' || itemsPerPage === 0) return 0
    return Math.ceil(clips.length / itemsPerPage)
  }, [mode, clips.length, itemsPerPage])

  // Reset page when filter changes (but not mode — double-click sets currentPage before mode switches)
  useEffect(() => {
    setCurrentPage(0)
  }, [activeFilterId])

  // Reset data page when filter or numPerPage changes
  useEffect(() => {
    setDataPage(0)
  }, [activeFilterId, numPerPage])

  // Clamp current page to valid range
  useEffect(() => {
    if (totalPages > 0 && currentPage >= totalPages) {
      setCurrentPage(Math.max(0, totalPages - 1))
    }
  }, [totalPages, currentPage])

  // Get clips for current page (full mode only)
  const paginatedClips = useMemo(() => {
    if (mode !== 'full') return clips
    const start = currentPage * itemsPerPage
    return clips.slice(start, start + itemsPerPage)
  }, [mode, clips, currentPage, itemsPerPage])

  // DEBUG: Log mode switches
  useEffect(() => {
    debugLog('[Tray] Mode', {
      mode,
      isDom,
      isGpu,
      clipSize,
      visibleCount,
      totalClips,
      lightDataLen: lightData.length,
    })
  }, [mode, isDom, isGpu, clipSize, visibleCount, totalClips, lightData.length])

  // Track values in refs to avoid re-triggering fetch on import updates
  const totalClipsRef = useRef(totalClips)
  totalClipsRef.current = totalClips

  // Calculate zoom-based capacity (not capped by totalClips) to use for fetch triggers
  // This way imports don't trigger fetches
  const zoomCapacity = useMemo(() => {
    const cellSize = clipSize + gap
    const padding = gap
    const availableWidth = Math.max(0, trayWidth - padding * 2)
    const availableHeight = Math.max(0, trayHeight - padding * 2)
    const cols =
      cellSize > 0
        ? Math.max(1, Math.floor((availableWidth + gap) / cellSize))
        : 1
    const rows =
      cellSize > 0 ? Math.max(1, Math.ceil(availableHeight / cellSize)) : 1
    return cols * rows
  }, [clipSize, gap, trayWidth, trayHeight])

  // Debounced fetch - only on zoom/filter changes, NOT on totalClips/visibleCount changes
  useEffect(() => {
    if (!archive) {
      setClips([])
      setLightData([])
      setFetchedTotal(0)
      setIsLoading(false)
      prevFilterIdRef.current = activeFilterId
      return
    }

    // Nothing to fetch — clear everything immediately (e.g. new empty project).
    // But if the count is merely still hydrating (unknown), don't clear — fetch
    // optimistically below so clips appear while the total spins.
    const currentTotal = totalClipsRef.current
    if (currentTotal === 0 && totalKnown && !isActiveFilterRunning) {
      setClips([])
      setLightData([])
      setFetchedTotal(0)
      setIsLoading(false)
      prevFilterIdRef.current = activeFilterId
      prevTotalClipsRef.current = currentTotal
      return
    }

    // Show loading immediately when switching filters or when a non-files filter's results changed (re-run)
    // Don't clear during file import — the files count increases gradually and clearing causes blipping
    const filterChanged = prevFilterIdRef.current !== activeFilterId
    const resultsChanged =
      prevTotalClipsRef.current !== currentTotal && !isGameFilter
    prevFilterIdRef.current = activeFilterId
    prevTotalClipsRef.current = currentTotal
    if (filterChanged || resultsChanged) {
      setClips([])
      setLightData([])
      setFetchedTotal(0)
      setIsLoading(true)
    }

    // Clear previous debounce timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    const doFetch = () => {
      const currentFetchId = ++fetchIdRef.current
      const fetchTotal = totalClipsRef.current

      // Fetch visible + buffer for both modes
      // When viewing a running filter or importing into game filter, don't cap by totalClips — just fetch what we can
      const isLiveUpdating = isActiveFilterRunning
      // When the total isn't known yet (count still hydrating), fetch a full
      // page optimistically instead of capping by an as-yet-unknown total.
      const countUnknown = !totalKnown
      const targetCount =
        isLiveUpdating || countUnknown
          ? numPerPage
          : Math.min(numPerPage, fetchTotal)
      const limit = isDom
        ? Math.min(targetCount, clipDisplayConfig.limits.maxDomElements)
        : targetCount

      if (limit <= 0 && !isLiveUpdating) {
        setIsLoading(false)
        return
      }

      // For unprocessed game filter, fetch from 'files' table directly
      const tableId =
        isGameFilter && !activeFilter?.isProcessed ? 'files' : activeFilterId

      // Show loading if we need more data than we have (zoom changes)
      // Don't flash loading during auto-refresh of a running filter or import
      if (!filterChanged && !isLiveUpdating) {
        const currentLoaded = isDom ? clips.length : lightData.length
        if (limit > currentLoaded) {
          setIsLoading(true)
        }
      }

      debugLog('[Tray] Fetching', { limit, isDom, isGpu, zoomCapacity })

      ipcBridge.getResults(
        {
          filterId: tableId,
          offset: dataPage * numPerPage,
          limit,
          lite: isGpu,
        },
        (response: {
          items: (ClipInterface | FileInterface | LiteItem)[]
          total: number
          error?: string
        }) => {
          if (currentFetchId !== fetchIdRef.current) return
          // A timed-out / errored reply has no items — never set state to
          // undefined (that would make clips.length throw on the next render).
          const items = Array.isArray(response?.items) ? response.items : null
          if (!items) {
            setIsLoading(false)
            return
          }
          const dbTotal = response.total

          if (isDom) {
            setClips(items as ClipData[])
          }
          setLightData(
            items.map((item, i) => ({
              id:
                'id' in item && item.id != null
                  ? String(item.id)
                  : 'path' in item && item.path
                    ? item.path
                    : String(i),
              stage: item.stage,
            })),
          )
          setFetchedTotal(dbTotal)
          setIsLoading(false)
        },
      )
    }

    // Debounce fetches to avoid excessive calls while zooming
    debounceTimerRef.current = setTimeout(doFetch, FETCH_DEBOUNCE_MS)

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [
    archive,
    activeFilterId,
    zoomCapacity,
    isDom,
    isGpu,
    isGameFilter,
    activeFilter,
    isActiveFilterRunning,
    previewTick,
    numPerPage,
    dataPage,
  ]) // eslint-disable-line react-hooks/exhaustive-deps -- totalClips tracked via ref to avoid import churn

  // Get zoom step based on current size
  const getZoomStep = useCallback((currentSize: number) => {
    if (currentSize >= ZOOM_STEP_THRESHOLD_XLARGE) return ZOOM_STEP_XLARGE
    if (currentSize >= ZOOM_STEP_THRESHOLD_LARGE) return ZOOM_STEP_LARGE
    if (currentSize >= ZOOM_STEP_THRESHOLD_MEDIUM) return ZOOM_STEP_MEDIUM
    return ZOOM_STEP_SMALL
  }, [])

  // Zoom handlers - these are instant, no waiting
  const handleZoomIn = useCallback(() => {
    setZoomSize((prev) => {
      const step = getZoomStep(prev)
      return Math.min(prev + step, clipDisplayConfig.thresholds.full)
    })
  }, [getZoomStep])

  const handleZoomOut = useCallback(() => {
    setZoomSize((prev) => {
      const step = getZoomStep(prev)
      return Math.max(prev - step, 1)
    })
  }, [getZoomStep])

  // Handle bulk removal of selected items
  const handleDeleteSelected = useCallback(() => {
    if (selectedIds.size === 0) return
    const ids = [...selectedIds].map(Number).filter((n) => !Number.isNaN(n))
    if (ids.length === 0) return

    // Optimistically remove from local state
    const idsToRemove = new Set(selectedIds)
    setClips((prev) =>
      prev.filter((clip) => {
        const clipId =
          'id' in clip && clip.id != null
            ? String(clip.id)
            : 'path' in clip && clip.path
              ? clip.path
              : ''
        return !idsToRemove.has(clipId as string)
      }),
    )
    setLightData((prev) => prev.filter((item) => !idsToRemove.has(item.id)))
    setSelectedIds(new Set())
    setLastSelectedIndex(null)

    if (isGameFilter && !activeFilter?.isProcessed) {
      // Unprocessed game filter reads from 'files' table — IDs are file IDs
      ipcBridge.removeGames(ids)
    } else {
      // Processed game filter or any other filter — IDs are filter table row IDs
      ipcBridge.removeResults({ filterId: activeFilterId, rowIds: ids })
    }
  }, [
    selectedIds,
    isGameFilter,
    activeFilter,
    activeFilterId,
    setSelectedIds,
    setLastSelectedIndex,
  ])

  // Keyboard shortcuts: Escape to clear, Ctrl+A to select all visible, Z/X/arrows for full mode nav
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip when an input/textarea is focused
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      if (e.key === 'Escape') {
        if (mode === 'full' && savedZoom !== null) {
          // Return to previous zoom level
          setZoomSize(savedZoom)
          setSavedZoom(null)
        } else {
          setSelectedIds(new Set())
          setLastSelectedIndex(null)
        }
      } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        // Select all visible clips
        const allIds = new Set(lightData.map((item) => item.id))
        setSelectedIds(allIds)
      } else if (mode === 'full' && (e.key === 'z' || e.key === 'ArrowLeft')) {
        setCurrentPage((p) => Math.max(0, p - 1))
      } else if (mode === 'full' && (e.key === 'x' || e.key === 'ArrowRight')) {
        setCurrentPage((p) => Math.min(Math.max(0, clips.length - 1), p + 1))
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        handleDeleteSelected()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    setSelectedIds,
    setLastSelectedIndex,
    lightData,
    mode,
    clips.length,
    savedZoom,
    handleDeleteSelected,
  ])

  // Wheel zoom - use native listener with { passive: false } to allow preventDefault
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        setZoomSize((prev) => {
          const step =
            prev >= ZOOM_STEP_THRESHOLD_XLARGE
              ? ZOOM_STEP_XLARGE
              : prev >= ZOOM_STEP_THRESHOLD_LARGE
                ? ZOOM_STEP_LARGE
                : prev >= ZOOM_STEP_THRESHOLD_MEDIUM
                  ? ZOOM_STEP_MEDIUM
                  : ZOOM_STEP_SMALL
          const delta = e.deltaY > 0 ? -step : step
          return Math.max(
            1,
            Math.min(prev + delta, clipDisplayConfig.thresholds.full),
          )
        })
      }
    }

    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [])

  // Mode label for display
  const _modeLabel = useMemo(() => {
    switch (mode) {
      case 'full':
        return 'Full'
      case 'mode2':
        return 'Detail'
      case 'mode3':
        return 'Compact'
      case 'mode4':
        return 'Micro'
      default:
        return mode
    }
  }, [mode])

  // Cross-page selection tracking
  const crossPageRef = useRef(false)
  const tableDurationRef = useRef(0) // raw frame sum from DB (no addStart/addEnd)
  const totalItemCountRef = useRef(0) // total items when Select All was clicked
  const excludedRawRef = useRef(0) // raw frames of excluded (deselected) clips
  const excludedCountRef = useRef(0) // number of excluded clips

  // Helper: compute raw frame duration for a set of clips (no addStart/addEnd)
  const computeRawDuration = useCallback((clipList: ClipData[]) => {
    let totalFrames = 0
    for (const clip of clipList) {
      const start = clip.startFrame ?? 0
      const end =
        (clip.endFrame ?? 0) > 0
          ? (clip.endFrame ?? 0)
          : (('lastFrame' in clip ? clip.lastFrame : 0) ?? 0)
      totalFrames += Math.max(0, end - start)
    }
    return totalFrames
  }, [])

  // Recompute cross-page duration from cached values
  const updateCrossPageDuration = useCallback(() => {
    const rawDuration = tableDurationRef.current - excludedRawRef.current
    const count = totalItemCountRef.current - excludedCountRef.current
    setSelectionDuration(rawDuration + count * (addStartFrames + addEndFrames))
  }, [addStartFrames, addEndFrames, setSelectionDuration])

  // Calculate duration when selection changes (including during drag)
  useEffect(() => {
    if (selectedIds.size === 0) {
      setSelectionDuration(null)
      crossPageRef.current = false
      return
    }

    // Cross-page selections are managed by click handlers
    if (crossPageRef.current) {
      updateCrossPageDuration()
      return
    }

    // Local calc for single-page selections
    const selectedClips = clips.filter((clip) => {
      const id =
        'id' in clip && clip.id != null
          ? String(clip.id)
          : 'path' in clip
            ? clip.path
            : ''
      return selectedIds.has(id as string)
    })
    let totalFrames = 0
    for (const clip of selectedClips) {
      const start = clip.startFrame ?? 0
      const end =
        (clip.endFrame ?? 0) > 0
          ? (clip.endFrame ?? 0)
          : (('lastFrame' in clip ? clip.lastFrame : 0) ?? 0)
      totalFrames += Math.max(0, end - start) + addStartFrames + addEndFrames
    }
    setSelectionDuration(totalFrames)
  }, [
    selectedIds,
    clips,
    setSelectionDuration,
    addStartFrames,
    addEndFrames,
    updateCrossPageDuration,
  ])

  // Reorder drag state
  const [reorderInsertIndex, setReorderInsertIndex] = useState<number | null>(
    null,
  )
  const reorderDragRef = useRef<{
    startX: number
    startY: number
    active: boolean
    draggingIds: Set<string>
  } | null>(null)
  const reorderPendingClickRef = useRef<{
    index: number
    clipId: string
  } | null>(null)

  // Handle mouse down on clip - select or start reorder drag
  const handleClipMouseDown = useCallback(
    (index: number, clipId: string, event: React.MouseEvent) => {
      if (event.button !== 0) return // Only left click
      if (reorderDragRef.current?.active) return // Suppress during reorder

      if (event.shiftKey && lastSelectedIndex !== null) {
        // Shift+click: range select from last selected
        crossPageRef.current = false
        const newSelected = new Set(selectedIds)
        const start = Math.min(lastSelectedIndex, index)
        const end = Math.max(lastSelectedIndex, index)
        for (let i = start; i <= end; i++) {
          const item = lightData[i]
          if (item) {
            newSelected.add(item.id)
          }
        }
        setSelectedIds(newSelected)
      } else if (event.ctrlKey || event.metaKey) {
        // Ctrl+click: toggle single item
        if (crossPageRef.current) {
          const clip = clips.find((c) => {
            const id = 'id' in c && c.id != null ? String(c.id) : ''
            return id === clipId
          })
          if (clip) {
            const rawDur = computeRawDuration([clip])
            if (selectedIds.has(clipId)) {
              excludedRawRef.current += rawDur
              excludedCountRef.current += 1
            } else {
              excludedRawRef.current -= rawDur
              excludedCountRef.current -= 1
            }
          }
        }
        const newSelected = new Set(selectedIds)
        if (newSelected.has(clipId)) {
          newSelected.delete(clipId)
        } else {
          newSelected.add(clipId)
        }
        setSelectedIds(newSelected)
        setLastSelectedIndex(index)
      } else {
        // Normal click: select this clip and set up potential reorder drag
        // If already selected, keep selection (drag all selected).
        // If not selected, select just this one.
        const isAlreadySelected = selectedIds.has(clipId)
        if (!isAlreadySelected) {
          crossPageRef.current = false
          setSelectedIds(new Set([clipId]))
          setLastSelectedIndex(index)
        }

        // Set up reorder drag (threshold will activate it)
        if (isDom) {
          const draggingIds = isAlreadySelected
            ? new Set(selectedIds)
            : new Set([clipId])
          reorderDragRef.current = {
            startX: event.clientX,
            startY: event.clientY,
            active: false,
            draggingIds,
          }
          reorderPendingClickRef.current = isAlreadySelected
            ? { index, clipId }
            : null
        }
      }
    },
    [
      lightData,
      selectedIds,
      lastSelectedIndex,
      setSelectedIds,
      setLastSelectedIndex,
      clips,
      computeRawDuration,
      isDom,
    ],
  )

  // No-op — drag-to-select removed, reorder handles mouse tracking via document listener
  const handleClipMouseEnter = useCallback((_index: number) => {}, [])

  // Handle reorder drop
  const handleReorderDrop = useCallback(
    (insertIndex: number) => {
      if (!reorderDragRef.current?.active) return
      const { draggingIds } = reorderDragRef.current

      // Build new order: remove dragged clips, insert at drop position
      const draggedClips: ClipData[] = []
      const remainingClips: ClipData[] = []
      const getClipId = (clip: ClipData) =>
        'id' in clip && clip.id != null
          ? String(clip.id)
          : 'path' in clip && clip.path
            ? clip.path
            : ''

      // Count how many dragged clips sit before the insert point
      let draggedBefore = 0
      for (let i = 0; i < clips.length; i++) {
        if (i >= insertIndex) break
        if (draggingIds.has(getClipId(clips[i]) as string)) {
          draggedBefore++
        }
      }

      for (const clip of clips) {
        if (draggingIds.has(getClipId(clip) as string)) {
          draggedClips.push(clip)
        } else {
          remainingClips.push(clip)
        }
      }

      // Adjust insert index: subtract dragged clips that were before the drop point
      const adjustedIndex = Math.min(
        insertIndex - draggedBefore,
        remainingClips.length,
      )
      const newOrder = [
        ...remainingClips.slice(0, adjustedIndex),
        ...draggedClips,
        ...remainingClips.slice(adjustedIndex),
      ]

      // Optimistic update
      setClips(newOrder)

      // Build sort_order updates for entire page
      const baseOffset = dataPage * numPerPage
      const updates = newOrder
        .map((clip, i) => {
          const id = 'id' in clip && clip.id != null ? Number(clip.id) : NaN
          if (Number.isNaN(id)) return null
          return { id, sort_order: baseOffset + i }
        })
        .filter(Boolean) as { id: number; sort_order: number }[]

      const tableId =
        isGameFilter && !activeFilter?.isProcessed ? 'files' : activeFilterId
      ipcBridge.reorderClips({ filterId: tableId, updates })

      // Update lightData to match new order
      setLightData(
        newOrder.map((clip, i) => ({
          id: getClipId(clip) || String(i),
          stage: clip.stage,
        })),
      )
    },
    [clips, dataPage, numPerPage, isGameFilter, activeFilter, activeFilterId],
  )

  // Handle mouse up - end reorder drag
  useEffect(() => {
    const handleMouseUp = () => {
      if (!reorderDragRef.current) return
      if (reorderDragRef.current.active && reorderInsertIndex !== null) {
        handleReorderDrop(reorderInsertIndex)
      } else if (reorderPendingClickRef.current) {
        // Didn't exceed threshold — treat as a normal click (deselect others)
        const { index, clipId } = reorderPendingClickRef.current
        crossPageRef.current = false
        setSelectedIds(new Set([clipId]))
        setLastSelectedIndex(index)
      }
      reorderDragRef.current = null
      reorderPendingClickRef.current = null
      setReorderInsertIndex(null)
    }

    document.addEventListener('mouseup', handleMouseUp)
    return () => document.removeEventListener('mouseup', handleMouseUp)
  }, [
    reorderInsertIndex,
    handleReorderDrop,
    setSelectedIds,
    setLastSelectedIndex,
  ])

  // Handle mousemove for reorder drag threshold and position tracking
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!reorderDragRef.current) return
      const { startX, startY, active } = reorderDragRef.current
      if (!active) {
        const dx = e.clientX - startX
        const dy = e.clientY - startY
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
          reorderDragRef.current.active = true
          reorderPendingClickRef.current = null
          // Force a re-render so DomLayer shows drag state
          setReorderInsertIndex(-1)
        }
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    return () => document.removeEventListener('mousemove', handleMouseMove)
  }, [])

  // Double-click a clip to open it in full mode
  const handleClipDoubleClick = useCallback(
    (index: number, _clipId: string) => {
      if (mode === 'full') return // Already in full mode
      setSavedZoom(zoomSize)
      setCurrentPage(index)
      setZoomSize(clipDisplayConfig.thresholds.full)
    },
    [mode, zoomSize],
  )

  // Close full mode (return to previous zoom)
  const handleFullCardClose = useCallback(() => {
    if (savedZoom !== null) {
      setZoomSize(savedZoom)
      setSavedZoom(null)
    }
  }, [savedZoom])

  // Show how many clips are visible on screen (capped by what we've loaded)
  const loadedCount = isDom ? clips.length : lightData.length
  const showCount = Math.min(visibleCount, loadedCount)
  const isLiveUpdating = isActiveFilterRunning
  const displayTotal = isLiveUpdating ? fetchedTotal : totalClips
  const totalDataPages =
    numPerPage > 0 ? Math.max(1, Math.ceil(displayTotal / numPerPage)) : 1
  // Count may still be hydrating; treat optimistically-loaded clips as content.
  const countPending = !totalKnown && !isLiveUpdating
  const hasContent = displayTotal > 0 || loadedCount > 0

  // Lazily detect the user's Slippi replay folder the first time the empty
  // import zone is actually shown.
  useEffect(() => {
    if (
      isGameFilter &&
      !hasContent &&
      !isLoading &&
      !slippiFetchedRef.current
    ) {
      slippiFetchedRef.current = true
      ipcBridge.detectSlippiReplays((res) => setSlippiReplays(res ?? null))
    }
  }, [isGameFilter, hasContent, isLoading])

  return (
    <div className="tray" ref={containerRef}>
      {/* Controls - always responsive */}
      <div className="tray-controls">
        <div className="tray-info">
          <span className="tray-count">
            Showing {showCount.toLocaleString()} /{' '}
            {countPending ? (
              <span className="tray-count-spinner" title="Counting…" />
            ) : (
              displayTotal.toLocaleString()
            )}{' '}
            {isClips ? 'clips' : 'games'}
          </span>
        </div>
        {lightData.length > 0 && (
          <div className="tray-select-btns">
            <button
              type="button"
              className="tray-select-all-btn"
              onClick={() => {
                const pageIds = new Set(lightData.map((item) => item.id))
                const allPageSelected =
                  pageIds.size > 0 &&
                  [...pageIds].every((id) => selectedIds.has(id))
                if (allPageSelected) {
                  // Deselect page
                  if (crossPageRef.current) {
                    const pageClips = clips.filter((c) => {
                      const id = 'id' in c && c.id != null ? String(c.id) : ''
                      return pageIds.has(id)
                    })
                    excludedRawRef.current += computeRawDuration(pageClips)
                    excludedCountRef.current += pageClips.length
                  }
                  setSelectedIds((prev) => {
                    const next = new Set(prev)
                    for (const id of pageIds) next.delete(id)
                    return next
                  })
                  setLastSelectedIndex(null)
                } else {
                  // Select page
                  if (crossPageRef.current) {
                    // Re-adding previously excluded page items
                    const readdedIds = [...pageIds].filter(
                      (id) => !selectedIds.has(id),
                    )
                    const readdedClips = clips.filter((c) => {
                      const id = 'id' in c && c.id != null ? String(c.id) : ''
                      return readdedIds.includes(id)
                    })
                    excludedRawRef.current -= computeRawDuration(readdedClips)
                    excludedCountRef.current -= readdedClips.length
                  }
                  setSelectedIds((prev) => new Set([...prev, ...pageIds]))
                }
              }}
            >
              {[...lightData].every((item) => selectedIds.has(item.id))
                ? 'Deselect Page'
                : 'Select Page'}
            </button>
            <button
              type="button"
              className="tray-select-all-btn"
              onClick={() => {
                if (selectedIds.size === displayTotal && displayTotal > 0) {
                  setSelectedIds(new Set())
                  setLastSelectedIndex(null)
                  crossPageRef.current = false
                } else {
                  const tableId =
                    isGameFilter && !activeFilter?.isProcessed
                      ? 'files'
                      : activeFilterId
                  ipcBridge.getAllResultIds(tableId, (ids) => {
                    if (!ids) return
                    setSelectedIds(new Set(ids))
                    crossPageRef.current = true
                    totalItemCountRef.current = ids.length
                    excludedRawRef.current = 0
                    excludedCountRef.current = 0
                    ipcBridge.getTableDuration(tableId, (dur) => {
                      tableDurationRef.current = dur ?? 0
                      updateCrossPageDuration()
                    })
                  })
                }
              }}
            >
              {selectedIds.size === displayTotal && displayTotal > 0
                ? 'Deselect All'
                : 'Select All'}
            </button>
          </div>
        )}
        <div className="tray-zoom">
          {totalDataPages > 1 && (
            <>
              <button
                type="button"
                className="tray-page-nav"
                onClick={() => setDataPage((p) => Math.max(0, p - 1))}
                disabled={dataPage === 0}
                aria-label="Previous page"
              >
                &#8249;
              </button>
              <span className="tray-page-indicator">
                {dataPage + 1}
                <span className="tray-page-sep">/</span>
                {totalDataPages}
              </span>
              <button
                type="button"
                className="tray-page-nav"
                onClick={() =>
                  setDataPage((p) => Math.min(totalDataPages - 1, p + 1))
                }
                disabled={dataPage >= totalDataPages - 1}
                aria-label="Next page"
              >
                &#8250;
              </button>
            </>
          )}
          <select
            className="tray-per-page"
            value={numPerPage}
            onChange={(e) => setNumPerPage(Number(e.target.value))}
            title="Items per page"
          >
            {[10, 100, 1000, 10000, 100000, 1000000, 10000000].map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="tray-zoom-btn"
            onClick={handleZoomOut}
            aria-label="Zoom out"
          >
            <FiZoomOut />
          </button>
          <button
            type="button"
            className="tray-zoom-btn"
            onClick={handleZoomIn}
            aria-label="Zoom in"
          >
            <FiZoomIn />
          </button>
        </div>
      </div>

      {/* Content area */}
      <div className="tray-content" ref={contentRef}>
        {/* Loading indicator - overlays content */}
        {isLoading && (
          <div className="tray-loading">
            <div className="tray-spinner" />
          </div>
        )}

        {/* Empty state */}
        {!hasContent && !isLoading && (
          <div className="tray-empty">
            {isGameFilter ? (
              <div className="tray-import">
                {slippiReplays ? (
                  <>
                    <div className="tray-import-title">
                      {slippiReplays.count.toLocaleString()}
                      {slippiReplays.count >= 50000 ? '+' : ''} replays found in
                      your Slippi folder
                    </div>
                    <div className="tray-import-path">{slippiReplays.dir}</div>
                    {onImportFolder && (
                      <button
                        type="button"
                        className="tray-import-primary"
                        onClick={() => onImportFolder(slippiReplays.dir)}
                      >
                        Import all
                      </button>
                    )}
                    <div className="tray-import-actions">
                      {onOpenFolder && (
                        <button
                          type="button"
                          className="tray-import-link"
                          onClick={() => onOpenFolder(slippiReplays.dir)}
                        >
                          Open folder
                        </button>
                      )}
                      {onOpenFolder && onImport && (
                        <span className="tray-import-dot">·</span>
                      )}
                      {onImport && (
                        <button
                          type="button"
                          className="tray-import-link"
                          onClick={onImport}
                        >
                          Choose other files
                        </button>
                      )}
                    </div>
                    <div className="tray-import-drag">
                      or drag .slp files or a folder anywhere onto the window
                    </div>
                  </>
                ) : (
                  <>
                    <div className="tray-import-title">No replays yet</div>
                    <div className="tray-import-drag">
                      Drag .slp / .slpz files or a folder onto the window
                    </div>
                    {onImport && (
                      <button
                        type="button"
                        className="tray-import-primary"
                        onClick={onImport}
                      >
                        Choose files…
                      </button>
                    )}
                  </>
                )}
              </div>
            ) : (
              <>
                <div className="tray-empty-title">No clips to display</div>
                <div className="tray-empty-subtitle">
                  Run this filter to see results
                </div>
              </>
            )}
          </div>
        )}

        {/* Full mode: FullCard (bypasses DomLayer) */}
        {hasContent && mode === 'full' && paginatedClips.length > 0 && (
          <FullCard
            data={paginatedClips[0]}
            isSelected={(() => {
              const clip = paginatedClips[0]
              const clipId =
                'id' in clip && clip.id != null
                  ? String(clip.id)
                  : 'path' in clip && clip.path
                    ? clip.path
                    : ''
              return selectedIds.has(clipId as string)
            })()}
            onMouseDown={(e: React.MouseEvent) => {
              const clip = paginatedClips[0]
              const clipId =
                'id' in clip && clip.id != null
                  ? String(clip.id)
                  : 'path' in clip && clip.path
                    ? clip.path
                    : ''
              handleClipMouseDown(
                currentPage * itemsPerPage,
                clipId as string,
                e,
              )
            }}
            onPlay={onClipPlay || undefined}
            onRecord={
              onClipRecord
                ? () => {
                    const clip = paginatedClips[0]
                    const clipId =
                      'id' in clip && clip.id != null
                        ? String(clip.id)
                        : 'path' in clip && clip.path
                          ? clip.path
                          : ''
                    onClipRecord(clipId as string)
                  }
                : undefined
            }
            onClose={savedZoom !== null ? handleFullCardClose : undefined}
          />
        )}

        {/* DOM Layer (mode2 only now — full mode uses FullCard above) */}
        {hasContent && mode !== 'full' && (
          <DomLayer
            clips={clips}
            mode={mode as Exclude<ClipMode, 'full'>}
            clipSize={clipSize}
            gap={gap}
            columns={columns}
            trayWidth={trayWidth}
            trayHeight={trayHeight}
            visible={isDom}
            selectedIds={selectedIds}
            onClipMouseDown={handleClipMouseDown}
            onClipMouseEnter={handleClipMouseEnter}
            onClipDoubleClick={handleClipDoubleClick}
            onClipPlay={onClipPlay}
            onClipRecord={onClipRecord}
            onBackgroundClick={() => {
              setSelectedIds(new Set())
              setLastSelectedIndex(null)
            }}
            startIndex={0}
            reorderActive={reorderDragRef.current?.active ?? false}
            reorderDraggingIds={reorderDragRef.current?.draggingIds ?? null}
            reorderInsertIndex={reorderInsertIndex}
            onReorderInsertIndexChange={setReorderInsertIndex}
          />
        )}

        {/* GPU Layer (modes mode3 and mode4) */}
        {/* TODO: Selection in GPU mode is implemented but disabled for now - can enable later */}
        {hasContent && (
          <GpuLayer
            clips={lightData}
            mode={mode}
            clipSize={clipSize}
            gap={gap}
            columns={columns}
            trayWidth={trayWidth}
            trayHeight={trayHeight}
            visible={isGpu}
          />
        )}
      </div>
    </div>
  )
}

export default Tray
