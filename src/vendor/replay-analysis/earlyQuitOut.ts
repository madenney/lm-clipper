/*
 * Early quit-outs: the kills the combo parser MISSES. A player is comboed to a
 * lethal percent and, rather than let the stock be taken, holds L+R+A+Start to
 * quit ("No Contest"). The stock never decrements, so the combo never sets
 * `didKill` and the play vanishes from a normal kill search.
 *
 * Found by cross-referencing the combos against the game-end record:
 *   - the game ended by No Contest (a quit), and
 *   - the player who quit (`lrasInitiatorIndex`) is the one being comboed, and
 *   - that combo ended right before the quit (it's the one they bailed on), and
 *   - the victim was at or above `killPercent` when they quit (would-be lethal).
 * At most one per game: the single combo the quit interrupted.
 */
import { detectCombos, DEFAULT_COMBO_TIMEOUT } from './combos'
import type { Combo, Frames, GameSettings } from './types'

// GameEndMethod.NO_CONTEST from @slippi/slippi-js — the game-end code written
// when a player quits out via L+R+A+Start, as opposed to the game ending on
// stocks (GAME = 2) or time (TIME = 1).
const NO_CONTEST = 7

// How close to the final frame the combo must end to count as "quit out of".
// Someone comboed who escapes and only quits several seconds later wasn't
// denied a kill; this window (frames @ 60fps) keeps us to the combo the quit
// actually interrupted, while staying generous enough to cover the victim's
// hitstun/tumble plus the frames it takes to input the quit.
export const QUIT_WINDOW_FRAMES = 180

export type EarlyQuitOutOpts = {
  comboTimeout: number
  killPercent: number
  minHits: number
}

export const DEFAULT_EARLY_QUIT_OUT_OPTS: EarlyQuitOutOpts = {
  comboTimeout: DEFAULT_COMBO_TIMEOUT,
  killPercent: 80,
  minHits: 1,
}

export type EarlyQuitOut = {
  /** The combo the quit interrupted; `playerIndex` is the quitter. */
  combo: Combo
  quitterIndex: number
  /** The quitter's percent when they quit. */
  victimPercent: number
  /** Last frame of the game (the quit). */
  gameLastFrame: number
}

/**
 * The denied kill in a game that ended by quit-out, or null. `lastFrame` is the
 * metadata's last frame when known; otherwise the last frame present is used.
 */
export function findEarlyQuitOut(
  frames: Frames,
  settings: GameSettings,
  gameEnd:
    | { gameEndMethod?: number | null; lrasInitiatorIndex?: number | null }
    | null
    | undefined,
  lastFrame: number | null | undefined,
  opts: EarlyQuitOutOpts = DEFAULT_EARLY_QUIT_OUT_OPTS,
): EarlyQuitOut | null {
  // Only quit-outs are candidates.
  if (!gameEnd || gameEnd.gameEndMethod !== NO_CONTEST) return null
  // A loop, not Math.max(...numbers): an hours-long game has more frames than
  // a call can take as arguments.
  let gameLastFrame = 0
  if (lastFrame && lastFrame > 0) gameLastFrame = lastFrame
  else
    for (const key of Object.keys(frames)) {
      const n = Number(key)
      if (!Number.isNaN(n) && n > gameLastFrame) gameLastFrame = n
    }
  const quitterIndex = gameEnd.lrasInitiatorIndex
  // Older replays record the No Contest but not who quit — can't attribute
  // the denied kill to a victim, so skip rather than guess.
  if (quitterIndex == null || quitterIndex < 0) return null

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
  if (victimPercent < opts.killPercent) return null

  const combos = detectCombos(frames, settings, opts.comboTimeout)

  // The denied kill is the LAST combo on the quitter that did not actually
  // take a stock and ended right before the quit. An open combo (never
  // terminated because the game ended mid-combo) has a null endFrame — that's
  // precisely the combo the quit interrupted, so treat it as ending at game end.
  let best: Combo | null = null
  let bestEnd = -Infinity
  for (const c of combos) {
    if (c.playerIndex !== quitterIndex) continue // victim must be the quitter
    if (c.didKill) continue // a stock actually fell — not a denied kill
    if (!c.moves || c.moves.length < opts.minHits) continue
    const end = c.endFrame ?? gameLastFrame
    if (gameLastFrame - end > QUIT_WINDOW_FRAMES) continue
    if (end > bestEnd) {
      bestEnd = end
      best = c
    }
  }
  if (!best || !best.moves || best.moves.length === 0) return null
  return { combo: best, quitterIndex, victimPercent, gameLastFrame }
}
