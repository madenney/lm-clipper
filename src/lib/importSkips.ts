/**
 * Why an import left files out, counted per reason, so the result notice and
 * the console can say so ("4 games skipped: not 1v1"). Two kinds:
 *  - skipped, on purpose: games Clipper doesn't import (not 1v1, under 20
 *    seconds, no stage) and .slpz files the user chose to skip. Files already
 *    in the project are counted apart, as duplicates.
 *  - failed, the file is broken: it couldn't be read as a Slippi replay at
 *    all, or it's damaged or cut off (no metadata, no end of game).
 * models/Archive.ts counts them; main/managers/ImportManager.ts logs them;
 * renderer/importNotice.ts shows them.
 */

export type SkipReason =
  /** .slpz files left out ("Skip .slpz files" in the SLPZ wizard). */
  | 'slpz'
  /** Teams, free-for-all or one-player games (models/File.ts: Clipper
   *  imports 1v1 games only). */
  | 'not1v1'
  /** Games under 20 seconds (models/File.ts). */
  | 'short'
  /** No stage in the game settings. */
  | 'noStage'

export type SkipCounts = Partial<Record<SkipReason, number>>

export type FailReason =
  /** Not readable as a Slippi replay: the parser threw, or there are no game
   *  settings (random bytes, an empty file, another format named .slp). */
  | 'unreadable'
  /** Readable start, but damaged or cut off: no metadata or no end frame. */
  | 'incomplete'

export type FailCounts = Partial<Record<FailReason, number>>

export type InvalidReason =
  | { kind: 'skipped'; reason: SkipReason }
  | { kind: 'failed'; reason: FailReason }

/** Why models/File.ts marked a game invalid (its `info`): a game Clipper
 *  leaves out on purpose, or a broken file. */
export function invalidReasonFor(
  info: string | null | undefined,
): InvalidReason {
  switch (info) {
    case 'teams':
    case '!2 players':
      return { kind: 'skipped', reason: 'not1v1' }
    case 'Game Length < 20 seconds':
      return { kind: 'skipped', reason: 'short' }
    case 'Invalid stage':
      return { kind: 'skipped', reason: 'noStage' }
    case 'Bad settings':
      return { kind: 'failed', reason: 'unreadable' }
    default:
      // 'Bad metadata', 'No lastFrame in metadata', 'No length', or anything
      // unknown: the replay is damaged or ends early.
      return { kind: 'failed', reason: 'incomplete' }
  }
}

const n = (count: number) => count.toLocaleString()
const games = (count: number) =>
  `${n(count)} ${count === 1 ? 'game' : 'games'} skipped`
const files = (count: number) => `${n(count)} ${count === 1 ? 'file' : 'files'}`

/** One line per reason, in a fixed order; empty when nothing was skipped. */
export function describeSkips(counts: SkipCounts | null | undefined): string[] {
  if (!counts) return []
  const lines: string[] = []
  const c = (reason: SkipReason) => counts[reason] ?? 0
  if (c('not1v1'))
    lines.push(
      `${games(c('not1v1'))}: not 1v1, e.g. teams or 4-player free-for-all (Clipper imports 1v1 games only)`,
    )
  if (c('short')) lines.push(`${games(c('short'))}: shorter than 20 seconds`)
  if (c('noStage')) lines.push(`${games(c('noStage'))}: no stage in the replay`)
  if (c('slpz'))
    lines.push(
      `Skipped ${n(c('slpz'))} .slpz ${c('slpz') === 1 ? 'file' : 'files'} (not decompressed)`,
    )
  return lines
}

/** One line per reason for broken files; empty when none failed. */
export function describeFailures(
  counts: FailCounts | null | undefined,
): string[] {
  if (!counts) return []
  const lines: string[] = []
  const c = (reason: FailReason) => counts[reason] ?? 0
  if (c('unreadable'))
    lines.push(`${files(c('unreadable'))} could not be read as Slippi replays`)
  if (c('incomplete'))
    lines.push(
      `${files(c('incomplete'))} could not be read: damaged or cut off before the game ended`,
    )
  return lines
}

/** "added 196 games, 4 already in the project" for the console. */
export function importSummary(inserted: number, duplicates: number): string {
  const parts = [`added ${n(inserted)} ${inserted === 1 ? 'game' : 'games'}`]
  if (duplicates > 0) parts.push(`${n(duplicates)} already in the project`)
  return parts.join(', ')
}

/** All skipped files, whatever the reason. */
export function totalSkips(counts: SkipCounts | null | undefined): number {
  if (!counts) return 0
  return Object.values(counts).reduce((sum, v) => sum + (v ?? 0), 0)
}
