import { useState, useRef, useEffect, useMemo } from 'react'
import stageGeometry from '../../constants/stageGeometry'

// Shared pieces of the stage-zone editors (StageZoneModal, EdgeguardZoneModal):
// canvas sizing, camera (zoom + pan), keyboard/wheel handling and the common
// stage drawing.

export const PAD = 28

export type StageGeo = (typeof stageGeometry)[number]

// Camera maps world -> screen as: sx = ox + wx*scale, sy = oy - wy*scale.
export const computeFit = (g: StageGeo, w: number, h: number) => {
  const bz = g.blastzone
  const worldXMin = bz.left - 10
  const worldXMax = bz.right + 10
  const worldYMin = bz.bottom - 10
  const worldYMax = bz.top + 10
  const scale = Math.min(
    (w - PAD * 2) / (worldXMax - worldXMin),
    (h - PAD * 2) / (worldYMax - worldYMin),
  )
  const cx = (worldXMin + worldXMax) / 2
  const cy = (worldYMin + worldYMax) / 2
  return { scale, ox: w / 2 - cx * scale, oy: h / 2 + cy * scale }
}

/**
 * Canvas size (1:1 with CSS px, measured from the wrapper), camera, cursor,
 * Escape / Space-pan keys and wheel zoom for a zone editor.
 */
export function useZoneViewport(
  stageId: number,
  idleCursor: string,
  onClose: () => void,
  interactionRef: { current: unknown },
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const spaceRef = useRef(false)
  const [cursor, setCursor] = useState(idleCursor)

  const wrapRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 900, h: 620 })
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return undefined
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      setSize({
        w: Math.max(300, Math.floor(r.width)),
        h: Math.max(200, Math.floor(r.height)),
      })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const CANVAS_W = size.w
  const CANVAS_H = size.h

  const geo = stageGeometry[stageId]

  const [camera, setCamera] = useState(() => computeFit(geo, size.w, size.h))
  // Refit when the stage or canvas size changes.
  useEffect(() => {
    setCamera(computeFit(geo, CANVAS_W, CANVAS_H))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageId, CANVAS_W, CANVAS_H])

  const transform = useMemo(() => {
    const { scale, ox, oy } = camera
    return {
      scale,
      toX: (wx: number) => ox + wx * scale,
      toY: (wy: number) => oy - wy * scale,
      fromX: (px: number) => (px - ox) / scale,
      fromY: (py: number) => (oy - py) / scale,
    }
  }, [camera])

  const resetView = () => setCamera(computeFit(geo, CANVAS_W, CANVAS_H))

  // Close on Escape; Space holds pan mode
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.code === 'Space') {
        const tag = (e.target as HTMLElement)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        e.preventDefault()
        spaceRef.current = true
        if (!interactionRef.current) setCursor('grab')
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceRef.current = false
        if (!interactionRef.current) setCursor(idleCursor)
      }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose])

  // Wheel to zoom toward the cursor (native listener so we can preventDefault).
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const px = ((e.clientX - rect.left) / rect.width) * CANVAS_W
      const py = ((e.clientY - rect.top) / rect.height) * CANVAS_H
      setCamera((c) => {
        const factor = Math.exp(-e.deltaY * 0.0015)
        const newScale = Math.min(Math.max(c.scale * factor, 0.05), 100)
        // Keep the world point under the cursor fixed.
        const wx = (px - c.ox) / c.scale
        const wy = (c.oy - py) / c.scale
        return {
          scale: newScale,
          ox: px - wx * newScale,
          oy: py + wy * newScale,
        }
      })
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [CANVAS_W, CANVAS_H])

  return {
    canvasRef,
    wrapRef,
    spaceRef,
    cursor,
    setCursor,
    CANVAS_W,
    CANVAS_H,
    geo,
    camera,
    setCamera,
    transform,
    resetView,
  }
}

export type ZoneTransform = ReturnType<typeof useZoneViewport>['transform']

/** Dark background plus the 50-unit world grid. */
export function drawBackdropAndGrid(
  ctx: CanvasRenderingContext2D,
  t: ZoneTransform,
  geo: StageGeo,
  w: number,
  h: number,
) {
  const { toX, toY } = t
  const bz = geo.blastzone
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = '#0f1117'
  ctx.fillRect(0, 0, w, h)

  // Grid every 50 world units
  ctx.lineWidth = 1
  ctx.strokeStyle = 'rgba(255,255,255,0.05)'
  for (let gx = 0; gx <= bz.right; gx += 50) {
    for (const sx of gx === 0 ? [0] : [gx, -gx]) {
      ctx.beginPath()
      ctx.moveTo(toX(sx), toY(bz.bottom))
      ctx.lineTo(toX(sx), toY(bz.top))
      ctx.stroke()
    }
  }
  for (let gy = Math.ceil(bz.bottom / 50) * 50; gy <= bz.top; gy += 50) {
    ctx.beginPath()
    ctx.moveTo(toX(bz.left), toY(gy))
    ctx.lineTo(toX(bz.right), toY(gy))
    ctx.stroke()
  }
}

/** Dashed blast zone border. */
export function drawBlastBorder(
  ctx: CanvasRenderingContext2D,
  t: ZoneTransform,
  geo: StageGeo,
) {
  const bz = geo.blastzone
  ctx.strokeStyle = 'rgba(255,80,80,0.55)'
  ctx.setLineDash([5, 4])
  ctx.lineWidth = 1.5
  ctx.strokeRect(
    t.toX(bz.left),
    t.toY(bz.top),
    (bz.right - bz.left) * t.scale,
    (bz.top - bz.bottom) * t.scale,
  )
  ctx.setLineDash([])
}

/** Axes (x=0, y=0). */
export function drawAxes(
  ctx: CanvasRenderingContext2D,
  t: ZoneTransform,
  geo: StageGeo,
) {
  const bz = geo.blastzone
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(t.toX(0), t.toY(bz.bottom))
  ctx.lineTo(t.toX(0), t.toY(bz.top))
  ctx.moveTo(t.toX(bz.left), t.toY(0))
  ctx.lineTo(t.toX(bz.right), t.toY(0))
  ctx.stroke()
}

/** Ground and platforms. */
export function drawStagePlatforms(
  ctx: CanvasRenderingContext2D,
  t: ZoneTransform,
  geo: StageGeo,
) {
  const drawPlat = (xMin: number, xMax: number, y: number, th: number) => {
    ctx.fillStyle = '#3a4150'
    ctx.strokeStyle = '#5a6377'
    ctx.lineWidth = 1
    const px = t.toX(xMin)
    const py = t.toY(y)
    const pw = (xMax - xMin) * t.scale
    ctx.fillRect(px, py, pw, th)
    ctx.strokeRect(px, py, pw, th)
  }
  drawPlat(geo.ground.xMin, geo.ground.xMax, geo.ground.y, 7)
  for (const plat of geo.platforms) drawPlat(plat.xMin, plat.xMax, plat.y, 4)
}
