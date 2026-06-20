/* eslint-disable eqeqeq */
import {
  ClipInterface,
  EventEmitterInterface,
  ComboFilterParams,
  NthMoveDef,
} from 'constants/types'
import matchesAny from './matchesAny'
import { matchesPlayer, safeInt } from '../../lib/filterHelpers'

export default (
  prevResults: ClipInterface[],
  params: ComboFilterParams,
  eventEmitter: EventEmitterInterface,
) => {
  return prevResults.filter((clip, index) => {
    eventEmitter({ current: index, total: prevResults.length })
    const {
      minHits,
      maxHits,
      minDamage,
      comboerChar,
      comboerTag,
      comboerCC,
      comboeeChar,
      comboeeTag,
      comboeeCC,
      comboStage,
      didKill,
      countPummels,
      nthMoves,
    } = params
    const { comboer, comboee, stage } = clip
    if (!comboer || !comboee) return false
    if (!clip.combo || !clip.combo.moves) return false
    const { moves } = clip.combo
    if (minHits) {
      const numHits = countPummels
        ? moves.length
        : moves.filter((move) => move.moveId != 52).length
      if (numHits < Number(minHits)) return false
    }
    if (maxHits) {
      const numHits = countPummels
        ? moves.length
        : moves.filter((move) => move.moveId != 52).length
      if (numHits > Number(maxHits)) return false
    }
    if (
      minDamage &&
      !(moves.reduce((n, m) => n + m.damage, 0) >= Number(minDamage))
    )
      return false
    if (!matchesPlayer(comboer, comboerChar, comboerTag, comboerCC))
      return false
    if (!matchesPlayer(comboee, comboeeChar, comboeeTag, comboeeCC))
      return false
    if (!matchesAny(stage, comboStage)) return false
    if (didKill && !clip.combo.didKill) return false
    if (nthMoves && nthMoves.length > 0) {
      const checkIndex = (
        idx: number,
        nthMove: NthMoveDef,
        t: number,
        d: number,
        dMax: number,
        tMin: number,
      ) => {
        const mi = idx >= 0 ? idx : moves.length + idx
        if (!moves[mi]) return false
        if (!matchesAny(moves[mi].moveId, nthMove.moveId)) return false
        if (d && moves[mi].damage < d) return false
        if (dMax && moves[mi].damage > dMax) return false
        if (t && moves[mi - 1]) {
          if (moves[mi].frame - moves[mi - 1].frame > t) return false
        }
        if (tMin && moves[mi - 1]) {
          if (moves[mi].frame - moves[mi - 1].frame < tMin) return false
        }
        return true
      }

      if (
        !nthMoves.every((nthMove: NthMoveDef) => {
          const t = safeInt(nthMove.t, 0, 0)
          const d = safeInt(nthMove.d, 0, 0)
          const dMax = safeInt(nthMove.dMax, 0, 0)
          const tMin = safeInt(nthMove.tMin, 0, 0)
          const nStr = String(nthMove.n).trim()

          // 'e' for every
          if (nStr === 'e') {
            return moves.every((move, moveIndex) => {
              if (!matchesAny(move.moveId, nthMove.moveId)) return false
              if (d && move.damage < d) return false
              if (dMax && move.damage > dMax) return false
              if (t && moves[moveIndex - 1]) {
                if (move.frame - moves[moveIndex - 1].frame > t) return false
              }
              if (tMin && moves[moveIndex - 1]) {
                if (move.frame - moves[moveIndex - 1].frame < tMin) return false
              }
              return true
            })
          }

          // comma-separated indices: any must match
          if (nStr.includes(',')) {
            const indices = nStr
              .split(',')
              .map((s: string) => parseInt(s.trim(), 10))
              .filter((v: number) => !Number.isNaN(v))
            if (indices.length === 0) return true
            return indices.some((idx: number) =>
              checkIndex(idx, nthMove, t, d, dMax, tMin),
            )
          }

          // single index
          const n = parseInt(nStr, 10)
          if (Number.isNaN(n)) return true
          return checkIndex(n, nthMove, t, d, dMax, tMin)
        })
      )
        return false
    }
    return true
  })
}
