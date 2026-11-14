/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import { useState, useRef, useEffect } from 'react'
import Modal from './Modal'
import stageGeometry, {
  ZONE_STAGE_IDS,
  DEFAULT_OFFSTAGE_BUFFER,
  LIP_BUFFER,
} from '../../constants/stageGeometry'
import {
  useZoneViewport,
  drawBackdropAndGrid,
  drawBlastBorder,
  drawAxes,
  drawStagePlatforms,
} from './zoneEditor'
import '../styles/StageZoneModal.css'

interface EdgeguardZoneModalProps {
  initialBuffer: number
  onApply: (_offstageBuffer: number) => void
  onClose: () => void
}

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
  const interactionRef = useRef<Interaction | null>(null)
  const [, setTick] = useState(0)
  const forceRender = () => setTick((n) => n + 1)

  const {
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
  } = useZoneViewport(stageId, 'default', onClose, interactionRef)
  const stageEnd = geo.ground.xMax // last standable x
  const ledge = geo.ledgeGrab // where you hang on the ledge (the ruler)
  const lipY = geo.ground.y - LIP_BUFFER
  const offstageX = stageEnd - buffer

  // ---- Drawing -----------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { toX, toY } = transform
    const bz = geo.blastzone

    drawBackdropAndGrid(ctx, transform, geo, CANVAS_W, CANVAS_H)

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
    drawBlastBorder(ctx, transform, geo)

    // Top blast zone emphasised — the parser reads this one
    ctx.strokeStyle = COLOR.blast
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(toX(bz.left), toY(bz.top))
    ctx.lineTo(toX(bz.right), toY(bz.top))
    ctx.stroke()

    // Axes
    drawAxes(ctx, transform, geo)

    // Stage + platforms
    drawStagePlatforms(ctx, transform, geo)

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

  return (
    <Modal
      overlayClassName="szm-overlay"
      className="szm-modal"
      initialFocus="box"
      onClose={onClose}
      label="Offstage line"
    >
      <div className="szm-header">
        <span className="szm-title">Offstage Line</span>
        <button
          type="button"
          className="szm-close"
          onClick={onClose}
          aria-label="Close"
        >
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
              the <b>ledge grab</b> point 2.91 beyond it, the lip, and the blast
              zone.
              <br />
              <br />
              The one judgment call is the <b>offstage line</b>: how far inside
              the stage edge the victim is considered to be in trouble. Drag it,
              or type a value below.
              <br />
              <br />
              At 0 it sits exactly on the stage edge — nobody standing on solid
              ground counts as offstage. Moving it inward slightly widens the
              net (~2% more clips at 18). It never affects where the clip
              starts, nor anything about the edgeguarder.
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
          {geo.name}: stage ends {stageEnd} · ledge grab {ledge} · offstage past{' '}
          {offstageX.toFixed(1)}
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
    </Modal>
  )
}
