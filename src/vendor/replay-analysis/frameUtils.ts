// Small helpers shared by the action detectors (grabs, crouch cancels,
// L-cancels, shield and ledge options).
import { isDead, isPunished } from './actionStates'
import type { Frames, PostFrame } from './types'

export function sortedFrameNumbers(frames: Frames): number[] {
  return Object.keys(frames)
    .map(Number)
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b)
}

export const postOf = (
  frames: Frames,
  f: number,
  i: number,
): PostFrame | null => frames[f]?.players?.[i]?.post ?? null

/** Frames a punish lasts after the victim is free again (slippi-js's PUNISH_RESET_FRAMES). */
export const FOLLOW_UP_RESET_FRAMES = 45
/** Never follow a punish for longer than this (20 s). */
export const FOLLOW_UP_MAX_FRAMES = 1200

export type FollowUp = {
  /** Last frame of the punish: the last hit, the KO, or `from` if nothing landed. */
  endFrame: number
  /** Damage the attacker dealt from `from` on (a KO's reset to 0% is not counted). */
  damage: number
  /** Hits that landed (frames the victim's percent went up). */
  hits: number
  /** The victim lost a stock while the punish was going. */
  kill: boolean
  /** The last move that hit (the attacker's lastAttackLanded on that frame). */
  lastMoveId: number | null
}

/**
 * What the attacker did to the victim from frame `from`: damage, hits, and
 * whether it took a stock. Ends once the victim has been free to act (not hit,
 * held, thrown, down or teching) for FOLLOW_UP_RESET_FRAMES in a row.
 */
export function followUp(
  frames: Frames,
  attacker: number,
  victim: number,
  from: number,
  resetFrames = FOLLOW_UP_RESET_FRAMES,
): FollowUp {
  const out: FollowUp = {
    endFrame: from,
    damage: 0,
    hits: 0,
    kill: false,
    lastMoveId: null,
  }
  let prev = postOf(frames, from, victim)
  let free = 0
  for (let f = from + 1; f <= from + FOLLOW_UP_MAX_FRAMES; f += 1) {
    const v = postOf(frames, f, victim)
    if (!v || !prev) break
    const a = v.actionStateId ?? -1
    if (
      (v.stocksRemaining ?? 0) < (prev.stocksRemaining ?? 0) ||
      isDead(a)
    ) {
      // A KO counts when this attacker was the last to hit them.
      out.kill = prev.lastHitBy === attacker || out.hits > 0
      if (out.kill) out.endFrame = f
      break
    }
    const dmg = (v.percent ?? 0) - (prev.percent ?? 0)
    // lastHitBy names no port (e.g. 6) for some hits, like Fox's down throw
    // lasers: damage then counts for the attacker.
    const byAttacker =
      v.lastHitBy === attacker || !isPort(v.lastHitBy)
    if (dmg > 0.001 && byAttacker) {
      out.damage += dmg
      out.hits += 1
      out.endFrame = f
      out.lastMoveId = postOf(frames, f, attacker)?.lastAttackLanded ?? null
      free = 0
    } else if (isPunished(a)) {
      free = 0
    } else {
      free += 1
      if (free >= resetFrames) break
    }
    prev = v
  }
  out.damage = Math.round(out.damage * 100) / 100
  return out
}

/** A real port index (lastHitBy uses other values for "nobody"). */
export const isPort = (n: number | null | undefined): n is number =>
  n != null && n >= 0 && n <= 3

/** The other player in a 1v1, else null. */
export function opponentOf(playerIndexes: number[], i: number): number | null {
  if (playerIndexes.length !== 2) return null
  return playerIndexes.find((j) => j !== i) ?? null
}

/**
 * 'toward' / 'away': does a roll in `facing` * (forward ? 1 : -1) move toward
 * the other player?
 */
export function towardOrAway(
  me: PostFrame | null,
  other: PostFrame | null,
  forward: boolean,
): 'toward' | 'away' | null {
  if (!me || !other || me.facingDirection == null) return null
  const moving = (me.facingDirection as number) * (forward ? 1 : -1)
  const side = Math.sign((other.positionX ?? 0) - (me.positionX ?? 0))
  if (side === 0) return null
  return moving === side ? 'toward' : 'away'
}
