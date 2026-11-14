/*
 * Grabs: every grab that caught someone, and what came of it.
 *
 * A grab lands when the grabber enters CatchPull (213) or CatchDashPull (215).
 * The hold lasts while the grabber is in CatchPull…CatchCut (213–218), counting
 * pummels (CatchAttack, 217). It ends in a throw (ThrowF/B/Hi/Lw, 219–222), a
 * release (CatchCut, 218: the victim mashed out or the grab timed out), or the
 * grabber being hit out of it.
 *
 * The punish is followed from the grab on (pummels and throw included) until the
 * victim has been free to act for 45 frames (see frameUtils.followUp), so
 * `damage` is everything the grab led to and `kill` says whether it took the
 * stock. Command grabs (Kirby's inhale, Bowser's Koopa Klaw…) are not grabs here.
 */
import { AS, isCaptured, isThrown } from './actionStates'
import { followUp, postOf, sortedFrameNumbers } from './frameUtils'
import type { Frames } from './types'

export type ThrowDirection = 'forward' | 'back' | 'up' | 'down'

export type GrabEvent = {
  playerIndex: number
  victimIndex: number
  /** First frame of the pull (the grab connected). */
  frame: number
  /** Dash grab (or pivot grab) rather than a standing grab. */
  dash: boolean
  /** Victim's percent when grabbed. */
  percent: number
  pummels: number
  outcome: 'throw' | 'release' | 'hit'
  throw: ThrowDirection | null
  /** First frame of the throw, or of the release / hit. */
  releaseFrame: number
  /** Damage from the grab on: pummels, throw and whatever followed. */
  damage: number
  /** Hits after the throw (the follow-up), not counting pummels or the throw. */
  followUpHits: number
  /** Last frame of the punish (the last hit or the KO). */
  endFrame: number
  kill: boolean
  /** Last move of the punish (slippi move id). */
  lastMoveId: number | null
}

const THROWS: Record<number, ThrowDirection> = {
  [AS.THROW_F]: 'forward',
  [AS.THROW_B]: 'back',
  [AS.THROW_HI]: 'up',
  [AS.THROW_LW]: 'down',
}
const isHolding = (a: number) => a >= AS.CATCH_PULL && a <= AS.CATCH_CUT
// How far after the pull to look for the victim's captured state.
const CAPTURE_LOOKAHEAD = 3
// A hold never lasts longer than this (safety).
const MAX_HOLD = 600

export function findGrabs(frames: Frames, playerIndexes: number[]): GrabEvent[] {
  const numbers = sortedFrameNumbers(frames)
  const post = (f: number, i: number) => postOf(frames, f, i)
  const out: GrabEvent[] = []

  for (const i of playerIndexes) {
    let prev: number | null = null
    for (const f of numbers) {
      const a = post(f, i)?.actionStateId ?? null
      const started =
        (a === AS.CATCH_PULL || a === AS.CATCH_DASH_PULL) &&
        prev !== AS.CATCH_PULL &&
        prev !== AS.CATCH_DASH_PULL
      prev = a
      if (!started) continue

      // Who is held: the other player who is captured right after.
      let victim: number | null = null
      for (let g = f; g <= f + CAPTURE_LOOKAHEAD && victim == null; g += 1) {
        for (const j of playerIndexes) {
          if (j === i) continue
          const s = post(g, j)?.actionStateId ?? -1
          if (isCaptured(s) || isThrown(s)) {
            victim = j
            break
          }
        }
      }
      if (victim == null) continue

      let pummels = 0
      let outcome: GrabEvent['outcome'] = 'hit'
      let dir: ThrowDirection | null = null
      let releaseFrame = f
      let last = a as number
      for (let g = f + 1; g <= f + MAX_HOLD; g += 1) {
        const s = post(g, i)?.actionStateId
        if (s == null) break
        if (s === AS.CATCH_ATTACK && last !== AS.CATCH_ATTACK) pummels += 1
        if (THROWS[s]) {
          outcome = 'throw'
          dir = THROWS[s]
          releaseFrame = g
          break
        }
        if (s === AS.CATCH_CUT) {
          outcome = 'release'
          releaseFrame = g
          break
        }
        if (!isHolding(s)) {
          outcome = 'hit'
          releaseFrame = g
          break
        }
        last = s
      }

      const fu = followUp(frames, i, victim, f - 1)
      // Hits once the throw animation is over (the throw's own hits, e.g.
      // Fox's down throw lasers, don't count).
      let thrownHits = 0
      if (outcome === 'throw') {
        let throwEnd = releaseFrame
        while (
          throwEnd < releaseFrame + MAX_HOLD &&
          THROWS[post(throwEnd, i)?.actionStateId ?? -1]
        )
          throwEnd += 1
        thrownHits = followUp(frames, i, victim, throwEnd - 1).hits
      }
      out.push({
        playerIndex: i,
        victimIndex: victim,
        frame: f,
        dash: a === AS.CATCH_DASH_PULL,
        percent: Math.round((post(f, victim)?.percent ?? 0) * 100) / 100,
        pummels,
        outcome,
        throw: dir,
        releaseFrame,
        damage: fu.damage,
        followUpHits: thrownHits,
        endFrame: Math.max(fu.endFrame, releaseFrame),
        kill: fu.kill,
        lastMoveId: fu.lastMoveId,
      })
    }
  }
  return out.sort((x, y) => x.frame - y.frame || x.playerIndex - y.playerIndex)
}
