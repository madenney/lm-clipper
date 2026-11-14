import path from 'path'
import fs, { promises as fsp } from 'fs'
import zlib from 'zlib'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { openPromise } from 'yauzl'
import { BUNDLE_MANIFEST_NAME } from '../constants/database'
import { SlpzError, decodeSlpz, slpzSupported } from '../lib/slpz'
import { existingAncestor, retryFs } from './fsRetry'
import {
  LibraryEntry,
  LibraryLookup,
  REPLAY_ID_RE,
  libraryFileFor,
  libraryRelativePath,
} from './replayLibrary'

const execFileAsync = promisify(execFile)
export type ExtractionProgress = (
  _current: number,
  _total: number | null,
  _detail: string,
) => void

export function checkAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Transfer paused.')
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** One archive path segment made safe to create on this platform: control
 *  characters, and on Windows the characters it forbids, trailing dots and
 *  spaces and reserved device names (CON, NUL, COM1...). Names from the full
 *  database ("Genesis 9: Pools") must unpack on Windows, not abort the run. */
export function portableSegment(
  segment: string,
  platform: NodeJS.Platform = process.platform,
): string {
  let out = [...segment].map((c) => (c.charCodeAt(0) < 32 ? '_' : c)).join('')
  if (platform === 'win32') out = out.replace(/[<>:"|?*]/g, '_')
  else if (platform === 'darwin') out = out.replace(/:/g, '_')
  if (platform === 'win32') {
    out = out.replace(/[. ]+$/, '')
    if (WINDOWS_RESERVED.test(out)) out = `_${out}`
  }
  if (out.length > 200) {
    const ext = path.extname(out).slice(0, 12)
    out = out.slice(0, 200 - ext.length) + ext
  }
  return out || '_'
}

/**
 * Where an archive entry goes under `root`. Rejects what could escape it (a
 * `..` segment, an absolute or drive path); the rest of the name is made safe
 * for the platform (portableSegment) rather than refused, and backslashes count
 * as separators (older Windows tools wrote them).
 */
export function safeArchivePath(
  root: string,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const parts = name.replace(/\\/g, '/').split('/')
  if (
    !name ||
    parts.some((p) => p === '..') ||
    /^[a-zA-Z]:/.test(name) ||
    path.posix.isAbsolute(name) ||
    path.win32.isAbsolute(name)
  ) {
    throw new Error('Archive contains an unsafe file path.')
  }
  const target = path.resolve(
    root,
    ...parts
      .filter((p) => p && p !== '.')
      .map((p) => portableSegment(p, platform)),
  )
  if (
    target !== path.resolve(root) &&
    !target.startsWith(`${path.resolve(root)}${path.sep}`)
  )
    throw new Error('Archive path escapes its output folder.')
  return target
}

/**
 * Throws when `folder`'s drive has less than `bytes` (+64 MB) free. An unknown
 * free size (no statfs, a network share, a folder that is not made yet: the
 * nearest existing parent is asked) never blocks: the write itself reports a
 * full drive. Neither does a statfs error.
 */
export async function requireDiskSpace(folder: string, bytes: number) {
  const statfs = (
    fsp as unknown as {
      statfs?: (_p: string) => Promise<{ bavail: number; bsize: number }>
    }
  ).statfs
  if (!statfs) return
  let free: number
  try {
    const info = await statfs(await existingAncestor(folder))
    free = info.bavail * info.bsize
  } catch {
    return
  }
  if (free < bytes + 64 * 1024 * 1024)
    throw Object.assign(
      new Error('Not enough free disk space in the destination folder.'),
      { code: 'ENOSPC' },
    )
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

const nativeCrc32 = (
  zlib as unknown as {
    crc32?: (_data: Uint8Array, _value?: number) => number
  }
).crc32

/** CRC-32 of `chunk` continuing from `crc` (zlib's when this Node has it: the
 *  per-byte loop below took minutes over the full database). */
export function crc32Update(crc: number, chunk: Uint8Array): number {
  if (nativeCrc32) return nativeCrc32(chunk, crc)
  let c = ~crc >>> 0
  for (const byte of chunk) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8)
  return ~c >>> 0
}

function crcVerifier(expected: number) {
  let crc = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      crc = crc32Update(crc, chunk)
      callback(null, chunk)
    },
    flush(callback) {
      callback(
        crc >>> 0 === expected
          ? null
          : new Error('ZIP checksum mismatch. Download the archive again.'),
      )
    },
  })
}

