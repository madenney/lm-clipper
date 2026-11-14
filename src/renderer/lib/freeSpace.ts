/**
 * Before a big download: does it fit? Main reports the free space on the Replay Library's drive
 * (`library.freeBytes`) when it can. The check is advisory, it never blocks: sizes are estimates,
 * and the library compresses.
 */
import { formatBytes } from '../../lib/format'

export type FreeSpaceNote = { level: 'ok' | 'tight' | 'short'; text: string }

/** What to say about `needBytes` against `freeBytes`; null when the free space is unknown. */
export function freeSpaceNote(
  needBytes: number,
  freeBytes: number | null | undefined,
): FreeSpaceNote | null {
  if (
    typeof freeBytes !== 'number' ||
    !Number.isFinite(freeBytes) ||
    freeBytes < 0
  )
    return null
  if (!(needBytes > 0)) return null
  const free = formatBytes(freeBytes)
  const need = formatBytes(needBytes)
  if (needBytes > freeBytes) {
    return {
      level: 'short',
      text: `This is about ${need}, but only ${free} is free on the drive with your Replay Library. Free some space or move the library (Settings, Paths) first, or pick fewer games.`,
    }
  }
  if (needBytes > freeBytes * 0.8) {
    return {
      level: 'tight',
      text: `About ${need} of the ${free} free on the drive with your Replay Library. That is nearly all of it.`,
    }
  }
  return {
    level: 'ok',
    text: `${free} free on the drive with your Replay Library.`,
  }
}
