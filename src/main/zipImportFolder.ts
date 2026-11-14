/**
 * Where a ZIP import unpacks its replays, the same place every time for the
 * same ZIP, so importing it again adds nothing: its replays are at the same
 * paths and import skips paths already in the project. (Each import used to
 * unpack into a new random folder, so a second import of the same ZIP added
 * every game again.) Like the .slpz fix (lib/slpzDecompress.ts): the same game
 * keeps the same path.
 *
 * The folder is `<output folder>/<zip name>-<fingerprint>/replays`. The
 * fingerprint comes from the ZIP's directory (each replay entry's name, CRC-32
 * and size; the file's bytes aren't read), so a renamed or moved copy of the
 * same ZIP is found too. A marker written once the unpacking finishes tells a
 * finished folder from one an interrupted import left half done (that one is
 * unpacked again).
 */
import crypto from 'crypto'
import path from 'path'
import { promises as fsp } from 'fs'
import { openPromise } from 'yauzl'
import { isReplayPath } from '../lib/replayPath'

const MARKER = '.clipper-zip-complete'

/** A short id of the ZIP's replays (names, CRC-32s and sizes). */
export async function zipFingerprint(zipPath: string): Promise<string> {
  const zip = await openPromise(zipPath, {
    lazyEntries: true,
    strictFileNames: false,
  })
  const entries: string[] = []
  try {
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName.endsWith('/') || !isReplayPath(entry.fileName))
        continue
      entries.push(
        `${entry.fileName}\0${entry.crc32}\0${entry.uncompressedSize}`,
      )
    }
  } finally {
    zip.close()
  }
  // Order in the ZIP doesn't matter: the same replays are the same ZIP.
  entries.sort()
  return crypto
    .createHash('sha256')
    .update(entries.join('\n'))
    .digest('hex')
    .slice(0, 12)
}

async function isFinished(dir: string) {
  try {
    await fsp.access(path.join(dir, MARKER))
    return (await fsp.stat(path.join(dir, 'replays'))).isDirectory()
  } catch {
    return false
  }
}

/** A finished unpacking of this ZIP in `outputDir` (under any name). */
async function findFinished(outputDir: string, fingerprint: string) {
  let names: string[] = []
  try {
    names = await fsp.readdir(outputDir)
  } catch {
    return null
  }
  for (const name of names) {
    if (!name.endsWith(`-${fingerprint}`)) continue
    const dir = path.join(outputDir, name)
    if (await isFinished(dir)) return dir
  }
  return null
}

export type ZipFolder = {
  /** The folder of replays to import. */
  replaysDir: string
  /** Unpacked by an earlier import: nothing was extracted this time. */
  reused: boolean
}

/**
 * The replays folder for this ZIP: an earlier finished unpacking when there
 * is one, else a fresh one filled by `extract(replaysDir)`. A failed or
 * cancelled extraction leaves nothing behind (and the error is thrown).
 */
export async function zipImportFolder(
  zipPath: string,
  outputDir: string,
  extract: (_replaysDir: string) => Promise<unknown>,
): Promise<ZipFolder> {
  const fingerprint = await zipFingerprint(zipPath)
  await fsp.mkdir(outputDir, { recursive: true })
  const earlier = await findFinished(outputDir, fingerprint)
  if (earlier)
    return { replaysDir: path.join(earlier, 'replays'), reused: true }

  const zipName = path.basename(zipPath).replace(/\.zip$/i, '')
  const batchDir = path.join(outputDir, `${zipName}-${fingerprint}`)
  // Half done by an interrupted import: start it again.
  await fsp.rm(batchDir, { recursive: true, force: true })
  await fsp.mkdir(batchDir)
  const replaysDir = path.join(batchDir, 'replays')
  try {
    await extract(replaysDir)
    await fsp.writeFile(
      path.join(batchDir, MARKER),
      JSON.stringify({ zip: path.basename(zipPath), fingerprint }),
    )
  } catch (error) {
    await fsp.rm(batchDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  return { replaysDir, reused: false }
}
