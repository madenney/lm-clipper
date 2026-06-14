/* eslint-disable eqeqeq */
import {
  ClipInterface,
  EventEmitterInterface,
  EdgeguardFilterParams,
} from '../../constants/types'
import { matchesPlayer } from '../../lib/filterHelpers'

// Tri-state gate: '' = any, 'yes' = metric must be true, 'no' = must be false.
function passesTriState(flag: string | undefined, actual: boolean): boolean {
  if (flag === 'yes') return actual
  if (flag === 'no') return !actual
  return true
}

function intOrNull(value: string | undefined): number | null {
  if (value === undefined || value === '') return null
  const n = parseInt(value, 10)
  return Number.isNaN(n) ? null : n
}

// Refines Edgeguards Parser output by the metrics stored on each clip. Operates
// purely on already-computed `edgeguardMetrics` — no .slp parsing — so it's fast
// and can be re-run freely to dial in thresholds.
export default (
  prevResults: ClipInterface[],
  params: EdgeguardFilterParams,
  eventEmitter: EventEmitterInterface,
) => {
  const minHits = intOrNull(params.minHits)
  const maxHits = intOrNull(params.maxHits)
  const minOffstageFrames = intOrNull(params.minOffstageFrames)
  const maxOffstageFrames = intOrNull(params.maxOffstageFrames)
  const maxLedgeDist = intOrNull(params.maxLedgeDist)
  const minDepthX = intOrNull(params.minDepthX)
  const maxMinY = intOrNull(params.maxMinY)
  const minScore = intOrNull(params.minScore)
  const {
    blockedByHit,
    ledgeSteal,
    edgeguarderOffstage,
    comboerChar,
    comboerTag,
    comboerCC,
    comboeeChar,
    comboeeTag,
    comboeeCC,
  } = params

  return prevResults.filter((clip, index) => {
    eventEmitter({ current: index, total: prevResults.length })

    // Only edgeguard-parser output carries metrics; anything else can't pass.
    const m = clip.edgeguardMetrics
    if (!m) return false

    if (minHits !== null && m.hits < minHits) return false
    if (maxHits !== null && m.hits > maxHits) return false
    if (minOffstageFrames !== null && m.offstageFrames < minOffstageFrames)
      return false
    if (maxOffstageFrames !== null && m.offstageFrames > maxOffstageFrames)
      return false
    if (maxLedgeDist !== null && m.minLedgeDist > maxLedgeDist) return false
    if (minDepthX !== null && m.maxDepthX < minDepthX) return false
    if (maxMinY !== null && m.minY > maxMinY) return false
    if (minScore !== null && m.score < minScore) return false

    if (!passesTriState(blockedByHit, m.blockedByHit)) return false
    if (!passesTriState(ledgeSteal, m.ledgeSteal)) return false
    if (!passesTriState(edgeguarderOffstage, m.edgeguarderOffstage))
      return false

    // Player filters operate on the edgeguarder (comboer) / victim (comboee)
    // attached by the parser.
    const { comboer, comboee } = clip
    if (comboer && !matchesPlayer(comboer, comboerChar, comboerTag, comboerCC))
      return false
    if (comboee && !matchesPlayer(comboee, comboeeChar, comboeeTag, comboeeCC))
      return false

    return true
  })
}
