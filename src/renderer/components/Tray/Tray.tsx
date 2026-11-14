/**
 * Tray - Clip Display System
 *
 * Prioritizes UI responsiveness:
 * - Zoom changes are instant (layout only)
 * - Data fetching is debounced and non-blocking
 * - Spinner shows while loading, but UI never freezes
 */

import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useCallback,
} from 'react'
import { FiGrid, FiSquare, FiZoomIn, FiZoomOut } from 'react-icons/fi'
import Tooltip from '../Tooltip'
import useIpcListener from '../../hooks/useIpcListener'

import { DomLayer } from './DomLayer'
import { nextWindowOffset, showsDomGrid } from '../../lib/domGrid'
import { createZoomFrame, wheelZoomFactor } from '../../lib/zoomFrame'
import OverviewCanvas, { fitTile } from './OverviewCanvas'
import { overviewFor } from '../../lib/overviewStore'
import { newHandoff } from '../../lib/viewAnchor'
import AddReplays, { IncomingReplays } from '../AddReplays'
import { useEnterOnChange } from '../../lib/motion'
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
import { Selection } from '../../../lib/selection'
import { lengthRepairChange } from '../../../lib/lengthRepair'
import type { LastFrameScanStatus } from '../../../lib/lastFrame'
import './Tray.css'
import { ConfirmModal } from '../FilterModals'
import {
  shortcutsBlocked,
  deleteKeyTargetsScope,
} from '../../lib/keyboardScope'
import { emptyResultsCopy } from '../../lib/emptyResults'
import { deleteReplaysCopy } from '../../../lib/deleteReplaysCopy'
import { cardLayoutForStep } from '../../lib/tileArt'
import { filterStepKey, stepFilter } from '../../lib/filterNav'

type TrayProps = {
  archive: ShallowArchiveInterface | null
  activeFilterId: string
  /** Compact at any size (lib/selection.ts): Select All is a flag, not ids. */
  selection: Selection
  setSelection: React.Dispatch<React.SetStateAction<Selection>>
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
  /** Shown under the clips and taking space (the background work bars), so
   *  it never covers the last row. */
  footer?: React.ReactNode
  /** Open in Single view the first time there is a clip (default true; the tray tests turn it off). */
  openInSingle?: boolean
  /** Ask before Delete in the Replays step removes replays (config
   *  confirmDeleteReplays, default on). */
  confirmDeleteReplays?: boolean
  /** "Don't show this again" in that warning. */
  onStopConfirmingDeletes?: () => void
}

// Zoom nudge step - increases at larger sizes
/** Rows loaded around the screen in the grid, and around the single view's clip. */
const GRID_WINDOW = 2000
const SINGLE_WINDOW = 200
/** Each zoom step multiplies the tile size: even from 300 px down to many clips per pixel. */
const ZOOM_FACTOR = 1.35
/** The grid's zoom when there's none to go back to (also the tray's starting
 *  zoom): the DOM grid's smallest cards (clipDisplay thresholds.mode2). */
const DEFAULT_GRID_ZOOM = 120
/** A short list zooms out at least this far (to see it as small cards), even
 *  when it fits on screen sooner. */
const FIT_ZOOM_CAP = 40
/** "Select visible" in the GPU view names at most this many clips. */
const SELECT_VISIBLE_MAX = 50_000

// Debounce delay for fetching (ms)
const FETCH_DEBOUNCE_MS = 150
/** While the game-length repair runs, lengths are read again at most this often. */
const LENGTHS_REFRESH_MS = 5000
// The read lane for the list window (main/readLane.ts): newer windows supersede.
const TRAY_LANE = 'tray-window'
// Removals of more ids than this go to main as the selection, not a list.
const REMOVE_ID_LIST_MAX = 5000
/** Removing more results than this from a step asks first (the Replays step always does). */
const REMOVE_CONFIRM_ABOVE = 20

/** A row's id as the tray keys it (rows without one fall back to their path). */
const rowId = (clip: ClipData) =>
  ('id' in clip && clip.id != null
    ? String(clip.id)
    : 'path' in clip && clip.path
      ? clip.path
      : '') as string

/** A clip's length in frames (no extra start/end frames). */
const rawFrames = (clip: ClipData) => {
  const start = clip.startFrame ?? 0
  const end =
    (clip.endFrame ?? 0) > 0
      ? (clip.endFrame ?? 0)
      : (('lastFrame' in clip ? clip.lastFrame : 0) ?? 0)
  return Math.max(0, end - start)
}

