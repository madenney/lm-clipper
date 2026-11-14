/**
 * A look at the Melee ISO before recording, so a wrong or broken one is named
 * instead of ending as "Dolphin isn't starting" after three 90 s boot stalls
 * (measured on the Windows rig, 2026-10-15: a truncated ISO took 273 s).
 *
 * Only plain .iso files are read: compressed images (.gcz, .ciso, .rvz, .nkit)
 * have other headers and sizes, and Dolphin handles them itself.
 */
import { promises as fsPromises } from 'fs'
import path from 'path'

/** A full GameCube disc image. Trimmed ISOs are smaller and may still play. */
export const GAMECUBE_DISC_BYTES = 1_459_978_240

export type IsoCheck = {
  /** Recording can't work with this file: stop now with this message. */
  fatal: string | null
  /** Something to add if Dolphin then fails to start. */
  hint: string | null
}

export async function checkIso(isoPath: string): Promise<IsoCheck> {
  if (path.extname(isoPath).toLowerCase() !== '.iso')
    return { fatal: null, hint: null }
  let gameId = ''
  let size = 0
  try {
    const fd = await fsPromises.open(isoPath, 'r')
    try {
      const buf = Buffer.alloc(6)
      const { bytesRead } = await fd.read(buf, 0, 6, 0)
      gameId = buf.toString('latin1', 0, bytesRead)
      size = (await fd.stat()).size
    } finally {
      await fd.close()
    }
  } catch {
    // Unreadable now: the access check before this already said what it could.
    return { fatal: null, hint: null }
  }
  const name = path.basename(isoPath)
  if (gameId !== 'GALE01') {
    const what =
      gameId === 'GALP01'
        ? 'the PAL version of Melee (GALP01)'
        : gameId === 'GALJ01'
          ? 'the Japanese version of Melee (GALJ01)'
          : /^[\x20-\x7e]{6}$/.test(gameId)
            ? `another game (game ID "${gameId}")`
            : 'not a GameCube disc image'
    return {
      fatal: `The Melee ISO ${name} is ${what}. Slippi needs NTSC Melee (GALE01): choose that ISO in Settings.`,
      hint: null,
    }
  }
  if (size < GAMECUBE_DISC_BYTES) {
    const mb = (n: number) => Math.round(n / 1048576).toLocaleString()
    return {
      fatal: null,
      hint: `The Melee ISO ${name} is ${mb(size)} MB, smaller than a full disc (${mb(GAMECUBE_DISC_BYTES)} MB): it may be incomplete (an interrupted copy or download).`,
    }
  }
  return { fatal: null, hint: null }
}
