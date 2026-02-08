/* eslint-disable eqeqeq */
import { ClipInterface, EventEmitterInterface } from 'constants/types'

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
    if (comboerChar && comboerChar != comboer.characterId) return false
    if (comboerTag) {
      const splitComboerTag = comboerTag.toLowerCase().split(';')
      if (splitComboerTag.indexOf(comboer.displayName.toLowerCase()) == -1) {
        return false
      }
    }
    if (comboeeChar && comboeeChar != comboee.characterId) return false
    if (comboeeTag) {
      const splitComboeeTag = comboeeTag.toLowerCase().split(';')
      if (splitComboeeTag.indexOf(comboee.displayName.toLowerCase()) == -1) {
        return false
      }
    }
    if (comboStage && comboStage != stage) {
      return false
    }
    if (didKill && !clip.combo.didKill) return false
    if (nthMoves && nthMoves.length > 0) {
      if (
        !nthMoves.every((nthMove: any) => {
          const n = parseInt(nthMove.n, 10)
          const t = parseInt(nthMove.t, 10)
          const d = parseInt(nthMove.d, 10)

          if (Number.isNaN(n)) {
            // c for 'contains'
            if (nthMove.n === 'c') {
              const move = moves.find((m, moveIndex) => {
                if (m.moveId != nthMove.moveId) return false
                if (d && m.damage > d) return false
                if (t && moves[moveIndex - 1]) {
                  if (m.frame - moves[moveIndex - 1].frame > t) return false
                }
                return true
              })
              if (!move) return false
            }
            // e for 'every'
            if (nthMove.n === 'e') {
              const every = moves.every((move, moveIndex) => {
                if (move.moveId != nthMove.moveId) return false
                if (d && move.damage < d) return false
                if (t && moves[moveIndex - 1]) {
                  if (move.frame - moves[moveIndex - 1].frame > t) return false
                }
                return true
              })
              if (!every) return false
            }
          } else if (n >= 0) {
            if (!moves[n]) return false
            if (moves[n].moveId != nthMove.moveId) return false
            if (d && moves[n].damage < d) return false
            if (t && moves[n - 1]) {
              if (moves[n].frame - moves[n - 1].frame > t) return false
            }
          } else {
            if (!moves[moves.length + n]) return false
            if (moves[moves.length + n].moveId != nthMove.moveId) return false
            if (d && moves[moves.length + n].damage < d) return false
            if (t && moves[moves.length + n - 1]) {
              if (
                moves[moves.length + n].frame -
                  moves[moves.length + n - 1].frame >
                t
              )
                return false
            }
          }
          return true
        })
      )
        return false
    }
    return true
  })
}
