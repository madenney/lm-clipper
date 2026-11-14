/* eslint-disable no-await-in-loop */
/*
 * Windows-flavoured file handling shared by recording, downloads and extraction:
 * retry a file operation when something (Defender, the Search indexer, OneDrive,
 * a just-killed child) still holds the file, and say a failed write in words.
 * Kept free of Electron and the recorder so any main-process module can use it.
 */
import { promises as fsp } from 'fs'
import path from 'path'
import { logMain } from './logger'

const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE'])

/**
 * Run a file operation, retrying with backoff when Windows still holds the file
 * (an antivirus scan, the indexer or a just-killed Dolphin/ffmpeg: EBUSY,
 * EPERM, EACCES). Throws the last error; callers decide whether that's fatal.
 */
export const retryFs = async <T>(
  op: () => Promise<T>,
  label: string,
  attempts = 6,
  baseDelayMs = 100,
): Promise<T> => {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await op()
    } catch (err) {
      lastErr = err
      const code = (err as { code?: string })?.code
      if (!code || !RETRYABLE.has(code) || i === attempts - 1) break
      await new Promise((resolve) => {
        setTimeout(resolve, baseDelayMs * 2 ** i)
      })
    }
  }
  logMain(`fs: ${label} failed`, {
    code: (lastErr as { code?: string })?.code,
    message: String((lastErr as Error)?.message ?? lastErr),
  })
  throw lastErr
}

/** Block the thread for `ms` (only for the short waits of retryFsSync). */
const sleepSync = (ms: number) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {
      /* spin */
    }
  }
}

/** retryFs for the few places that must stay synchronous (transfers.json).
 *  Waits at most ~0.4 s in total. */
export const retryFsSync = <T>(
  op: () => T,
  label: string,
  attempts = 5,
  baseDelayMs = 25,
): T => {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return op()
    } catch (err) {
      lastErr = err
      const code = (err as { code?: string })?.code
      if (!code || !RETRYABLE.has(code) || i === attempts - 1) break
      sleepSync(baseDelayMs * 2 ** i)
    }
  }
  logMain(`fs: ${label} failed`, {
    code: (lastErr as { code?: string })?.code,
    message: String((lastErr as Error)?.message ?? lastErr),
  })
  throw lastErr
}

/** Node syscalls of local file work (a network error carries 'connect' etc.). */
const FILE_SYSCALLS = new Set([
  'open',
  'mkdir',
  'rename',
  'write',
  'read',
  'unlink',
  'rmdir',
  'rm',
  'copyfile',
  'cp',
  'link',
  'symlink',
  'stat',
  'lstat',
  'scandir',
  'statfs',
  'utime',
  'chmod',
  'ftruncate',
  'close',
])

/** Did this error come from the local file system (not a network call)? */
export const isFileSystemError = (err: unknown): boolean => {
  const e = err as { code?: unknown; syscall?: unknown } | null
  if (!e || typeof e !== 'object' || typeof e.code !== 'string') return false
  if (typeof e.syscall === 'string') return FILE_SYSCALLS.has(e.syscall)
  return ['ENOSPC', 'EDQUOT', 'ENAMETOOLONG', 'EROFS', 'EISDIR'].includes(
    e.code,
  )
}

/** "D:\" on Windows, the folder elsewhere. */
export const driveOf = (
  folder: string,
  platform = process.platform,
): string => {
  if (platform === 'win32') {
    const m = /^[A-Za-z]:[\\/]/.exec(folder)
    if (m) return `${m[0][0].toUpperCase()}:\\`
  }
  return folder
}

export type FileSystemProblem = {
  kind: 'disk-full' | 'permission' | 'locked' | 'path-too-long' | 'read-only'
  message: string
}

/**
 * A failed file operation in words: a full drive, a folder Clipper may not
 * write to (read-only, Windows Controlled Folder Access, antivirus), a file
 * something else holds, a path too long. null for anything else.
 * `folder` names where the work was happening, for the message.
 */
export const describeFileSystemError = (
  err: unknown,
  folder?: string,
  platform = process.platform,
): FileSystemProblem | null => {
  const e = err as { code?: string; path?: string } | null
  const code = e?.code
  if (!code) return null
  const where = folder || (typeof e?.path === 'string' ? e.path : '')
  if (code === 'ENOSPC' || code === 'EDQUOT')
    return {
      kind: 'disk-full',
      message: `Your drive${where ? ` (${driveOf(where, platform)})` : ''} is full: free some space, or move the Replay Library in Settings > Paths.`,
    }
  if (!isFileSystemError(err)) return null
  if (code === 'ENAMETOOLONG')
    return {
      kind: 'path-too-long',
      message: `A file path is too long for Windows${where ? ` (${where})` : ''}. Choose a shorter folder in Settings > Paths.`,
    }
  if (code === 'EROFS')
    return {
      kind: 'read-only',
      message: `Clipper can't write to ${where || 'that folder'}: it is read-only.`,
    }
  if (code === 'EACCES' || code === 'EPERM')
    return {
      kind: 'permission',
      message: `Clipper can't write to ${where || 'that folder'}. Check the folder's permissions; on Windows, allow Lunar Clipper in Windows Security > Ransomware protection, or choose another folder.`,
    }
  if (code === 'EBUSY')
    return {
      kind: 'locked',
      message: `Something is locking a file in ${where || 'your replay folder'} (antivirus, OneDrive or the indexer?). Resume in a moment.`,
    }
  return null
}

// fs.statfs is available in Electron's Node runtime, but our older Node typings
// predate it (same compatibility cast as replayExtraction's requireDiskSpace).
type StatFs = (_p: string) => Promise<{ bavail: number; bsize: number }>
const statfsOf = (): StatFs | undefined =>
  (fsp as unknown as { statfs?: StatFs }).statfs

/** The nearest existing folder at or above `p` (the output subfolder or the
 *  scratch dir may not exist yet). */
export const existingAncestor = async (p: string): Promise<string> => {
  let cur = path.resolve(p)
  for (;;) {
    try {
      await fsp.stat(cur)
      return cur
    } catch {
      const up = path.dirname(cur)
      if (up === cur) return cur
      cur = up
    }
  }
}

/** Free bytes for this user on the drive holding `folder`; null when unknown
 *  (no statfs, or it failed): callers then skip the check rather than refuse. */
export const freeBytesAt = async (folder: string): Promise<number | null> => {
  const statfs = statfsOf()
  if (!statfs) return null
  try {
    const info = await statfs(await existingAncestor(folder))
    return info.bavail * info.bsize
  } catch {
    return null
  }
}

/** ffmpeg's way of saying an input file is still held by another process (Dolphin
 *  closing its dump, Defender scanning it): worth a short wait and one more try. */
export const isFileLockedText = (text: string): boolean =>
  /Permission denied|being used by another process|Resource busy/i.test(text)
