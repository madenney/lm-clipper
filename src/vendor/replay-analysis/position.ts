/*
 * Where players spend the game: per-player frame counts of stage position and
 * posture, plus the average distance between two players. Counts are over
 * in-game frames (frame 0 onward, after the countdown) on which the player is
 * alive and on stage (not dead or on the respawn platform).
 *
 *   center      within the middle third of the main stage (|x| < edge / 3)
 *   offstage    past the stage edge, or below the stage lip
 *   platform    standing on a raised platform
 *   airborne    in the air
 *   shield      in a shield state (GuardOn … GuardReflect)
 *   ledge       hanging on or acting from the ledge
 *   closer      (1v1) nearer the stage center than the opponent — stage control
 *
 * Position fields are null on stages without geometry (see stageGeometry.ts).
 */
import stageGeometry, { LIP_BUFFER } from './stageGeometry'
import type { Frames } from './types'

// Dead (0-10), Sleep, Rebirth, RebirthWait: not in play.
const LAST_NOT_IN_PLAY_STATE = 13
const SHIELD_FIRST = 178 // GuardOn
const SHIELD_LAST = 182 // GuardReflect
const LEDGE_FIRST = 252 // CliffCatch
const LEDGE_LAST = 263 // CliffJumpQuick2
// A player this far above the main stage while grounded is on a platform.
const PLATFORM_MIN_HEIGHT = 5

export type PositionCounts = {
  playerIndex: number
  activeFrames: number
  center: number | null
  offstage: number | null
  platform: number | null
  airborne: number
  shield: number
  ledge: number
  closer: number | null
}

export type PositionStats = {
  players: PositionCounts[]
  /** Mean distance between the two players while both are in play (1v1). */
  avgDistance: number | null
}

export function positionStats(
  frames: Frames,
  playerIndexes: number[],
  stageId: number,
): PositionStats {
  const geo = stageGeometry[stageId]
  const edge = geo?.ground.xMax ?? null
  const lip = geo ? geo.ground.y : null
  const counts: PositionCounts[] = playerIndexes.map((playerIndex) => ({
    playerIndex,
    activeFrames: 0,
    center: geo ? 0 : null,
    offstage: geo ? 0 : null,
    platform: geo ? 0 : null,
    airborne: 0,
    shield: 0,
    ledge: 0,
    closer: geo && playerIndexes.length === 2 ? 0 : null,
  }))
  let distanceSum = 0
  let distanceFrames = 0

  const frameNumbers = Object.keys(frames)
    .map(Number)
    .filter((n) => !Number.isNaN(n) && n >= 0)
    .sort((a, b) => a - b)

  for (const f of frameNumbers) {
    const posts = playerIndexes.map((i) => {
      const p = frames[f]?.players?.[i]?.post
      if (!p || p.actionStateId == null) return null
      if (p.actionStateId <= LAST_NOT_IN_PLAY_STATE) return null
      return p
    })
    posts.forEach((p, k) => {
      if (!p) return
      const c = counts[k]
      const x = p.positionX ?? 0
      const y = p.positionY ?? 0
      const a = p.actionStateId as number
      c.activeFrames += 1
      if (p.isAirborne) c.airborne += 1
      if (a >= SHIELD_FIRST && a <= SHIELD_LAST) c.shield += 1
      if (a >= LEDGE_FIRST && a <= LEDGE_LAST) c.ledge += 1
      if (edge != null && lip != null) {
        if (Math.abs(x) < edge / 3) c.center! += 1
        if (Math.abs(x) > edge || y < lip - LIP_BUFFER) c.offstage! += 1
        if (!p.isAirborne && y > lip + PLATFORM_MIN_HEIGHT) c.platform! += 1
      }
    })
    if (playerIndexes.length === 2 && posts[0] && posts[1]) {
      const [a, b] = posts
      const ax = a.positionX ?? 0
      const bx = b.positionX ?? 0
      distanceSum += Math.hypot(
        ax - bx,
        (a.positionY ?? 0) - (b.positionY ?? 0),
      )
      distanceFrames += 1
      if (edge != null) {
        if (Math.abs(ax) < Math.abs(bx)) counts[0].closer! += 1
        else if (Math.abs(bx) < Math.abs(ax)) counts[1].closer! += 1
      }
    }
  }

  return {
    players: counts,
    avgDistance:
      distanceFrames > 0
        ? Math.round((distanceSum / distanceFrames) * 10) / 10
        : null,
  }
}
