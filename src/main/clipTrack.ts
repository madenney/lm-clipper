import fs from 'fs'
import { SlippiGame } from '../lib/slippiGame'
import { isReplayPath } from '../lib/replayPath'

/**
 * Where both players were during a clip, for the full-zoom card's combo map.
 * Reads the replay's frames (slippi-js): every other frame for a clip, sparser for
 * a whole game (at most MAX_POINTS per player), with percent and stocks for the
 * game flow chart. Cached for the last few looked at.
 */
/** f frame, x/y position, p percent, s stocks remaining. */
export type TrackPoint = {
  f: number
  x: number
  y: number
  p: number
  s: number
}
export type ClipTrack = {
  players: { playerIndex: number; points: TrackPoint[] }[]
}

const PAD = 30 // half a second either side, so the map shows the run-in and the finish
/** At most this many points per player: a whole game samples more sparsely. */
const MAX_POINTS = 2400
const CACHE = new Map<string, ClipTrack>()
const CACHE_SIZE = 12

export function readClipTrack(
  slpPath: string,
  startFrame: number,
  endFrame: number,
  playerIndexes: number[],
): ClipTrack {
  const key = `${slpPath}|${startFrame}|${endFrame}|${playerIndexes.join(',')}`
  const hit = CACHE.get(key)
  if (hit) return hit
  if (!isReplayPath(slpPath) || !fs.existsSync(slpPath))
    throw new Error('The replay file is not on this computer.')
  const game = new SlippiGame(slpPath)
  const frames = game.getFrames()
  const from = startFrame - PAD
  const to = endFrame + PAD
  const step = Math.max(2, Math.ceil((to - from) / MAX_POINTS))
  // The game's last frame is where the final stock drops to 0 (the game ends
  // before the percent resets), so it's always read, whatever the sampling step.
  const latest = game.getLatestFrame()?.frame
  const lastFrame =
    typeof latest === 'number' && latest >= from && latest < to ? latest : null
  const track: ClipTrack = {
    players: playerIndexes.map((playerIndex) => {
      const points: TrackPoint[] = []
      const wanted: number[] = []
      for (let f = from; f <= to; f += step) wanted.push(f)
      if (lastFrame !== null) {
        while (wanted.length && wanted[wanted.length - 1] >= lastFrame)
          wanted.pop()
        wanted.push(lastFrame)
      }
      for (const f of wanted) {
        const post = frames[f]?.players?.[playerIndex]?.post
        const x = post?.positionX
        const y = post?.positionY
        if (typeof x === 'number' && typeof y === 'number')
          points.push({
            f,
            x: Math.round(x * 10) / 10,
            y: Math.round(y * 10) / 10,
            p: Math.round((post?.percent ?? 0) * 10) / 10,
            s: post?.stocksRemaining ?? 0,
          })
      }
      return { playerIndex, points }
    }),
  }
  CACHE.set(key, track)
  if (CACHE.size > CACHE_SIZE) CACHE.delete(CACHE.keys().next().value as string)
  return track
}
