/**
 * Decompress one .slpz for import (models/ImportWorker.ts) with the slpz tool.
 *
 * The tool overwrites whatever is at its output path without asking, so the
 * output is reserved first ('wx', like replayExtraction.decompressReplay) and
 * an existing replay is never written over:
 * - the .slp is already there and is this same game (imported before, or the
 *   folder has both): it's reused, nothing is written;
 * - another replay has that name: the game gets a free name beside it
 *   (`<folder>_<name>.slp` when extracting, then `<name>-2.slp`, …).
 * Replace mode deletes the .slpz only once its .slp is there.
 */
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'

export type SlpzConfig = {
  slpzBinaryPath: string
  slpzMode: 'extract' | 'replace' | 'keep'
  slpzOutputDir: string
  /** A folder whose .slpz files are always kept as they are (the replay library). */
  keepInside?: string
}

/** Whether a .slpz is imported as it is (read in memory, lib/slippiGame.ts):
 *  "Keep compressed", and always inside Clipper's own library. */
export function keepsSlpz(slpzPath: string, config: SlpzConfig): boolean {
  if (config.slpzMode === 'keep') return true
  if (!config.keepInside) return false
  // Windows paths compare without case (C:\Users and c:\users are one folder).
  const norm = (p: string) =>
    process.platform === 'win32'
      ? path.resolve(p).toLowerCase()
      : path.resolve(p)
  return norm(slpzPath).startsWith(`${norm(config.keepInside)}${path.sep}`)
}

/**
 * The SLPZ wizard's default "extract to" folder: `slp` beside the .slpz files
 * when files were chosen, and `<folder>-slp` next to a chosen folder (e.g.
 * Replays/ranked -> Replays/ranked-slp). Never inside the chosen folder: the
 * import walks it while it decompresses, so it would find its own output.
 * (A folder used to get its parent's `slp`, Replays/slp, shared by every
 * folder in Replays.)
 */
export async function slpzDefaultOutputDir(
  filePaths: string[],
): Promise<string> {
  const slpz = filePaths.find((p) => path.extname(p).toLowerCase() === '.slpz')
  if (slpz) return path.join(path.dirname(slpz), 'slp')
  for (const p of filePaths) {
    try {
      if ((await fs.promises.stat(p)).isDirectory()) {
        const folder = path.resolve(p)
        return path.join(path.dirname(folder), `${path.basename(folder)}-slp`)
      }
    } catch {
      // Gone: try the next one.
    }
  }
  return filePaths[0] ? path.join(path.dirname(filePaths[0]), 'slp') : ''
}

/** Create the file if it isn't there; false when something already is. */
function reserve(file: string): boolean {
  try {
    fs.closeSync(fs.openSync(file, 'wx'))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return false
    throw error
  }
}

function sameBytes(a: string, b: string): boolean {
  const sa = fs.statSync(a)
  const sb = fs.statSync(b)
  if (sa.size !== sb.size) return false
  return fs.readFileSync(a).equals(fs.readFileSync(b))
}

function runSlpz(binary: string, source: string, destination: string) {
  try {
    execFileSync(binary, ['-d', '-q', '-o', destination, source], {
      timeout: 60000,
      // No console window flashing up per replay on Windows.
      windowsHide: true,
      stdio: 'ignore',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      `slpz decompression failed for ${path.basename(source)}: ${msg}`,
    )
  }
  if (fs.statSync(destination).size === 0)
    throw new Error(
      `slpz decompression produced an empty replay for ${path.basename(source)}`,
    )
}

/** Names to try after `<name>.slp`, in order. */
function otherNames(dir: string, base: string, parent: string | null) {
  const names: string[] = []
  if (parent) names.push(path.join(dir, `${parent}_${base}.slp`))
  for (let i = 2; i < 1000; i += 1)
    names.push(path.join(dir, `${base}-${i}.slp`))
  return names
}

/** Decompress `slpzPath`; returns the .slp to import. */
export function decompressSlpzForImport(
  slpzPath: string,
  config: SlpzConfig,
): string {
  const extract = config.slpzMode === 'extract' && !!config.slpzOutputDir
  const dir = extract ? config.slpzOutputDir : path.dirname(slpzPath)
  if (extract) fs.mkdirSync(dir, { recursive: true })
  const base = path.basename(slpzPath).replace(/\.slpz$/i, '')
  const target = path.join(dir, `${base}.slp`)

  let output: string
  if (reserve(target)) {
    try {
      runSlpz(config.slpzBinaryPath, slpzPath, target)
    } catch (error) {
      fs.rmSync(target, { force: true })
      throw error
    }
    output = target
  } else {
    // Something is already there: decompress beside it and compare.
    let temp = ''
    for (let i = 0; !temp; i += 1) {
      const candidate = path.join(dir, `.${base}.${process.pid}-${i}.slp.part`)
      if (reserve(candidate)) temp = candidate
    }
    try {
      runSlpz(config.slpzBinaryPath, slpzPath, temp)
      const parent = extract ? path.basename(path.dirname(slpzPath)) : null
      let found = ''
      for (const name of [target, ...otherNames(dir, base, parent)]) {
        if (name !== target && reserve(name)) {
          // A free name: over the empty file just reserved.
          fs.renameSync(temp, name)
          found = name
          break
        }
        // This same game, decompressed before: use it as it is.
        if (fs.existsSync(name) && sameBytes(temp, name)) {
          found = name
          break
        }
      }
      if (!found) throw new Error(`No free name for ${base}.slp in ${dir}`)
      output = found
    } finally {
      fs.rmSync(temp, { force: true })
    }
  }

  if (config.slpzMode === 'replace') {
    try {
      fs.unlinkSync(slpzPath)
    } catch {
      // Non-fatal: the .slp is there.
    }
  }
  return output
}
