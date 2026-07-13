/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import { useState, useRef, useEffect, useMemo } from 'react'
import stageGeometry, {
  ZONE_STAGE_IDS,
  DEFAULT_OFFSTAGE_BUFFER,
  LIP_BUFFER,
} from '../../constants/stageGeometry'
import '../styles/StageZoneModal.css'

interface EdgeguardZoneModalProps {
  initialBuffer: number
  onApply: (_offstageBuffer: number) => void
  onClose: () => void
}

const PAD = 28
const MIN_BUFFER = 0
const MAX_BUFFER = 30
const GRAB_PX = 7

const COLOR = {
  stageEnd: '#7ec8e3', // libmelee EDGE_GROUND_POSITION — last standable x
  ledgeGrab: '#5ae08a', // libmelee EDGE_POSITION — where you hang on the ledge
  lip: '#8f7ee3', // the stage surface
  blast: '#f55', // libmelee BLASTZONES
  offstage: '#3cf', // the one knob
}

const clampBuffer = (n: number) =>
  Math.min(MAX_BUFFER, Math.max(MIN_BUFFER, Math.round(n * 2) / 2))

type Interaction =
  | { kind: 'dragLine' }
  | {
      kind: 'pan'
      startX: number
      startY: number
      origOx: number
      origOy: number
    }