/** Upper bound on .slp size relative to its .slpz (the database estimates 8x). */
const SLPZ_EXPANSION = 12

/** A .slpz this big or smaller is decoded in this process (a few ms); bigger
 *  ones go to the bundled tool. */
const IN_PROCESS_SLPZ_BYTES = 64 * 1024 * 1024

export async function decompressReplay(
  source: string,
  destination: string,
  binary: string,
  signal?: AbortSignal,
) {
  checkAborted(signal)
  // SLPZ is roughly 8x smaller than the replay; leave room for the expansion.
  await requireDiskSpace(
    path.dirname(destination),
    (await fsp.stat(source)).size * SLPZ_EXPANSION,
  )
  // Never let the decompressor overwrite an existing replay.
  const handle = await fsp.open(destination, 'wx')
  try {
    // In this process when Node can (Electron's can): no program started per
    // replay, which made unpacking the full database take days.
    if (
      slpzSupported() &&
      (await fsp.stat(source)).size <= IN_PROCESS_SLPZ_BYTES
    ) {
      try {
        const slp = decodeSlpz(await fsp.readFile(source))
        await handle.writeFile(slp)
        await handle.close()
        return
      } catch (error) {
        // Not decodable here (damaged, or an odd .slpz): the tool decides.
        if (!(error instanceof SlpzError)) throw error
      }
    }
    await handle.close()
    await execFileAsync(binary, ['-d', '-o', destination, source], {
      signal,
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      // No console window flashing up per replay on Windows.
      windowsHide: true,
    })
    if ((await fsp.stat(destination)).size === 0)
      throw new Error('Decompressor produced an empty replay.')
  } catch (error) {
    await handle.close().catch(() => {})
    await fsp.unlink(destination).catch(() => {})
    if (signal?.aborted) throw new Error('Transfer paused.')
    // A full or protected drive is not the replay's fault: say so.
    const code = (error as { code?: string })?.code
    if (code === 'ENOSPC' || code === 'EACCES' || code === 'EPERM') throw error
    throw new Error(
      `Could not decompress ${path.basename(source)}. Check the SLPZ executable and source file.`,
    )
  }
}

const REPLAY_NAME = /\.slp[z]?$/i
const caseFolds = (platform: NodeJS.Platform) =>
  platform === 'win32' || platform === 'darwin'

/** `target`, or "name (2).ext" when another entry already took it. */
function uniqueTarget(
  target: string,
  taken: Set<string>,
  platform: NodeJS.Platform,
): string {
  const key = (p: string) => (caseFolds(platform) ? p.toLowerCase() : p)
  let candidate = target
  const ext = path.extname(target)
  const stem = target.slice(0, target.length - ext.length)
  for (let n = 2; taken.has(key(candidate)); n++)
    candidate = `${stem} (${n})${ext}`
  taken.add(key(candidate))
  return candidate
}

/** Extract the replays of a ZIP into `destination`. Non-replay entries are
 *  ignored; the source is preserved. Archives cannot traverse existing symlinks
 *  or overwrite user files. Each replay is written as a `.part` and renamed once
 *  verified, so a stopped run leaves only whole replays under their real names.
 *
 *  Without `resume` the destination MUST be new. With it (a transfer that was
 *  paused) the folder may exist and replays already extracted are skipped, so
 *  pausing a multi-hour unpack of the full database loses nothing. */
