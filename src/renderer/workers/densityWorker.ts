/// <reference lib="webworker" />
import { zoomConfig } from '../zoomConfig'
import {
  hexToUint32,
  resolveStageColorHex as resolveStageColorHexBase,
  resolveStageColorUint as resolveStageColorUintBase,
} from '../lib/colorUtils'

type DrawPayload = {
  type: 'draw'
  width: number
  height: number
  columns: number
  cell: number
  padding: number
  scrollOffset: number
  offset: number
  limit: number
  total: number
  densityStride: number
}

type DataPayload = {
  type: 'data'
  offset: number
  limit: number
  stageIds: Int32Array
}

type InitPayload = {
  type: 'init'
  canvas: OffscreenCanvas
}

type WorkerMessage = DrawPayload | DataPayload | InitPayload

let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null

const stageColorHexCache = new Map<number, string>()
const stageColorUintCache = new Map<number, number>()
const paletteHex = Object.values(zoomConfig.stageSolidColors)
const palette = paletteHex.map((color) => hexToUint32(color))
const paletteLength = palette.length

let cachedStageIds: Int32Array | null = null
let cachedRange = { offset: 0, limit: 0 }

let isDrawing = false
let pendingDraw: DrawPayload | null = null
const perfLogThresholdMs = 8

function resolveStageColorHex(stageId: number) {
  return resolveStageColorHexBase(stageId, paletteHex, stageColorHexCache)
}

function resolveStageColorUint(stageId: number) {
  return resolveStageColorUintBase(stageId, paletteHex, stageColorHexCache, stageColorUintCache)
}

function drawDensity(payload: DrawPayload) {
  if (!canvas || !ctx) return

  const width = Math.max(0, Math.floor(payload.width))
  const height = Math.max(0, Math.floor(payload.height))
  if (width === 0 || height === 0) {
    ctx.clearRect(0, 0, width, height)
    return { count: 0, columns: 0, cell: 0, reason: 'empty' }
  }

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }

  const { columns, cell, padding, scrollOffset, offset, total } = payload
  const limit = Math.max(0, Math.min(payload.limit, total - offset))
  if (columns <= 0 || limit <= 0) {
    ctx.clearRect(0, 0, width, height)
    return { count: 0, columns, cell: Math.round(cell), reason: 'empty' }
  }

  const hasMatchingRange =
    cachedStageIds &&
    cachedRange.offset === offset &&
    cachedRange.limit >= limit
  const stageIds = hasMatchingRange ? cachedStageIds : null

  ctx.clearRect(0, 0, width, height)
  ctx.imageSmoothingEnabled = false

  const cellSize = Math.max(1, Math.round(cell))

  if (cellSize === 1) {
    const image = ctx.createImageData(width, height)
    const buffer = new Uint32Array(image.data.buffer)
    const baseY = Math.floor(scrollOffset)
    const basePadding = Math.floor(padding)
    const stride = payload.densityStride || 1

    for (let i = 0; i < limit; i += 1) {
      const index = offset + i
      const row = Math.floor(index / columns)
      const col = index - row * columns
      const x = basePadding + col
      const y = basePadding + row - baseY
      if (x < 0 || x >= width || y < 0 || y >= height) continue
      const stageId = stageIds ? stageIds[i] : -1
      const color =
        typeof stageId === 'number' && stageId >= 0
          ? resolveStageColorUint(stageId)
          : paletteLength > 0
          ? palette[Math.floor(index * stride) % paletteLength]
          : 0xff333333
      buffer[y * width + x] = color
    }

    ctx.putImageData(image, 0, 0)
    return { count: limit, columns, cell: cellSize }
  }

  for (let i = 0; i < limit; i += 1) {
    const index = offset + i
    const row = Math.floor(index / columns)
    const col = index - row * columns
    const x = Math.floor(padding + col * cellSize)
    const y = Math.floor(padding + row * cellSize - scrollOffset)
    if (x > width || y > height || x + cellSize < 0 || y + cellSize < 0) {
      continue
    }
    const stageId = stageIds ? stageIds[i] : -1
    ctx.fillStyle =
      typeof stageId === 'number' && stageId >= 0
        ? resolveStageColorHex(stageId)
        : paletteHex.length
        ? paletteHex[Math.floor(index * payload.densityStride) % paletteHex.length]
        : '#333333'
    ctx.fillRect(x, y, cellSize, cellSize)
  }
  return { count: limit, columns, cell: cellSize }
}

function queueDraw(payload: DrawPayload) {
  if (isDrawing) {
    pendingDraw = payload
    return
  }
  isDrawing = true
  const drawStart = performance.now()
  const meta = drawDensity(payload)
  const drawDuration = performance.now() - drawStart
  if (meta && drawDuration >= perfLogThresholdMs) {
    self.postMessage({
      type: 'perf',
      name: 'density_draw',
      durationMs: drawDuration,
      meta,
    })
  }
  isDrawing = false
  if (pendingDraw) {
    const next = pendingDraw
    pendingDraw = null
    queueDraw(next)
  }
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const payload = event.data
  if (payload.type === 'init') {
    canvas = payload.canvas
    ctx = canvas.getContext('2d')
    return
  }
  if (payload.type === 'data') {
    cachedStageIds = payload.stageIds
    cachedRange = { offset: payload.offset, limit: payload.limit }
    return
  }
  if (payload.type === 'draw') {
    if (!ctx) return
    queueDraw(payload)
  }
}
