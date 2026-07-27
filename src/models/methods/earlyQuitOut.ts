import { existsSync } from 'fs'
import { SlippiGame } from '@slippi/slippi-js'
import type { ComboType } from '@slippi/slippi-js/dist/stats/common'
import {
  FileInterface,
  ClipInterface,
  EarlyQuitOutParams,
} from '../../constants/types'
import { detectCombos } from './comboDetection'
import { matchesPlayer, safeInt } from '../../lib/filterHelpers'

/**
 * Early Quit Out parser.
 *
 * Finds the kills the combo parser MISSES: a player is comboed to a lethal
 * percent and, rather than let the stock be taken, holds L+R+A+Start to quit
 * the game ("No Contest"). Because the stock never actually decrements, the
 * combo detector never sets `didKill`, so these plays vanish from a normal
 * "did kill" search.
 *
 * We recover them by cross-referencing the combos against the game-end record,
 * which nothing else in the pipeline reads:
 *   - the game ended by No Contest (a quit), and
 *   - the player who quit (`lrasInitiatorIndex`) is the one being comboed, and
 *   - that combo ended right before the quit (it's the one they bailed on), and
 *   - the victim was at or above `killPercent` when they quit (would-be lethal).
 *
 * Emits at most one clip per game — the single combo the quit interrupted —
 * tagged `didKill: true` + `earlyQuit: true` so it flows through the kill-combo
 * machinery while staying distinguishable from a stock actually taken.
 */

// GameEndMethod.NO_CONTEST from @slippi/slippi-js — the game-end code written
// when a player quits out via L+R+A+Start, as opposed to the game ending on
// stocks (GAME = 2) or time (TIME = 1).
const NO_CONTEST = 7

// How close to the final frame the combo must end to count as "quit out of".
// Someone comboed who escapes and only quits several seconds later wasn't
// denied a kill; this window (frames @ 60fps) keeps us to the combo the quit
// actually interrupted, while staying generous enough to cover the victim's
// hitstun/tumble plus the frames it takes to input the quit.
const QUIT_WINDOW_FRAMES = 180

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
      lastFrame = Math.max(...frameNumbers)
    }
    const gameLastFrame =
      lastFrame && lastFrame > 0
        ? lastFrame
        : frameNumbers.length > 0
          ? Math.max(...frameNumbers)
          : 0

    // Only quit-outs are candidates. getGameEnd() gives the end method and,
    // for a quit, the index of the player who initiated it (held LRAStart).
    const gameEnd = game.getGameEnd()
    if (!gameEnd || gameEnd.gameEndMethod !== NO_CONTEST) {
      return { combos: [], lastFrame }
    }
    const quitterIndex = gameEnd.lrasInitiatorIndex
    // Older replays record the No Contest but not who quit — can't attribute
    // the denied kill to a victim, so skip rather than guess.
    if (quitterIndex == null || quitterIndex < 0) {
      return { combos: [], lastFrame }
    }

    const timeout = safeInt(comboTimeout, 45, 1, 600)
    const minPct = safeInt(killPercent, 80, 0, 999)
    const minHitsN = safeInt(minHits, 1, 1, 999)

    // The victim's percent at the moment they quit — the "would this have
    // killed?" gate. Read straight off the last frame carrying their post-frame
    // (the game-end frame itself may not), walking back a little if needed.
    let victimPercent = 0
    for (let f = gameLastFrame; f > gameLastFrame - 60 && f > -200; f -= 1) {
      const p = frames[f]?.players?.[quitterIndex]?.post?.percent
      if (typeof p === 'number') {
        victimPercent = p
        break
      }
    }
    if (victimPercent < minPct) return { combos: [], lastFrame }

    const combos = detectCombos(frames, settings, timeout)

    // The denied kill is the LAST combo on the quitter that did not actually
    // take a stock and ended right before the quit. An open combo (never
    // terminated because the game ended mid-combo) has a null endFrame — that's
    // precisely the combo the quit interrupted, so treat it as ending at game end.
    let best: ComboType | null = null
    let bestEnd = -Infinity
    for (const c of combos) {
      if (c.playerIndex !== quitterIndex) continue // victim must be the quitter
      if (c.didKill) continue // a stock actually fell — not a denied kill
      if (!c.moves || c.moves.length < minHitsN) continue
      const end = c.endFrame ?? gameLastFrame
      if (gameLastFrame - end > QUIT_WINDOW_FRAMES) continue
      if (end > bestEnd) {
        bestEnd = end
        best = c
      }
    }
    if (!best || !best.moves || best.moves.length === 0) {
      return { combos: [], lastFrame }
    }

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
