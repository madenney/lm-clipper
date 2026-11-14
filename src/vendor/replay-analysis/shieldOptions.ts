/*
 * Shield options: each time a player shields, what they did to leave it.
 *
 * A shield runs while the player is in GuardOn / Guard / GuardSetOff (shieldstun)
 * / GuardReflect (178–182 minus GuardOff). The option is read from the first
 * state after it:
 *   release   GuardOff (180), letting go of shield
 *   drop      Pass (244), shield drop through a platform
 *   grab      Catch / CatchDash (212/214), also a jump-cancelled grab
 *   roll      EscapeF/B (233/234), toward or away from the opponent
 *   spotdodge Escape (235)
 *   jump      KneeBend (24), then nothing below within the jump
 *   aerial    KneeBend → an aerial (nair…dair), out of jumpsquat or right after
 *   wavedash  KneeBend → airdodge → back on the ground within WAVEDASH_LAND frames
 *   airdodge  KneeBend → airdodge that doesn't land soon
 *   usmash    KneeBend → up smash (jump-cancelled)
 *   special   a character special (state ≥ 341), straight from shield or jumpsquat
 *   poked     hit out of shield (a damage state)
 *   grabbed   grabbed out of shield
 *   broken    shield broke (ShieldBreakFly…FuraFura, 205–211)
 *   other     anything else (e.g. KO'd, the game ended)
 *
 * Timing: `stunFrames` is the shieldstun the player took; `actFrames` is how
 * many frames after shieldstun ended the option came out (1 = the first possible
 * frame), null when they were never hit on shield. `punish` is the option (or
 * anything right after it) hitting the opponent within PUNISH_WINDOW frames.
 */
import { AS, aerialOf, isCaptured, isDamaged, isDead, isShieldBroken, isShielding, isThrown } from './actionStates'
import type { Aerial } from './actionStates'
import { followUp, opponentOf, postOf, sortedFrameNumbers, towardOrAway } from './frameUtils'
import type { Frames } from './types'

export type ShieldOption =
  | 'release'
  | 'drop'
  | 'grab'
  | 'roll'
  | 'spotdodge'
  | 'jump'
  | 'aerial'
  | 'wavedash'
  | 'airdodge'
  | 'usmash'
  | 'special'
  | 'poked'
  | 'grabbed'
  | 'broken'
  | 'other'

export type ShieldEvent = {
  playerIndex: number
  /** First shield frame. */
  frame: number
  /** First frame of the option (the frame after the last shield frame). */
  optionFrame: number
  option: ShieldOption
  aerial: Aerial | null
  direction: 'toward' | 'away' | null
  heldFrames: number
  stunFrames: number
  hitOnShield: boolean
  powershield: boolean
  /** The player who hit the shield last, if anyone did. */
  attackerIndex: number | null
  actFrames: number | null
  shieldSize: number | null
  percent: number
  punish: {
    /** The player the option hit. */
    targetIndex: number
    frame: number
    damage: number
    hits: number
    endFrame: number
    kill: boolean
    moveId: number | null
  } | null
}

const JUMPSQUAT_MAX = 12
const AFTER_JUMP = 8
const WAVEDASH_LAND = 12
const PUNISH_WINDOW = 40

