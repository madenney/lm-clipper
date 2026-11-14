/**
 * Files that Clipper's own cleanup (dev "reset all", the old-Untitled tidy-up) must
 * never move to the Trash or delete. The owner tools can name some
 * (owner/main ownerKeptPaths); in a public build the list is empty.
 */
import fs from 'fs'
import path from 'path'

const real = (p: string) => {
  const abs = path.resolve(p)
  try {
    return fs.realpathSync(abs)
  } catch {
    // Not there (yet): its folder may still be a link.
    try {
      return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs))
    } catch {
      return abs
    }
  }
}

const inside = (parent: string, child: string) => {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Whether removing `target` would touch a kept file: it is one of them (or its
 * SQLite -wal/-shm), or a folder that holds one.
 */
export function touchesKeptPath(target: string, kept: string[]): boolean {
  if (!kept.length) return false
  const t = real(target)
  return kept.some((k) => {
    const file = real(k)
    return (
      inside(t, file) ||
      t === `${file}-wal` ||
      t === `${file}-shm` ||
      t === `${file}-journal`
    )
  })
}

/** `targets` without the ones that would touch a kept file. */
export function withoutKeptPaths(
  targets: string[],
  kept: string[],
): { remove: string[]; skipped: string[] } {
  const remove: string[] = []
  const skipped: string[] = []
  for (const t of targets) (touchesKeptPath(t, kept) ? skipped : remove).push(t)
  return { remove, skipped }
}
