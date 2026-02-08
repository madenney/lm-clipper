import { promises as fsPromises } from 'fs'
import path from 'path'

type StreamOptions = {
  signal?: AbortSignal
}

const normalizeExtensions = (extensions: string[]) =>
  new Set(extensions.map((ext) => ext.toLowerCase()))

async function* streamFilePathsByExtension(
  _paths: string | string[],
  extensions: string[],
  options: StreamOptions = {},
) {
  const paths = Array.isArray(_paths) ? _paths : [_paths]
  const extSet = normalizeExtensions(extensions)
  const stack = [...paths]

  while (stack.length > 0) {
    if (options.signal?.aborted) return
    const currentPath = stack.pop()
    if (!currentPath) continue

    let stats
    try {
      stats = await fsPromises.lstat(currentPath)
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
          if (entry.isDirectory()) {
            stack.push(nextPath)
          } else if (entry.isFile()) {
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
  yield* streamFilePathsByExtension(_paths, ['.slp'], options)
}
