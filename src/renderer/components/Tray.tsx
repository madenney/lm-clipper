// Feature flags — re-enable density/canvas paths from git history if needed
import {
  useMemo,
  useRef,
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react'
import { FiZoomIn, FiZoomOut } from 'react-icons/fi'
import '../styles/Tray.css'
import Item from './Item'
import { stages } from '../../constants/stages'
import type { ShallowArchiveInterface, ClipInterface, FileInterface, LiteItem } from '../../constants/types'
import { zoomConfig } from '../zoomConfig'
import { resolveVariantBucket, stageVariantSizes } from '../stageVariant'
import { setTestModeInfo } from '../testModeStore'
import { hexToRgbaFloat } from '../lib/colorUtils'
import {
  clamp,
  getGap,
  getInfoPadding,
  computeViewMetrics,
  buildLayout,
  paddingBottom,
  type Layout,
} from '../lib/layoutMath'
import { createTrayDebug } from '../lib/trayDebug'
import { useTraySize } from '../hooks/useTraySize'
import { useTrayZoom } from '../hooks/useTrayZoom'
import { useWindowRange } from '../hooks/useWindowRange'
import { useResultsFetcher } from '../hooks/useResultsFetcher'
import { useWebglPipeline } from '../hooks/useWebglPipeline'

type TrayProps = {
  archive: ShallowArchiveInterface | null
  activeFilterId: string
}

const pageSizeDefault = 50
const maxStageColors = 64

const DEFAULT_FILTER = { id: 'files', label: 'Files', type: 'files', isProcessed: true, tableId: 'files' } as const

type ShowingCountStore = {
  getSnapshot: () => number
  set: (value: number) => void
  subscribe: (listener: () => void) => () => void
}

type ScrollDetectStore = {
  getSnapshot: () => boolean
  pulse: () => void
  subscribe: (listener: () => void) => () => void
}

type LoadingStore = {
  getSnapshot: () => boolean
  set: (value: boolean) => void
  subscribe: (listener: () => void) => () => void
}

const createShowingCountStore = (): ShowingCountStore => {
  let value = 0
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    set: (next: number) => {
      if (next === value) return
      value = next
      listeners.forEach((listener) => listener())
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const createScrollDetectStore = (): ScrollDetectStore => {
  let active = false
  let timeoutId: number | null = null
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())
  const setActive = (next: boolean) => {
    if (active === next) return
    active = next
    notify()
  }
  return {
    getSnapshot: () => active,
    pulse: () => {
      setActive(true)
      if (timeoutId != null) window.clearTimeout(timeoutId)
      timeoutId = window.setTimeout(() => {
        timeoutId = null
        setActive(false)
      }, 250)
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const createLoadingStore = (): LoadingStore => {
  let active = false
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => active,
    set: (next: boolean) => {
      if (active === next) return
      active = next
      listeners.forEach((listener) => listener())
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const showingCountStore = createShowingCountStore()
const scrollDetectStore = createScrollDetectStore()
const loadingStore = createLoadingStore()

const useShowingCount = () =>
  useSyncExternalStore(showingCountStore.subscribe, showingCountStore.getSnapshot)

const ShowingCountLabel = () => {
  const count = useShowingCount()
  const scrollDetected = useSyncExternalStore(scrollDetectStore.subscribe, scrollDetectStore.getSnapshot)
  const isLoading = useSyncExternalStore(loadingStore.subscribe, loadingStore.getSnapshot)
  const isBusy = scrollDetected || isLoading
  return (
    <div className="active-filter-label">
      {isBusy ? 'Loading...' : `Showing ${count.toLocaleString()} results`}
    </div>
  )
}

type DebugFns = {
  logZoomTrace: (event: string, meta?: Record<string, string | number | boolean | null>) => void
  updateDebugLines: (source: string) => void
  setTaskLabel: (label: string) => void
}

export default function Tray({ archive, activeFilterId }: TrayProps) {
  const [currentPage, setCurrentPage] = useState(0)

  const trayRef = useRef<HTMLDivElement | null>(null)
  const resultsRef = useRef<HTMLDivElement | null>(null)

  // Shared refs for cross-hook communication
  const webglDataRangeRef = useRef({ offset: 0, limit: 0 })
  const pageOffsetRef = useRef(0)
  const webglWantedRef = useRef(false)
  const onZoomCommitRef = useRef(() => {})
  const scheduleWebglDrawRef = useRef(() => {})
  const debugRef = useRef<DebugFns>({
    logZoomTrace: () => {},
    updateDebugLines: () => {},
    setTaskLabel: () => {},
  })
  const useWebglModeRef = useRef(false)
  const renderModeRef = useRef('full')
  const elementsOnScreenRef = useRef(0)
  // Pre-create refs that multiple hooks share (zoom reads, Tray writes)
  const layoutRef = useRef<Layout>({ gap: 0, cell: 0, padding: 0, availableHeight: 0, columns: 0, totalRows: 0, totalHeight: 0 })
  const displayTotalResultsRef = useRef(0)
  const totalResultsRef = useRef(0)

  // ─── Hook 1: Tray Size ───
  const totalResultsForSize = useMemo(() => {
    if (!archive) return 0
    return archive.files || 0
  }, [archive])

  const {
    trayWidth, trayHeight, resultsTop,
    traySizeRef, resultsTopRef, refreshResultsTop,
  } = useTraySize(trayRef, resultsRef, totalResultsForSize)

  // ─── Hook 2: Tray Zoom ───
  const {
    zoomSize, displayZoom, maxZoom, minZoomForDensity, effectiveMinZoom,
    isFullWidthZoom, nudgeZoom,
    zoomTargetRef, isZoomingRef, zoomRafRef, zoomStopTimeoutRef,
    zoomScrollTopRef, lastWheelInfoRef, maxZoomRef, effectiveMinZoomRef,
    displayZoomRef,
  } = useTrayZoom({
    trayRef, traySizeRef, resultsTopRef,
    layoutRef, displayTotalResultsRef, totalResultsRef,
    trayWidth, trayHeight, resultsTop,
    pageOffsetRef, onZoomCommitRef, debugRef,
    scrollDetectPulse: scrollDetectStore.pulse,
  })

  // ─── Derived State (stays in Tray) ───
  const canUseWebglWorker = useMemo(() => {
    if (typeof OffscreenCanvas === 'undefined') return false
    if (typeof HTMLCanvasElement === 'undefined') return false
    return 'transferControlToOffscreen' in HTMLCanvasElement.prototype
  }, [])

  const activeFilter = useMemo(() => {
    if (!archive) return DEFAULT_FILTER
    if (activeFilterId === 'files') return DEFAULT_FILTER
    const selected = archive.filters.find((filter) => filter.id === activeFilterId)
    if (!selected) return DEFAULT_FILTER
    const tableId = selected.type === 'files' && !selected.isProcessed ? 'files' : selected.id
    return { id: selected.id, label: selected.label, type: selected.type, isProcessed: selected.isProcessed, tableId }
  }, [archive, activeFilterId])

  useEffect(() => { setCurrentPage(0) }, [activeFilter.id, activeFilter.tableId])

  const stageColorPalette = useMemo(() => {
    const paletteHex: string[] = Object.values(zoomConfig.stageSolidColors)
    const palette = new Float32Array(maxStageColors * 4)
    for (let i = 0; i < maxStageColors; i += 1) {
      const entry = stages[i as keyof typeof stages] as { tag?: string } | undefined
      const stageTag = entry?.tag
      const solidColors: Record<string, string> = zoomConfig.stageSolidColors
      let color = stageTag && stageTag in solidColors ? solidColors[stageTag] : undefined
      if (!color) color = paletteHex.length ? paletteHex[Math.abs(i) % paletteHex.length] : '#333333'
      const [r, g, b, a] = hexToRgbaFloat(color)
      palette[i * 4] = r
      palette[i * 4 + 1] = g
      palette[i * 4 + 2] = b
      palette[i * 4 + 3] = a
    }
    return palette
  }, [])

  const fitToTray = zoomConfig.fitToTray

  const totalResults = useMemo(() => {
    if (!archive) return 0
    if (activeFilter.tableId === 'files') return archive.files || 0
    const active = archive.filters.find((filter) => filter.id === activeFilter.id)
    return active ? active.results : 0
  }, [archive, activeFilter.id, activeFilter.tableId])

  const baseGap = useMemo(() => getGap(displayZoom), [displayZoom])
  const baseViewMetrics = useMemo(
    () => computeViewMetrics(displayZoom, trayWidth, trayHeight, resultsTop, baseGap),
    [displayZoom, trayWidth, trayHeight, resultsTop, baseGap]
  )
  const isFullWidthMode = baseViewMetrics.columns === 1
  const paginationEnabled = isFullWidthMode
  const pageSize = pageSizeDefault
  const totalPages = paginationEnabled ? Math.max(1, Math.ceil(totalResults / pageSize)) : 1
  const safePage = paginationEnabled ? clamp(currentPage, 0, totalPages - 1) : 0

  useEffect(() => {
    if (!paginationEnabled && currentPage !== 0) { setCurrentPage(0); return }
    if (paginationEnabled && safePage !== currentPage) setCurrentPage(safePage)
  }, [paginationEnabled, safePage, currentPage])

  const pageOffset = paginationEnabled ? safePage * pageSize : 0
  const pageTotal = paginationEnabled
    ? Math.max(0, Math.min(pageSize, totalResults - pageOffset))
    : totalResults
  const displayTotalResultsBase = pageTotal
  const baseElementsOnScreen = Math.min(displayTotalResultsBase, baseViewMetrics.capacity)
  const gapValue = baseElementsOnScreen >= zoomConfig.gapOffAt ? 0 : baseGap

  const viewMetrics = useMemo(
    () => computeViewMetrics(displayZoom, trayWidth, trayHeight, resultsTop, gapValue),
    [displayZoom, trayWidth, trayHeight, resultsTop, gapValue]
  )
  const effectiveFitToTray = paginationEnabled ? false : fitToTray
  const displayTotalResults = effectiveFitToTray && viewMetrics.capacity > 0
    ? Math.min(viewMetrics.capacity, displayTotalResultsBase)
    : displayTotalResultsBase
  const elementsOnScreen = Math.min(displayTotalResults, viewMetrics.capacity)
  const pageStart = paginationEnabled && pageTotal > 0 ? pageOffset + 1 : 0
  const pageEnd = paginationEnabled && pageTotal > 0 ? pageOffset + pageTotal : 0

  const borderEnabled = elementsOnScreen < zoomConfig.borderOffAt
  const renderMode = elementsOnScreen >= zoomConfig.lowResAt ? 'lowRes' : 'full'
  const webglWanted = displayZoom <= 16 && canUseWebglWorker
  const showStageLabel = elementsOnScreen <= zoomConfig.infoStageAt
  const showPlayers = elementsOnScreen <= zoomConfig.infoPlayersAt
  const showLength = elementsOnScreen <= zoomConfig.infoLengthAt
  const showFileName = elementsOnScreen <= zoomConfig.infoFileAt

  const variantBucket = useMemo(() => resolveVariantBucket(displayZoom), [displayZoom])
  const webglVariantSize = useMemo(() => variantBucket || stageVariantSizes[0] || 1, [variantBucket])
  const variantBucketRef = useRef(variantBucket)
  useEffect(() => { variantBucketRef.current = variantBucket }, [variantBucket])

  // Update shared refs that hooks read
  pageOffsetRef.current = pageOffset
  webglWantedRef.current = webglWanted
  renderModeRef.current = renderMode
  elementsOnScreenRef.current = elementsOnScreen

  // Keep shared refs in sync with derived values
  displayTotalResultsRef.current = displayTotalResults
  totalResultsRef.current = totalResults

  // ─── Hook 3: Window Range ───
  const {
    windowRange, visibleRange,
    windowRangeRef, visibleRangeRef, visibleCountRef,
    scheduleWindowUpdate, handleScroll,
  } = useWindowRange({
    trayRef, resultsRef, resultsTopRef,
    layoutRef, displayTotalResultsRef, totalResultsRef,
    isZoomingRef, webglWantedRef, useWebglModeRef,
    webglDataRangeRef, scheduleWebglDrawRef, debugRef,
    showingCountStore, refreshResultsTop,
    layout: layoutRef.current,
    displayTotalResults,
    activeFilterId: activeFilter.id,
    activeFilterTableId: activeFilter.tableId,
    currentPage, paginationEnabled,
  })

  // Wire onZoomCommit → scheduleWindowUpdate
  onZoomCommitRef.current = scheduleWindowUpdate

  // ─── Hook 4: WebGL Pipeline ───
  const {
    webglCanvasNode, setWebglCanvasRef,
    webglWorkerRef, webglDrawRafRef,
    webglTextureSizesRef, webglTexturesLoadingRef,
    webglTextureVersion,
    scheduleWebglDraw,
  } = useWebglPipeline({
    canUseWebglWorker, stageColorPalette,
    trayRef, traySizeRef, resultsTopRef,
    layoutRef, visibleRangeRef, windowRangeRef,
    webglDataRangeRef, displayZoomRef, variantBucketRef,
    debugRef,
  })

  // Wire scheduleWebglDraw ref
  scheduleWebglDrawRef.current = scheduleWebglDraw

  const webglTextureReady = useMemo(
    () => webglWanted && webglTextureSizesRef.current.has(webglVariantSize),
    [webglWanted, webglVariantSize, webglTextureVersion]
  )
  const useWebglMode = webglWanted && webglTextureReady
  useEffect(() => { useWebglModeRef.current = useWebglMode }, [useWebglMode])

  const infoVisible = !useWebglMode && renderMode === 'full' && (showStageLabel || showPlayers || showLength || showFileName)

  const variantLabel = useMemo(() => variantBucket ? `${variantBucket}px` : 'base', [variantBucket])

  useEffect(() => {
    setTestModeInfo({ tileSize: displayZoom, imageSize: variantBucket || 0, variantLabel })
  }, [displayZoom, variantLabel])

  useEffect(() => {
    setTestModeInfo({ processLabel: webglWanted ? 'gpu render' : 'web render' })
  }, [webglWanted])

  // ─── Hook 5: Results Fetcher ───
  const { currentResults, webglFetchTimeoutRef } = useResultsFetcher({
    archive, activeFilter, windowRange, visibleRange, pageOffset,
    useWebglMode, webglWanted, renderMode,
    webglWorkerRef, webglDataRangeRef, scheduleWebglDrawRef, debugRef,
    visibleCountRef, showingCountStore,
  })

  // ─── Layout ───
  const zoomStyles = useMemo(() => {
    const font = Math.max(0, Math.round(displayZoom * 0.1))
    const infoPadding = getInfoPadding(infoVisible)
    const infoOpacity = infoVisible ? 0.6 : 0
    const borderWidth = borderEnabled ? '1px' : '0px'
    return {
      '--tile-size': `${displayZoom}px`,
      '--tile-gap': `${gapValue}px`,
      '--info-font': `${font}px`,
      '--info-padding': infoPadding,
      '--info-bg-opacity': infoOpacity,
      '--tile-border': borderWidth,
    } as CSSProperties
  }, [displayZoom, gapValue, infoVisible, borderEnabled])

  const layout = useMemo(() => {
    return buildLayout(displayZoom, displayTotalResults, trayWidth, trayHeight, resultsTop, gapValue)
  }, [displayZoom, trayWidth, trayHeight, resultsTop, displayTotalResults, gapValue])

  // Keep layoutRef in sync
  layoutRef.current = layout

  const resultsHeight = effectiveFitToTray
    ? Math.max(0, trayHeight - resultsTop)
    : Math.ceil(layout.totalHeight)

  // ─── Debug Infrastructure ───
  const debugFns = useMemo(() => createTrayDebug({
    trayRef, traySizeRef, resultsTopRef,
    layoutRef, visibleRangeRef, windowRangeRef,
    webglDataRangeRef, variantBucketRef,
    zoomTargetRef, displayZoomRef,
    isZoomingRef, zoomRafRef, zoomStopTimeoutRef,
    lastWheelInfoRef, maxZoomRef,
    displayTotalResultsRef, totalResultsRef, visibleCountRef,
    useWebglModeRef, webglDrawRafRef,
    webglTextureSizesRef, webglFetchTimeoutRef,
    webglWantedRef, renderModeRef, elementsOnScreenRef,
    loadingStore,
  }), [])

  // Wire debug ref for hooks
  debugRef.current = debugFns

  // ─── Pagination ───
  const canPageBack = paginationEnabled && safePage > 0
  const canPageForward = paginationEnabled && safePage < totalPages - 1
  const handlePrevPage = () => {
    if (!canPageBack) return
    setCurrentPage((prev) => Math.max(0, prev - 1))
  }
  const handleNextPage = () => {
    if (!canPageForward) return
    setCurrentPage((prev) => Math.min(totalPages - 1, prev + 1))
  }

  // ─── Render ───
  function renderResults() {
    if (useWebglMode) return null
    const { columns, cell, padding } = layout
    if (!currentResults || currentResults.length === 0 || columns <= 0) return null
    const availableWidth = Math.max(0, trayWidth - padding * 2)
    const isFullWidth = paginationEnabled
    const squareSize = isFullWidth ? availableWidth : displayZoom
    const cardState = isFullWidth ? 'full' : 'square'
    const allowCardActions = columns <= 8

    return currentResults.map(
      (item: ClipInterface | FileInterface | LiteItem, index: number) => {
        const globalIndex = windowRange.offset + index
        const itemId = 'id' in item ? item.id : undefined
        const itemKey = itemId || `${item.path}-${item.startFrame ?? globalIndex}`
        const row = Math.floor(globalIndex / columns)
        const col = globalIndex % columns
        const top = padding + row * cell
        const left = padding + col * cell
        return (
          <Item
            item={item}
            key={itemKey}
            index={globalIndex}
            renderMode={renderMode as 'lowRes' | 'full'}
            tileSize={displayZoom}
            showStageLabel={showStageLabel}
            showPlayers={showPlayers}
            showLength={showLength}
            showFileName={showFileName}
            disableInteraction={webglWanted}
            cardState={cardState}
            showCardActions={allowCardActions}
            style={{ position: 'absolute', top, left, width: squareSize, height: squareSize }}
          />
        )
      }
    )
  }

  return (
    <div className="tray" ref={trayRef} onScroll={handleScroll}>
      {((archive && archive.files > 0) || currentResults.length > 0) ? (
        <div>
          <div className="tray-controls">
            <ShowingCountLabel />
            <div className="zoom-controls">
              <button type="button" className="zoom-button" onClick={() => nudgeZoom('out')} aria-label="Zoom out">
                <FiZoomOut />
              </button>
              <button
                type="button"
                className="zoom-button"
                onClick={() => nudgeZoom('in')}
                disabled={paginationEnabled || isFullWidthZoom(displayZoom)}
                aria-label="Zoom in"
              >
                <FiZoomIn />
              </button>
            </div>
          </div>
          {paginationEnabled ? (
            <div className="pagination">
              <button type="button" className="pagination-button" onClick={handlePrevPage} disabled={!canPageBack}>
                Prev
              </button>
              <div className="pagination-info">Page {safePage + 1} / {totalPages}</div>
              <button type="button" className="pagination-button" onClick={handleNextPage} disabled={!canPageForward}>
                Next
              </button>
              <div className="pagination-meta">
                {pageTotal > 0 ? `${pageStart}-${pageEnd} of ${totalResults}` : `0 of ${totalResults}`}, {pageSize} per page
              </div>
            </div>
          ) : null}
          <div className="results" style={{ ...zoomStyles, height: resultsHeight }} ref={resultsRef}>
            {canUseWebglWorker ? (
              <canvas
                ref={setWebglCanvasRef}
                className="webgl-canvas"
                style={{ height: useWebglMode ? `${Math.max(0, trayHeight - resultsTop)}px` : '0px' }}
              />
            ) : null}
            {useWebglMode ? null : renderResults()}
          </div>
        </div>
      ) : (
        <div className="noFilesMsg">
          <div className="firstLine">Add Slippi replays by dropping them on this window</div>
          <div className="secondLine"> or by clicking File &gt; Import Replays</div>
        </div>
      )}
    </div>
  )
}
