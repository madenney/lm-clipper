/*
 * Phantom Hits parser. The detection (a hit that freezes only the defender and
 * whose damage lands after the freeze) is detectPhantoms in the shared
 * replay-analysis package, which documents it in full. This file applies
 * Clipper's parameters and player filters and shapes the clips.
 */
import { SlippiGame } from '../../lib/slippiGame'
import matchesAny from './matchesAny'
import { matchesPlayer } from '../../lib/filterHelpers'
import {
  FileInterface,
  ClipInterface,
  PhantomParams,
  EventEmitterInterface,
  PlayerInterface,
} from '../../constants/types'
import { detectPhantoms, frameBounds } from '../../vendor/replay-analysis'

export type { PhantomMetrics } from '../../vendor/replay-analysis'

export default (
  prevResults: (FileInterface | ClipInterface)[],
  params: PhantomParams,
  _eventEmitter: EventEmitterInterface,
) => {
  const results: ClipInterface[] = []
  const {
    comboerChar,
    comboeeChar,
    comboerTag,
    comboeeTag,
    comboerCC,
    comboeeCC,
    stageFilter,
  } = params

  const num = (v: unknown, dflt: number) => {
    const n = parseFloat(String(v ?? ''))
    return Number.isFinite(n) ? n : dflt
  }
  const minDamage = num(params.minDamage, 1)
  const leadInFrames = Math.round(num(params.leadInFrames, 45))
  const tailFrames = Math.round(num(params.tailFrames, 90))

  for (const item of prevResults) {
    const { path, stage } = item
    if (!matchesAny(stage, stageFilter)) continue

    let frames: ReturnType<SlippiGame['getFrames']>
    try {
      frames = new SlippiGame(path).getFrames()
    } catch (e) {
      continue
    }

    // Real game frame bounds (for clamping output clips).
    const bounds = frameBounds(frames)
    if (!bounds) continue
    const { min: gameMin, max: gameMax } = bounds

    const scanStart = Number.isFinite(item.startFrame)
      ? (item.startFrame as number)
      : gameMin
    // endFrame 0 / missing: the combo was still open when the game ended.
    const scanEnd =
      Number.isFinite(item.endFrame) && (item.endFrame as number) > 0
        ? (item.endFrame as number)
        : gameMax

    const parts: PlayerInterface[] = ((): PlayerInterface[] => {
      if ('players' in item && Array.isArray(item.players)) return item.players
      const two: PlayerInterface[] = []
      if ('comboer' in item && item.comboer) two.push(item.comboer)
      if ('comboee' in item && item.comboee) two.push(item.comboee)
      return two
    })()
    if (parts.length < 2) continue

    const events = detectPhantoms(
      frames,
      parts.map((p) => p.playerIndex),
      scanStart,
      scanEnd,
      minDamage,
    )
    for (const ev of events) {
      // eslint-disable-next-line eqeqeq
      const attacker = parts.find((p) => p.playerIndex == ev.attackerIndex)
      const victim = parts.find((p) => p.playerIndex === ev.victimIndex)
      if (!attacker || !victim) continue
      if (
        matchesPlayer(attacker, comboerChar, comboerTag, comboerCC) &&
        matchesPlayer(victim, comboeeChar, comboeeTag, comboeeCC)
      ) {
        const { id: _srcId, ...srcFields } = item as ClipInterface
        const f = ev.metrics.hitFrame
        results.push({
          ...srcFields,
          startFrame: Math.max(gameMin, f - leadInFrames),
          endFrame: Math.min(gameMax, f + tailFrames),
          comboer: attacker,
          comboee: victim,
          phantomMetrics: ev.metrics,
        })
      }
    }
  }

  return results
}
