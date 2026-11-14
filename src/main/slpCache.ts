/**
 * Decoded copies of .slpz replays for Dolphin, which only plays real .slp
 * files (lib/slpz.ts). Watching a clip (VideoManager.playClipAsync) and
 * recording (slpToVideo.processOneReplay) ask playableSlp() for a path:
 * a .slp is used where it is; a .slpz is decoded once into this cache and
 * reused while it's unchanged (key: its path, size and mtime).
 *
 * The cache is Clipper's own folder (<temp>/lunar-clipper-slp-cache) and only
 * ever holds these copies: pruning deletes nothing else, never a library or
 * user file. It's kept under a size cap (default 2 GB, oldest first), files
 * untouched for a week go, and a file used in the last 30 minutes is never
 * pruned (a Dolphin may still be reading it). Each use refreshes its mtime.
 */
import crypto from 'crypto'
import { promises as fsp } from 'fs'
import os from 'os'
import path from 'path'
import { isSlpzPath, readReplayBytesAsync } from '../lib/slpz'

const DEFAULT_CAP_BYTES = 2 * 1024 * 1024 * 1024
const KEEP_RECENT_MS = 30 * 60 * 1000
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const NAME_RE = /^[0-9a-f]{24}\.slp$/
const PART_RE = /^[0-9a-f]{24}\.slp\.[0-9a-z.-]+\.part$/

// A folder per user: a shared, predictable name in a shared temp folder (multi-user
// Linux) would let one user's files sit in, or block, another's.
const userTag = (): string => {
  if (typeof process.getuid === 'function') return String(process.getuid())
  try {
    return os
      .userInfo()
      .username.replace(/[^A-Za-z0-9_-]/g, '_')
      .slice(0, 40)
  } catch {
    return 'user'
  }
}

/** Dolphin and ffmpeg are not long-path aware (Windows MAX_PATH is 260; the same
 *  margin as diskSpace.WINDOWS_PATH_LIMIT): a replay deeper than this is handed
 *  over as a copy in this short cache path (launch review WIN-13). */
export const WINDOWS_LONG_PATH = 240

let cacheDir = path.join(os.tmpdir(), `lunar-clipper-slp-cache-${userTag()}`)
let capBytes = DEFAULT_CAP_BYTES

/** Tests (and a future setting): where the cache lives and how big it may get. */
export function configureSlpCache(opts: { dir?: string; capBytes?: number }) {
  if (opts.dir) cacheDir = path.resolve(opts.dir)
  if (opts.capBytes !== undefined) capBytes = Math.max(0, opts.capBytes)
}

export function slpCacheDir() {
  return cacheDir
}

const inFlight = new Map<string, Promise<string>>()

/** A .slp Dolphin can open for `file`: the file itself, or a copy in the short
 *  cache path (a decoded .slpz, or a .slp whose path is too long on Windows). */
export async function playableSlp(
  file: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (!isSlpzPath(file)) {
    if (platform !== 'win32' || path.resolve(file).length < WINDOWS_LONG_PATH)
      return file
  }
  const st = await fsp.stat(file)
  const key = crypto
    .createHash('sha1')
    .update(`${path.resolve(file)}\0${st.size}\0${Math.floor(st.mtimeMs)}`)
    .digest('hex')
    .slice(0, 24)
  const out = path.join(cacheDir, `${key}.slp`)
  const running = inFlight.get(out)
  if (running) return running
  const job = (async () => {
    try {
      const now = new Date()
      await fsp.utimes(out, now, now)
      return out
    } catch {
      /* not cached yet */
    }
    const bytes = await readReplayBytesAsync(file)
    await fsp.mkdir(cacheDir, { recursive: true })
    const part = `${out}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.part`
    try {
      await fsp.writeFile(part, bytes, { flag: 'wx' })
      await fsp.rename(part, out)
    } catch (error) {
      await fsp.rm(part, { force: true }).catch(() => {})
      throw error
    }
    pruneSlpCache().catch(() => {})
    return out
  })().finally(() => inFlight.delete(out))
  inFlight.set(out, job)
  return job
}

/**
 * Bring the cache under its cap: old copies first, never one used in the last
 * 30 minutes. Only names this module writes are touched. Returns bytes removed.
 */
export async function pruneSlpCache(now = Date.now()): Promise<number> {
  let names: string[]
  try {
    names = await fsp.readdir(cacheDir)
  } catch {
    return 0
  }
  const files: { p: string; size: number; mtime: number }[] = []
  for (const name of names) {
    if (!NAME_RE.test(name) && !PART_RE.test(name)) continue
    const p = path.join(cacheDir, name)
    try {
      const st = await fsp.lstat(p)
      if (!st.isFile()) continue
      // A .part left by a crash is garbage once it's old.
      if (PART_RE.test(name)) {
        if (now - st.mtimeMs > KEEP_RECENT_MS) await fsp.rm(p, { force: true })
        continue
      }
      files.push({ p, size: st.size, mtime: st.mtimeMs })
    } catch {
      /* gone */
    }
  }
  files.sort((a, b) => a.mtime - b.mtime)
  let total = files.reduce((n, f) => n + f.size, 0)
  let removed = 0
  for (const f of files) {
    const recent = now - f.mtime < KEEP_RECENT_MS
    if (recent) break
    if (total <= capBytes && now - f.mtime < MAX_AGE_MS) continue
    try {
      await fsp.rm(f.p, { force: true })
      total -= f.size
      removed += f.size
    } catch {
      // In use (Windows): next time.
    }
  }
  return removed
}
