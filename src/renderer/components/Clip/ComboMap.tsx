/**
 * The full-zoom card's combo map: the stage to scale (ground, platforms, blast
 * zones) with where the victim went during the clip, each hit numbered where it
 * landed, and how it ended (a KO mark when the combo killed). The attacker's path
 * is drawn faintly underneath. Positions come from the replay (main/clipTrack.ts).
 */
import { useId, useMemo } from 'react'
import stageGeometry from '../../../constants/stageGeometry'
import type { ClipTrack, TrackPoint } from '../../../main/clipTrack'
import type { ComboHit } from './comboView'

type Props = {
  stageId?: number
  track: ClipTrack | null
  status: 'loading' | 'ready' | 'none' | 'error'
  message?: string
  attacker?: { playerIndex: number; color: string; image?: string | null }
  victim?: { playerIndex: number; color: string; image?: string | null }
  hits: ComboHit[]
  startFrame: number | null
  endFrame: number | null
  didKill?: boolean
  /** A whole game: both players' positions as a heat of dots, no hits. */
  mode?: 'combo' | 'game'
}

const pathOf = (pts: TrackPoint[]) =>
  pts.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${-p.y}`).join(' ')

/** A whole game's movement as crisp trails, broken at respawns and teleports. */
const trailsOf = (pts: TrackPoint[]) => {
  let d = ''
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i]
    const prev = pts[i - 1]
    const jump =
      !prev || p.s !== prev.s || Math.hypot(p.x - prev.x, p.y - prev.y) > 25
    d += `${jump ? 'M' : 'L'}${p.x} ${-p.y}`
  }
  return d
}

/** A character icon in a port-coloured ring, centred on (x, y). */
function Icon({
  id,
  x,
  y,
  r,
  image,
  color,
}: {
  id: string
  x: number
  y: number
  r: number
  image: string
  color: string
}) {
  return (
    <g className="combomap-icon">
      <clipPath id={id}>
        <circle cx={x} cy={y} r={r} />
      </clipPath>
      <circle cx={x} cy={y} r={r} style={{ fill: '#0d0e11', stroke: 'none' }} />
      <image
        href={image}
        x={x - r}
        y={y - r}
        width={r * 2}
        height={r * 2}
        clipPath={`url(#${id})`}
        preserveAspectRatio="xMidYMid slice"
      />
      <circle
        cx={x}
        cy={y}
        r={r}
        // inline: .combomap-hit circle would override presentation attributes
        style={{ fill: 'none', stroke: color, strokeWidth: r * 0.16 }}
      />
    </g>
  )
}

const nearest = (pts: TrackPoint[], f: number) => {
  let best: TrackPoint | null = null
  for (const p of pts)
    if (!best || Math.abs(p.f - f) < Math.abs(best.f - f)) best = p
  return best
}

