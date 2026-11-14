// What to tell the user when an import finishes. A silent no-op reads as
// "drag and drop is broken", and silently dropped games read as lost ones,
// so say what was added and why anything was left out.
import {
  describeFailures,
  describeSkips,
  type FailCounts,
  type SkipCounts,
} from '../lib/importSkips'

export type ImportFinished = {
  cancelled?: boolean
  inserted?: number
  skipped?: number
  /** Skipped files per reason (lib/importSkips.ts). */
  skippedReasons?: SkipCounts
  duplicates?: number
  failed?: number
  /** Failed (broken) files per reason (lib/importSkips.ts). */
  failedReasons?: FailCounts
}

export const NOTICE_EVENT = 'lunar-notice'

// Show a short message in the app's notice line (App.tsx listens).
export function showNotice(message: string) {
  window.dispatchEvent(new CustomEvent(NOTICE_EVENT, { detail: message }))
}

const n = (count: number) => count.toLocaleString()
const plural = (count: number, one: string, many: string) =>
  `${n(count)} ${count === 1 ? one : many}`

export function importResultNotice(result: ImportFinished): string | null {
  if (result.cancelled) return null
  // Older main processes don't send counts; say nothing rather than guess.
  if (typeof result.inserted !== 'number') return null
  const duplicates = result.duplicates ?? 0
  const failed = result.failed ?? 0
  const skipped = result.skipped ?? 0
  // Why files were left out: skipped ones by reason (a .slpz left compressed,
  // a game that isn't 1v1, ...), then the broken ones (unreadable, damaged or
  // cut off), which count as failed.
  const left = describeSkips(result.skippedReasons)
  if (!left.length && skipped > 0)
    left.push(`${plural(skipped, 'file', 'files')} skipped`)
  const broken = describeFailures(result.failedReasons)
  left.push(...broken)
  if (!broken.length && failed > 0)
    left.push(
      `${plural(failed, 'file', 'files')} could not be read as Slippi replays`,
    )

  if (result.inserted > 0) {
    // A plain successful import says nothing (the tray shows the games).
    if (!left.length) return null
    return `Added ${plural(result.inserted, 'game', 'games')}. ${left.join('. ')}.`
  }
  if (duplicates > 0 && !left.length) {
    return duplicates === 1
      ? 'That replay is already in this project.'
      : `Those ${n(duplicates)} replays are already in this project.`
  }
  if (left.length) {
    const parts =
      duplicates > 0
        ? [
            `${plural(duplicates, 'replay', 'replays')} already in this project`,
            ...left,
          ]
        : left
    return `Nothing added. ${parts.join('. ')}.`
  }
  return 'No Slippi replays (.slp or .slpz) found there.'
}

// A drop that carried no readable file paths, e.g. files dragged straight out
// of a .zip in Windows Explorer (they aren't real files on disk yet).
export const NO_PATHS_NOTICE =
  "Couldn't read those files. If they're inside a .zip, drop the .zip itself or extract it first."
