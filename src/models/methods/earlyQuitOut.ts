import { existsSync } from 'fs'
import { SlippiGame } from '../../lib/slippiGame'
import {
  FileInterface,
  ClipInterface,
  EarlyQuitOutParams,
} from '../../constants/types'
import { findEarlyQuitOut } from '../../vendor/replay-analysis'
import { matchesPlayer, maxOf, safeInt } from '../../lib/filterHelpers'

/**
 * Early Quit Out parser: the kills the combo parser misses because the victim
 * quit (L+R+A+Start) instead of losing the stock. The detection is
 * findEarlyQuitOut in the shared replay-analysis package; this file applies
 * Clipper's parameters and player filters and shapes the clip, tagged
 * `didKill: true` + `earlyQuit: true` so it flows through the kill-combo
 * machinery while staying distinguishable from a stock actually taken.
 */

type EarlyQuitOutResult = {
  combos: ClipInterface[]
  lastFrame?: number
  // Mirrors slpParser: 'missing' = file moved/deleted, 'corrupt' = unreadable.
  readError?: 'missing' | 'corrupt'
}

export default (
  file: FileInterface,
  params: EarlyQuitOutParams,
): EarlyQuitOutResult => {
  const {
    minHits,
    comboerChar,
    comboerTag,
    comboerCC,
    comboeeChar,
    comboeeTag,
    comboeeCC,
    comboTimeout,
    killPercent,
  } = params

  const { path, players, stage, startedAt } = file
  if (!players) return { combos: [] }

  let lastFrame: number | undefined
  try {
    const game = new SlippiGame(path)
    const settings = game.getSettings()
    const frames = game.getFrames()
    if (!settings || !frames) return { combos: [] }

    // Discover lastFrame from frame data (free — already loaded). Done before
    // any early return so metadata-stripped files still get backfilled by the
    // Worker's lastFrame update, exactly like the combo parser.
    const metadata = game.getMetadata()
    lastFrame = metadata?.lastFrame ?? undefined
    const frameNumbers = Object.keys(frames)
      .map(Number)
      .filter((n) => !Number.isNaN(n))
    if ((!lastFrame || lastFrame <= 0) && frameNumbers.length > 0) {
      lastFrame = maxOf(frameNumbers)
    }

    const found = findEarlyQuitOut(
      frames,
      settings,
      game.getGameEnd(),
      metadata?.lastFrame,
      {
        comboTimeout: safeInt(comboTimeout, 45, 1, 600),
        killPercent: safeInt(killPercent, 80, 0, 999),
        minHits: safeInt(minHits, 1, 1, 999),
      },
    )
    if (!found) return { combos: [], lastFrame }
    const { combo: best, victimPercent, gameLastFrame } = found

    const comboer = players.find(
      (p) => p && p.playerIndex === best!.moves![0].playerIndex,
    )
    const comboee = players.find(
      (p) => p && p.playerIndex === best!.playerIndex,
    )
    if (!comboer || !comboee) return { combos: [], lastFrame }
    if (!matchesPlayer(comboer, comboerChar, comboerTag, comboerCC))
      return { combos: [], lastFrame }
    if (!matchesPlayer(comboee, comboeeChar, comboeeTag, comboeeCC))
      return { combos: [], lastFrame }

    const clip: ClipInterface = {
      startFrame: best.startFrame,
      // End at the quit itself, so the clip runs through them bailing rather
      // than cutting at the last hit (an open combo has no endFrame anyway).
      endFrame: gameLastFrame,
      comboer,
      comboee,
      path,
      stage,
      startedAt,
      combo: {
        startPercent: best.startPercent,
        endPercent: best.endPercent ?? victimPercent,
        moves: best.moves,
        // It would have been a kill; tag earlyQuit so the UI can tell it apart
        // from a stock actually taken.
        didKill: true,
        earlyQuit: true,
      },
    }
    return { combos: [clip], lastFrame }
  } catch (e) {
    // Match slpParser: a missing path means the file moved/deleted (or its
    // drive unmounted); otherwise it exists but couldn't be parsed.
    return { combos: [], readError: existsSync(path) ? 'corrupt' : 'missing' }
  }
}
