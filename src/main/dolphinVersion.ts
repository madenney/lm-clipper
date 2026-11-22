/**
 * Refuse a playback Dolphin older than 3.5.2 (2026-11-19).
 *
 * A Slippi replay carries Gecko codes, and Slippi Playback Dolphin before 3.5.2 ran them; with an SRAM bug in Dolphin
 * that let a crafted replay run code on the computer that played it (fixed in Playback 3.5.2, 2026-01-14:
 * https://khang06.github.io/slippirce/). Clipper plays replays from anywhere, the Lunar Database included, so it
 * neither plays nor records with an older Dolphin. The version comes from `Dolphin --version` (prints "3.5.2" and
 * exits, on Windows too, without a window), as the Slippi Launcher reads it.
 */
import { execFile } from 'child_process'
import { promises as fsPromises } from 'fs'

export const MIN_DOLPHIN_VERSION: [number, number, number] = [3, 5, 2]
export const MIN_DOLPHIN_TEXT = MIN_DOLPHIN_VERSION.join('.')

/** "3.5.2" (also inside longer text, e.g. "Slippi Dolphin 3.5.2-abc") as numbers, or null. */
export function parseDolphinVersion(
  text: string,
): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '')
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export const versionAtLeast = (
  v: [number, number, number],
  min: [number, number, number] = MIN_DOLPHIN_VERSION,
) => {
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i]
  return true
}

type Runner = (_file: string) => Promise<string>
const runVersion: Runner = (file) =>
  new Promise((resolve) => {
    execFile(
      file,
      ['--version'],
      { timeout: 20_000, windowsHide: true, maxBuffer: 64 * 1024 },
      (_err, stdout, stderr) => resolve(`${stdout ?? ''}\n${stderr ?? ''}`),
    )
  })

const cache = new Map<string, string>() // path + size + mtime -> version text (only good answers are kept)

/**
 * null when this Dolphin may play replays, otherwise the message to show. A Dolphin whose version cannot be read is
 * refused too: Clipper cannot tell it is safe.
 */
export async function dolphinVersionProblem(
  dolphinExe: string,
  run: Runner = runVersion,
): Promise<string | null> {
  let key = dolphinExe
  try {
    const st = await fsPromises.stat(dolphinExe)
    key = `${dolphinExe}|${st.size}|${st.mtimeMs}`
  } catch {
    return null // a missing file is reported by the existing checks, with their own wording
  }
  let text = cache.get(key)
  if (text === undefined) text = await run(dolphinExe)
  const v = parseDolphinVersion(text)
  if (!v)
    return `Clipper could not read this Dolphin's version, so it will not play replays with it. Use the Slippi Launcher's Playback Dolphin (${MIN_DOLPHIN_TEXT} or newer; Settings › Paths).`
  if (!versionAtLeast(v))
    return `Your Slippi Playback Dolphin is ${v.join('.')}. Versions before ${MIN_DOLPHIN_TEXT} can run harmful code hidden in a replay, so Clipper will not use it. Open the Slippi Launcher to update it (it updates by itself), then try again.`
  cache.set(key, text)
  return null
}

export function clearDolphinVersionCache() {
  cache.clear()
}
