import { promises as fsPromises, Dirent, Stats } from 'fs'
import path from 'path'

type StreamOptions = {
  signal?: AbortSignal
}

const normalizeExtensions = (extensions: string[]) =>
  new Set(extensions.map((ext) => ext.toLowerCase()))

export type EntryKind = 'file' | 'dir' | 'skip'

// On Windows, directory listings report EVERY reparse point as a symlink,
// including OneDrive / cloud-synced files and folders (Documents\Slippi is
// often OneDrive-backed), so trusting the Dirent alone silently skipped them.
// When the listing says neither file nor folder, ask lstat, which only calls
// real symlinks and junctions links. Those stay skipped (no loops, no
// escaping the dropped folder).
function kindFromStats(stats: Stats): EntryKind {
  if (stats.isSymbolicLink()) return 'skip'
  if (stats.isDirectory()) return 'dir'
  if (stats.isFile()) return 'file'
  return 'skip'
}

export async function entryKind(
  entry: Dirent,
  fullPath: string,
): Promise<EntryKind> {
  if (entry.isDirectory()) return 'dir'
  if (entry.isFile()) return 'file'
  try {
    return kindFromStats(await fsPromises.lstat(fullPath))
  } catch {
    return 'skip'
  }
}

async function* streamFilePathsByExtension(
  _paths: string | string[],
  extensions: string[],
  options: StreamOptions = {},
) {
  const paths = Array.isArray(_paths) ? _paths : [_paths]
  const extSet = normalizeExtensions(extensions)
  const stack = [...paths]
  // Paths the user picked or dropped are followed even if they are links;
  // only links found inside a folder are skipped.
  const chosen = new Set(paths)

  while (stack.length > 0) {
    if (options.signal?.aborted) return
    const currentPath = stack.pop()
    if (!currentPath) continue

    let stats
    try {
      stats = chosen.has(currentPath)
        ? await fsPromises.stat(currentPath)
        : await fsPromises.lstat(currentPath)
    } catch (error) {
      continue
    }

    if (stats.isDirectory()) {
      let dir
      try {
        dir = await fsPromises.opendir(currentPath)
      } catch (error) {
        continue
      }

      let aborted = false
      try {
        for await (const entry of dir) {
          if (options.signal?.aborted) {
            aborted = true
            break
          }

          const nextPath = path.resolve(currentPath, entry.name)
          // eslint-disable-next-line no-await-in-loop
          const kind = await entryKind(entry, nextPath)
          if (kind === 'dir') {
            stack.push(nextPath)
          } else if (kind === 'file') {
            const ext = path.extname(entry.name).toLowerCase()
            if (extSet.has(ext)) yield nextPath
          }
        }
      } catch (error) {
        const { code } = error as NodeJS.ErrnoException
        if (options.signal?.aborted && code === 'ERR_DIR_CLOSED') return
        throw error
      }
      if (aborted || options.signal?.aborted) return
      continue
    }

    if (stats.isFile()) {
      const ext = path.extname(currentPath).toLowerCase()
      if (extSet.has(ext)) yield currentPath
    }
  }
}

export async function* streamSlpFilePaths(
  _paths: string | string[],
  options: StreamOptions = {},
) {
  yield* streamFilePathsByExtension(_paths, ['.slp', '.slpz'], options)
}
