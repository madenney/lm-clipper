import { SlippiGame } from '@slippi/slippi-js'
import {
  FileInterface,
  EventEmitterInterface,
  ClipInterface,
} from '../../constants/types'

export default (
  file: FileInterface[] | ClipInterface[],
  params: { [key: string]: any },
) => {
  const results: ClipInterface[] = []
  const {
    minHits,
    maxHits,
    comboerChar,
    comboerTag,
    comboeeChar,
    comboeeTag,
    didKill,
  } = params

  const { path, players, stage } = file
  if (!players) {
    console.log('No players?')
    return false
  }

  const game = new SlippiGame(path)
  let combos
  try {
    const stats = game.getStats()
    if (!stats) return false
    combos = stats.combos
  } catch (e) {
    return console.log('Broken file:', file)
  }
  const filteredCombos: ClipInterface[] = []
  combos.forEach((combo) => {
    if (!combo.moves || combo.moves.length === 0) return false
    if (minHits && combo.moves.length < minHits) return false
    if (maxHits && combo.moves.length > maxHits) return false
    const comboer = players.find(
      (p) => p && p.playerIndex === combo.moves[0].playerIndex
    )
    if (!comboer) return false
    const comboee = players.find((p) => p.playerIndex === combo.playerIndex)
    if (!comboee) return false
    if (comboerChar && comboerChar !== comboer.characterId.toString())
      return false
    if (comboerTag){
      const splitComboerTag = comboerTag.toLowerCase().split(";")
      if(splitComboerTag.indexOf(comboer.displayName.toLowerCase()) == -1){
        return false
      }
    }
    if (comboeeChar && comboeeChar !== comboee.characterId.toString())
      return false
    if (comboeeTag){
      const splitComboeeTag = comboeeTag.toLowerCase().split(";")
      if(splitComboeeTag.indexOf(comboee.displayName.toLowerCase()) == -1){
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
