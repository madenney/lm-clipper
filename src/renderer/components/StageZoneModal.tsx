/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import stageGeometry, { ZONE_STAGE_IDS } from '../../constants/stageGeometry'
import { StageZoneBox } from '../../constants/types'
import '../styles/StageZoneModal.css'

type Target = string

// Generic per-stage map of named boxes. In 'zones' mode the keys are
// comboer/comboee; in 'edgeRects' mode they are edge/bz.
type ZoneMap = Record<number, Record<string, StageZoneBox>>

type ModeKey = 'zones' | 'edgeRects'

interface StageZoneModalProps {
  initialZones: ZoneMap
  initialStageId: number
  hasParser: boolean
  mode?: ModeKey
  onApply: (_zones: ZoneMap) => void
  onClose: () => void
}

const PAD = 28

type ModeConfig = {
  targets: [Target, Target]
  colors: Record<Target, { stroke: string; fill: string }>
  title: string
  // Draw the X-mirrored (left-side) copy of each box read-only. Edgeguard
  // rectangles are stored right-side only and mirrored at runtime.
  mirror: boolean
  label: (_t: Target, _hasParser: boolean) => string
}

const MODE_CONFIG: Record<ModeKey, ModeConfig> = {
  zones: {
    targets: ['comboer', 'comboee'],
    colors: {
      comboer: { stroke: '#4ea1ff', fill: 'rgba(78,161,255,0.22)' },
      comboee: { stroke: '#ff9d3d', fill: 'rgba(255,157,61,0.22)' },
    },
    title: 'Draw Position Zone',
    mirror: false,
    label: (t, hasParser) => {
      if (t === 'comboer') return hasParser ? 'Attacker' : 'Player 1'
      return hasParser ? 'Victim' : 'Player 2'
    },
  },
  edgeRects: {
    targets: ['edge', 'bz'],
    colors: {
      edge: { stroke: '#3cf', fill: 'rgba(60,200,255,0.18)' },
      bz: { stroke: '#f55', fill: 'rgba(255,80,80,0.12)' },
    },
    title: 'Edit Edgeguard Rectangles',
    mirror: true,
    label: (t) => (t === 'edge' ? 'Edge Region' : 'Blast Zone'),
  },
}

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
type Handle = (typeof HANDLES)[number]
const HANDLE_CURSOR: Record<Handle, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
}

// Current pointer interaction (null when idle). Tracked in a ref; a render
// tick triggers the canvas redraw.
type Interaction =
  | {
      kind: 'draw'
      x0: number
      y0: number
      x1: number
      y1: number
      target: Target
    }
  | {
      kind: 'move'
      target: Target
      orig: StageZoneBox
      startWX: number
      startWY: number
      curWX: number
      curWY: number
    }
  | {
      kind: 'resize'
      target: Target
      handle: Handle
      orig: StageZoneBox
      curWX: number
      curWY: number
    }
  | {
      kind: 'pan'
      startX: number
      startY: number
      origOx: number
      origOy: number
    }

const cloneZones = (z: ZoneMap): ZoneMap => JSON.parse(JSON.stringify(z || {}))

const applyResize = (
  orig: StageZoneBox,
  handle: Handle,
  wx: number,
  wy: number,
): StageZoneBox => {
  let { xMin, xMax, yMin, yMax } = orig
  if (handle.includes('w')) xMin = wx
  if (handle.includes('e')) xMax = wx
  if (handle.includes('n')) yMax = wy // north = top = larger world-y
  if (handle.includes('s')) yMin = wy
  return {
    xMin: Math.round(Math.min(xMin, xMax)),
    xMax: Math.round(Math.max(xMin, xMax)),
    yMin: Math.round(Math.min(yMin, yMax)),
    yMax: Math.round(Math.max(yMin, yMax)),
  }
}

