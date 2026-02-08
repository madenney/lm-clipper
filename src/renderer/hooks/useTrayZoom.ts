import {
  useState,
  useEffect,
  useMemo,
  useRef,
  type MutableRefObject,
} from 'react'
import { zoomConfig } from '../zoomConfig'
import {
  clamp,
  getGap,
  computeMaxZoom,
  computeZoomForColumns,
  computeViewMetrics,
  buildLayout,
  paddingBottom,
  minSquareColumns,
  defaultColumns,
  roundNumber,
  type Layout,
} from '../lib/layoutMath'

type DebugFns = {
  logZoomTrace: (
    _event: string,
    _meta?: Record<string, string | number | boolean | null>,
  ) => void
  updateDebugLines: (_source: string) => void
}

type WheelDebugInfo = {
  deltaX: number
  deltaY: number
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  factor: number
  nextZoom: number
  anchorX: number
  anchorY: number
  time: number
}

export type UseTrayZoomParams = {
  trayRef: MutableRefObject<HTMLDivElement | null>
  traySizeRef: MutableRefObject<{ width: number; height: number }>
  resultsTopRef: MutableRefObject<number>
  layoutRef: MutableRefObject<Layout>
  displayTotalResultsRef: MutableRefObject<number>
  totalResultsRef: MutableRefObject<number>
  trayWidth: number
  trayHeight: number
  resultsTop: number
  pageOffsetRef: MutableRefObject<number>
  onZoomCommitRef: MutableRefObject<() => void>
  debugRef: MutableRefObject<DebugFns>
  scrollDetectPulse: () => void
}

const maxVisibleItems = zoomConfig.densityMaxVisibleItems
const zoomCommitDelayMs = 120
const { zoomButtonStep } = zoomConfig
const { fitToTray } = zoomConfig
const pageSizeDefault = 50