export function Tray({
  archive,
  activeFilterId,
  selection,
  setSelection,
  lastSelectedIndex,
  setLastSelectedIndex,
  setSelectionDuration,
  addStartFrames,
  addEndFrames,
  onClipPlay,
  onClipRecord,
  footer,
  confirmDeleteReplays = true,
  onStopConfirmingDeletes,
  openInSingle = true,
}: TrayProps) {
  // If the user has a Slippi replay folder, offer to import it straight from
  // the empty import zone. Detected once, lazily, when that zone is relevant.
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // Track which filters are currently running (by id: positions shift when
  // steps are deleted or moved mid-run)
  const [runningFilterIds, setRunningFilterIds] = useState<Set<string>>(
    new Set(),
  )
  // Bumped on a timer while viewing a running filter to trigger re-fetches
  const [previewTick, setPreviewTick] = useState(0)

  useIpcListener(
    'currentlyRunningFilter',
    (event: { running: number[]; runningIds?: string[] }) => {
      setRunningFilterIds(new Set(event.runningIds ?? []))
    },
  )

  // Tray dimensions
  const [trayWidth, setTrayWidth] = useState(800)
  const [trayHeight, setTrayHeight] = useState(600)

  // Zoom state - this updates instantly
  const [zoomSize, setZoomSize] = useState<number>(DEFAULT_GRID_ZOOM)

  // Clip data - this updates after debounced fetch
  const [clips, setClips] = useState<ClipData[]>([])
  const [lightData, setLightData] = useState<{ id: string; stage: number }[]>(
    [],
  )
  const [isLoading, setIsLoading] = useState(false)
  // The last read of this step's results failed (the project was busy or locked).
  const [readError, setReadError] = useState(false)
  // Real total count from DB (returned alongside items)
  const [fetchedTotal, setFetchedTotal] = useState(0)

  // One continuous list (tray-v2.md): the grid and the single view load a window
  // of rows around what's on screen. windowOffset is the window asked for;
  // clipsOffset is where the rows in `clips`/`lightData` actually start.
  const [windowOffset, setWindowOffset] = useState(0)
  const [clipsOffset, setClipsOffset] = useState(0)
  // The single view's clip: its position in the whole list.
  const [singleIndex, setSingleIndex] = useState(0)
  // What the grid has on screen (global positions), for "Select visible".
  const [visibleRange, setVisibleRange] = useState<[number, number]>([0, 0])
  const visibleRangeRef = useRef<[number, number]>([0, 0])
  visibleRangeRef.current = visibleRange
  // A new step or page fades in (opacity only: the GPU layer tracks positions).
  useEnterOnChange(contentRef, `${activeFilterId}:${singleIndex}`, {
    lift: false,
  })

  // Saved zoom state for returning from full mode (double-click → Escape/close)
  const [savedZoom, setSavedZoom] = useState<number | null>(null)
  // The single view's Z/X step (set below, once its inputs exist).
  const fullStepRef = useRef<(_dir: 1 | -1) => void>(() => {})
  // Bumped when rows are reordered or removed: the GPU overview reads afresh.
  const [overviewEpoch, setOverviewEpoch] = useState(0)

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
  // The table the tray reads (an unprocessed game filter reads 'files').
  const viewTable =
    isGameFilter && !activeFilter?.isProcessed ? 'files' : activeFilterId
  const activeFilterIndex =
    archive?.filters.findIndex((f) => f.id === activeFilterId) ?? -1
  // How the GPU tiles place their icons (the DOM cards read their own rows).
  const cardLayout = cardLayoutForStep(archive?.filters, activeFilterIndex)
  const comboFilterTypes = new Set([
    'slpParser',
    'comboFilter',
    'actionStateFilter',
    'reverse',
    'edgeguard',
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
    !!activeFilterId && runningFilterIds.has(activeFilterId)

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

  // Where the grid or GPU view is, so crossing between them (and closing
  // Single) keeps your place (lib/viewAnchor.ts).
  const [handoff] = useState(newHandoff)
  // The far-out view's last clicked clip: where Single opens from there.
  const overviewAnchorRef = useRef(-1)
  // The clips on screen ("Select visible", Ctrl+A in the GPU view).
  const visibleIdsRef = useRef<(string | number)[]>([])
  // The GPU view has been shown: keep it mounted (hidden) from then on.
  const [gpuKept, setGpuKept] = useState(false)
  useEffect(() => {
    if (isGpu) setGpuKept(true)
  }, [isGpu])

  // A new filter starts at the top.
  useEffect(() => {
    setReadError(false)
    setSingleIndex(0)
    setWindowOffset(0)
    overviewAnchorRef.current = -1
    handoff.place = null
    handoff.pinned = null
  }, [activeFilterId, handoff])

  // The single view's clip, once its window has loaded.
  const paginatedClips = useMemo(() => {
    if (mode !== 'full') return clips
    const local = singleIndex - clipsOffset
    return local >= 0 && local < clips.length ? [clips[local]] : []
  }, [mode, clips, singleIndex, clipsOffset])

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
      // Far out, the GPU overview reads the whole table itself.
      if (isGpu) {
        setIsLoading(false)
        return
      }
      const fetchTotal = totalClipsRef.current

      // Fetch visible + buffer for both modes
      // When viewing a running filter or importing into game filter, don't cap by totalClips — just fetch what we can
      const isLiveUpdating = isActiveFilterRunning
      // When the total isn't known yet (count still hydrating), fetch a full
      // page optimistically instead of capping by an as-yet-unknown total.
      const countUnknown = !totalKnown
      const windowRows = mode === 'full' ? SINGLE_WINDOW : GRID_WINDOW
      const offset = Math.max(0, windowOffset)
      const targetCount =
        isLiveUpdating || countUnknown
          ? windowRows
          : Math.min(windowRows, Math.max(0, fetchTotal - offset))
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

      ipcBridge.getResults(
        {
          filterId: tableId,
          offset,
          limit,
          lite: isGpu,
          // Main skips or stops this read once a newer window is asked for.
          lane: TRAY_LANE,
        },
        (response: {
          items: (ClipInterface | FileInterface | LiteItem)[]
          total: number
          error?: string
          stale?: boolean
        }) => {
          if (currentFetchId !== fetchIdRef.current) return
          if (response?.stale) {
            // Stopped without a newer window (the project's read connection was
            // closed, e.g. for Save As): ask again.
            debounceTimerRef.current = setTimeout(doFetch, FETCH_DEBOUNCE_MS)
            return
          }
          // A timed-out / errored reply has no items — never set state to
          // undefined (that would make clips.length throw on the next render).
          const items = Array.isArray(response?.items) ? response.items : null
          if (!items) {
            setReadError(true)
            setIsLoading(false)
            return
          }
          setReadError(false)
          const dbTotal = response.total

          if (isDom) {
            setClips(items as ClipData[])
          }
          setClipsOffset(offset)
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
    windowOffset,
    mode === 'full',
  ]) // eslint-disable-line react-hooks/exhaustive-deps -- totalClips tracked via ref to avoid import churn

  // Furthest out: every clip on screen (tray-v2.md); beyond that is empty space.
  const minZoom = Math.min(
    FIT_ZOOM_CAP,
    fitTile(trayWidth, trayHeight, totalClips),
  )
  const minZoomRef = useRef(minZoom)
  minZoomRef.current = minZoom

  // Wheel, pinch, slider and buttons move the live zoom; the tray re-renders
  // at most once per frame (lib/zoomFrame.ts). Only Ctrl+wheel reaches Single.
  const [zoomFrame] = useState(() =>
    createZoomFrame({
      initial: DEFAULT_GRID_ZOOM,
      clamp: (z) =>
        Math.max(
          minZoomRef.current,
          Math.min(z, clipDisplayConfig.thresholds.full),
        ),
      commit: setZoomSize,
    }),
  )
  useLayoutEffect(() => zoomFrame.sync(zoomSize), [zoomFrame, zoomSize])
  useEffect(() => () => zoomFrame.cancel(), [zoomFrame])
  // Grid zooms (buttons, slider, the far-out view) stop short of Single.
  const zoomGridTo = useCallback(
    (z: number) =>
      zoomFrame.to(Math.min(z, clipDisplayConfig.thresholds.full - 1)),
    [zoomFrame],
  )
  const zoomGridBy = useCallback(
    (factor: number) => zoomGridTo(zoomFrame.live() * factor),
    [zoomFrame, zoomGridTo],
  )
  // Jumps (open/close Single) win over any zoom still waiting for its frame.
  const jumpZoom = useCallback(
    (z: number) => {
      zoomFrame.cancel()
      setZoomSize(z)
    },
    [zoomFrame],
  )

  // The buttons and slider keep the top row in place (the wheel: the cursor).
  const handleZoomIn = useCallback(() => {
    handoff.focus = null
    zoomGridBy(ZOOM_FACTOR)
  }, [zoomGridBy, handoff])
  const handleZoomOut = useCallback(() => {
    handoff.focus = null
    zoomGridBy(1 / ZOOM_FACTOR)
  }, [zoomGridBy, handoff])
  // Back to the grid from Single: the clip you were on, mid-screen.
  const pinSingleClip = useCallback(() => {
    handoff.pinned = {
      idx: singleIndex,
      fy: 0.5,
      cy: trayHeight / 2,
    }
  }, [handoff, singleIndex, trayHeight])

  // The Replays step's warning before replays are deleted from Clipper.
  const [deleteAsk, setDeleteAsk] = useState<{
    games: number
    selection: Selection
  } | null>(null)
  const deleteAskRef = useRef(deleteAsk)
  deleteAskRef.current = deleteAsk
  // Any other step: removing more than a handful of results at once asks first too.
  const [removeAsk, setRemoveAsk] = useState<Selection | null>(null)
  const removeAskRef = useRef(removeAsk)
  removeAskRef.current = removeAsk
  useEffect(() => {
    setDeleteAsk(null)
    setRemoveAsk(null)
  }, [activeFilterId, archive?.path])

  // Remove these rows. The Replays step: the replays go from Clipper (project,
  // library, My Replays; files stay on disk). Any other step: only those
  // results and what later steps made from them (main/managers/ClipManager.ts).
  const removeRows = useCallback(
    (removed: Selection) => {
      if (removed.isEmpty) return
      // A short list goes as ids (as always); Select All or a big range goes as
      // the selection and main resolves it.
      const ids = removed.explicitIds(REMOVE_ID_LIST_MAX)
      if (ids && ids.length === 0) return

      // Optimistically remove from local state
      setClips((prev) => prev.filter((clip) => !removed.has(rowId(clip))))
      setLightData((prev) => prev.filter((item) => !removed.has(item.id)))
      setSelection(Selection.none())
      setLastSelectedIndex(null)

      overviewAnchorRef.current = -1
      // The GPU view reads the table again once main has removed every row (a
      // big removal runs in 5,000-row statements; reading sooner gets the old rows).
      const reread = () => setOverviewEpoch((e) => e + 1)
      if (isGameFilter && !activeFilter?.isProcessed) {
        // Unprocessed game filter reads from 'files' table — IDs are file IDs
        ipcBridge.removeGames(ids ?? { selection: removed.toWire() }, reread)
      } else {
        // Processed game filter or any other filter — IDs are filter table row IDs
        ipcBridge.removeResults(
          ids
            ? { filterId: activeFilterId, rowIds: ids }
            : { filterId: activeFilterId, selection: removed.toWire() },
          reread,
        )
      }
    },
    [
      isGameFilter,
      activeFilter,
      activeFilterId,
      setSelection,
      setLastSelectedIndex,
    ],
  )

  // Handle bulk removal of selected items
  const handleDeleteSelected = useCallback(() => {
    if (selection.isEmpty || deleteAskRef.current || removeAskRef.current)
      return
    const ids = selection.explicitIds(REMOVE_ID_LIST_MAX)
    if (ids && ids.length === 0) return
    if (!isGameFilter) {
      // Results of a step: a few go at once, more ask (a stray Backspace once removed 800).
      if (selection.count > REMOVE_CONFIRM_ABOVE) setRemoveAsk(selection)
      else removeRows(selection)
      return
    }
    if (!confirmDeleteReplays) {
      removeRows(selection)
      return
    }
    // Deleting replays: say how many first (main counts a Select All).
    const asked = selection
    ipcBridge.previewRemoveGames(
      ids
        ? { filterId: viewTable, ids }
        : { filterId: viewTable, selection: asked.toWire() },
      (res) => {
        if (!res || res.error || typeof res.games !== 'number') {
          console.error('[Tray] could not count the replays:', res?.error)
          return
        }
        setDeleteAsk({ games: res.games, selection: asked })
      },
    )
  }, [selection, isGameFilter, confirmDeleteReplays, removeRows, viewTable])

  // Keyboard shortcuts: Escape to clear, Ctrl+A to select all visible, Z/X/arrows for full mode nav
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Leave the key alone while the user types, a dialog or a menu is open (Backspace in
      // Settings must not remove the selected clips).
      if (shortcutsBlocked(e)) return

      if (e.key === 'Escape') {
        if (mode === 'full') {
          // Back to the grid (the zoom you came from)
          pinSingleClip()
          jumpZoom(savedZoom ?? DEFAULT_GRID_ZOOM)
          setSavedZoom(null)
        } else {
          setSelection(Selection.none())
          setLastSelectedIndex(null)
        }
      } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        // The clips on screen in the GPU view (as Select visible); in the grid,
        // the loaded clips.
        setSelection(
          Selection.of(
            isGpu ? visibleIdsRef.current : lightData.map((item) => item.id),
          ),
        )
      } else if (
        mode !== 'full' &&
        !e.defaultPrevented &&
        filterStepKey(e) !== 0
      ) {
        // The grid: Z/X and ↑/↓ move the highlighted filter step (Single keeps Z/X for clips).
        e.preventDefault()
        stepFilter(filterStepKey(e) as -1 | 1)
      } else if (mode === 'full' && (e.key === 'z' || e.key === 'ArrowLeft')) {
        fullStepRef.current(-1)
      } else if (mode === 'full' && (e.key === 'x' || e.key === 'ArrowRight')) {
        fullStepRef.current(1)
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        // Only with the focus on the page or in the tray, not on a button elsewhere.
        if (deleteKeyTargetsScope(e, containerRef.current))
          handleDeleteSelected()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    setSelection,
    setLastSelectedIndex,
    lightData,
    isGpu,
    mode,
    clips.length,
    savedZoom,
    handleDeleteSelected,
    jumpZoom,
    pinSingleClip,
  ])

  // Full zoom: step to the next/previous replay (the card's ‹ › arrows; Z/X and ←/→ above).
  // Positions are global, so Z/X walk the whole result list; the window follows.
  const globalIndex = singleIndex
  const clampIndex = useCallback(
    (i: number) =>
      Math.max(
        0,
        Math.min(Math.max(0, (totalClipsRef.current || clips.length) - 1), i),
      ),
    [clips.length],
  )
  const goToIndex = useCallback(
    (i: number) => setSingleIndex(clampIndex(i)),
    [clampIndex],
  )
  // Each press steps from the latest position (held keys and quick presses
  // don't lose steps to a render that hasn't happened yet).
  const fullStep = useCallback(
    (dir: 1 | -1) => setSingleIndex((prev) => clampIndex(prev + dir)),
    [clampIndex],
  )
  // Keep the single view's window around its clip.
  useEffect(() => {
    if (mode !== 'full') return
    if (
      singleIndex < clipsOffset ||
      singleIndex >= clipsOffset + clips.length
    ) {
      const want = Math.max(0, singleIndex - Math.floor(SINGLE_WINDOW / 2))
      setWindowOffset((prev) => (prev === want ? prev : want))
    }
  }, [mode, singleIndex, clipsOffset, clips.length])
  useEffect(() => {
    fullStepRef.current = fullStep
  }, [fullStep])
  // Open the single view on a clip by its position in the whole list.
  const openAt = useCallback(
    (i: number) => {
      if (mode !== 'full') setSavedZoom(zoomSize)
      goToIndex(i)
      jumpZoom(clipDisplayConfig.thresholds.full)
    },
    [mode, zoomSize, goToIndex, jumpZoom],
  )
  // Wheel zoom - use native listener with { passive: false } to allow preventDefault
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        // The clip under the cursor stays put (lib/viewAnchor.ts).
        const rect = contentRef.current?.getBoundingClientRect()
        handoff.focus = rect
          ? { x: e.clientX - rect.left, y: e.clientY - rect.top }
          : null
        // Smooth, ratio-based: trackpad pinches and wheel notches both feel even.
        zoomFrame.by(wheelZoomFactor(e))
      }
    }

    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [zoomFrame, handoff])

  // The selection's length. When every selected clip is loaded it's added up
  // here at once; otherwise main adds it up in SQL (a range or Select All
  // reaches rows the tray hasn't loaded). Select All's table total is asked for
  // once and the rows left out are taken off it, so Ctrl-clicks stay cheap.
  const durationReqRef = useRef(0)
  const tableFramesRef = useRef<{
    key: string
    frames: number | null
    waiting: ((_frames: number) => void)[]
  } | null>(null)

  // The background game-length repair (main/LastFrameScanWorker.ts) gives
  // games their length under the tray: the Select All total and the loaded
  // rows are read again as it goes (at most every LENGTHS_REFRESH_MS) and at
  // once when it stops, finishes or its project closes.
  const [lengthsEpoch, setLengthsEpoch] = useState(0)
  const repairRef = useRef<{
    last: LastFrameScanStatus | null
    at: number
    timer: ReturnType<typeof setTimeout> | null
  }>({ last: null, at: 0, timer: null })
  const archivePath = archive?.path
  useIpcListener(
    'lastFrameScanStatus',
    (status: LastFrameScanStatus | null) => {
      if (status && status.projectPath !== archivePath) return
      const r = repairRef.current
      const change = lengthRepairChange(r.last, status)
      r.last = status
      if (change === 'none') return
      const reread = () => {
        r.timer = null
        r.at = Date.now()
        // A new key for Select All's cached table total (below).
        setLengthsEpoch((e) => e + 1)
        setPreviewTick((t) => t + 1)
      }
      if (change === 'ended') {
        if (r.timer) clearTimeout(r.timer)
        reread()
      } else if (!r.timer) {
        r.timer = setTimeout(
          reread,
          Math.max(0, LENGTHS_REFRESH_MS - (Date.now() - r.at)),
        )
      }
    },
    [archivePath],
  )
  useEffect(() => {
    const r = repairRef.current
    r.last = null
    return () => {
      if (r.timer) clearTimeout(r.timer)
      r.timer = null
    }
  }, [archivePath])

  useEffect(() => {
    const req = ++durationReqRef.current
    if (selection.isEmpty) {
      setSelectionDuration(null)
      return undefined
    }
    const pad = addStartFrames + addEndFrames
    if (!selection.all && selection.count <= clips.length) {
      let found = 0
      let frames = 0
      for (const clip of clips)
        if (selection.has(rowId(clip))) {
          found += 1
          frames += rawFrames(clip) + pad
        }
      if (found === selection.count) {
        setSelectionDuration(frames)
        return undefined
      }
    }
    const current = () => req === durationReqRef.current
    // Frames and rows of the clips named (the selected ones, or with Select
    // All the ones left out); nothing on an error.
    const named = (done: (_r: { frames: number; count: number }) => void) => {
      if (selection.all && selection.bits.size === 0) {
        done({ frames: 0, count: 0 })
        return
      }
      // With Select All, the rows left out, as a plain selection.
      const wire = { ...selection.toWire(), all: false }
      ipcBridge.getSelectionDuration(
        { filterId: viewTable, selection: wire },
        (r) => {
          if (current() && r && 'frames' in r) done(r)
        },
      )
    }
    const timer = setTimeout(() => {
      if (!selection.all) {
        named((r) => setSelectionDuration(r.frames + r.count * pad))
        return
      }
      // The project too: another one (or this one reopened) has its own sums.
      const key = `${archivePath}|${viewTable}|${overviewEpoch}|${lengthsEpoch}|${selection.total}`
      const withTable = (tableFrames: number) =>
        named((r) =>
          setSelectionDuration(
            tableFrames -
              r.frames +
              Math.max(0, selection.total - r.count) * pad,
          ),
        )
      const waiter = (frames: number) => {
        if (current()) withTable(frames)
      }
      const cached = tableFramesRef.current
      if (cached && cached.key === key) {
        // Asked for already: the sum can take a while on a huge table.
        if (cached.frames !== null) waiter(cached.frames)
        else cached.waiting.push(waiter)
        return
      }
      const entry = { key, frames: null as number | null, waiting: [waiter] }
      tableFramesRef.current = entry
      ipcBridge.getTableDuration(viewTable, (frames) => {
        if (tableFramesRef.current !== entry) return
        if (typeof frames !== 'number') {
          tableFramesRef.current = null
          return
        }
        entry.frames = frames
        entry.waiting.splice(0).forEach((w) => w(frames))
      })
    }, FETCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [
    selection,
    clips,
    viewTable,
    overviewEpoch,
    lengthsEpoch,
    archivePath,
    setSelectionDuration,
    addStartFrames,
    addEndFrames,
  ])

  // Select All counts the table as it is (a running filter keeps growing).
  const tableRows = isActiveFilterRunning ? fetchedTotal : totalClips
  useEffect(() => {
    if (selection.all && tableRows > 0 && selection.total !== tableRows)
      setSelection((prev) => prev.withTotal(tableRows))
  }, [selection, tableRows, setSelection])

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
        // Shift+click: range select from last selected (the loaded rows of it)
        const start = Math.min(lastSelectedIndex, index)
        const end = Math.max(lastSelectedIndex, index)
        const ids: string[] = []
        for (let i = start; i <= end; i++) {
          const item = lightData[i - clipsOffset]
          if (item) ids.push(item.id)
        }
        setSelection((prev) => prev.with(ids, true))
      } else if (event.ctrlKey || event.metaKey) {
        // Ctrl+click: toggle single item
        setSelection((prev) => prev.toggle(clipId))
        setLastSelectedIndex(index)
      } else {
        // Normal click: select this clip and set up potential reorder drag
        // If already selected, keep selection (drag all selected).
        // If not selected, select just this one.
        const isAlreadySelected = selection.has(clipId)
        if (!isAlreadySelected) {
          setSelection(Selection.of([clipId]))
          setLastSelectedIndex(index)
        }

        // Set up reorder drag (threshold will activate it). Only loaded clips
        // can move: the drop works on the loaded window.
        if (isDom) {
          const draggingIds = isAlreadySelected
            ? new Set(
                lightData
                  .filter((item) => selection.has(item.id))
                  .map((item) => item.id),
              )
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
      clipsOffset,
      selection,
      lastSelectedIndex,
      setSelection,
      setLastSelectedIndex,
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
      const baseOffset = clipsOffset
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
      setOverviewEpoch((e) => e + 1)

      // Update lightData to match new order
      setLightData(
        newOrder.map((clip, i) => ({
          id: getClipId(clip) || String(i),
          stage: clip.stage,
        })),
      )
    },
    [clips, clipsOffset, isGameFilter, activeFilter, activeFilterId],
  )

  // Handle mouse up - end reorder drag
  useEffect(() => {
    const handleMouseUp = () => {
      if (!reorderDragRef.current) return
      if (reorderDragRef.current.active && reorderInsertIndex !== null) {
        // The grid reports positions in the whole list; the drop works on the window.
        handleReorderDrop(reorderInsertIndex - clipsOffset)
      } else if (reorderPendingClickRef.current) {
        // Didn't exceed threshold — treat as a normal click (deselect others)
        const { index, clipId } = reorderPendingClickRef.current
        setSelection(Selection.of([clipId]))
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
    setSelection,
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
      openAt(index)
    },
    [mode, openAt],
  )

  // Close full mode (return to previous zoom, or the default grid)
  const handleFullCardClose = useCallback(() => {
    pinSingleClip()
    jumpZoom(savedZoom ?? DEFAULT_GRID_ZOOM)
    setSavedZoom(null)
  }, [savedZoom, jumpZoom, pinSingleClip])

  // The toolbar's Grid | Single switch. Single opens the first selected clip on
  // this page (or the first clip); Grid goes back to the zoom you came from.
  const showSingle = useCallback(() => {
    if (mode === 'full') return
    if (isGpu) {
      // The clip last clicked there, or the first one on screen.
      openAt(
        overviewAnchorRef.current >= 0
          ? overviewAnchorRef.current
          : visibleRangeRef.current[0],
      )
      return
    }
    const selectedIndex = lightData.findIndex((item) => selection.has(item.id))
    openAt(
      selectedIndex >= 0
        ? clipsOffset + selectedIndex
        : visibleRangeRef.current[0],
    )
  }, [mode, isGpu, lightData, selection, openAt, clipsOffset])

  // The tray opens in Single (user, 2026-11-01): the first time there is a clip to show. After
  // that the view is the user's to change (Grid keeps its zoom; steps and pages keep the view).
  const openedInSingleRef = useRef(false)
  useEffect(() => {
    if (openedInSingleRef.current || lightData.length === 0) return
    openedInSingleRef.current = true
    if (openInSingle && mode !== 'full') showSingle()
  }, [lightData.length, mode, showSingle, openInSingle])

  // Show how many clips are visible on screen (capped by what we've loaded)
  const loadedCount = isDom ? clips.length : lightData.length
  const showCount = Math.min(visibleCount, loadedCount)
  const isLiveUpdating = isActiveFilterRunning
  const displayTotal = isLiveUpdating ? fetchedTotal : totalClips
  // The loaded clips on screen right now ("Select visible"); in the GPU view,
  // from its overview ids (not when millions are on screen).
  const visibleIds = useMemo((): (string | number)[] => {
    const [first, last] = visibleRange
    if (isGpu) {
      if (last - first > SELECT_VISIBLE_MAX) return []
      const data = overviewFor(viewTable, `${overviewEpoch}`)
      return Array.from(data.ids.subarray(first, Math.min(last, data.count)))
    }
    if (!isDom) return []
    return lightData
      .slice(Math.max(0, first - clipsOffset), Math.max(0, last - clipsOffset))
      .map((item) => item.id)
  }, [
    isGpu,
    isDom,
    visibleRange,
    viewTable,
    overviewEpoch,
    lightData,
    clipsOffset,
  ])
  visibleIdsRef.current = visibleIds
  const allVisibleSelected = useMemo(
    () => visibleIds.length > 0 && visibleIds.every((id) => selection.has(id)),
    [visibleIds, selection],
  )
  const everythingSelected =
    selection.count === displayTotal && displayTotal > 0
  // Count may still be hydrating; treat optimistically-loaded clips as content.
  const countPending = !totalKnown && !isLiveUpdating
  const hasContent = displayTotal > 0 || loadedCount > 0

  return (
    <div className="tray" ref={containerRef}>
      {/* Controls - always responsive */}
      <div className="tray-controls">
        {/* Three fixed columns (left / centre / right), so nothing shifts when the
            slider, a button label or the count changes width. */}
        <div className="tray-controls-left">
          <div className="tray-info">
            <span className="tray-count">
              {mode === 'full'
                ? `${isClips ? 'Clip' : 'Game'} ${(globalIndex + 1).toLocaleString()} of `
                : `Showing ${(isGpu ? Math.min(visibleCount, displayTotal) : showCount).toLocaleString()} / `}
              {countPending ? (
                <span className="tray-count-spinner" title="Counting…" />
              ) : (
                displayTotal.toLocaleString()
              )}{' '}
              {isClips ? 'clips' : 'games'}
            </span>
          </div>
          {(lightData.length > 0 || isGpu) && (
            <div className="tray-select-btns">
              <Tooltip
                text={
                  'The clips on screen.\nCtrl+A selects them too. Click a clip to pick it, Shift-click a range, Ctrl-click to add one.'
                }
              >
                <button
                  type="button"
                  className="tray-select-all-btn"
                  onClick={() => {
                    if (allVisibleSelected) {
                      setSelection((prev) => prev.with(visibleIds, false))
                      setLastSelectedIndex(null)
                    } else {
                      setSelection((prev) => prev.with(visibleIds, true))
                    }
                  }}
                >
                  {allVisibleSelected ? 'Deselect visible' : 'Select visible'}
                </button>
              </Tooltip>
              <Tooltip text="Every clip in these results, not just the ones on screen.">
                <button
                  type="button"
                  className="tray-select-all-btn"
                  onClick={() => {
                    if (everythingSelected) {
                      setSelection(Selection.none())
                      setLastSelectedIndex(null)
                    } else if (
                      clipsOffset === 0 &&
                      !isLiveUpdating &&
                      lightData.length >= displayTotal
                    ) {
                      // Every row is loaded: name them, as always.
                      setSelection(
                        Selection.of(lightData.map((item) => item.id)),
                      )
                    } else {
                      // A flag, whatever the table's size (lib/selection.ts).
                      setSelection(Selection.everything(displayTotal))
                    }
                  }}
                >
                  {everythingSelected ? 'Deselect All' : 'Select All'}
                </button>
              </Tooltip>
            </div>
          )}
        </div>
        {lightData.length > 0 && (
          <div
            className={`tray-view-switch${mode === 'full' ? ' is-single' : ''}`}
            role="group"
            aria-label="View"
          >
            <Tooltip
              text={
                'Grid: every clip as a tile.\nEsc goes back to it from Single.\nZ / X or ↑ / ↓: previous / next filter step'
              }
            >
              <button
                type="button"
                className={mode !== 'full' ? 'is-active' : ''}
                aria-pressed={mode !== 'full'}
                onClick={handleFullCardClose}
                disabled={mode !== 'full'}
                aria-label="Grid"
              >
                <FiGrid aria-hidden />
              </button>
            </Tooltip>
            <Tooltip
              text={
                'Single: one clip in detail.\nZ / X or ← / →: previous / next clip\nEsc: back to the grid'
              }
            >
              <button
                type="button"
                className={mode === 'full' ? 'is-active' : ''}
                aria-pressed={mode === 'full'}
                onClick={showSingle}
                disabled={mode === 'full'}
                aria-label="Single"
              >
                <FiSquare aria-hidden />
              </button>
            </Tooltip>
          </div>
        )}
        <div className="tray-zoom">
          {/* Hidden, not removed, in Single: it keeps its space. */}
          <input
            type="range"
            className={`tray-zoom-slider${mode === 'full' ? ' is-hidden' : ''}`}
            disabled={mode === 'full'}
            tabIndex={mode === 'full' ? -1 : undefined}
            aria-hidden={mode === 'full' || undefined}
            min={0}
            max={1000}
            step={1}
            aria-label="Zoom"
            title={`Zoom: ${zoomSize >= 1 ? `${Math.round(zoomSize)} px` : `${Math.round(1 / (zoomSize * zoomSize)).toLocaleString()} clips per px`}. Also Ctrl + scroll over the clips.`}
            value={Math.round(
              (1000 * Math.log(Math.max(zoomSize, minZoom) / minZoom)) /
                Math.log((clipDisplayConfig.thresholds.full - 1) / minZoom),
            )}
            onChange={(e) => {
              handoff.focus = null
              zoomGridTo(
                minZoom *
                  ((clipDisplayConfig.thresholds.full - 1) / minZoom) **
                    (Number(e.target.value) / 1000),
              )
            }}
          />
          <Tooltip text="Zoom out">
            <button
              type="button"
              className="tray-zoom-btn"
              onClick={handleZoomOut}
              aria-label="Zoom out"
            >
              <FiZoomOut />
            </button>
          </Tooltip>
          <Tooltip text="Zoom in">
            <button
              type="button"
              className="tray-zoom-btn"
              onClick={handleZoomIn}
              aria-label="Zoom in"
            >
              <FiZoomIn />
            </button>
          </Tooltip>
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
        {(!hasContent || (readError && loadedCount === 0)) && !isLoading && (
          <div className="tray-empty">
            {isGameFilter && !readError ? (
              // No replays yet: any on their way, then the two places they
              // come from (APP_FLOW.md).
              <>
                <IncomingReplays />
                <AddReplays />
              </>
            ) : (
              (() => {
                const copy = emptyResultsCopy({
                  running: isActiveFilterRunning,
                  readError,
                  processed: !!activeFilter?.isProcessed,
                  type: activeFilter?.type,
                })
                return (
                  <>
                    <div className="tray-empty-title" role="status">
                      {copy.title}
                    </div>
                    <div className="tray-empty-subtitle">{copy.subtitle}</div>
                    {copy.retry && (
                      <button
                        type="button"
                        className="tray-select-all-btn"
                        onClick={() => {
                          setReadError(false)
                          setPreviewTick((t) => t + 1)
                        }}
                      >
                        Try again
                      </button>
                    )}
                  </>
                )
              })()
            )}
          </div>
        )}

        {/* Full mode: FullCard (bypasses DomLayer) */}
        {hasContent && mode === 'full' && paginatedClips.length > 0 && (
          <FullCard
            data={paginatedClips[0]}
            filterId={
              isGameFilter && !activeFilter?.isProcessed
                ? 'files'
                : activeFilterId
            }
            isSelected={(() => {
              return selection.has(rowId(paginatedClips[0]))
            })()}
            onMouseDown={(e: React.MouseEvent) => {
              const clip = paginatedClips[0]
              const clipId =
                'id' in clip && clip.id != null
                  ? String(clip.id)
                  : 'path' in clip && clip.path
                    ? clip.path
                    : ''
              handleClipMouseDown(globalIndex, clipId as string, e)
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
            onClose={handleFullCardClose}
            nav={{
              index: globalIndex,
              total: totalClips || clips.length,
              onPrev: () => fullStep(-1),
              onNext: () => fullStep(1),
            }}
          />
        )}

        {/* DOM grid: mode2 only. Full mode uses FullCard above; further out the
            GPU overview draws everything and the grid isn't mounted at all. */}
        {hasContent && showsDomGrid(mode) && (
          <DomLayer
            clips={clips}
            mode={mode as Exclude<ClipMode, 'full'>}
            clipSize={clipSize}
            gap={gap}
            columns={columns}
            trayWidth={trayWidth}
            trayHeight={trayHeight}
            visible
            selection={selection}
            onClipMouseDown={handleClipMouseDown}
            onClipMouseEnter={handleClipMouseEnter}
            onClipDoubleClick={handleClipDoubleClick}
            onClipPlay={onClipPlay}
            onClipRecord={onClipRecord}
            onBackgroundClick={() => {
              setSelection(Selection.none())
              setLastSelectedIndex(null)
            }}
            startIndex={clipsOffset}
            total={Math.max(totalClips, clipsOffset + clips.length)}
            onVisibleRange={(first, last) => {
              if (!showsDomGrid(mode)) return
              setVisibleRange((prev) =>
                prev[0] === first && prev[1] === last ? prev : [first, last],
              )
              // Keep a window of rows around the screen loaded, starting no
              // later than the first row on screen.
              const want = nextWindowOffset({
                first,
                last,
                loadedStart: clipsOffset,
                loadedCount: clips.length,
                total: totalClipsRef.current,
                windowRows: GRID_WINDOW,
              })
              if (want !== null) {
                setWindowOffset((prev) => (prev === want ? prev : want))
              }
            }}
            reorderActive={reorderDragRef.current?.active ?? false}
            reorderDraggingIds={reorderDragRef.current?.draggingIds ?? null}
            reorderInsertIndex={reorderInsertIndex}
            onReorderInsertIndexChange={setReorderInsertIndex}
            handoff={handoff}
          />
        )}

        {/* Far out: every clip of the table drawn by the GPU (tray-v2.md). Once
            shown it stays mounted, hidden, so crossing 120 px reuses its GPU
            textures and selection marks instead of uploading them again. */}
        {hasContent && (isGpu || gpuKept) && (
          <OverviewCanvas
            active={isGpu}
            layout={cardLayout}
            filterId={
              isGameFilter && !activeFilter?.isProcessed
                ? 'files'
                : activeFilterId
            }
            dataVersion={`${overviewEpoch}`}
            total={totalClips}
            tile={zoomSize}
            width={trayWidth}
            height={trayHeight}
            selection={selection}
            onSelectionChange={(next, anchor) => {
              overviewAnchorRef.current = anchor
              setSelection(next)
            }}
            onOpen={openAt}
            onClipPlay={onClipPlay}
            onClipRecord={onClipRecord}
            onZoom={zoomGridBy}
            handoff={handoff}
            onVisibleRange={(first, last) =>
              setVisibleRange((prev) =>
                prev[0] === first && prev[1] === last ? prev : [first, last],
              )
            }
          />
        )}
      </div>
      {footer ? <div className="tray-footer-bars">{footer}</div> : null}
      {removeAsk && (
        <ConfirmModal
          title={`Remove ${removeAsk.count.toLocaleString()} results from this step?`}
          body="They disappear from this step and from the steps after it that were made from them. Your replay files are not touched. Run the step again to find them anew."
          confirmLabel="Remove"
          onCancel={() => setRemoveAsk(null)}
          onConfirm={() => {
            const asked = removeAsk
            setRemoveAsk(null)
            removeRows(asked)
          }}
        />
      )}
      {deleteAsk && (
        <ConfirmModal
          title={deleteReplaysCopy(deleteAsk.games).title}
          body={deleteReplaysCopy(deleteAsk.games).body}
          confirmLabel="Remove from Clipper"
          extraLabel="Open library folder"
          onExtra={() =>
            ipcBridge.database({ action: 'openLibrary' }, () => {})
          }
          checkboxLabel="Don't show this again"
          onCancel={() => setDeleteAsk(null)}
          onConfirm={(dontAskAgain) => {
            const { selection: asked } = deleteAsk
            setDeleteAsk(null)
            if (dontAskAgain) onStopConfirmingDeletes?.()
            removeRows(asked)
          }}
        />
      )}
    </div>
  )
}

export default Tray