export default function ComboMap({
  stageId,
  track,
  status,
  message,
  attacker,
  victim,
  hits,
  startFrame,
  endFrame,
  didKill,
  mode = 'combo',
}: Props) {
  const stage = stageId != null ? stageGeometry[stageId] : undefined
  const uid = useId().replace(/:/g, '')

  const view = useMemo(() => {
    if (!stage) return null
    const bz = stage.blastzone
    const pointsOf = (idx?: number) =>
      track?.players.find((p) => p.playerIndex === idx)?.points ?? []
    const victimPts = pointsOf(victim?.playerIndex)
    const attackerPts = pointsOf(attacker?.playerIndex)
    // Frame the stage and everything that happened, inside the blast zones.
    const xs = [stage.ground.xMin - 20, stage.ground.xMax + 20]
    const ys = [
      stage.ground.y - 30,
      Math.max(60, ...stage.platforms.map((p) => p.y + 30)),
    ]
    for (const p of [...victimPts, ...attackerPts]) {
      xs.push(p.x)
      ys.push(p.y)
    }
    const pad = 26 // room for the character icons at the edges
    const x0 = Math.max(bz.left - 22, Math.min(...xs) - pad)
    const x1 = Math.min(bz.right + 22, Math.max(...xs) + pad)
    const y0 = Math.max(bz.bottom - 22, Math.min(...ys) - pad)
    const y1 = Math.min(bz.top + 22, Math.max(...ys) + pad)
    const inClip = (p: TrackPoint) =>
      startFrame == null ||
      endFrame == null ||
      (p.f >= startFrame && p.f <= endFrame)
    return {
      bz,
      box: { x: x0, y: -y1, w: x1 - x0, h: y1 - y0 },
      victimPts,
      victimClip: victimPts.filter(inClip),
      attackerClip: attackerPts.filter(inClip),
      hitPts: hits.map((h) => ({ hit: h, at: nearest(victimPts, h.frame) })),
    }
  }, [
    stage,
    track,
    victim?.playerIndex,
    attacker?.playerIndex,
    hits,
    startFrame,
    endFrame,
  ])

  if (!stage || !view)
    return <div className="combomap combomap--empty">No map for this stage</div>

  const { box, bz } = view
  const unit = box.w / 400 // keeps strokes and labels the same size at any zoom
  const last = view.victimClip[view.victimClip.length - 1]
  const first = view.victimClip[0]

  return (
    <div className="combomap">
      <svg
        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Combo map on ${stage.name}`}
      >
        <defs>
          <linearGradient id="combomap-body" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#3a3f4b" />
            <stop offset="1" stopColor="#15171c" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Blast zones (only the edges in view) */}
        {[
          { x1: bz.left, y1: -bz.top, x2: bz.left, y2: -bz.bottom },
          { x1: bz.right, y1: -bz.top, x2: bz.right, y2: -bz.bottom },
          { x1: bz.left, y1: -bz.top, x2: bz.right, y2: -bz.top },
          { x1: bz.left, y1: -bz.bottom, x2: bz.right, y2: -bz.bottom },
        ].map((l, i) => (
          <line
            key={i}
            x1={l.x1}
            y1={l.y1}
            x2={l.x2}
            y2={l.y2}
            className="combomap-blast"
            strokeWidth={unit * 1.5}
            strokeDasharray={`${unit * 6} ${unit * 5}`}
          />
        ))}
        {/* Stage body, ground, platforms */}
        <path
          d={`M${stage.ground.xMin} ${-stage.ground.y} L${stage.ground.xMax} ${-stage.ground.y} L${stage.ground.xMax * 0.72} ${-stage.ground.y + 38} L${stage.ground.xMin * 0.72} ${-stage.ground.y + 38} Z`}
          fill="url(#combomap-body)"
        />
        <line
          x1={stage.ground.xMin}
          y1={-stage.ground.y}
          x2={stage.ground.xMax}
          y2={-stage.ground.y}
          className="combomap-ground"
          strokeWidth={unit * 3}
        />
        {stage.platforms.map((p, i) => (
          <line
            key={i}
            x1={p.xMin}
            y1={-p.y}
            x2={p.xMax}
            y2={-p.y}
            className="combomap-platform"
            strokeWidth={unit * 2.2}
          />
        ))}

        {status === 'ready' && mode === 'game' && (
          <>
            {[attacker, victim].map((side) =>
              side ? (
                <path
                  key={side.playerIndex}
                  d={trailsOf(
                    track?.players.find(
                      (p) => p.playerIndex === side.playerIndex,
                    )?.points ?? [],
                  )}
                  stroke={side.color}
                  strokeWidth={unit * 1.1}
                  className="combomap-trail"
                />
              ) : null,
            )}
          </>
        )}
        {status === 'ready' && mode === 'combo' && (
          <>
            {/* Run-in / aftermath, then the clip itself */}
            <path
              d={pathOf(view.victimPts)}
              className="combomap-ghost"
              stroke={victim?.color}
              strokeWidth={unit * 1.2}
            />
            <path
              d={pathOf(view.attackerClip)}
              className="combomap-attacker"
              stroke={attacker?.color}
              strokeWidth={unit * 1.6}
              strokeDasharray={`${unit * 3} ${unit * 3}`}
            />
            <path
              d={pathOf(view.victimClip)}
              className="combomap-victim"
              stroke={victim?.color}
              strokeWidth={unit * 2.6}
              pathLength={1}
            />
            {first && (
              <circle
                cx={first.x}
                cy={-first.y}
                r={unit * 4}
                className="combomap-start"
                stroke={victim?.color}
                strokeWidth={unit * 1.5}
              />
            )}
            {/* Where the victim ended up: their icon (the KO mark goes over it). */}
            {last && victim?.image && (
              <g className="combomap-hit" style={{ animationDelay: '1.2s' }}>
                <Icon
                  id={`${uid}-victim`}
                  x={last.x}
                  y={-last.y}
                  r={unit * 15}
                  image={victim.image}
                  color={victim.color}
                />
              </g>
            )}
            {view.hitPts.map(({ hit, at }, i) =>
              at ? (
                <g
                  key={hit.n}
                  className="combomap-hit"
                  style={{
                    animationDelay: `${0.25 + (i / Math.max(1, view.hitPts.length)) * 0.9}s`,
                  }}
                >
                  <title>{`${hit.n}. ${hit.name} +${hit.damage.toFixed(0)}% (${hit.percent.toFixed(0)}%)`}</title>
                  {hit.n === 1 && attacker?.image ? (
                    // The opener: who started it, where.
                    <Icon
                      id={`${uid}-opener`}
                      x={at.x}
                      y={-at.y}
                      r={unit * 17}
                      image={attacker.image}
                      color={attacker.color}
                    />
                  ) : (
                    <>
                      <circle
                        cx={at.x}
                        cy={-at.y}
                        r={unit * 7}
                        fill={attacker?.color}
                      />
                      <text
                        x={at.x}
                        y={-at.y}
                        fontSize={unit * 8.5}
                        dy={unit * 3}
                      >
                        {hit.n}
                      </text>
                    </>
                  )}
                </g>
              ) : null,
            )}
            {last && didKill && (
              <g
                className="combomap-ko"
                transform={`translate(${last.x} ${-last.y})`}
              >
                <title>KO</title>
                <path
                  d={`M${-unit * 6} ${-unit * 6} L${unit * 6} ${unit * 6} M${unit * 6} ${-unit * 6} L${-unit * 6} ${unit * 6}`}
                  strokeWidth={unit * 2.6}
                />
              </g>
            )}
          </>
        )}
      </svg>
      {status !== 'ready' && (
        <div className="combomap-status">
          {status === 'loading'
            ? 'Reading the replay…'
            : message || 'No positions for this clip'}
        </div>
      )}
      {mode === 'combo' && (
        <div className="combomap-legend">
          <span>
            <i style={{ background: victim?.color }} /> Got hit
          </span>
          <span>
            <i
              className="combomap-legend-dash"
              style={{ borderColor: attacker?.color }}
            />{' '}
            Attacker
          </span>
          <span>{stage.name}</span>
        </div>
      )}
    </div>
  )
}
