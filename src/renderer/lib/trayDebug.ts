import type { MutableRefObject } from 'react'
import { zoomConfig } from '../zoomConfig'
import { stageVariantSizes } from '../stageVariant'
import { perfLog } from '../perfLogger'
import { setTestModeInfo } from '../testModeStore'
import { roundNumber, formatNumber, boolLabel, type Layout } from './layoutMath'

type Range = { offset: number; limit: number }

export type WheelDebugInfo = {
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

export type TrayDebugContext = {
  trayRef: MutableRefObject<HTMLDivElement | null>
  traySizeRef: MutableRefObject<{ width: number; height: number }>
  resultsTopRef: MutableRefObject<number>
  layoutRef: MutableRefObject<Layout>
  visibleRangeRef: MutableRefObject<Range>
  windowRangeRef: MutableRefObject<Range>
  webglDataRangeRef: MutableRefObject<Range>
  variantBucketRef: MutableRefObject<number | null>
  zoomTargetRef: MutableRefObject<number>
  displayZoomRef: MutableRefObject<number>
  isZoomingRef: MutableRefObject<boolean>
  zoomRafRef: MutableRefObject<number | null>
  zoomStopTimeoutRef: MutableRefObject<number | null>
  lastWheelInfoRef: MutableRefObject<WheelDebugInfo>
  maxZoomRef: MutableRefObject<number>
  displayTotalResultsRef: MutableRefObject<number>
  totalResultsRef: MutableRefObject<number>
  visibleCountRef: MutableRefObject<number>
  useWebglModeRef: MutableRefObject<boolean>
  webglDrawRafRef: MutableRefObject<number | null>
  webglTextureSizesRef: MutableRefObject<Set<number>>
  webglFetchTimeoutRef: MutableRefObject<number | null>
  webglWantedRef: MutableRefObject<boolean>
  renderModeRef: MutableRefObject<string>
  elementsOnScreenRef: MutableRefObject<number>
  loadingStore: { set: (_value: boolean) => void }
}

const maxVisibleItems = zoomConfig.densityMaxVisibleItems
const zoomCommitDelayMs = 120
const maxOverscanItems = 1000
const liteResultsThreshold = 6000
const webglFetchDebounceMs = 120

export function createTrayDebug(ctx: TrayDebugContext) {
  let seq = 0

  const getZoomTraceBase = () => {
    const traySize = ctx.traySizeRef.current
    const scrollTop = ctx.trayRef.current?.scrollTop || 0
    const rTop = ctx.resultsTopRef.current
    const scrollOffset = Math.max(0, scrollTop - rTop)
    const currentLayout = ctx.layoutRef.current
    const visible = ctx.visibleRangeRef.current
    const windowRangeValue = ctx.windowRangeRef.current
    const dataRange = ctx.webglDataRangeRef.current
    const visibleEnd = visible.offset + visible.limit
    const dataEnd = dataRange.offset + dataRange.limit
    const varSize = ctx.variantBucketRef.current || stageVariantSizes[0] || 1
    const useFallback =
      dataRange.limit <= 0 ||
      visible.offset < dataRange.offset ||
      visibleEnd > dataEnd
    seq += 1
    return {
      seq,
      perfNow: roundNumber(performance.now(), 2),
      zoomTarget: roundNumber(ctx.zoomTargetRef.current, 3),
      displayZoom: roundNumber(ctx.displayZoomRef.current, 3),
      scrollTop: roundNumber(scrollTop, 2),
      scrollOffset: roundNumber(scrollOffset, 2),
      resultsTop: roundNumber(rTop, 2),
      trayWidth: Math.round(traySize.width),
      trayHeight: Math.round(traySize.height),
      columns: currentLayout.columns,
      cell: roundNumber(currentLayout.cell, 3),
      gap: currentLayout.gap,
      padding: currentLayout.padding,
      totalRows: currentLayout.totalRows,
      visibleOffset: visible.offset,
      visibleLimit: visible.limit,
      windowOffset: windowRangeValue.offset,
      windowLimit: windowRangeValue.limit,
      dataOffset: dataRange.offset,
      dataLimit: dataRange.limit,
      displayTotal: ctx.displayTotalResultsRef.current,
      totalResults: ctx.totalResultsRef.current,
      visibleCount: ctx.visibleCountRef.current,
      variantSize: varSize,
      useWebgl: ctx.useWebglModeRef.current,
      webglWanted: ctx.webglWantedRef.current,
      renderMode: ctx.renderModeRef.current,
      useFallback,
      zooming: ctx.isZoomingRef.current,
      zoomRaf: ctx.zoomRafRef.current != null,
      windowRaf: false,
      webglDrawRaf: ctx.webglDrawRafRef.current != null,
      webglFetch: ctx.webglFetchTimeoutRef.current != null,
    }
  }

  const logZoomTrace = (
    event: string,
    meta?: Record<string, string | number | boolean | null>,
  ) => {
    perfLog.event('zoom_trace', {
      event,
      ...getZoomTraceBase(),
      ...(meta || {}),
    })
  }

  const buildDebugLines = (source: string) => {
    const wheel = ctx.lastWheelInfoRef.current
    const now = Date.now()
    const wheelTimeLabel = wheel.time
      ? new Date(wheel.time).toLocaleTimeString()
      : 'n/a'
    const wheelAgeLabel =
      wheel.time > 0 ? `${Math.max(0, now - wheel.time)}ms` : 'n/a'
    const traySize = ctx.traySizeRef.current
    const scrollTop = ctx.trayRef.current?.scrollTop || 0
    const rTop = ctx.resultsTopRef.current
    const scrollOffset = Math.max(0, scrollTop - rTop)
    const currentLayout = ctx.layoutRef.current
    const visible = ctx.visibleRangeRef.current
    const windowRangeValue = ctx.windowRangeRef.current
    const dataRange = ctx.webglDataRangeRef.current
    const visibleEnd = visible.offset + visible.limit
    const windowEnd = windowRangeValue.offset + windowRangeValue.limit
    const dataEnd = dataRange.offset + dataRange.limit
    const varSize = ctx.variantBucketRef.current || stageVariantSizes[0] || 1
    const textureReady = ctx.webglTextureSizesRef.current.has(varSize)
    const useFallback =
      dataRange.limit <= 0 ||
      visible.offset < dataRange.offset ||
      visibleEnd > dataEnd
    const pendingWebglFetch = ctx.webglFetchTimeoutRef.current != null
    const pendingZoomCommit = ctx.zoomStopTimeoutRef.current != null
    const pendingZoomRaf = ctx.zoomRafRef.current != null
    const pendingWebglDraw = ctx.webglDrawRafRef.current != null
    const elementsOnScreen = ctx.elementsOnScreenRef.current
    return [
      `Debug source: ${source} (wheel ${wheelTimeLabel}, age ${wheelAgeLabel})`,
      `Wheel: dx ${formatNumber(wheel.deltaX, 1)} dy ${formatNumber(wheel.deltaY, 1)} ctrl=${boolLabel(wheel.ctrlKey)} shift=${boolLabel(wheel.shiftKey)} alt=${boolLabel(wheel.altKey)} meta=${boolLabel(wheel.metaKey)}`,
      `Zoom: target ${formatNumber(ctx.zoomTargetRef.current, 2)} display ${formatNumber(ctx.displayZoomRef.current, 2)} next ${formatNumber(wheel.nextZoom, 2)} factor ${formatNumber(wheel.factor, 4)} min ${formatNumber(zoomConfig.minZoom, 2)} max ${formatNumber(ctx.maxZoomRef.current, 2)}`,
      `Pointer: x ${formatNumber(wheel.anchorX, 1)} y ${formatNumber(wheel.anchorY, 1)} tray ${formatNumber(traySize.width, 0)}x${formatNumber(traySize.height, 0)}`,
      `Scroll: top ${formatNumber(scrollTop, 1)} offset ${formatNumber(scrollOffset, 1)} resultsTop ${formatNumber(rTop, 1)}`,
      `Layout: columns ${currentLayout.columns} cell ${formatNumber(currentLayout.cell, 2)} gap ${currentLayout.gap} pad ${currentLayout.padding} rows ${currentLayout.totalRows} availH ${formatNumber(currentLayout.availableHeight, 1)}`,
      `Ranges: window ${windowRangeValue.offset}-${windowEnd} (${windowRangeValue.limit}) visible ${visible.offset}-${visibleEnd} (${visible.limit})`,
      `Results: display ${formatNumber(ctx.displayTotalResultsRef.current, 0)} total ${formatNumber(ctx.totalResultsRef.current, 0)} onScreen ${formatNumber(elementsOnScreen, 0)} showing ${formatNumber(ctx.visibleCountRef.current, 0)}`,
      `Render: mode ${ctx.renderModeRef.current} webglWanted ${boolLabel(ctx.webglWantedRef.current)} webglOn ${boolLabel(ctx.useWebglModeRef.current)} textureReady ${boolLabel(textureReady)} variant ${varSize}px fallback ${boolLabel(useFallback)}`,
      `Webgl data: range ${dataRange.offset}-${dataEnd} (${dataRange.limit}) textures ${ctx.webglTextureSizesRef.current.size}/${stageVariantSizes.length}`,
      `Timers: zooming ${boolLabel(ctx.isZoomingRef.current)} zoomRaf ${boolLabel(pendingZoomRaf)} zoomCommit ${boolLabel(pendingZoomCommit)} webglDraw ${boolLabel(pendingWebglDraw)} webglFetch ${boolLabel(pendingWebglFetch)}`,
      `Config: scrollSpeed ${formatNumber(zoomConfig.scrollSpeed, 3)} commitDelay ${zoomCommitDelayMs}ms maxVisible ${maxVisibleItems} overscan ${maxOverscanItems} liteAt ${liteResultsThreshold} webglDebounce ${webglFetchDebounceMs}ms`,
    ]
  }

  const updateDebugLines = (source: string) => {
    setTestModeInfo({ debugLines: buildDebugLines(source) })
  }

  const setTaskLabel = (label: string) => {
    setTestModeInfo({ taskLabel: label })
    ctx.loadingStore.set(label !== 'idle')
    logZoomTrace('task_label', { label })
  }

  return { logZoomTrace, updateDebugLines, setTaskLabel }
}