export async function extractReplayZip(
  source: string,
  destination: string,
  options: {
    signal?: AbortSignal
    onProgress?: ExtractionProgress
    slpzBinary?: string
    /** Entries to leave out (e.g. replays already extracted by an earlier bundle). */
    skipEntry?: (_name: string) => boolean
    /** Allow a result of zero extracted replays (everything was skipped). */
    allowEmpty?: boolean
    /** Leave .slpz entries compressed (Clipper's own transfer folders only). */
    keepSlpz?: boolean
    /** The destination may exist: skip replays already extracted into it. */
    resume?: boolean
    /** Names are made safe for this platform (tests). */
    platform?: NodeJS.Platform
  } = {},
) {
  checkAborted(options.signal)
  const platform = options.platform ?? process.platform
  await fsp.mkdir(destination, { recursive: !!options.resume })
  // Names older Windows tools wrote with backslashes are separators, not errors.
  const zip = await openPromise(source, {
    lazyEntries: true,
    strictFileNames: false,
  })
  let count = 0
  let visited = 0
  const taken = new Set<string>()
  try {
    for await (const entry of zip.eachEntry()) {
      checkAborted(options.signal)
      visited++
      options.onProgress?.(visited, zip.entryCount, entry.fileName)
      // Anything that is not a replay is ignored before any other check: a
      // stray "notes: final.txt" or a macOS alias must not end the whole run.
      if (
        entry.fileName.endsWith('/') ||
        !REPLAY_NAME.test(entry.fileName) ||
        options.skipEntry?.(entry.fileName)
      )
        continue
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000
      if (mode && mode !== 0x8000 && mode !== 0x4000)
        throw new Error('Archive contains a link or unsupported special file.')
      const safe = safeArchivePath(destination, entry.fileName, platform)
      if (entry.isEncrypted())
        throw new Error('Password-protected ZIP files are not supported.')
      const decode =
        /\.slpz$/i.test(safe) && !!options.slpzBinary && !options.keepSlpz
      // After the rename to .slp, so "a.slp" and "a.slpz" cannot meet.
      const final = uniqueTarget(
        decode ? safe.replace(/\.slpz$/i, '.slp') : safe,
        taken,
        platform,
      )
      if (options.resume && fs.existsSync(final)) {
        count++
        continue
      }
      await requireDiskSpace(destination, entry.uncompressedSize)
      await fsp.mkdir(path.dirname(final), { recursive: true })
      const part = `${final}.part`
      await retryFs(() => fsp.rm(part, { force: true }), `rm ${part}`)
      const stream = await zip.openReadStreamPromise(entry)
      const signal = options.signal || new AbortController().signal
      try {
        await pipeline(
          stream,
          crcVerifier(entry.crc32),
          fs.createWriteStream(part, { flags: 'wx' }),
          { signal },
        )
        if (decode) {
          const unpacked = `${final}.unpacked`
          await retryFs(
            () => fsp.rm(unpacked, { force: true }),
            `rm ${unpacked}`,
          )
          try {
            await decompressReplay(
              part,
              unpacked,
              options.slpzBinary!,
              options.signal,
            )
          } catch (error) {
            await fsp.rm(unpacked, { force: true })
            throw error
          }
          await retryFs(() => fsp.rename(unpacked, final), `rename ${unpacked}`)
          // This is the extracted copy; the original archive is retained.
          await fsp.rm(part, { force: true })
        } else {
          await retryFs(() => fsp.rename(part, final), `rename ${part}`)
        }
      } catch (error) {
        await fsp.rm(part, { force: true }).catch(() => {})
        throw error
      }
      count++
    }
  } finally {
    zip.close()
  }
  if (!count && !options.allowEmpty)
    throw new Error('No SLP or SLPZ replays were found in this ZIP.')
  return count
}

export type BundleManifestEntry = {
  file: string
  replayId: string
  fileHash: string
}

/** Read lunar-manifest.json from a database export bundle; null when absent or
 *  malformed (older bundles have none). */