export function findShieldOptions(
  frames: Frames,
  playerIndexes: number[],
): ShieldEvent[] {
  const numbers = sortedFrameNumbers(frames)
  const post = (f: number, i: number) => postOf(frames, f, i)
  const state = (f: number, i: number) => post(f, i)?.actionStateId ?? null
  const out: ShieldEvent[] = []

  // What a jump out of shield turned into.
  const afterJump = (
    f: number,
    i: number,
  ): [ShieldOption, Aerial | null] => {
    let g = f
    while (g < f + JUMPSQUAT_MAX && state(g, i) === AS.KNEE_BEND) g += 1
    for (let h = g; h <= g + AFTER_JUMP; h += 1) {
      const s = state(h, i)
      if (s == null) break
      if (h === g && (s === AS.CATCH || s === AS.CATCH_DASH)) return ['grab', null]
      if (h === g && s === AS.ATTACK_HI4) return ['usmash', null]
      if (aerialOf(s) && s >= AS.ATTACK_AIR_N && s <= AS.ATTACK_AIR_LW)
        return ['aerial', aerialOf(s)]
      if (s >= AS.SPECIAL_FIRST) return ['special', null]
      if (s === AS.ESCAPE_AIR) {
        for (let k = h + 1; k <= h + WAVEDASH_LAND; k += 1) {
          const q = post(k, i)
          if (!q) break
          if (q.actionStateId === AS.LANDING_FALL_SPECIAL || q.isAirborne === false)
            return ['wavedash', null]
        }
        return ['airdodge', null]
      }
      if (h > g && s !== AS.JUMP_F && s !== AS.JUMP_B) break
    }
    return ['jump', null]
  }

  for (const i of playerIndexes) {
    const opp = opponentOf(playerIndexes, i)
    const validAttacker = (n: number | null | undefined) =>
      n != null && n !== i && playerIndexes.includes(n) ? n : null
    let start: number | null = null
    let stun = 0
    let lastStunFrame: number | null = null
    let powershield = false
    let attacker: number | null = null
    let prevFrame: number | null = null
    for (const f of numbers) {
      const p = post(f, i)
      const s = p?.actionStateId ?? null
      if (s != null && isShielding(s)) {
        if (start == null) {
          start = f
          stun = 0
          lastStunFrame = null
          powershield = false
          attacker = null
        }
        if (s === AS.GUARD_SET_OFF) {
          stun += 1
          lastStunFrame = f
          attacker = validAttacker(p?.lastHitBy) ?? attacker ?? opp
        }
        if (s === AS.GUARD_REFLECT) powershield = true
        prevFrame = f
        continue
      }
      if (start == null || prevFrame == null) continue

      // Left the shield on frame f.
      let option: ShieldOption = 'other'
      let aerial: Aerial | null = null
      let direction: 'toward' | 'away' | null = null
      if (s == null || isDead(s)) option = 'other'
      else if (s === AS.GUARD_OFF) option = 'release'
      else if (s === AS.PASS) option = 'drop'
      else if (s === AS.CATCH || s === AS.CATCH_DASH) option = 'grab'
      else if (s === AS.ESCAPE_F || s === AS.ESCAPE_B) {
        option = 'roll'
        direction = opp == null ? null : towardOrAway(p, post(f, opp), s === AS.ESCAPE_F)
      } else if (s === AS.ESCAPE) option = 'spotdodge'
      else if (s === AS.KNEE_BEND) [option, aerial] = afterJump(f, i)
      else if (isShieldBroken(s)) option = 'broken'
      else if (isCaptured(s) || isThrown(s)) option = 'grabbed'
      else if (isDamaged(s)) option = 'poked'
      else if (s >= AS.SPECIAL_FIRST) option = 'special'
      if (option === 'poked' || option === 'grabbed' || option === 'broken')
        attacker = validAttacker(p?.lastHitBy) ?? attacker ?? opp

      let punish: ShieldEvent['punish'] = null
      const target = attacker ?? opp
      const offensive = !['poked', 'grabbed', 'broken', 'other'].includes(option)
      if (offensive && target != null) {
        let prevT = post(f - 1, target)
        for (let g = f; g <= f + PUNISH_WINDOW; g += 1) {
          const q = post(g, target)
          if (!q || !prevT) break
          if ((q.stocksRemaining ?? 0) !== (prevT.stocksRemaining ?? 0)) break
          if ((q.percent ?? 0) - (prevT.percent ?? 0) > 0.001 && q.lastHitBy === i) {
            const fu = followUp(frames, i, target, g - 1)
            punish = {
              targetIndex: target,
              frame: g,
              damage: fu.damage,
              hits: fu.hits,
              endFrame: fu.endFrame,
              kill: fu.kill,
              moveId: post(g, i)?.lastAttackLanded ?? null,
            }
            break
          }
          prevT = q
        }
      }

      const last = post(prevFrame, i)
      out.push({
        playerIndex: i,
        frame: start,
        optionFrame: f,
        option,
        aerial,
        direction,
        heldFrames: f - start,
        stunFrames: stun,
        hitOnShield: stun > 0,
        powershield,
        attackerIndex: stun > 0 || option === 'poked' || option === 'grabbed' || option === 'broken' ? attacker : null,
        actFrames: lastStunFrame == null ? null : f - lastStunFrame,
        shieldSize: last?.shieldSize == null ? null : Math.round(last.shieldSize * 10) / 10,
        percent: Math.round((last?.percent ?? 0) * 100) / 100,
        punish,
      })
      start = null
      prevFrame = null
    }
  }
  return out.sort((x, y) => x.frame - y.frame || x.playerIndex - y.playerIndex)
}