export default function EdgeguardZoneModal({
  initialBuffer,
  onApply,
  onClose,
}: EdgeguardZoneModalProps) {
  const [buffer, setBuffer] = useState<number>(() =>
    clampBuffer(
      Number.isFinite(initialBuffer) ? initialBuffer : DEFAULT_OFFSTAGE_BUFFER,
    ),
  )
  const [stageId, setStageId] = useState<number>(ZONE_STAGE_IDS[0])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const interactionRef = useRef<Interaction | null>(null)
  const spaceRef = useRef(false)
  const [cursor, setCursor] = useState('default')
  const [, setTick] = useState(0)
  const forceRender = () => setTick((n) => n + 1)

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
  const stageEnd = geo.ground.xMax // last standable x
  const ledge = geo.ledgeGrab // where you hang on the ledge (the ruler)
  const lipY = geo.ground.y - LIP_BUFFER
  const offstageX = stageEnd - buffer

  const computeFit = (g: typeof geo, w: number, h: number) => {
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

  const [camera, setCamera] = useState(() => computeFit(geo, size.w, size.h))
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

  // ---- Drawing -----------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { toX, toY } = transform
    const bz = geo.blastzone

    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H)
    ctx.fillStyle = '#0f1117'
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)

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

    // Shade the offstage region on both sides — what the knob actually controls
    ctx.fillStyle = 'rgba(60,200,255,0.10)'
    ctx.fillRect(
      toX(offstageX),
      toY(bz.top),
      (bz.right - offstageX) * transform.scale,
      (bz.top - bz.bottom) * transform.scale,
    )
    ctx.fillRect(
      toX(bz.left),
      toY(bz.top),
      (-offstageX - bz.left) * transform.scale,
      (bz.top - bz.bottom) * transform.scale,
    )
    // ...and below the lip, which is also offstage
    ctx.fillRect(
      toX(bz.left),
      toY(lipY),
      (bz.right - bz.left) * transform.scale,
      (lipY - bz.bottom) * transform.scale,
    )

    // Blast zone border (Melee fact)
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

    // Top blast zone emphasised — the parser reads this one
    ctx.strokeStyle = COLOR.blast
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(toX(bz.left), toY(bz.top))
    ctx.lineTo(toX(bz.right), toY(bz.top))
    ctx.stroke()

    // Axes
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(toX(0), toY(bz.bottom))
    ctx.lineTo(toX(0), toY(bz.top))
    ctx.moveTo(toX(bz.left), toY(0))
    ctx.lineTo(toX(bz.right), toY(0))
    ctx.stroke()

    // Stage + platforms
    const drawPlat = (xMin: number, xMax: number, y: number, th: number) => {
      ctx.fillStyle = '#3a4150'
      ctx.strokeStyle = '#5a6377'
      ctx.lineWidth = 1
      const px = toX(xMin)
      const py = toY(y)
      const pw = (xMax - xMin) * transform.scale
      ctx.fillRect(px, py, pw, th)
      ctx.strokeRect(px, py, pw, th)
    }
    drawPlat(geo.ground.xMin, geo.ground.xMax, geo.ground.y, 7)
    for (const plat of geo.platforms) drawPlat(plat.xMin, plat.xMax, plat.y, 4)

    const label = (text: string, px: number, py: number, color: string) => {
      ctx.fillStyle = color
      ctx.font = '10px monospace'
      ctx.fillText(text, px, py)
    }

    // Stage lip (Melee fact + fixed margin) — horizontal, read-only
    ctx.strokeStyle = COLOR.lip
    ctx.setLineDash([2, 4])
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(toX(bz.left), toY(lipY))
    ctx.lineTo(toX(bz.right), toY(lipY))
    ctx.stroke()
    ctx.setLineDash([])

    // Stage edge — last standable x (libmelee EDGE_GROUND_POSITION), read-only
    ctx.strokeStyle = COLOR.stageEnd
    ctx.lineWidth = 2
    for (const lx of [stageEnd, -stageEnd]) {
      ctx.beginPath()
      ctx.moveTo(toX(lx), toY(bz.top))
      ctx.lineTo(toX(lx), toY(bz.bottom))
      ctx.stroke()
    }

    // Ledge-grab point (libmelee EDGE_POSITION) — the ruler, read-only
    ctx.strokeStyle = COLOR.ledgeGrab
    ctx.lineWidth = 2
    ctx.setLineDash([6, 3])
    for (const lx of [ledge, -ledge]) {
      ctx.beginPath()
      ctx.moveTo(toX(lx), toY(bz.top))
      ctx.lineTo(toX(lx), toY(bz.bottom))
      ctx.stroke()
    }
    ctx.setLineDash([])
    ctx.fillStyle = COLOR.ledgeGrab
    for (const lx of [ledge, -ledge]) {
      ctx.beginPath()
      ctx.arc(toX(lx), toY(geo.ground.y), 3.5, 0, Math.PI * 2)
      ctx.fill()
    }

    // The offstage line — the only draggable thing. Solid on the right (the
    // handle), dashed on the left (mirrored, read-only).
    ctx.strokeStyle = COLOR.offstage
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.moveTo(toX(offstageX), toY(bz.top))
    ctx.lineTo(toX(offstageX), toY(bz.bottom))
    ctx.stroke()
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(toX(-offstageX), toY(bz.top))
    ctx.lineTo(toX(-offstageX), toY(bz.bottom))
    ctx.stroke()
    ctx.setLineDash([])

    // Grip marks on the draggable line
    ctx.fillStyle = COLOR.offstage
    for (const gy of [0.35, 0.5, 0.65]) {
      const py = toY(bz.top) + (toY(bz.bottom) - toY(bz.top)) * gy
      ctx.fillRect(toX(offstageX) - 3, py - 10, 6, 20)
    }

    // Buffer span: offstage line → stage edge (that's what the buffer measures)
    const midY = toY(geo.ground.y) + 46
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(toX(offstageX), midY)
    ctx.lineTo(toX(stageEnd), midY)
    ctx.stroke()
    label(
      `${buffer}`,
      (toX(offstageX) + toX(stageEnd)) / 2 - 8,
      midY - 5,
      'rgba(255,255,255,0.75)',
    )

    label('offstage line', toX(offstageX) + 5, toY(bz.top) + 14, COLOR.offstage)
    label('stage edge', toX(stageEnd) + 5, toY(bz.top) + 30, COLOR.stageEnd)
    label('ledge grab', toX(ledge) + 5, toY(bz.top) + 46, COLOR.ledgeGrab)
    label('lip', toX(bz.left) + 6, toY(lipY) - 4, COLOR.lip)
    label('top blast zone', toX(0) + 6, toY(bz.top) + 14, COLOR.blast)
    label('0,0', toX(0) + 4, toY(0) - 4, 'rgba(255,255,255,0.5)')
  }, [transform, geo, buffer, offstageX, ledge, lipY, CANVAS_W, CANVAS_H])

  // ---- Pointer -----------------------------------------------------------
  const eventToScreen = (e: React.MouseEvent) => {
    const canvas = canvasRef.current
    if (!canvas) return { px: 0, py: 0 }
    const rect = canvas.getBoundingClientRect()
    return {
      px: ((e.clientX - rect.left) / rect.width) * CANVAS_W,
      py: ((e.clientY - rect.top) / rect.height) * CANVAS_H,
    }
  }

  // The line is grabbable on either side; both map to the same buffer.
  const overLine = (px: number) =>
    Math.abs(px - transform.toX(offstageX)) <= GRAB_PX ||
    Math.abs(px - transform.toX(-offstageX)) <= GRAB_PX

  const bufferFromPointer = (px: number) =>
    clampBuffer(stageEnd - Math.abs(transform.fromX(px)))

  const onMouseDown = (e: React.MouseEvent) => {
    const { px, py } = eventToScreen(e)
    if (e.button === 1 || (e.button === 0 && spaceRef.current)) {
      interactionRef.current = {
        kind: 'pan',
        startX: px,
        startY: py,
        origOx: camera.ox,
        origOy: camera.oy,
      }
      setCursor('grabbing')
      return
    }
    if (e.button !== 0) return
    if (overLine(px)) {
      interactionRef.current = { kind: 'dragLine' }
      setBuffer(bufferFromPointer(px))
      forceRender()
    }
  }

  const onMouseMove = (e: React.MouseEvent) => {
    const it = interactionRef.current
    const { px, py } = eventToScreen(e)
    if (!it) {
      if (spaceRef.current) setCursor('grab')
      else setCursor(overLine(px) ? 'ew-resize' : 'default')
      return
    }
    if (it.kind === 'pan') {
      setCamera((c) => ({
        ...c,
        ox: it.origOx + (px - it.startX),
        oy: it.origOy + (py - it.startY),
      }))
      return
    }
    setBuffer(bufferFromPointer(px))
  }

  const endInteraction = () => {
    if (interactionRef.current?.kind === 'pan') setCursor('default')
    interactionRef.current = null
  }

  const resetView = () => setCamera(computeFit(geo, CANVAS_W, CANVAS_H))

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
        if (!interactionRef.current) setCursor('default')
      }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [onClose])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const px = ((e.clientX - rect.left) / rect.width) * CANVAS_W
      const py = ((e.clientY - rect.top) / rect.height) * CANVAS_H
      setCamera((c) => {
        const newScale = Math.min(
          Math.max(c.scale * Math.exp(-e.deltaY * 0.0015), 0.05),
          100,
        )
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

  return (
    <div className="szm-overlay" onClick={onClose}>
      <div className="szm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="szm-header">
          <span className="szm-title">Offstage Line</span>
          <button type="button" className="szm-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="szm-body">
          <div className="szm-stage-tabs">
            {ZONE_STAGE_IDS.map((sid) => (
              <button
                key={sid}
                type="button"
                className={`szm-stage-tab${sid === stageId ? ' szm-stage-tab-active' : ''}`}
                onClick={() => setStageId(sid)}
              >
                {stageGeometry[sid].name}
              </button>
            ))}
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
                onMouseUp={endInteraction}
                onMouseLeave={endInteraction}
                onDoubleClick={resetView}
                onContextMenu={(e) => e.preventDefault()}
              />
            </div>

            <div className="szm-side">
              <div className="szm-hint">
                Every line here comes from Melee&apos;s own stage data and
                can&apos;t be moved — the <b>stage edge</b> (last standable x),
                the <b>ledge grab</b> point 2.91 beyond it, the lip, and the
                blast zone.
                <br />
                <br />
                The one judgment call is the <b>offstage line</b>: how far
                inside the stage edge the victim is considered to be in trouble.
                Drag it, or type a value below.
                <br />
                <br />
                At 0 it sits exactly on the stage edge — nobody standing on
                solid ground counts as offstage. Moving it inward slightly
                widens the net (~2% more clips at 18). It never affects where
                the clip starts, nor anything about the edgeguarder.
                <br />
                <br />
                Scroll to zoom · Space-drag or middle-drag to pan · double-click
                to reset view.
              </div>

              <div className="szm-coords">
                <label className="szm-coord">
                  <span>Offstage buffer</span>
                  <input
                    inputMode="decimal"
                    value={String(buffer)}
                    onChange={(e) => {
                      const raw = e.target.value
                      if (raw !== '' && !/^\d*\.?\d*$/.test(raw)) return
                      const n = parseFloat(raw)
                      setBuffer(Number.isNaN(n) ? 0 : clampBuffer(n))
                    }}
                  />
                </label>
              </div>

              <div className="szm-side-actions">
                <button type="button" className="szm-btn" onClick={resetView}>
                  Reset view
                </button>
                <button
                  type="button"
                  className="szm-btn"
                  disabled={buffer === DEFAULT_OFFSTAGE_BUFFER}
                  onClick={() => setBuffer(DEFAULT_OFFSTAGE_BUFFER)}
                  title={`Back to the default (${DEFAULT_OFFSTAGE_BUFFER})`}
                >
                  Reset to default
                </button>
              </div>

              {geo.note && <div className="szm-note">⚠ {geo.note}</div>}
            </div>
          </div>
        </div>

        <div className="szm-footer">
          <span className="szm-footer-summary">
            {geo.name}: stage ends {stageEnd} · ledge grab {ledge} · offstage
            past {offstageX.toFixed(1)}
            {'  ·  applies to all stages'}
          </span>
          <div className="szm-footer-actions">
            <button type="button" className="szm-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="szm-btn szm-btn-primary"
              onClick={() => onApply(buffer)}
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
