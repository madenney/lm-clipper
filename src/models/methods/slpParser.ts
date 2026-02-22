import { SlippiGame } from '@slippi/slippi-js'
import { FileInterface, ClipInterface } from '../../constants/types'

const matchesAny = (value: any, param: any) => {
  if (!param || (Array.isArray(param) && param.length === 0)) return true
  const arr = Array.isArray(param) ? param : [param]
  return arr.some((v: any) => String(v) === String(value))
}

export default (file: FileInterface, params: { [key: string]: any }) => {
  const results: ClipInterface[] = []
  const {
    minHits,
    maxHits,
    comboerChar,
    comboerTag,
    comboerCC,
    comboeeChar,
    comboeeTag,
    comboeeCC,
    didKill,
  } = params

  const { path, players, stage, startedAt } = file
  if (!players) {
    return []
  }

  const game = new SlippiGame(path)
  let combos
  try {
    const stats = game.getStats()
    if (!stats) return []
    combos = stats.combos
  } catch (e) {
    console.log('Broken file:', path)
    return []
  }
  if (!combos || combos.length === 0) return []
  const filteredCombos: ClipInterface[] = []
  combos.forEach((combo) => {
    if (!combo.moves || combo.moves.length === 0) return false
    if (minHits && combo.moves.length < minHits) return false
    if (maxHits && combo.moves.length > maxHits) return false
    const comboer = players.find(
      (p) => p && p.playerIndex === combo.moves[0].playerIndex,
    )
    if (!comboer) return false
    const comboee = players.find((p) => p.playerIndex === combo.playerIndex)
    if (!comboee) return false
    if (!matchesAny(comboer.characterId, comboerChar)) return false
    if (comboerTag && (!Array.isArray(comboerTag) || comboerTag.length > 0)) {
      const tags = Array.isArray(comboerTag)
        ? comboerTag.map((t: string) => t.toLowerCase())
        : comboerTag.toLowerCase().split(';')
      const name = (comboer.displayName || '').toLowerCase()
      if (tags.indexOf(name) === -1) {
        return false
      }
    }
    if (comboerCC && (!Array.isArray(comboerCC) || comboerCC.length > 0)) {
      const codes = Array.isArray(comboerCC)
        ? comboerCC.map((t: string) => t.toLowerCase())
        : comboerCC.toLowerCase().split(';')
      const code = (comboer.connectCode || '').toLowerCase()
      if (codes.indexOf(code) === -1) {
        return false
      }
    }
    if (!matchesAny(comboee.characterId, comboeeChar)) return false
    if (comboeeTag && (!Array.isArray(comboeeTag) || comboeeTag.length > 0)) {
      const tags = Array.isArray(comboeeTag)
        ? comboeeTag.map((t: string) => t.toLowerCase())
        : comboeeTag.toLowerCase().split(';')
      const name = (comboee.displayName || '').toLowerCase()
      if (tags.indexOf(name) === -1) {
        return false
      }
    }
    if (comboeeCC && (!Array.isArray(comboeeCC) || comboeeCC.length > 0)) {
      const codes = Array.isArray(comboeeCC)
        ? comboeeCC.map((t: string) => t.toLowerCase())
        : comboeeCC.toLowerCase().split(';')
      const code = (comboee.connectCode || '').toLowerCase()
      if (codes.indexOf(code) === -1) {
        return false
      }
    }
    if (didKill && !combo.didKill) return false

    return filteredCombos.push({
      startFrame: combo.startFrame,
      endFrame: combo.endFrame ? combo.endFrame : 0,
      comboer,
      comboee,
      path,
      stage,
      startedAt,
      combo: {
        startPercent: combo.startPercent,
        endPercent: combo.endPercent,
        moves: combo.moves,
        didKill: combo.didKill,
      },
    })
  })
  filteredCombos.forEach((c) => results.push(c))
  return results
}
