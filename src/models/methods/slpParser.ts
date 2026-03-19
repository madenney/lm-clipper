import { SlippiGame } from '@slippi/slippi-js'
import {
  FileInterface,
  ClipInterface,
  SlpParserParams,
} from '../../constants/types'
import { detectCombos } from './comboDetection'
import { matchesPlayer, safeInt } from '../../lib/filterHelpers'

type SlpParserResult = {
  combos: ClipInterface[]
  lastFrame?: number
}

export default (
  file: FileInterface,
  params: SlpParserParams,
): SlpParserResult => {
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
    comboTimeout,
  } = params

  const { path, players, stage, startedAt } = file
  if (!players) {
    return { combos: [] }
  }

  const game = new SlippiGame(path)
  let combos
  let lastFrame: number | undefined
  try {
    const settings = game.getSettings()
    const frames = game.getFrames()
    if (!settings || !frames) return { combos: [] }
    const timeout = safeInt(comboTimeout, 45, 1, 600)
    combos = detectCombos(frames, settings, timeout)
    // Discover lastFrame from frame data (free — already loaded)
    const metadata = game.getMetadata()
    lastFrame = metadata?.lastFrame ?? undefined
    if (!lastFrame || lastFrame <= 0) {
      const frameKeys = Object.keys(frames)
      if (frameKeys.length > 0) {
        lastFrame = Math.max(...frameKeys.map(Number))
      }
    }
  } catch (e) {
    console.warn('Broken file:', path)
    return { combos: [] }
  }
  if (!combos || combos.length === 0) return { combos: [], lastFrame }
  const filteredCombos: ClipInterface[] = []
  combos.forEach((combo) => {
    if (!combo.moves || combo.moves.length === 0) return false
    if (minHits && combo.moves.length < minHits) return false
    if (maxHits && combo.moves.length > maxHits) return false
    const comboer = players.find(
      (p) => p && p.playerIndex === combo.moves[0].playerIndex,
    )
    if (!comboer) return false
    const comboee = players.find(
      (p) => p && p.playerIndex === combo.playerIndex,
    )
    if (!comboee) return false
    if (!matchesPlayer(comboer, comboerChar, comboerTag, comboerCC))
      return false
    if (!matchesPlayer(comboee, comboeeChar, comboeeTag, comboeeCC))
      return false
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
  return { combos: filteredCombos, lastFrame }
}