const normalizeBox = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
): StageZoneBox => ({
  xMin: Math.round(Math.min(ax, bx)),
  xMax: Math.round(Math.max(ax, bx)),
  yMin: Math.round(Math.min(ay, by)),
  yMax: Math.round(Math.max(ay, by)),
})

export default function StageZoneModal({
  initialZones,
  initialStageId,
  hasParser,
  mode = 'zones',
  onApply,
  onClose,
}: StageZoneModalProps) {
  const cfg = MODE_CONFIG[mode]
  const [zones, setZones] = useState<ZoneMap>(() => cloneZones(initialZones))
  const [stageId, setStageId] = useState<number>(
    stageGeometry[initialStageId] ? initialStageId : ZONE_STAGE_IDS[0],
  )
  const [target, setTarget] = useState<Target>(cfg.targets[0])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const interactionRef = useRef<Interaction | null>(null)
  const spaceRef = useRef(false)
  const [cursor, setCursor] = useState('crosshair')
  const [tick, setTick] = useState(0)
  const forceRender = () => setTick((n) => n + 1)

  // Canvas buffer size tracks the available drawing area (1:1 with CSS px so
  // mouse mapping stays exact). Measured from the wrapper via ResizeObserver.
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

  // ---- Camera (zoom + pan) ----------------------------------------------
  // Camera maps world → screen as: sx = ox + wx*scale, sy = oy - wy*scale.
  const computeFit = (g: typeof geo, w: number, h: number) => {
    const bz = g.blastzone
    const worldXMin = bz.left - 10
    const worldXMax = bz.right + 10
    const worldYMin = bz.bottom - 10
    const worldYMax = bz.top + 10
    const worldW = worldXMax - worldXMin
    const worldH = worldYMax - worldYMin
    const scale = Math.min((w - PAD * 2) / worldW, (h - PAD * 2) / worldH)
    const cx = (worldXMin + worldXMax) / 2
    const cy = (worldYMin + worldYMax) / 2
    return { scale, ox: w / 2 - cx * scale, oy: h / 2 + cy * scale }
  }

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

  const activeBox = zones[stageId]?.[target]

  const writeBox = useCallback(
    (t: Target, box: StageZoneBox | null) => {
      setZones((prev) => {
        const next = cloneZones(prev)
        const entry = { ...(next[stageId] || {}) }
        if (box) entry[t] = box
        else delete entry[t]
        if (cfg.targets.some((k) => entry[k])) next[stageId] = entry
        else delete next[stageId]
        return next
      })
    },
    [stageId, cfg],
  )
  const setActiveBox = useCallback(
    (box: StageZoneBox | null) => writeBox(target, box),
    [writeBox, target],
  )

  // ---- Hit testing (screen space) ---------------------------------------
  const boxScreen = (box: StageZoneBox) => {
    const x1 = transform.toX(box.xMin)
    const x2 = transform.toX(box.xMax)
    const y1 = transform.toY(box.yMax)
    const y2 = transform.toY(box.yMin)
    return {
      left: Math.min(x1, x2),
      right: Math.max(x1, x2),
      top: Math.min(y1, y2),
      bottom: Math.max(y1, y2),
    }
  }
  const handlePoints = (
    box: StageZoneBox,
  ): Record<Handle, [number, number]> => {
    const r = boxScreen(box)
    const mx = (r.left + r.right) / 2
    const my = (r.top + r.bottom) / 2
    return {
      nw: [r.left, r.top],
      n: [mx, r.top],
      ne: [r.right, r.top],
      e: [r.right, my],
      se: [r.right, r.bottom],
      s: [mx, r.bottom],
      sw: [r.left, r.bottom],
      w: [r.left, my],
    }
  }
  const HANDLE_HIT = 9
  const hitHandle = (
    px: number,
    py: number,
    box: StageZoneBox,
  ): Handle | null => {
    const pts = handlePoints(box)
    for (const h of HANDLES) {
      const [hx, hy] = pts[h]
      if (Math.abs(px - hx) <= HANDLE_HIT && Math.abs(py - hy) <= HANDLE_HIT)
        return h
    }
    return null
  }
  const insideBox = (px: number, py: number, box: StageZoneBox) => {
    const r = boxScreen(box)
    return px >= r.left && px <= r.right && py >= r.top && py <= r.bottom
  }

  // ---- Drawing -----------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { toX, toY } = transform

    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H)
    ctx.fillStyle = '#0f1117'
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)

    // Grid every 50 world units
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'
    const bz = geo.blastzone
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

    // Blast zone border
    ctx.strokeStyle = 'rgba(255,80,80,0.55)'
    ctx.setLineDash([5, 4])
    ctx.lineWidth = 1.5
    ctx.strokeRect(
      toX(bz.left),
      toY(bz.top),
      (bz.right - bz.left) * transform.scale,
      (bz.top - bz.bottom) * transform.scale,
    )
    ctx.setLineDash([])

    // Axes (x=0, y=0)
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(toX(0), toY(bz.bottom))
    ctx.lineTo(toX(0), toY(bz.top))
    ctx.moveTo(toX(bz.left), toY(0))
    ctx.lineTo(toX(bz.right), toY(0))
    ctx.stroke()

    // Ground platform
    const drawPlat = (
      xMin: number,
      xMax: number,
      y: number,
      thickness: number,
    ) => {
      ctx.fillStyle = '#3a4150'
      ctx.strokeStyle = '#5a6377'
      ctx.lineWidth = 1
      const px = toX(xMin)
      const py = toY(y)
      const pw = (xMax - xMin) * transform.scale
      ctx.fillRect(px, py, pw, thickness)
      ctx.strokeRect(px, py, pw, thickness)
    }
    drawPlat(geo.ground.xMin, geo.ground.xMax, geo.ground.y, 7)
    for (const plat of geo.platforms) drawPlat(plat.xMin, plat.xMax, plat.y, 4)

    // Ledge markers
    ctx.fillStyle = '#7ec8e3'
    for (const lx of [geo.ground.xMin, geo.ground.xMax]) {
      ctx.beginPath()
      ctx.arc(toX(lx), toY(geo.ground.y), 3, 0, Math.PI * 2)
      ctx.fill()
    }

    // Origin marker
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.font = '10px monospace'
    ctx.fillText('0,0', toX(0) + 4, toY(0) - 4)

    // Zone boxes
    const drawBox = (
      box: StageZoneBox,
      t: Target,
      isActive: boolean,
      withHandles: boolean,
    ) => {
      const c = cfg.colors[t]
      const x = toX(box.xMin)
      const y = toY(box.yMax)
      const w = (box.xMax - box.xMin) * transform.scale
      const h = (box.yMax - box.yMin) * transform.scale
      ctx.fillStyle = c.fill
      ctx.fillRect(x, y, w, h)
      ctx.strokeStyle = c.stroke
      ctx.lineWidth = isActive ? 2 : 1
      ctx.setLineDash(isActive ? [] : [4, 3])
      ctx.strokeRect(x, y, w, h)
      ctx.setLineDash([])
      if (withHandles) {
        const pts = handlePoints(box)
        ctx.fillStyle = c.stroke
        for (const hh of HANDLES) {
          const [hx, hy] = pts[hh]
          ctx.fillRect(hx - 4, hy - 4, 8, 8)
        }
      }
    }

    // Faint read-only mirror of a box across x=0 (edge-rect mode only).
    const drawMirror = (box: StageZoneBox, t: Target) => {
      const c = cfg.colors[t]
      const x = toX(-box.xMax)
      const y = toY(box.yMax)
      const w = (box.xMax - box.xMin) * transform.scale
      const h = (box.yMax - box.yMin) * transform.scale
      ctx.save()
      ctx.globalAlpha = 0.4
      ctx.fillStyle = c.fill
      ctx.fillRect(x, y, w, h)
      ctx.strokeStyle = c.stroke
      ctx.lineWidth = 1
      ctx.setLineDash([3, 3])
      ctx.strokeRect(x, y, w, h)
      ctx.restore()
    }

    const it = interactionRef.current
    const liveTarget = it && it.kind !== 'pan' ? it.target : null
    const entry = zones[stageId]
    // Draw stored boxes (skip the one being interacted with — it's redrawn live)
    ;([cfg.targets[1], cfg.targets[0]] as Target[]).forEach((t) => {
      const box = entry?.[t]
      if (box && cfg.mirror) drawMirror(box, t)
      if (t === liveTarget) return
      if (box) drawBox(box, t, t === target, t === target)
    })
    // Live interaction box
    if (it && it.kind === 'draw') {
      drawBox(normalizeBox(it.x0, it.y0, it.x1, it.y1), it.target, true, false)
    } else if (it && it.kind === 'move') {
      const dx = it.curWX - it.startWX
      const dy = it.curWY - it.startWY
      const b = it.orig
      drawBox(
        {
          xMin: b.xMin + dx,
          xMax: b.xMax + dx,
          yMin: b.yMin + dy,
          yMax: b.yMax + dy,
        },
        it.target,
        true,
        true,
      )
    } else if (it && it.kind === 'resize') {
      drawBox(
        applyResize(it.orig, it.handle, it.curWX, it.curWY),
        it.target,
        true,
        true,
      )
    }
  }, [transform, geo, zones, stageId, target, tick, CANVAS_W, CANVAS_H])

  // ---- Pointer mapping ---------------------------------------------------
  const eventToScreen = (e: React.MouseEvent) => {
    const canvas = canvasRef.current
    if (!canvas) return { px: 0, py: 0 }
    const rect = canvas.getBoundingClientRect()
    return {
      px: ((e.clientX - rect.left) / rect.width) * CANVAS_W,
      py: ((e.clientY - rect.top) / rect.height) * CANVAS_H,
    }
  }
  const eventToWorld = (e: React.MouseEvent) => {
    const { px, py } = eventToScreen(e)
    return { wx: transform.fromX(px), wy: transform.fromY(py) }
  }

  const updateHoverCursor = (e: React.MouseEvent) => {
    if (spaceRef.current) {
      setCursor('grab')
      return
    }
    const { px, py } = eventToScreen(e)
    if (activeBox) {
      const h = hitHandle(px, py, activeBox)
      if (h) {
        setCursor(HANDLE_CURSOR[h])
        return
      }
      if (insideBox(px, py, activeBox)) {
        setCursor('move')
        return
      }
    }
    const otherT: Target =
      target === cfg.targets[0] ? cfg.targets[1] : cfg.targets[0]
    const ob = zones[stageId]?.[otherT]
    if (ob && insideBox(px, py, ob)) {
      setCursor('move')
      return
    }
    setCursor('crosshair')
  }

  // ---- Mouse handling ----------------------------------------------------
  const onMouseDown = (e: React.MouseEvent) => {
    const { px, py } = eventToScreen(e)
    const { wx, wy } = eventToWorld(e)
    // Pan: middle mouse, or Space + left
    if (e.button === 1 || (e.button === 0 && spaceRef.current)) {
      interactionRef.current = {
        kind: 'pan',
        startX: px,
        startY: py,
        origOx: camera.ox,
        origOy: camera.oy,
      }
      setCursor('grabbing')
      forceRender()
      return
    }
    if (e.button !== 0) return
    // Resize/move the active box
    if (activeBox) {
      const h = hitHandle(px, py, activeBox)
      if (h) {
        interactionRef.current = {
          kind: 'resize',
          target,
          handle: h,
          orig: activeBox,
          curWX: wx,
          curWY: wy,
        }
        forceRender()
        return
      }
      if (insideBox(px, py, activeBox)) {
        interactionRef.current = {
          kind: 'move',
          target,
          orig: activeBox,
          startWX: wx,
          startWY: wy,
          curWX: wx,
          curWY: wy,
        }
        forceRender()
        return
      }
    }
    // Click inside the other player's box → grab and move it
    const otherT: Target =
      target === cfg.targets[0] ? cfg.targets[1] : cfg.targets[0]
    const otherBox = zones[stageId]?.[otherT]
    if (otherBox && insideBox(px, py, otherBox)) {
      setTarget(otherT)
      interactionRef.current = {
        kind: 'move',
        target: otherT,
        orig: otherBox,
        startWX: wx,
        startWY: wy,
        curWX: wx,
        curWY: wy,
      }
      forceRender()
      return
    }
    // Else draw a new box for the active target
    interactionRef.current = {
      kind: 'draw',
      x0: wx,
      y0: wy,
      x1: wx,
      y1: wy,
      target,
    }
    forceRender()
  }

  const onMouseMove = (e: React.MouseEvent) => {
    const it = interactionRef.current
    if (!it) {
      updateHoverCursor(e)
      return
    }
    if (it.kind === 'pan') {
      const { px, py } = eventToScreen(e)
      setCamera((c) => ({
        ...c,
        ox: it.origOx + (px - it.startX),
        oy: it.origOy + (py - it.startY),
      }))
      return
    }
    const { wx, wy } = eventToWorld(e)
    if (it.kind === 'draw') {
      it.x1 = wx
      it.y1 = wy
    } else {
      it.curWX = wx
      it.curWY = wy
    }
    forceRender()
  }

  const commitInteraction = () => {
    const it = interactionRef.current
    if (!it) return
    interactionRef.current = null
    if (it.kind === 'pan') {
      setCursor('crosshair')
      forceRender()
      return
    }
    if (it.kind === 'draw') {
      if (Math.abs(it.x1 - it.x0) < 1 && Math.abs(it.y1 - it.y0) < 1) {
        forceRender()
        return
      }
      writeBox(it.target, normalizeBox(it.x0, it.y0, it.x1, it.y1))
      return
    }
    if (it.kind === 'move') {
      const dx = it.curWX - it.startWX
      const dy = it.curWY - it.startWY
      const b = it.orig
      writeBox(it.target, {
        xMin: Math.round(b.xMin + dx),
        xMax: Math.round(b.xMax + dx),
        yMin: Math.round(b.yMin + dy),
        yMax: Math.round(b.yMax + dy),
      })
      return
    }
    // resize
    writeBox(it.target, applyResize(it.orig, it.handle, it.curWX, it.curWY))
  }

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
        if (!interactionRef.current) setCursor('crosshair')
      }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
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

  const patchBox = (field: keyof StageZoneBox, raw: string) => {
    if (raw !== '' && !/^-?\d*$/.test(raw)) return
    const n = parseInt(raw, 10)
    const base: StageZoneBox = activeBox || {
      xMin: 0,
      xMax: 0,
      yMin: 0,
      yMax: 0,
    }
    setActiveBox({ ...base, [field]: Number.isNaN(n) ? 0 : n })
  }

  const applyToAllStages = () => {
    if (!activeBox) return
    setZones((prev) => {
      const next = cloneZones(prev)
      for (const sid of ZONE_STAGE_IDS) {
        const entry = { ...(next[sid] || {}) }
        entry[target] = { ...activeBox }
        next[sid] = entry
      }
      return next
    })
  }

  const targetLabel = (t: Target) => cfg.label(t, hasParser)

  // Count stages with at least one box (for the footer summary)
  const stageHasBox = (sid: number) => cfg.targets.some((t) => zones[sid]?.[t])
  const zonedStageCount = ZONE_STAGE_IDS.filter(stageHasBox).length

  return (
    <div className="szm-overlay" onClick={onClose}>
      <div className="szm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="szm-header">
          <span className="szm-title">{cfg.title}</span>
          <button type="button" className="szm-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="szm-body">
          {/* Stage tabs */}
          <div className="szm-stage-tabs">
            {ZONE_STAGE_IDS.map((sid) => {
              const has = stageHasBox(sid)
              return (
                <button
                  key={sid}
                  type="button"
                  className={`szm-stage-tab${sid === stageId ? ' szm-stage-tab-active' : ''}${has ? ' szm-stage-tab-set' : ''}`}
                  onClick={() => setStageId(sid)}
                >
                  {stageGeometry[sid].name}
                  {has && <span className="szm-stage-dot" />}
                </button>
              )
            })}
          </div>

          <div className="szm-main">
            <div className="szm-canvas-wrap" ref={wrapRef}>
              <canvas
                ref={canvasRef}
                width={CANVAS_W}
                height={CANVAS_H}
                className="szm-canvas"
                style={{ cursor }}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={commitInteraction}
                onMouseLeave={commitInteraction}
                onDoubleClick={resetView}
                onContextMenu={(e) => e.preventDefault()}
              />
            </div>

            <div className="szm-side">
              {/* Player target toggle */}
              <div className="szm-target-toggle">
                {cfg.targets.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`szm-target-btn${t === target ? ' szm-target-btn-active' : ''}`}
                    style={
                      t === target
                        ? {
                            borderColor: cfg.colors[t].stroke,
                            color: cfg.colors[t].stroke,
                          }
                        : undefined
                    }
                    onClick={() => setTarget(t)}
                  >
                    <span
                      className="szm-swatch"
                      style={{ background: cfg.colors[t].stroke }}
                    />
                    {targetLabel(t)}
                  </button>
                ))}
              </div>

              <div className="szm-hint">
                Drag empty space to draw the {targetLabel(target)} zone. Drag a
                box to move it, drag its handles to resize.
                <br />
                Scroll to zoom · Space-drag or middle-drag to pan · double-click
                to reset view.
              </div>

              {/* Numeric readout / nudge */}
              <div className="szm-coords">
                {(
                  [
                    ['xMin', 'X min'],
                    ['xMax', 'X max'],
                    ['yMin', 'Y min'],
                    ['yMax', 'Y max'],
                  ] as [keyof StageZoneBox, string][]
                ).map(([field, label]) => (
                  <label key={field} className="szm-coord">
                    <span>{label}</span>
                    <input
                      inputMode="numeric"
                      value={activeBox ? String(activeBox[field]) : ''}
                      placeholder="—"
                      onChange={(e) => patchBox(field, e.target.value)}
                    />
                  </label>
                ))}
              </div>

              <div className="szm-side-actions">
                <button
                  type="button"
                  className="szm-btn"
                  onClick={resetView}
                  title="Reset zoom and pan to fit the stage"
                >
                  Reset view
                </button>
                <button
                  type="button"
                  className="szm-btn"
                  disabled={!activeBox}
                  onClick={() => setActiveBox(null)}
                >
                  Clear zone
                </button>
                <button
                  type="button"
                  className="szm-btn"
                  disabled={!activeBox}
                  onClick={applyToAllStages}
                  title="Copy this box to every stage for this player"
                >
                  Apply to all stages
                </button>
              </div>

              {geo.note && <div className="szm-note">⚠ {geo.note}</div>}
            </div>
          </div>
        </div>

        <div className="szm-footer">
          <span className="szm-footer-summary">
            {zonedStageCount === 0
              ? 'No zones set'
              : `Zones set on ${zonedStageCount} stage${zonedStageCount === 1 ? '' : 's'}`}
          </span>
          <div className="szm-footer-actions">
            <button type="button" className="szm-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="szm-btn szm-btn-primary"
              onClick={() => onApply(zones)}
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
