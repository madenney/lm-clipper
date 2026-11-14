/*
 * Crouch cancels: a player hit while crouching (Squat 39 / SquatWait 40, on the
 * ground), which takes 2/3 knockback — and what they did with it.
 *
 * A hit is a frame where the player's percent rises and lastHitBy names the
 * attacker; the state on the frame before decides whether they were crouching.
 * Hits from the same attacker within MERGE_FRAMES of a crouch cancel (multi-hit
 * moves) belong to it. Grabs are not crouch cancels.
 *
 * held:   no tumble (DamageFly*, DamageFall) or knockdown in the next HELD_FRAMES:
 *         the crouch cancel worked (a light hop in DamageN that lands is still
 *         held); false means they were launched anyway.
 * punish: the crouch canceller hit the attacker back within PUNISH_WINDOW frames;
 *         the punish is followed like any other (frameUtils.followUp).
 */
import { AS, isCaptured, isDead, isDown, isThrown } from './actionStates'
import { followUp, postOf, sortedFrameNumbers } from './frameUtils'
import type { Frames } from './types'

export type CrouchCancelEvent = {
  /** The crouch canceller. */
  playerIndex: number
  attackerIndex: number
  frame: number
  /** Move that hit them (slippi move id). */
  moveId: number | null
  /** Damage taken from the hit (all its hits). */
  damageTaken: number
  /** Percent after the hit. */
  percent: number
  held: boolean
  punish: {
    frame: number
    moveId: number | null
    damage: number
    hits: number
    endFrame: number
    kill: boolean
  } | null
}

const MERGE_FRAMES = 20
const HELD_FRAMES = 30
const PUNISH_WINDOW = 60

export function findCrouchCancels(
  frames: Frames,
  playerIndexes: number[],
): CrouchCancelEvent[] {
  const numbers = sortedFrameNumbers(frames)
  const post = (f: number, i: number) => postOf(frames, f, i)
  const out: CrouchCancelEvent[] = []

  for (const v of playerIndexes) {
    let lastCc: CrouchCancelEvent | null = null
    for (const f of numbers) {
      const p = post(f, v)
      const before = post(f - 1, v)
      if (!p || !before) continue
      if ((p.stocksRemaining ?? 0) !== (before.stocksRemaining ?? 0)) continue
      const dmg = (p.percent ?? 0) - (before.percent ?? 0)
      if (dmg <= 0.001) continue
      const attacker = p.lastHitBy
      if (attacker == null || attacker === v || !playerIndexes.includes(attacker))
        continue

      if (lastCc && lastCc.attackerIndex === attacker && f - lastCc.frame <= MERGE_FRAMES) {
        lastCc.damageTaken = round(lastCc.damageTaken + dmg)
        lastCc.percent = round(p.percent ?? 0)
        continue
      }
      const prevState = before.actionStateId ?? -1
      const crouching =
        (prevState === AS.SQUAT || prevState === AS.SQUAT_WAIT) &&
        !before.isAirborne
      const s = p.actionStateId ?? -1
      if (!crouching || isCaptured(s) || isThrown(s)) {
        lastCc = null
        continue
      }

      let held = true
      for (let g = f; g <= f + HELD_FRAMES; g += 1) {
        const q = post(g, v)
        if (!q) break
        const qs = q.actionStateId ?? -1
        if (
          (qs >= AS.DAMAGE_FLY_FIRST && qs <= AS.DAMAGE_LAST) ||
          qs === AS.DAMAGE_FALL ||
          isDown(qs) ||
          isDead(qs)
        ) {
          held = false
          break
        }
      }

      let punish: CrouchCancelEvent['punish'] = null
      let prevA = post(f, attacker)
      for (let g = f + 1; g <= f + PUNISH_WINDOW; g += 1) {
        const q = post(g, attacker)
        if (!q || !prevA) break
        if ((q.stocksRemaining ?? 0) !== (prevA.stocksRemaining ?? 0)) break
        if ((q.percent ?? 0) - (prevA.percent ?? 0) > 0.001 && q.lastHitBy === v) {
          const fu = followUp(frames, v, attacker, g - 1)
          punish = {
            frame: g,
            moveId: post(g, v)?.lastAttackLanded ?? null,
            damage: fu.damage,
            hits: fu.hits,
            endFrame: fu.endFrame,
            kill: fu.kill,
          }
          break
        }
        prevA = q
      }

      lastCc = {
        playerIndex: v,
        attackerIndex: attacker,
        frame: f,
        moveId: post(f, attacker)?.lastAttackLanded ?? null,
        damageTaken: round(dmg),
        percent: round(p.percent ?? 0),
        held,
        punish,
      }
      out.push(lastCc)
    }
  }
  return out.sort((x, y) => x.frame - y.frame || x.playerIndex - y.playerIndex)
}

const round = (n: number) => Math.round(n * 100) / 100
