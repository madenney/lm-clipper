/**
 * Replays that disappeared from disk (docs/library-workspaces.md, Part D).
 * MissingCheckWorker checks a project's files when it opens; this module holds
 * the pure parts so they can be tested without a disk or SQLite.
 */
import path from 'path'

export type MissingReport = {
  projectPath: string
  /** Games checked. */
  total: number
  /** Games whose file isn't on disk now. */
  missing: number
  /** Games found at another path of the same recording and repointed. */
  repointed: number
  /** Whole folders that are gone (unplugged drive, moved or deleted folder). */
  folders: { folder: string; count: number }[]
  /** Missing games that came from the Lunar Database (can be downloaded again). */
  downloadable: string[]
}

/**
 * The highest folder of `filePath` that no longer exists, if the file is
 * missing because its folder is gone; null when the folder is still there (the
 * file itself was deleted or renamed). `exists` is injected for tests.
 */
export function goneFolderOf(
  filePath: string,
  exists: (_p: string) => boolean,
): string | null {
  let dir = path.dirname(filePath)
  if (exists(dir)) return null
  for (;;) {
    const parent = path.dirname(dir)
    if (parent === dir || exists(parent)) return dir
    dir = parent
  }
}

/** Missing files grouped by the folder that's gone; the rest are single files. */
export function groupGoneFolders(
  missingPaths: string[],
  exists: (_p: string) => boolean,
): { folders: { folder: string; count: number }[]; loose: number } {
  const counts = new Map<string, number>()
  // Folders are shared by many files: remember answers.
  const cache = new Map<string, boolean>()
  const cachedExists = (p: string) => {
    let v = cache.get(p)
    if (v === undefined) {
      v = exists(p)
      cache.set(p, v)
    }
    return v
  }
  let loose = 0
  for (const p of missingPaths) {
    const gone = goneFolderOf(p, cachedExists)
    if (gone) counts.set(gone, (counts.get(gone) ?? 0) + 1)
    else loose++
  }
  const folders = [...counts]
    .map(([folder, count]) => ({ folder, count }))
    .sort((a, b) => b.count - a.count)
  return { folders, loose }
}

/**
 * Locate…: match missing files to files found under a folder the user picked,
 * by file name, using the size when known to pick between same-named files.
 * Returns old path -> new path for every confident match.
 */
export function matchMoved(
  missing: { path: string; size: number | null }[],
  found: { path: string; size: number }[],
): Map<string, string> {
  const byName = new Map<string, { path: string; size: number }[]>()
  for (const f of found) {
    const name = path.basename(f.path).toLowerCase()
    const list = byName.get(name)
    if (list) list.push(f)
    else byName.set(name, [f])
  }
  const remap = new Map<string, string>()
  const used = new Set<string>()
  for (const m of missing) {
    const candidates = (
      byName.get(path.basename(m.path).toLowerCase()) ?? []
    ).filter((c) => !used.has(c.path))
    const sized =
      m.size != null ? candidates.filter((c) => c.size === m.size) : candidates
    // One candidate (by size when known), or the only file of that name.
    const pick =
      sized.length === 1
        ? sized[0]
        : m.size == null && candidates.length === 1
          ? candidates[0]
          : null
    if (pick) {
      remap.set(m.path, pick.path)
      used.add(pick.path)
    }
  }
  return remap
}
