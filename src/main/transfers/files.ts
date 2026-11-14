import fs from 'fs'
import path from 'path'
import type { Transfer } from '../../constants/database'

/** Whether `target` is `folder` itself or inside it (both already resolved). */
export function isInside(target: string, folder: string): boolean {
  const relative = path.relative(folder, target)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}

/** Resolve symlinks for a path that may not exist yet, via its nearest
 *  existing ancestor, so a linked folder can't defeat a containment check. */
export function realPath(target: string): string {
  const missing: string[] = []
  let current = path.resolve(target)
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missing.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(target)
      missing.push(path.basename(current))
      current = parent
    }
  }
}

/** An unfinished download's partial archive, removed with its transfer. Only
 *  Clipper's own download file names in the transfer's folder are touched. */
export function discardPartial(job: {
  outputDir: string
  file?: string
  preparedPath?: string
}) {
  // A single-file download (the whole database) lives in a folder of the
  // user's: only its own partial file goes, never anything else there.
  if (job.file) {
    for (const name of [`${job.file}.part`, `${job.file}.part.json`])
      fs.rmSync(name, { force: true })
    return
  }
  for (const name of [
    'download.zip',
    'download.zip.part',
    'download.zip.part.json',
  ])
    fs.rmSync(path.join(job.outputDir, name), { force: true })
  // A paused or stopped unpack keeps its folder so Resume can carry on; it goes
  // only now, when the transfer is canceled or removed (only Clipper's own
  // replays-<id> folders in this transfer's folder, never a source).
  removeUnfinishedAttempts(job.outputDir, job.preparedPath).catch(() => {})
  // A direct download's plan (where its games are on storage), never replays.
  fs.rmSync(path.join(job.outputDir, DIRECT_DIR), {
    recursive: true,
    force: true,
  })
}

/**
 * Remove `replays-*` extraction attempts in a transfer's own folder, except the
 * completed one. Only folders matching Clipper's attempt naming are touched.
 */
export async function removeUnfinishedAttempts(
  outputDir: string,
  keep?: string,
): Promise<string[]> {
  let names: string[]
  try {
    names = await fs.promises.readdir(outputDir)
  } catch {
    return []
  }
  const removed: string[] = []
  for (const name of names) {
    const full = path.join(outputDir, name)
    if (!/^replays-[0-9a-f]{8}$/.test(name) || full === keep) continue
    const stat = await fs.promises.lstat(full)
    if (!stat.isDirectory()) continue
    await fs.promises.rm(full, { recursive: true, force: true })
    removed.push(full)
  }
  return removed
}

/** A library batch's replay paths (preparedPath points here); written once
 *  extraction finishes, since a batch's files are spread across the library. */
export const FILE_LIST_NAME = 'replays.json'

/** A direct snapshot download's plan folder inside the transfer's folder. */
export const DIRECT_DIR = 'direct'

/** "3 not available yet (newer than the stored games)". */
export function notStoredText(n: number): string {
  return `${n.toLocaleString()} not available yet (newer than the stored games)`
}

/** What to import for a prepared transfer: its extraction folder, or the file
 *  list of a batch extracted into the library. */
export function preparedImportPaths(preparedPath: string): string[] {
  if (path.basename(preparedPath) !== FILE_LIST_NAME) return [preparedPath]
  const list = JSON.parse(fs.readFileSync(preparedPath, 'utf8'))
  if (!Array.isArray(list)) throw new Error('Invalid prepared replay list.')
  return list.filter(
    (p): p is string => typeof p === 'string' && path.isAbsolute(p),
  )
}

/** "1,200 replays added · 40 already in project · 12 skipped (not 1v1 singles
 *  or under 20 seconds)": explains why the count can differ from the batch. */
export function importSummary(result: NonNullable<Transfer['result']>): string {
  const parts = [`${result.inserted.toLocaleString()} replays added`]
  if (result.duplicates)
    parts.push(`${result.duplicates.toLocaleString()} already in project`)
  if (result.skipped)
    parts.push(
      `${result.skipped.toLocaleString()} skipped (not 1v1 singles or under 20 seconds)`,
    )
  if (result.failed)
    parts.push(
      `${result.failed.toLocaleString()} failed (damaged or unreadable)`,
    )
  return parts.join(' · ')
}