export async function readBundleManifest(
  source: string,
): Promise<BundleManifestEntry[] | null> {
  const zip = await openPromise(source, {
    lazyEntries: true,
    strictFileNames: true,
  })
  try {
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName !== BUNDLE_MANIFEST_NAME) continue
      if (entry.uncompressedSize > 64 * 1024 * 1024) return null
      const chunks: Buffer[] = []
      for await (const chunk of await zip.openReadStreamPromise(entry))
        chunks.push(Buffer.from(chunk))
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (parsed?.version !== 1 || !Array.isArray(parsed.replays)) return null
      return parsed.replays.filter(
        (r: unknown): r is BundleManifestEntry =>
          !!r &&
          typeof (r as BundleManifestEntry).file === 'string' &&
          typeof (r as BundleManifestEntry).fileHash === 'string' &&
          /^[\w.-]{1,128}$/.test((r as BundleManifestEntry).fileHash),
      )
    }
    return null
  } catch {
    return null
  } finally {
    zip.close()
  }
}

/** The replay library as extraction sees it (replayLibrary.ts, run on the DB
 *  worker in the app; a plain object in tests). */
export type LibraryAccess = {
  folder: string
  /** Store new downloads as .slpz (keepDownloadsCompressed; default true). */
  compress?: boolean
  lookup: (
    _replayIds: string[],
    _fileHashes: string[],
  ) => Promise<LibraryLookup>
  register: (_entries: LibraryEntry[]) => Promise<unknown>
  /** Games on disk, and how many came from the Lunar Database. */
  summary?: () => Promise<LibrarySummary>
}

export type LibrarySummary = { games: number; fromDatabase: number }

/**
 * Extract a database export bundle into the replay library: each replay goes
 * to its fixed place (libraryRelativePath), replays the library already has
 * (same replayId, or the same recording under another id) are not extracted
 * again, and every new file is registered. Returns the absolute paths of all
 * the bundle's replays, new and already present, for importing as one batch;
 * or null when the bundle has no usable manifest (the caller extracts it the
 * old way into its own folder).
 *
 * Files are written as `.part` and renamed only once complete and verified, so
 * an interrupted run never leaves a truncated replay at its library path, and
 * a rerun picks up where it stopped.
 */
export async function extractBundleIntoLibrary(
  source: string,
  library: LibraryAccess,
  slpzBinary: string,
  signal?: AbortSignal,
  onProgress?: ExtractionProgress,
): Promise<{ files: string[]; extracted: number; reused: number } | null> {
  const manifest = await readBundleManifest(source)
  if (
    !manifest?.length ||
    !manifest.every((r) => REPLAY_ID_RE.test(r.replayId))
  )
    return null
  const { have, haveHashes } = await library.lookup(
    manifest.map((r) => r.replayId),
    manifest.map((r) => r.fileHash),
  )
  const files: string[] = []
  const register: LibraryEntry[] = []
  const wanted = new Map<string, BundleManifestEntry & { target: string }>()
  let reused = 0
  for (const r of manifest) {
    const existing = have[r.replayId] || haveHashes[r.fileHash]
    if (existing) {
      files.push(existing)
      reused++
      // Same recording under another id: remember it under this id too.
      if (!have[r.replayId]) register.push({ ...r, path: existing })
    } else {
      // Kept compressed (library.compress): a .slpz entry stays .slpz.
      const ext = library.compress && /\.slpz$/i.test(r.file) ? '.slpz' : '.slp'
      wanted.set(r.file, {
        ...r,
        target: path.join(library.folder, libraryRelativePath(r.replayId, ext)),
      })
    }
  }
  const flush = async () => {
    if (register.length) await library.register(register.splice(0))
  }

  let extracted = 0
  if (wanted.size) {
    const zip = await openPromise(source, {
      lazyEntries: true,
      strictFileNames: true,
    })
    let visited = 0
    try {
      for await (const entry of zip.eachEntry()) {
        checkAborted(signal)
        visited++
        onProgress?.(visited, zip.entryCount, entry.fileName)
        const want = wanted.get(entry.fileName)
        if (!want) continue
        wanted.delete(entry.fileName)
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000
        if (mode && mode !== 0x8000)
          throw new Error(
            'Archive contains a link or unsupported special file.',
          )
        if (entry.isEncrypted())
          throw new Error('Password-protected ZIP files are not supported.')
        let { target } = want
        const existing = libraryFileFor(library.folder, want.replayId)
        if (existing) target = existing
        else {
          await fsp.mkdir(path.dirname(target), { recursive: true })
          await requireDiskSpace(path.dirname(target), entry.uncompressedSize)
          const part = `${target}.part`
          await pipeline(
            await zip.openReadStreamPromise(entry),
            crcVerifier(entry.crc32),
            fs.createWriteStream(part),
            { signal: signal || new AbortController().signal },
          )
          if (/\.slpz$/i.test(target)) {
            // Stored as it came (CRC checked above).
            await retryFs(() => fsp.rename(part, target), `rename ${part}`)
          } else if (/\.slpz$/i.test(entry.fileName)) {
            const unpacked = `${target}.unpacked`
            await fsp.rm(unpacked, { force: true })
            try {
              await decompressReplay(part, unpacked, slpzBinary, signal)
            } finally {
              await fsp.rm(part, { force: true })
            }
            await retryFs(
              () => fsp.rename(unpacked, target),
              `rename ${unpacked}`,
            )
          } else await retryFs(() => fsp.rename(part, target), `rename ${part}`)
          extracted++
        }
        files.push(target)
        register.push({
          replayId: want.replayId,
          fileHash: want.fileHash,
          path: target,
        })
        if (register.length >= 200) await flush()
      }
    } finally {
      zip.close()
      // Whatever finished is kept and registered, even if a later entry failed.
      await flush()
    }
  }
  await flush()
  if (!files.length)
    throw new Error('No SLP or SLPZ replays were found in this ZIP.')
  return { files, extracted, reused }
}

