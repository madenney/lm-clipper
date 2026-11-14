import { existsSync } from 'fs'
import { createHash } from 'crypto'
import { readReplayBytes } from '../../lib/slpz'
import { SlippiGame } from '../../lib/slippiGame'
import {
  FileInterface,
  ClipInterface,
  SlpParserParams,
} from '../../constants/types'
import { detectCombos } from '../../vendor/replay-analysis'
import { matchesPlayer, maxOf, safeInt } from '../../lib/filterHelpers'
import { COMBO_DETECTOR, DetectionCache } from '../detectionCache'

type SlpParserResult = {
  combos: ClipInterface[]
  lastFrame?: number
  // Set when the .slp file could not be read. 'missing' = file moved/deleted,
  // 'corrupt' = file exists but failed to parse. Used by Worker.ts to report
  // an aggregated summary instead of silently returning zero combos.
  readError?: 'missing' | 'corrupt'
}

type DetectedCombos = {
  combos: ReturnType<typeof detectCombos>
  lastFrame?: number
}

export default (
  file: FileInterface,
  params: SlpParserParams,
  cache?: DetectionCache,
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

  let combos
  let lastFrame: number | undefined
  const timeout = safeInt(comboTimeout, 45, 1, 600)
  // Only the timeout changes what the detector finds; every other setting
  // filters its output below. So the raw combos are cached per game + timeout.
  const key = { ...COMBO_DETECTOR, paramsKey: String(timeout) }
  const cached = cache?.get<DetectedCombos>(path, key)
  try {
    if (cached?.data) {
      ;({ combos, lastFrame } = cached.data)
    } else {
      // One read: the same bytes are hashed (the game's identity in the
      // library's detector cache) and parsed. A .slpz is decoded first, so the
      // hash is the .slp's whichever way the game is stored.
      const bytes = cache ? readReplayBytes(path) : null
      const game = new SlippiGame(bytes ?? path)
      const settings = game.getSettings()
      const frames = game.getFrames()
      if (!settings || !frames) return { combos: [] }
      combos = detectCombos(frames, settings, timeout)
      // Discover lastFrame from frame data (free — already loaded)
      const metadata = game.getMetadata()
      lastFrame = metadata?.lastFrame ?? undefined
      if (!lastFrame || lastFrame <= 0) {
        const numericKeys = Object.keys(frames)
          .map(Number)
          .filter((n) => !Number.isNaN(n))
        if (numericKeys.length > 0) {
          lastFrame = maxOf(numericKeys)
        }
      }
      if (cache && bytes && cached?.seen)
        cache.put(
          cached.seen,
          createHash('md5').update(bytes).digest('hex'),
          key,
          { combos, lastFrame } satisfies DetectedCombos,
        )
    }
  } catch (e) {
    // Only stat on the failure path so the happy path pays nothing. A missing
    // path means the file was moved/deleted (or its drive unmounted); otherwise
    // the file exists but couldn't be parsed.
    return { combos: [], readError: existsSync(path) ? 'corrupt' : 'missing' }
  }
  if (!combos || combos.length === 0) return { combos: [], lastFrame }
  const filteredCombos: ClipInterface[] = []
  combos.forEach((combo) => {
    if (!combo.moves || combo.moves.length === 0) return false
    if (minHits && combo.moves.length < Number(minHits)) return false
    if (maxHits && combo.moves.length > Number(maxHits)) return false
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
