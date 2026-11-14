/**
 * The full-zoom card's damage timeline: the victim's percent over the clip, a
 * step at every hit (numbered like the combo map), move names underneath.
 */
import { fmtSeconds, type ComboHit } from './comboView'

type Props = {
  hits: ComboHit[]
  startFrame: number
  endFrame: number
  startPercent: number
  color: string
  didKill?: boolean
  /** The chart, the hit list, or both (default). */
  part?: 'chart' | 'list' | 'both'
}

export default function DamageTimeline({
  hits,
  startFrame,
  endFrame,
  startPercent,
  color,
  didKill,
  part = 'both',
}: Props) {
  const span = Math.max(1, endFrame - startFrame)
  const top = Math.max(startPercent + 10, ...hits.map((h) => h.percent)) * 1.12
  const W = 600
  const H = 120
  const x = (f: number) =>
    ((Math.min(Math.max(f, startFrame), endFrame) - startFrame) / span) * W
  const y = (p: number) => H - (p / top) * H
  let d = `M0 ${y(startPercent)}`
  for (const h of hits) d += ` H${x(h.frame)} V${y(h.percent)}`
  d += ` H${W}`
  const area = `${d} V${H} H0 Z`

  return (
    <div className={`dmgline dmgline--${part}`}>
      {part !== 'list' && (
        <>
          <svg
            viewBox={`0 -14 ${W} ${H + 14}`}
            preserveAspectRatio="none"
            aria-hidden
          >
            <defs>
              <linearGradient id="dmgline-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={color} stopOpacity="0.35" />
                <stop offset="1" stopColor={color} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={area} fill="url(#dmgline-fill)" className="dmgline-area" />
            <path
              d={d}
              stroke={color}
              className="dmgline-line"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {/* Markers in HTML so text isn't stretched by the SVG's scaling */}
          <div className="dmgline-marks">
            {hits.map((h, i) => (
              <span
                key={h.n}
                className="dmgline-mark"
                style={{
                  left: `${(x(h.frame) / W) * 100}%`,
                  top: `${((y(h.percent) + 14) / (H + 14)) * 100}%`,
                  animationDelay: `${0.2 + (i / Math.max(1, hits.length)) * 0.9}s`,
                }}
                title={`${h.name} +${h.damage.toFixed(0)}% at ${fmtSeconds(h.frame - startFrame)}`}
              >
                {h.n}
              </span>
            ))}
          </div>
          <div className="dmgline-axis">
            <span>{startPercent.toFixed(0)}%</span>
            <span>
              {hits.length
                ? `${hits[hits.length - 1].percent.toFixed(0)}%`
                : ''}
              {didKill ? ' · KO' : ''}
            </span>
          </div>
        </>
      )}
      {part !== 'chart' && (
        <ol className="dmgline-hits">
          {hits.map((h) => (
            <li key={h.n}>
              <b>{h.n}</b>
              <span className="dmgline-hit-name">{h.name}</span>
              <span className="dmgline-hit-dmg">+{h.damage.toFixed(0)}%</span>
              <span className="dmgline-hit-at">
                {fmtSeconds(h.frame - startFrame)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
