/* eslint-disable eqeqeq */
import {
  ClipInterface,
  EventEmitterInterface,
  PhantomFilterParams,
} from '../../constants/types'
import { matchesPlayer } from '../../lib/filterHelpers'
import { actionStates } from '../../constants/actionStates'

function intOrNull(value: string | undefined): number | null {
  if (value === undefined || value === '') return null
  const n = parseInt(value, 10)
  return Number.isNaN(n) ? null : n
}

// Resolve selected move ids (actionStates entries, e.g. Rest) to the set of
// action-state ids they cover, so we can match the attacker's animation state.
function resolveMoveStates(ids: (string | number)[] | undefined): Set<number> {
  const out = new Set<number>()
  if (!ids) return out
  const arr = Array.isArray(ids) ? ids : [ids]
  for (const id of arr) {
    const s = actionStates.find((a: { id: string | number }) => a.id == id)
    if (!s) continue
    const sids = Array.isArray(s.actionStateID)
      ? s.actionStateID
      : [s.actionStateID]
    for (const sid of sids) out.add(sid)
  }
  return out
}

// Refines Phantom Hits parser output by the metrics stored on each clip. Operates
// purely on already-computed `phantomMetrics` — no .slp parsing — so it's fast and
// can be re-run freely to dial in thresholds (e.g. "Rest = yes" for a phantom-Rest
// compilation).
export default (
  prevResults: ClipInterface[],
  params: PhantomFilterParams,
  eventEmitter: EventEmitterInterface,
) => {
  const minDamage = intOrNull(params.minDamage)
  const maxDamage = intOrNull(params.maxDamage)
  const minHitlag = intOrNull(params.minHitlag)
  const minVictimPercent = intOrNull(params.minVictimPercent)
  const {
    move,
    comboerChar,
    comboerTag,
    comboerCC,
    comboeeChar,
    comboeeTag,
    comboeeCC,
  } = params
  const moveStates = resolveMoveStates(move)

  return prevResults.filter((clip, index) => {
    eventEmitter({ current: index, total: prevResults.length })

    // Only Phantom-parser output carries metrics; anything else can't pass.
    const m = clip.phantomMetrics
    if (!m) return false

    if (minDamage !== null && m.damage < minDamage) return false
    if (maxDamage !== null && m.damage > maxDamage) return false
    if (minHitlag !== null && m.hitlag < minHitlag) return false
    if (minVictimPercent !== null && m.victimPercent < minVictimPercent)
      return false

    // Move: match the phantoming move by the attacker's action state (e.g. Rest).
    if (moveStates.size > 0 && !moveStates.has(m.attackerState)) return false

    // Player filters operate on the attacker (comboer) / victim (comboee)
    // attached by the parser.
    const { comboer, comboee } = clip
    if (comboer && !matchesPlayer(comboer, comboerChar, comboerTag, comboerCC))
      return false
    if (comboee && !matchesPlayer(comboee, comboeeChar, comboeeTag, comboeeCC))
      return false

    return true
  })
}