export const useTrayZoom = (params: UseTrayZoomParams) => {
  const {
    trayRef,
    traySizeRef,
    resultsTopRef,
    layoutRef,
    displayTotalResultsRef,
    totalResultsRef,
    trayWidth,
    trayHeight,
    resultsTop,
    pageOffsetRef,
    onZoomCommitRef,
    debugRef,
    scrollDetectPulse,
  } = params

  const [zoomSize, setZoomSize] = useState(20)
  const zoomTargetRef = useRef(zoomSize)
  const zoomScrollTopRef = useRef<number | null>(null)
  const isZoomingRef = useRef(false)
  const zoomStopTimeoutRef = useRef<number | null>(null)
  const zoomRafRef = useRef<number | null>(null)
  const initialZoomSetRef = useRef(false)
  const lastWheelInfoRef = useRef<WheelDebugInfo>({
    deltaX: 0,
    deltaY: 0,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    factor: 1,
    nextZoom: 0,
    anchorX: 0,
    anchorY: 0,
    time: 0,
  })

  const minZoomForDensity = useMemo(() => {
    const width = Math.max(0, trayWidth)
    const height = Math.max(0, trayHeight - resultsTop - paddingBottom)
    if (width === 0 || height === 0) return zoomConfig.minZoom
    const minCell = Math.sqrt((width * height) / maxVisibleItems)
    return Math.max(zoomConfig.minZoom, minCell)
  }, [trayWidth, trayHeight, resultsTop])

  const maxZoom = useMemo(() => computeMaxZoom(trayWidth), [trayWidth])
  const effectiveMinZoom = Math.min(minZoomForDensity, maxZoom)
  const displayZoom = zoomSize

  const maxZoomRef = useRef(maxZoom)
  maxZoomRef.current = maxZoom
  const effectiveMinZoomRef = useRef(effectiveMinZoom)
  effectiveMinZoomRef.current = effectiveMinZoom
  const displayZoomRef = useRef(displayZoom)
  useEffect(() => {
    displayZoomRef.current = displayZoom
  }, [displayZoom])

  // Initial zoom from column count
  useEffect(() => {
    if (initialZoomSetRef.current) return
    if (trayWidth <= 0) return
    const nextZoom = computeZoomForColumns(trayWidth, defaultColumns)
    initialZoomSetRef.current = true
    setZoomSize(clamp(nextZoom, zoomConfig.minZoom, maxZoom))
  }, [trayWidth, maxZoom])

  // Clamp zoom when maxZoom changes
  useEffect(() => {
    setZoomSize((prev) => clamp(prev, zoomConfig.minZoom, maxZoom))
  }, [maxZoom])

  // Sync zoomTarget ref
  useEffect(() => {
    zoomTargetRef.current = zoomSize
  }, [zoomSize])

  const isFullWidthZoom = (zoom: number) => {
    const { width } = traySizeRef.current
    if (width <= 0) return false
    const gap = getGap(zoom)
    const cell = Math.max(1, zoom + gap)
    const padding = gap
    const availableWidth = Math.max(0, width - padding * 2)
    const maxColumns = Math.max(1, Math.floor((availableWidth + gap) / cell))
    return maxColumns < minSquareColumns
  }

  const computeZoomMetrics = (zoom: number) => {
    const nextEffectiveMinZoom = effectiveMinZoomRef.current
    const nextIsDensity = zoom < nextEffectiveMinZoom
    const nextStride = nextIsDensity
      ? Math.max(1, nextEffectiveMinZoom / Math.max(zoom, 0.001))
      : 1
    const total = totalResultsRef.current
    const nextDisplayBase = nextIsDensity
      ? Math.max(0, Math.ceil(total / nextStride))
      : total
    const currentSize = traySizeRef.current
    const rTop = resultsTopRef.current
    const currentBaseGap = getGap(zoom)
    const baseMetrics = computeViewMetrics(
      zoom,
      currentSize.width,
      currentSize.height,
      rTop,
      currentBaseGap,
    )
    const nextFullWidth = baseMetrics.columns === 1
    const nextFitToTray = nextFullWidth ? false : fitToTray
    const pageOffset = pageOffsetRef.current
    const pagedDisplayBase = nextFullWidth
      ? Math.max(0, Math.min(pageSizeDefault, nextDisplayBase - pageOffset))
      : nextDisplayBase
    const currentBaseOnScreen = Math.min(pagedDisplayBase, baseMetrics.capacity)
    const currentGapValue =
      currentBaseOnScreen >= zoomConfig.gapOffAt ? 0 : currentBaseGap
    const currentViewMetrics = computeViewMetrics(
      zoom,
      currentSize.width,
      currentSize.height,
      rTop,
      currentGapValue,
    )
    const nextDisplayTotal =
      nextFitToTray && currentViewMetrics.capacity > 0
        ? Math.min(currentViewMetrics.capacity, pagedDisplayBase)
        : pagedDisplayBase
    const nextLayout = buildLayout(
      zoom,
      nextDisplayTotal,
      currentSize.width,
      currentSize.height,
      rTop,
      currentGapValue,
    )
    return { displayTotal: nextDisplayTotal, layout: nextLayout }
  }

  const applyZoom = (nextZoom: number, anchorX: number, anchorY: number) => {
    const node = trayRef.current
    if (!node) return
    if (
      isFullWidthZoom(zoomTargetRef.current) &&
      nextZoom > zoomTargetRef.current
    )
      return

    isZoomingRef.current = true
    if (zoomStopTimeoutRef.current != null)
      window.clearTimeout(zoomStopTimeoutRef.current)
    zoomStopTimeoutRef.current = window.setTimeout(() => {
      isZoomingRef.current = false
      onZoomCommitRef.current()
    }, zoomCommitDelayMs)

    const width = node.clientWidth
    const height = node.clientHeight
    const pointerX = clamp(anchorX, 0, width)
    const pointerY = clamp(anchorY, 0, height)
    const oldTotal = displayTotalResultsRef.current
    const oldLayout = layoutRef.current
    let anchorRatio = 0
    if (oldTotal > 0 && oldLayout.columns > 0) {
      const gridY = node.scrollTop + pointerY - resultsTopRef.current
      const row = clamp(
        Math.floor((gridY - oldLayout.padding) / oldLayout.cell),
        0,
        Math.max(0, oldLayout.totalRows - 1),
      )
      const col = clamp(
        Math.floor((pointerX - oldLayout.padding) / oldLayout.cell),
        0,
        Math.max(0, oldLayout.columns - 1),
      )
      const index = Math.min(row * oldLayout.columns + col, oldTotal - 1)
      anchorRatio = (index + 0.5) / oldTotal
    }

    debugRef.current.logZoomTrace('apply_zoom', {
      nextZoom: roundNumber(nextZoom, 3),
      anchorX: roundNumber(anchorX, 2),
      anchorY: roundNumber(anchorY, 2),
      anchorRatio: roundNumber(anchorRatio, 4),
    })

    const nextMetrics = computeZoomMetrics(nextZoom)
    if (nextMetrics.displayTotal > 0 && nextMetrics.layout.columns > 0) {
      const safeTotal = Math.max(1, nextMetrics.displayTotal)
      const nextIndex = clamp(
        Math.floor(anchorRatio * safeTotal),
        0,
        safeTotal - 1,
      )
      const nextColumns = Math.max(1, nextMetrics.layout.columns)
      const nextRow = Math.floor(nextIndex / nextColumns)
      const nextScrollOffset =
        nextRow * nextMetrics.layout.cell +
        nextMetrics.layout.padding -
        pointerY
      const nextScrollTop = nextScrollOffset + resultsTopRef.current
      const maxScroll = Math.max(
        0,
        resultsTopRef.current +
          nextMetrics.layout.totalHeight -
          traySizeRef.current.height,
      )
      zoomScrollTopRef.current = clamp(nextScrollTop, 0, maxScroll)
    } else {
      zoomScrollTopRef.current = 0
    }

    zoomTargetRef.current = nextZoom
    if (zoomRafRef.current != null) return
    zoomRafRef.current = window.requestAnimationFrame(() => {
      zoomRafRef.current = null
      setZoomSize(zoomTargetRef.current)
      if (zoomScrollTopRef.current != null) {
        node.scrollTop = zoomScrollTopRef.current
      }
      debugRef.current.logZoomTrace('zoom_commit', {
        appliedZoom: roundNumber(zoomTargetRef.current, 3),
        appliedScrollTop: roundNumber(node.scrollTop, 2),
      })
    })
  }

  const nudgeZoom = (direction: 'in' | 'out') => {
    const node = trayRef.current
    if (!node) return
    if (direction === 'in' && isFullWidthZoom(zoomTargetRef.current)) return
    const step = zoomButtonStep > 1 ? zoomButtonStep : 1.05
    const factor = direction === 'in' ? step : 1 / step
    const next = zoomTargetRef.current * factor
    const nextZoom = clamp(next, zoomConfig.minZoom, maxZoomRef.current)
    applyZoom(nextZoom, node.clientWidth / 2, node.clientHeight / 2)
  }

  // Wheel handler
  useEffect(() => {
    const node = trayRef.current
    if (!node) return
    const { minZoom } = zoomConfig
    const onWheel = (event: WheelEvent) => {
      const rect = node.getBoundingClientRect()
      const aX = event.clientX - rect.left
      const aY = event.clientY - rect.top
      let factor = 1
      let nz = zoomTargetRef.current
      if (event.ctrlKey) {
        factor = Math.exp(-event.deltaY * zoomConfig.scrollSpeed * 0.01)
        nz = clamp(zoomTargetRef.current * factor, minZoom, maxZoomRef.current)
      }
      lastWheelInfoRef.current = {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        factor,
        nextZoom: nz,
        anchorX: aX,
        anchorY: aY,
        time: Date.now(),
      }
      if (event.ctrlKey) scrollDetectPulse()
      debugRef.current.updateDebugLines('wheel')
      debugRef.current.logZoomTrace('wheel', {
        deltaX: roundNumber(event.deltaX, 2),
        deltaY: roundNumber(event.deltaY, 2),
        deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        factor: roundNumber(factor, 5),
        nextZoom: roundNumber(nz, 3),
        anchorX: roundNumber(aX, 2),
        anchorY: roundNumber(aY, 2),
      })
      if (!event.ctrlKey) return
      event.preventDefault()
      if (nz > zoomTargetRef.current && isFullWidthZoom(zoomTargetRef.current))
        return
      applyZoom(nz, aX, aY)
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [])

  return {
    zoomSize,
    displayZoom,
    maxZoom,
    minZoomForDensity,
    effectiveMinZoom,
    isFullWidthZoom,
    nudgeZoom,
    computeZoomMetrics,
    zoomTargetRef,
    isZoomingRef,
    zoomRafRef,
    zoomStopTimeoutRef,
    zoomScrollTopRef,
    lastWheelInfoRef,
    maxZoomRef,
    effectiveMinZoomRef,
    displayZoomRef,
    initialZoomSetRef,
  }
}
