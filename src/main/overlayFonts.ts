/**
 * Fonts the user imported for the video overlay (Settings > Overlay). Clipper
 * keeps its own copy of each in one folder of its data directory, so the
 * overlay keeps working when the original file is moved or deleted, and the
 * list is simply what is in that folder: nothing to keep in step with the
 * config, which only names the chosen file (`overlayFont`, '' = the bundled
 * font). No Electron here: the folder is passed in.
 */
import { promises as fsp } from 'fs'
import path from 'path'
import type { OverlayFont } from '../constants/types'
import { retryFs } from './fsRetry'
import { registerUserFont } from './overlayRenderer'

/** What the canvas library reads (checked against real files of each kind). */
export const OVERLAY_FONT_EXTS = ['.ttf', '.otf', '.ttc', '.woff', '.woff2']

// The biggest real fonts (CJK collections) are 20-30 MB.
export const OVERLAY_FONT_MAX_BYTES = 64 * 1024 * 1024

// `file` is the name inside the fonts folder (what `overlayFont` stores);
// `name` is what the list shows: the file name without its extension.
export type { OverlayFont }

export const overlayFontsDir = (userData: string): string =>
  path.join(userData, 'overlay-fonts')

const isFontName = (name: string): boolean =>
  OVERLAY_FONT_EXTS.includes(path.extname(name).toLowerCase()) &&
  !name.startsWith('.')

const toFont = (file: string): OverlayFont => ({
  file,
  name: path.basename(file, path.extname(file)),
})

/** The imported fonts, by name. A missing folder is an empty list. */
export async function listOverlayFonts(dir: string): Promise<OverlayFont[]> {
  let entries: import('fs').Dirent[] = []
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isFile() && isFontName(e.name))
    .map((e) => toFont(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
}

/**
 * The path of a chosen font, or null for the bundled one: '' or anything that
 * is not a plain font file name inside the folder (a stored name never reaches
 * outside it).
 */
export function overlayFontPath(
  dir: string,
  file: string | null | undefined,
): string | null {
  if (typeof file !== 'string' || !file) return null
  if (file !== path.basename(file) || !isFontName(file)) return null
  return path.join(dir, file)
}

/** A name safe on every file system, still recognisable as the user's file. */
const safeName = (original: string): string => {
  const ext = path.extname(original).toLowerCase()
  const stem =
    path
      .basename(original, path.extname(original))
      .replace(/[^\p{L}\p{N} ._()-]/gu, '_')
      .replace(/^[. ]+|[. ]+$/g, '')
      .slice(0, 80) || 'font'
  return `${stem}${ext}`
}

const sameFile = async (a: string, b: string): Promise<boolean> => {
  try {
    const [x, y] = await Promise.all([fsp.readFile(a), fsp.readFile(b)])
    return x.equals(y)
  } catch {
    return false
  }
}

export type OverlayFontImport = {
  imported: OverlayFont[]
  failed: { name: string; reason: string }[]
}

/**
 * Copy font files into the folder. Each is checked first: a real file of a
 * supported kind, not huge, and one the canvas library actually loads. A font
 * imported before is not copied again; a different file with the same name
 * gets " (2)".
 */
export async function importOverlayFonts(
  dir: string,
  sources: string[],
  loads: (_file: string) => boolean = (file) => registerUserFont(file) !== null,
): Promise<OverlayFontImport> {
  const result: OverlayFontImport = { imported: [], failed: [] }
  for (const source of sources) {
    const shown = path.basename(source)
    const fail = (reason: string) => result.failed.push({ name: shown, reason })
    try {
      if (!isFontName(shown)) {
        fail(`not a font file (${OVERLAY_FONT_EXTS.join(', ')})`)
        continue
      }
      // eslint-disable-next-line no-await-in-loop
      const st = await fsp.stat(source)
      if (!st.isFile() || st.size === 0) {
        fail('not a readable file')
        continue
      }
      if (st.size > OVERLAY_FONT_MAX_BYTES) {
        fail('the file is too big to be a font (over 64 MB)')
        continue
      }
      if (!loads(source)) {
        fail('this file could not be read as a font')
        continue
      }
      // eslint-disable-next-line no-await-in-loop
      await fsp.mkdir(dir, { recursive: true })
      const wanted = safeName(shown)
      const ext = path.extname(wanted)
      const stem = path.basename(wanted, ext)
      let file = wanted
      let already = false
      for (let n = 2; ; n += 1) {
        const target = path.join(dir, file)
        // eslint-disable-next-line no-await-in-loop
        const exists = await fsp.stat(target).then(
          () => true,
          () => false,
        )
        if (!exists) break
        // eslint-disable-next-line no-await-in-loop
        if (await sameFile(source, target)) {
          already = true
          break
        }
        file = `${stem} (${n})${ext}`
      }
      if (!already) {
        const target = path.join(dir, file)
        const partial = `${target}.partial`
        try {
          // eslint-disable-next-line no-await-in-loop
          await retryFs(() => fsp.copyFile(source, partial), `copy ${shown}`)
          // eslint-disable-next-line no-await-in-loop
          await retryFs(() => fsp.rename(partial, target), `rename ${file}`)
        } catch (err) {
          // eslint-disable-next-line no-await-in-loop
          await fsp.unlink(partial).catch(() => {})
          throw err
        }
      }
      result.imported.push(toFont(file))
    } catch (err) {
      fail((err as Error)?.message || 'could not be copied')
    }
  }
  return result
}

/** Delete Clipper's copy of a font (never the user's original). */
export async function removeOverlayFont(
  dir: string,
  file: string,
): Promise<boolean> {
  const target = overlayFontPath(dir, file)
  if (!target) return false
  try {
    await retryFs(() => fsp.unlink(target), `remove ${file}`)
    return true
  } catch {
    return false
  }
}
