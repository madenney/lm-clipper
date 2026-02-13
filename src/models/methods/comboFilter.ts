/* eslint-disable eqeqeq */
import { ClipInterface, EventEmitterInterface } from 'constants/types'

const matchesAny = (value: any, param: any) => {
  if (!param || (Array.isArray(param) && param.length === 0)) return true
  const arr = Array.isArray(param) ? param : [param]
  return arr.some((v: any) => v == value)
}

export default (
  prevResults: ClipInterface[],
  params: { [key: string]: any },
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
      comboeeChar,
      comboeeTag,
      comboStage,
      didKill,
      excludeICs,
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
      if (numHits < minHits) return false
    }
    if (maxHits) {
      const numHits = countPummels
        ? moves.length
        : moves.filter((move) => move.moveId != 52).length
      if (numHits > maxHits) return false
    }
    if (minDamage && !(moves.reduce((n, m) => n + m.damage, 0) >= minDamage))
      return false
    if (excludeICs && comboer.characterId == 14) return false
    if (!matchesAny(comboer.characterId, comboerChar)) return false
    if (comboerTag && (!Array.isArray(comboerTag) || comboerTag.length > 0)) {
      const tags = Array.isArray(comboerTag)
        ? comboerTag.map((t: string) => t.toLowerCase())
        : comboerTag.toLowerCase().split(';')
      if (tags.indexOf(comboer.displayName.toLowerCase()) == -1) {
        return false
      }
    }
    if (!matchesAny(comboee.characterId, comboeeChar)) return false
    if (comboeeTag && (!Array.isArray(comboeeTag) || comboeeTag.length > 0)) {
      const tags = Array.isArray(comboeeTag)
        ? comboeeTag.map((t: string) => t.toLowerCase())
        : comboeeTag.toLowerCase().split(';')
      if (tags.indexOf(comboee.displayName.toLowerCase()) == -1) {
        return false
      }
    }
    if (!matchesAny(stage, comboStage)) return false
    if (didKill && !clip.combo.didKill) return false
    if (nthMoves && nthMoves.length > 0) {
      const checkDamage = (damage: number, threshold: number, mode: string) => {
        if (mode === 'max') return damage <= threshold
        return damage >= threshold
      }

      const checkIndex = (
        idx: number,
        nthMove: any,
        t: number,
        d: number,
        tMin: number,
        dMode: string,
      ) => {
        const mi = idx >= 0 ? idx : moves.length + idx
        if (!moves[mi]) return false
        if (!matchesAny(moves[mi].moveId, nthMove.moveId)) return false
        if (d && !checkDamage(moves[mi].damage, d, dMode)) return false
        if (t && moves[mi - 1]) {
          if (moves[mi].frame - moves[mi - 1].frame > t) return false
        }
        if (tMin && moves[mi - 1]) {
          if (moves[mi].frame - moves[mi - 1].frame < tMin) return false
        }
        return true
      }

      if (
        !nthMoves.every((nthMove: any) => {
          const t = parseInt(nthMove.t, 10)
          const d = parseInt(nthMove.d, 10)
          const tMin = parseInt(nthMove.tMin, 10)
          const dMode = nthMove.dMode || 'min'
          const nStr = String(nthMove.n).trim()

          // 'e' for every
          if (nStr === 'e') {
            return moves.every((move, moveIndex) => {
              if (!matchesAny(move.moveId, nthMove.moveId)) return false
              if (d && !checkDamage(move.damage, d, dMode)) return false
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
              checkIndex(idx, nthMove, t, d, tMin, dMode),
            )
          }

          // single index
          const n = parseInt(nStr, 10)
          if (Number.isNaN(n)) return true
          return checkIndex(n, nthMove, t, d, tMin, dMode)
        })
      )
        return false
    }
    return true
  })
}
