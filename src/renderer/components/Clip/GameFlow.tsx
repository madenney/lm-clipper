/**
 * The full-zoom card's game flow for a whole game: each player's percent over the
 * game in their port colour, dropping back to 0 at every stock lost (marked ✕).
 * Read from the replay with the positions (main/clipTrack.ts).
 */
import type { ClipTrack, TrackPoint } from '../../../main/clipTrack'

type Side = { playerIndex: number; color: string; name: string }

const mmss = (frames: number) => {
  const sec = Math.max(0, Math.round(frames / 60))
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}

/**
 * Split a player's points into one line per stock. On a KO the percent resets a
 * few frames before the stock count drops, so a line ends at any percent reset,
 * and the KO is marked at that stock's peak (where they were when they died).
 */
function stockRuns(points: TrackPoint[]) {
  const runs: TrackPoint[][] = []
  const kos: TrackPoint[] = []
  let run: TrackPoint[] = []
  for (let i = 0; i < points.length; i += 1) {
    const pt = points[i]
    const prev = points[i - 1]
    if (prev && pt.s < prev.s) {
      // The stock just lost: mark its highest percent (a self-destruct at 0%
      // marks where it was).
      kos.push(run.reduce((best, p) => (p.p > best.p ? p : best), prev))
    }
    if (prev && (pt.p < prev.p - 1 || pt.s < prev.s)) {
      if (run.length) runs.push(run)
      run = []
    }
    run.push(pt)
  }
  if (run.length) runs.push(run)
  return { runs, kos }
}

export default function GameFlow({
  track,
  sides,
  startFrame,
  endFrame,
}: {
  track: ClipTrack
  sides: Side[]
  startFrame: number
  endFrame: number
}) {
  const W = 600
  const H = 150
  const span = Math.max(1, endFrame - startFrame)
  const lines = sides.map((side) => {
    const pts = (
      track.players.find((p) => p.playerIndex === side.playerIndex)?.points ??
      []
    ).filter((p) => p.f >= startFrame && p.f <= endFrame)
    return { side, pts, ...stockRuns(pts) }
  })
  // Percent/stocks come from a newer main process than positions did: an app
  // that hasn't restarted since the update sends positions only.
  if (
    !lines.some((l) =>
      l.pts.some((p) => typeof p.p === 'number' && typeof p.s === 'number'),
    )
  )
    return (
      <p className="fullcard-muted">
        No percent data from this replay yet. Restart Clipper to load the game
        flow.
      </p>
    )
  const top =
    Math.max(100, ...lines.flatMap((l) => l.pts.map((p) => p.p))) * 1.08
  const x = (f: number) => ((f - startFrame) / span) * W
  const y = (p: number) => H - (Math.min(p, top) / top) * H
  const path = (run: TrackPoint[]) =>
    run
      .map(
        (p, i) => `${i ? 'L' : 'M'}${x(p.f).toFixed(1)} ${y(p.p).toFixed(1)}`,
      )
      .join(' ')
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => startFrame + t * span)

  return (
    <div className="gameflow">
      <div className="gameflow-chart">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
          {[0.25, 0.5, 0.75].map((t) => (
            <line
              key={t}
              x1={0}
              x2={W}
              y1={H * t}
              y2={H * t}
              className="gameflow-grid"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {lines.map(({ side, runs }) =>
            runs.map((run, i) => (
              <path
                // eslint-disable-next-line react/no-array-index-key
                key={`${side.playerIndex}-${i}`}
                d={path(run)}
                stroke={side.color}
                className="gameflow-line"
                vectorEffect="non-scaling-stroke"
              />
            )),
          )}
        </svg>
        <div className="gameflow-marks">
          {lines.map(({ side, kos }) =>
            kos.map((ko) => (
              <span
                key={`${side.playerIndex}-${ko.f}`}
                className="gameflow-ko"
                style={{
                  left: `${(x(ko.f) / W) * 100}%`,
                  top: `${(y(ko.p) / H) * 100}%`,
                  color: side.color,
                }}
                title={`${side.name} lost a stock at ${mmss(ko.f - startFrame)} (${ko.p.toFixed(0)}%)`}
              >
                ✕
              </span>
            )),
          )}
        </div>
      </div>
      <div className="gameflow-axis">
        {ticks.map((f) => (
          <span key={f}>{mmss(f - startFrame)}</span>
        ))}
      </div>
      <div className="gameflow-legend">
        {lines.map(({ side, kos, pts }) => (
          <span key={side.playerIndex}>
            <i style={{ background: side.color }} />
            {side.name}
            <em>
              {kos.length} {kos.length === 1 ? 'stock' : 'stocks'} lost
              {pts.length ? ` · ${pts[pts.length - 1].s} left` : ''}
            </em>
          </span>
        ))}
      </div>
    </div>
  )
}
