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
    if (!matchesAny(comboer.characterId, comboerChar)) return false
    if (comboerTag && (!Array.isArray(comboerTag) || comboerTag.length > 0)) {
      const tags = Array.isArray(comboerTag)
        ? comboerTag.map((t: string) => t.toLowerCase())
        : comboerTag.toLowerCase().split(';')
      const name = (comboer.displayName || '').toLowerCase()
      if (tags.indexOf(name) == -1) {
        return false
      }
    }
    if (comboerCC && (!Array.isArray(comboerCC) || comboerCC.length > 0)) {
      const codes = Array.isArray(comboerCC)
        ? comboerCC.map((t: string) => t.toLowerCase())
        : comboerCC.toLowerCase().split(';')
      const code = (comboer.connectCode || '').toLowerCase()
      if (codes.indexOf(code) == -1) {
        return false
      }
    }
    if (!matchesAny(comboee.characterId, comboeeChar)) return false
    if (comboeeTag && (!Array.isArray(comboeeTag) || comboeeTag.length > 0)) {
      const tags = Array.isArray(comboeeTag)
        ? comboeeTag.map((t: string) => t.toLowerCase())
        : comboeeTag.toLowerCase().split(';')
      const name = (comboee.displayName || '').toLowerCase()
      if (tags.indexOf(name) == -1) {
        return false
      }
    }
    if (comboeeCC && (!Array.isArray(comboeeCC) || comboeeCC.length > 0)) {
      const codes = Array.isArray(comboeeCC)
        ? comboeeCC.map((t: string) => t.toLowerCase())
        : comboeeCC.toLowerCase().split(';')
      const code = (comboee.connectCode || '').toLowerCase()
      if (codes.indexOf(code) == -1) {
        return false
      }
    }
    if (!matchesAny(stage, comboStage)) return false
    if (didKill && !clip.combo.didKill) return false
    if (nthMoves && nthMoves.length > 0) {
      const checkIndex = (
        idx: number,
        nthMove: any,
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
        !nthMoves.every((nthMove: any) => {
          const t = parseInt(nthMove.t, 10)
          const d = parseInt(nthMove.d, 10)
          const dMax = parseInt(nthMove.dMax, 10)
          const tMin = parseInt(nthMove.tMin, 10)
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
