/*
 * L-cancels: every aerial landing the game graded (post-frame lCancelStatus,
 * 1 = L-cancelled, 2 = missed, set on the landing frame), per player, and
 * whether a missed one got punished.
 *
 * The counts match slippi-js's actionCounts.lCancelCount. `punish` is the
 * opponent hitting the player within PUNISH_WINDOW frames of the landing,
 * followed like any other punish (frameUtils.followUp).
 */
import { aerialOf } from './actionStates'
import type { Aerial } from './actionStates'
import { followUp, opponentOf, postOf, sortedFrameNumbers } from './frameUtils'
import type { Frames } from './types'

export type LCancelEvent = {
  playerIndex: number
  frame: number
  missed: boolean
  aerial: Aerial | null
  percent: number
  /** Opponent hit them during or right after the landing (misses only). */
  punish: {
    attackerIndex: number
    frame: number
    damage: number
    endFrame: number
    kill: boolean
  } | null
}

export type LCancelSummary = {
  playerIndex: number
  success: number
  missed: number
  /** Missed L-cancels that got punished. */
  punished: number
}

const PUNISH_WINDOW = 30

export function findLCancels(
  frames: Frames,
  playerIndexes: number[],
): { events: LCancelEvent[]; players: LCancelSummary[] } {
  const numbers = sortedFrameNumbers(frames)
  const post = (f: number, i: number) => postOf(frames, f, i)
  const events: LCancelEvent[] = []

  for (const i of playerIndexes) {
    let prevStatus = 0
    for (const f of numbers) {
      const p = post(f, i)
      const status = p?.lCancelStatus ?? 0
      const changed = status !== prevStatus
      prevStatus = status
      if (!p || !changed || (status !== 1 && status !== 2)) continue
      const missed = status === 2
      let punish: LCancelEvent['punish'] = null
      if (missed) {
        const opp = opponentOf(playerIndexes, i)
        let prev = p
        for (let g = f + 1; g <= f + PUNISH_WINDOW && opp != null; g += 1) {
          const q = post(g, i)
          if (!q) break
          if ((q.stocksRemaining ?? 0) !== (prev.stocksRemaining ?? 0)) break
          if ((q.percent ?? 0) - (prev.percent ?? 0) > 0.001 && q.lastHitBy === opp) {
            const fu = followUp(frames, opp, i, g - 1)
            punish = {
              attackerIndex: opp,
              frame: g,
              damage: fu.damage,
              endFrame: fu.endFrame,
              kill: fu.kill,
            }
            break
          }
          prev = q
        }
      }
      events.push({
        playerIndex: i,
        frame: f,
        missed,
        aerial: aerialOf(p.actionStateId ?? -1),
        percent: Math.round((p.percent ?? 0) * 100) / 100,
        punish,
      })
    }
  }
  events.sort((x, y) => x.frame - y.frame || x.playerIndex - y.playerIndex)
  const players = playerIndexes.map((playerIndex) => {
    const mine = events.filter((e) => e.playerIndex === playerIndex)
    return {
      playerIndex,
      success: mine.filter((e) => !e.missed).length,
      missed: mine.filter((e) => e.missed).length,
      punished: mine.filter((e) => e.punish).length,
    }
  })
  return { events, players }
}
