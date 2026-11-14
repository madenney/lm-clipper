/*
 * Ledge options with timing, built on techLedgeEvents' ledge options.
 *
 * ledgeFrames         frames from grabbing the ledge (CliffCatch) to acting
 * invincibleOnAction  still invincible from the ledge grab when they acted
 *                     (hurtboxCollisionState ≠ 0 on the last hanging frame)
 * regrab              a drop that grabbed the ledge again within REGRAB_WINDOW
 *                     frames (refreshing invincibility)
 * galint              ledgedashes only: frames they were actionable on stage while
 *                     still intangible (GALINT); null when it can't be read
 * punish              the opponent hit them within PUNISH_WINDOW frames of the option
 */
import { AS } from './actionStates'
import { followUp, opponentOf, postOf } from './frameUtils'
import { techLedgeEvents } from './techLedge'
import type { LedgeOption } from './techLedge'
import type { Frames } from './types'

export type LedgeTimingEvent = {
  playerIndex: number
  /** First frame of the option. */
  frame: number
  /** Frame they caught the ledge. */
  grabFrame: number
  option: LedgeOption
  percent: number
  ledgeFrames: number
  invincibleOnAction: boolean | null
  regrab: boolean
  galint: number | null
  punish: {
    attackerIndex: number
    frame: number
    damage: number
    endFrame: number
    kill: boolean
  } | null
}

const REGRAB_WINDOW = 40
const PUNISH_WINDOW = 60
const MAX_HANG = 600

export function findLedgeOptions(
  frames: Frames,
  playerIndexes: number[],
  stageId: number,
): LedgeTimingEvent[] {
  const post = (f: number, i: number) => postOf(frames, f, i)
  const onLedge = (s: number | null | undefined) =>
    s === AS.CLIFF_CATCH || s === AS.CLIFF_WAIT

  return techLedgeEvents(frames, playerIndexes, stageId)
    .filter((e) => e.kind === 'ledge')
    .map((e) => {
      const i = e.playerIndex
      const f = e.frame
      let grabFrame = f - 1
      while (grabFrame > f - MAX_HANG && onLedge(post(grabFrame - 1, i)?.actionStateId)) grabFrame -= 1
      const lastHang = post(f - 1, i)
      const hurt = lastHang?.hurtboxCollisionState
      const option = e.option as LedgeOption

      let regrab = false
      if (option === 'drop') {
        for (let g = f + 1; g <= f + REGRAB_WINDOW; g += 1) {
          const s = post(g, i)?.actionStateId
          if (s == null) break
          if (s === AS.CLIFF_CATCH) {
            regrab = true
            break
          }
          if (s === AS.ESCAPE_AIR) break
        }
      }

      let galint: number | null = null
      if (option === 'ledgedash') {
        let land: number | null = null
        for (let g = f; g <= f + 45; g += 1) {
          const q = post(g, i)
          if (!q) break
          if (q.isAirborne === false) {
            land = g
            break
          }
        }
        if (land != null && post(land, i)?.hurtboxCollisionState != null) {
          galint = 0
          for (let g = land; g <= land + 40; g += 1) {
            const q = post(g, i)
            if (!q || (q.hurtboxCollisionState ?? 0) === 0) break
            if (q.actionStateId !== AS.LANDING_FALL_SPECIAL) galint += 1
          }
        }
      }

      let punish: LedgeTimingEvent['punish'] = null
      const opp = opponentOf(playerIndexes, i)
      if (opp != null && option !== 'hit') {
        let prev = post(f - 1, i)
        for (let g = f; g <= f + PUNISH_WINDOW; g += 1) {
          const q = post(g, i)
          if (!q || !prev) break
          if ((q.stocksRemaining ?? 0) !== (prev.stocksRemaining ?? 0)) break
          if ((q.percent ?? 0) - (prev.percent ?? 0) > 0.001 && q.lastHitBy === opp) {
            const fu = followUp(frames, opp, i, g - 1)
            punish = { attackerIndex: opp, frame: g, damage: fu.damage, endFrame: fu.endFrame, kill: fu.kill }
            break
          }
          prev = q
        }
      }

      return {
        playerIndex: i,
        frame: f,
        grabFrame,
        option,
        percent: e.percent,
        ledgeFrames: f - grabFrame,
        invincibleOnAction: hurt == null ? null : hurt !== 0,
        regrab,
        galint,
        punish,
      }
    })
}