export async function extractReplayFiles(
  sources: string[],
  destination: string,
  binary: string,
  signal?: AbortSignal,
  onProgress?: ExtractionProgress,
  /** The destination may exist (a paused unpack): replays already there are skipped. */
  options: { resume?: boolean } = {},
) {
  const resume = !!options.resume
  await fsp.mkdir(destination, { recursive: resume })
  let count = 0
  const make = (dir: string) => fsp.mkdir(dir, { recursive: resume })
  async function visit(source: string, target: string): Promise<void> {
    checkAborted(signal)
    const stat = await fsp.lstat(source)
    if (stat.isSymbolicLink())
      throw new Error('Symbolic links are not supported in replay extraction.')
    if (stat.isDirectory()) {
      await make(target)
      for (const name of await fsp.readdir(source))
        await visit(path.join(source, name), path.join(target, name))
    } else if (/\.zip$/i.test(source)) {
      count += await extractReplayZip(source, `${target}.extracted`, {
        signal,
        onProgress,
        slpzBinary: binary,
        resume,
        // A zip with nothing new in it, on a resumed run, is not an error.
        allowEmpty: resume,
      })
    } else if (/\.slpz$/i.test(source)) {
      onProgress?.(count, null, path.basename(source))
      const final = target.replace(/\.slpz$/i, '.slp')
      if (!(resume && fs.existsSync(final))) {
        const unpacked = `${final}.unpacked`
        await fsp.rm(unpacked, { force: true })
        await decompressReplay(source, unpacked, binary, signal)
        await retryFs(() => fsp.rename(unpacked, final), `rename ${unpacked}`)
      }
      count++
    } else if (/\.slp$/i.test(source)) {
      if (!(resume && fs.existsSync(target))) {
        const part = `${target}.part`
        await fsp.rm(part, { force: true })
        await pipeline(
          fs.createReadStream(source),
          fs.createWriteStream(part, { flags: 'wx' }),
          { signal: signal || new AbortController().signal },
        )
        await retryFs(() => fsp.rename(part, target), `rename ${part}`)
      }
      count++
    }
  }
  for (let i = 0; i < sources.length; i++) {
    // Separate roots avoid collisions between identically named source files.
    const root = path.join(destination, String(i + 1))
    await make(root)
    await visit(sources[i], path.join(root, path.basename(sources[i])))
  }
  if (!count) throw new Error('No replay files were found in the selection.')
  return count
}
