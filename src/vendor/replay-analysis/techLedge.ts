/*
 * Tech and ledge options: what a player chose when knocked down and when on the
 * ledge. One event per choice, read from action-state transitions.
 *
 * Tech (hitting the ground or a wall/ceiling while tumbling):
 *   in_place, roll (toward/away from the opponent), wall, wall_jump, ceiling,
 *   missed (bounced without teching — the knockdown that starts a tech chase)
 * Getup after a missed tech:
 *   stand, attack, roll (toward/away), spotdodge, jab_reset (hit while lying down)
 * Ledge (leaving a ledge hang):
 *   getup, attack, roll, jump, drop, ledgedash (drop → airdodge → land on stage),
 *   hit (knocked off the ledge)
 *
 * "toward"/"away" compares the roll's direction with the opponent's side at that
 * moment (1v1 only; null otherwise).
 */
import stageGeometry from './stageGeometry'
import type { Frames } from './types'

export type TechOption =
  | 'in_place'
  | 'roll'
  | 'wall'
  | 'wall_jump'
  | 'ceiling'
  | 'missed'
export type GetupOption =
  | 'stand'
  | 'attack'
  | 'roll'
  | 'spotdodge'
  | 'jab_reset'
export type LedgeOption =
  | 'getup'
  | 'attack'
  | 'roll'
  | 'jump'
  | 'drop'
  | 'ledgedash'
  | 'hit'

export type TechLedgeEvent = {
  playerIndex: number
  frame: number
  kind: 'tech' | 'getup' | 'ledge'
  option: TechOption | GetupOption | LedgeOption
  direction: 'toward' | 'away' | null
  percent: number
}

const TECH_STATES: Record<number, [TechOption, 'forward' | 'back' | null]> = {
  199: ['in_place', null], // Passive
  200: ['roll', 'forward'], // PassiveStandF
  201: ['roll', 'back'], // PassiveStandB
  202: ['wall', null], // PassiveWall
  203: ['wall_jump', null], // PassiveWallJump
  204: ['ceiling', null], // PassiveCeil
  183: ['missed', null], // DownBoundU
  191: ['missed', null], // DownBoundD
}
const GETUP_STATES: Record<number, [GetupOption, 'forward' | 'back' | null]> = {
  185: ['jab_reset', null], // DownDamageU
  193: ['jab_reset', null], // DownDamageD
  186: ['stand', null], // DownStandU
  194: ['stand', null], // DownStandD
  187: ['attack', null], // DownAttackU
  195: ['attack', null], // DownAttackD
  188: ['roll', 'forward'], // DownFowardU
  196: ['roll', 'forward'], // DownFowardD
  189: ['roll', 'back'], // DownBackU
  197: ['roll', 'back'], // DownBackD
  190: ['spotdodge', null], // DownSpotU
  198: ['spotdodge', null], // DownSpotD
}
const CLIFF_CATCH = 252
const CLIFF_WAIT = 253
const LEDGE_ACTIONS: Record<number, LedgeOption> = {
  254: 'getup', // CliffClimbSlow
  255: 'getup', // CliffClimbQuick
  256: 'attack', // CliffAttackSlow
  257: 'attack', // CliffAttackQuick
  258: 'roll', // CliffEscapeSlow
  259: 'roll', // CliffEscapeQuick
  260: 'jump', // CliffJumpSlow1
  261: 'jump', // CliffJumpSlow2
  262: 'jump', // CliffJumpQuick1
  263: 'jump', // CliffJumpQuick2
}
const ESCAPE_AIR = 236 // airdodge
const DAMAGE_FIRST = 75 // DamageHi1 … DamageFlyRoll
const DAMAGE_LAST = 91
const LAST_DEAD_STATE = 10
// A drop counts as a ledgedash if the airdodge comes within this many frames of
// letting go, and the landing on stage within this many frames of the airdodge.
const LEDGEDASH_AIRDODGE_WINDOW = 20
const LEDGEDASH_LANDING_WINDOW = 20

export function techLedgeEvents(
  frames: Frames,
  playerIndexes: number[],
  stageId: number,
): TechLedgeEvent[] {
  const edge = stageGeometry[stageId]?.ground.xMax ?? null
  const events: TechLedgeEvent[] = []
  const frameNumbers = Object.keys(frames)
    .map(Number)
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b)
  const post = (f: number, i: number) => frames[f]?.players?.[i]?.post ?? null

  const relative = (
    f: number,
    i: number,
    roll: 'forward' | 'back' | null,
  ): 'toward' | 'away' | null => {
    if (!roll || playerIndexes.length !== 2) return null
    const me = post(f, i)
    const other = post(f, playerIndexes.find((j) => j !== i)!)
    if (!me || !other || me.facingDirection == null) return null
    const moving =
      (me.facingDirection as number) * (roll === 'forward' ? 1 : -1)
    const side = Math.sign((other.positionX ?? 0) - (me.positionX ?? 0))
    if (side === 0) return null
    return moving === side ? 'toward' : 'away'
  }

  // After letting go of the ledge: airdodge soon, then land on the stage.
  const isLedgedash = (start: number, i: number): boolean => {
    for (let f = start; f <= start + LEDGEDASH_AIRDODGE_WINDOW; f += 1) {
      const p = post(f, i)
      if (!p) return false
      if (p.actionStateId === ESCAPE_AIR) {
        for (let g = f; g <= f + LEDGEDASH_LANDING_WINDOW; g += 1) {
          const q = post(g, i)
          if (!q) return false
          if (!q.isAirborne)
            return edge == null || Math.abs(q.positionX ?? 0) <= edge
        }
        return false
      }
    }
    return false
  }

  for (const i of playerIndexes) {
    let prev: number | null = null
    for (const f of frameNumbers) {
      const p = post(f, i)
      const a = p?.actionStateId
      if (a == null) {
        prev = null
        continue
      }
      if (a !== prev && p) {
        const percent = Math.round((p.percent ?? 0) * 100) / 100
        const tech = TECH_STATES[a]
        const getup = GETUP_STATES[a]
        if (tech) {
          events.push({
            playerIndex: i,
            frame: f,
            kind: 'tech',
            option: tech[0],
            direction: relative(f, i, tech[1]),
            percent,
          })
        } else if (getup) {
          events.push({
            playerIndex: i,
            frame: f,
            kind: 'getup',
            option: getup[0],
            direction: relative(f, i, getup[1]),
            percent,
          })
        } else if (
          prev != null &&
          (prev === CLIFF_CATCH || prev === CLIFF_WAIT) &&
          a !== CLIFF_CATCH &&
          a !== CLIFF_WAIT &&
          a > LAST_DEAD_STATE
        ) {
          let option: LedgeOption
          if (LEDGE_ACTIONS[a]) option = LEDGE_ACTIONS[a]
          else if (a >= DAMAGE_FIRST && a <= DAMAGE_LAST) option = 'hit'
          else option = isLedgedash(f, i) ? 'ledgedash' : 'drop'
          events.push({
            playerIndex: i,
            frame: f,
            kind: 'ledge',
            option,
            direction: null,
            percent,
          })
        }
      }
      prev = a
    }
  }
  return events.sort(
    (x, y) => x.frame - y.frame || x.playerIndex - y.playerIndex,
  )
}
