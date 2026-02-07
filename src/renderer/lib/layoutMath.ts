import { zoomConfig } from '../zoomConfig'

export const paddingBottom = 10
export const minSquareColumns = 3
export const defaultColumns = zoomConfig.defaultColumns

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

export const getGapRatio = (size: number) => {
  const minAt = zoomConfig.gapRatioMinAt
  const maxAt = zoomConfig.gapRatioMaxAt
  if (maxAt <= minAt) return zoomConfig.gapRatioMax
  const t = clamp((size - minAt) / (maxAt - minAt), 0, 1)
  return zoomConfig.gapRatioMin + (zoomConfig.gapRatioMax - zoomConfig.gapRatioMin) * t
}

export const getGap = (size: number) => {
  const ratio = getGapRatio(size)
  const minGap = Math.max(
    zoomConfig.minGapFloor,
    Math.round(size * zoomConfig.minGapRatio)
  )
  return Math.max(minGap, Math.round(size * ratio))
}

export const getBorder = () => 2

export const getInfoPadding = (enabled: boolean) =>
  enabled ? '4px 2px 2px 2px' : '0px'

export const computeMaxZoom = (trayWidth: number) => {
  const minZoom = zoomConfig.minZoom
  const baseWidth = Math.max(
    zoomConfig.maxZoomFloor,
    Math.floor(trayWidth || zoomConfig.maxZoomFloor)
  )
  for (let size = baseWidth; size >= minZoom; size -= 1) {
    const gap = getGap(size)
    const padding = gap * 2
    const border = getBorder()
    if (size + padding + border <= baseWidth) {
      return size
    }
  }
  return minZoom
}

export const computeZoomForColumns = (
  trayWidth: number,
  targetColumns: number
) => {
  if (trayWidth <= 0 || targetColumns <= 0) return zoomConfig.minZoom
  const maxZoom = computeMaxZoom(trayWidth)
  let bestZoom: number = zoomConfig.minZoom
  let bestDelta = Number.POSITIVE_INFINITY
  for (
    let size = Math.floor(maxZoom);
    size >= zoomConfig.minZoom;
    size -= 1
  ) {
    const gap = getGap(size)
    const cell = Math.max(1, size + gap)
    const padding = gap
    const availableWidth = Math.max(0, trayWidth - padding * 2)
    const maxColumns = Math.max(1, Math.floor((availableWidth + gap) / cell))
    const columns = maxColumns < minSquareColumns ? 1 : maxColumns
    const delta = Math.abs(columns - targetColumns)
    if (delta < bestDelta) {
      bestDelta = delta
      bestZoom = size
    }
    if (columns === targetColumns) {
      return size
    }
  }
  return bestZoom
}

type GridMetricsCore = {
  gap: number
  cell: number
  padding: number
  availableHeight: number
  columns: number
  maxRows: number
}

const computeGridMetrics = (
  zoom: number,
  trayWidth: number,
  trayHeight: number,
  resultsTop: number,
  gapOverride?: number
): GridMetricsCore => {
  const gap = gapOverride ?? getGap(zoom)
  const cell = Math.max(1, zoom + gap)
  const padding = gap
  const availableWidth = Math.max(0, trayWidth - padding * 2)
  const availableHeight = Math.max(
    0,
    trayHeight - resultsTop - padding - paddingBottom
  )
  const maxColumns = Math.max(1, Math.floor((availableWidth + gap) / cell))
  const columns = maxColumns < minSquareColumns ? 1 : maxColumns
  const maxRows = Math.max(0, Math.floor(availableHeight / cell))
  return { gap, cell, padding, availableHeight, columns, maxRows }
}

export type Layout = {
  gap: number
  cell: number
  padding: number
  availableHeight: number
  columns: number
  totalRows: number
  totalHeight: number
}

export const buildLayout = (
  zoom: number,
  totalResults: number,
  trayWidth: number,
  trayHeight: number,
  resultsTop: number,
  gapOverride?: number
): Layout => {
  const core = computeGridMetrics(zoom, trayWidth, trayHeight, resultsTop, gapOverride)
  let { columns } = core
  if (totalResults > 0 && core.maxRows > 0 && totalResults >= core.maxRows) {
    const minColumns = Math.max(1, Math.ceil(totalResults / core.maxRows))
    if (minColumns < columns) {
      columns = minColumns
    }
  }
  const totalRows = columns > 0 ? Math.ceil(totalResults / columns) : 0
  const totalHeight = Math.max(
    0,
    totalRows * core.cell + core.padding + paddingBottom
  )
  return {
    gap: core.gap,
    cell: core.cell,
    padding: core.padding,
    availableHeight: core.availableHeight,
    columns,
    totalRows,
    totalHeight,
  }
}

export type ViewMetrics = {
  gap: number
  cell: number
  padding: number
  availableHeight: number
  columns: number
  maxRows: number
  capacity: number
}

export const computeViewMetrics = (
  zoom: number,
  trayWidth: number,
  trayHeight: number,
  resultsTop: number,
  gapOverride?: number
): ViewMetrics => {
  const core = computeGridMetrics(zoom, trayWidth, trayHeight, resultsTop, gapOverride)
  const capacity = Math.max(0, core.columns * core.maxRows)
  return {
    gap: core.gap,
    cell: core.cell,
    padding: core.padding,
    availableHeight: core.availableHeight,
    columns: core.columns,
    maxRows: core.maxRows,
    capacity,
  }
}

export const roundNumber = (value: number, digits = 2) => {
  if (!Number.isFinite(value)) return 0
  if (digits <= 0) return Math.round(value)
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export const formatNumber = (value: number, digits = 2) => {
  if (!Number.isFinite(value)) return '0'
  if (digits <= 0) return Math.round(value).toString()
  return value.toFixed(digits)
}

export const boolLabel = (value: boolean) => (value ? '1' : '0')
