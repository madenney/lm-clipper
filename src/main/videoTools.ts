/**
 * Video Tools (the top bar's film button): what it lists, where a result goes and
 * the ffmpeg arguments for it. No Electron and no ffmpeg here, so it is all
 * testable; VideoManager owns the IPC and slpToVideo.concatClips runs ffmpeg.
 *
 * Two jobs on videos already in the output folder: combine several into one
 * (a stream copy at Original quality), and compress (re-encode to H.264 at a
 * target bitrate), which also works on one video by itself.
 */
import { promises as fsp, existsSync } from 'fs'
import path from 'path'
import type { VideoFolder } from '../constants/types'

export const VIDEO_EXTS = ['.mp4', '.avi'] as const
export type VideoExt = (typeof VIDEO_EXTS)[number]

/** The audio bitrate a compressed result is written with. */
export const COMPRESS_AUDIO_KBPS = 160

// Never listed: kept masters, a recording's intermediates, and a result that is
// still being written (ours is `<name>.partial<ext>`, a recording's `.partial`).
const WORK_FILE = /(\.master\.(avi|wav)$|-unmerged|-merged|\.partial(\.|$))/i

// A video that is already a result: a recording's or our own `final`, a
// cross-folder `stitched`, a compressed copy. Listed, but never picked by
// "select all", so a folder's clips are not combined with their own result.
const FINISHED_FILE =
  /^(final|stitched)([-_ .]|$)|-compressed(_\d+)?\.[a-z0-9]+$/i

export const videoExtOf = (name: string): VideoExt | null => {
  const ext = path.extname(name).toLowerCase()
  return (VIDEO_EXTS as readonly string[]).includes(ext)
    ? (ext as VideoExt)
    : null
}

/** 'clip', 'finished', or null for anything the tool should not show. */
export const videoKind = (name: string): 'clip' | 'finished' | null => {
  if (!videoExtOf(name) || WORK_FILE.test(name)) return null
  return FINISHED_FILE.test(name) ? 'finished' : 'clip'
}

// A filename pattern can put clips in folders ({stage}/{index}), so the scan
// goes a few levels down; the caps keep a huge or odd tree from stalling it.
const SCAN_MAX_DEPTH = 4
const SCAN_MAX_FOLDERS = 300

/**
 * Every folder under the output root (and the root itself) that holds at least
 * one video, with the byte size of each. A finished clip can leave both an .avi
 * and an .mp4: clips are listed in one extension (.mp4 when there is any).
 */
export async function scanVideoFolders(root: string): Promise<VideoFolder[]> {
  const found: VideoFolder[] = []
  if (!root) return found
  const top = path.resolve(root)

  const walk = async (dir: string, rel: string, depth: number) => {
    if (found.length >= SCAN_MAX_FOLDERS) return
    let entries: import('fs').Dirent[] = []
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return // missing or unreadable: nothing to show from here
    }
    const clipsByExt: Record<VideoExt, string[]> = { '.mp4': [], '.avi': [] }
    const finished: string[] = []
    const subfolders: string[] = []
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!e.name.startsWith('.')) subfolders.push(e.name)
      } else if (e.isFile()) {
        const kind = videoKind(e.name)
        if (kind === 'finished') finished.push(e.name)
        else if (kind === 'clip') clipsByExt[videoExtOf(e.name)!].push(e.name)
      }
    }
    const clips = (
      clipsByExt['.mp4'].length > 0 ? clipsByExt['.mp4'] : clipsByExt['.avi']
    ).sort()
    finished.sort()
    if (clips.length + finished.length > 0) {
      const sizes: Record<string, number> = {}
      await Promise.all(
        [...clips, ...finished].map(async (name) => {
          try {
            sizes[name] = (await fsp.stat(path.join(dir, name))).size
          } catch {
            sizes[name] = 0
          }
        }),
      )
      found.push({
        path: dir,
        name: rel,
        isRoot: rel === '',
        clips,
        finished,
        sizes,
      })
    }
    if (depth >= SCAN_MAX_DEPTH) return
    for (const name of subfolders.sort()) {
      // eslint-disable-next-line no-await-in-loop
      await walk(path.join(dir, name), rel ? `${rel}/${name}` : name, depth + 1)
    }
  }

  await walk(top, '', 0)
  return found
}

/**
 * A selection sent by the window, as absolute paths: only video files inside
 * the output root, so the window can never point ffmpeg at anything else.
 */
export function resolveVideoFiles(
  root: string,
  items: { folder: string; name: string }[],
): { files: string[]; folders: Set<string> } {
  const top = path.resolve(root)
  const prefix = top.endsWith(path.sep) ? top : top + path.sep
  const files: string[] = []
  const folders = new Set<string>()
  for (const item of items ?? []) {
    if (typeof item?.folder !== 'string' || typeof item?.name !== 'string')
      continue
    const folder = path.resolve(item.folder)
    const name = path.basename(item.name)
    const abs = path.resolve(folder, name)
    if (folder !== top && !folder.startsWith(prefix)) continue
    if (!abs.startsWith(prefix) || videoKind(name) === null) continue
    if (files.includes(abs)) continue
    files.push(abs)
    folders.add(folder)
  }
  return { files, folders }
}

export type VideoJobPlan =
  | {
      ok: true
      /** What the job does, for the log and the progress wording. */
      mode: 'combine' | 'compress' | 'combine-compress'
      outDir: string
      baseName: string
      ext: VideoExt
    }
  | { ok: false; error: string }

/**
 * Where a job's result goes and under what name. Several videos from one folder
 * make `final` in that folder; from several folders (or the output root itself)
 * `stitched` in the root; one video compressed makes `<name>-compressed` beside
 * it. A compressed result is always .mp4.
 */
export function planVideoJob(
  root: string,
  files: string[],
  folders: Set<string>,
  compress: boolean,
): VideoJobPlan {
  if (files.length === 0)
    return { ok: false, error: 'Select at least one video.' }
  const top = path.resolve(root)
  if (files.length === 1) {
    if (!compress)
      return {
        ok: false,
        error:
          'One video at Original quality would only be a copy. Pick a smaller quality to compress it, or select more to combine.',
      }
    const file = files[0]
    return {
      ok: true,
      mode: 'compress',
      outDir: path.dirname(file),
      baseName: `${path.basename(file, path.extname(file))}-compressed`,
      ext: '.mp4',
    }
  }
  const exts = new Set(files.map((f) => videoExtOf(f)))
  if (exts.size > 1)
    return {
      ok: false,
      error:
        'These videos are in different formats (.avi and .mp4) and cannot be joined into one. Select videos of one format.',
    }
  const single = folders.size === 1 ? [...folders][0] : null
  const inOneFolder = single !== null && single !== top
  return {
    ok: true,
    mode: compress ? 'combine-compress' : 'combine',
    outDir: inOneFolder ? single : top,
    baseName: inOneFolder ? 'final' : 'stitched',
    ext: compress ? '.mp4' : ([...exts][0] as VideoExt),
  }
}

/** `<dir>/<base><ext>`, or `<base>_2`, `_3`… when that name is taken. */
export function freeVideoPath(
  dir: string,
  baseName: string,
  ext: string,
  exists: (_p: string) => boolean = existsSync,
): string {
  let output = path.resolve(dir, `${baseName}${ext}`)
  for (let n = 2; exists(output) || exists(partialPathFor(output)); n += 1)
    output = path.resolve(dir, `${baseName}_${n}${ext}`)
  return output
}

/**
 * The name a result is written under until it is whole. The extension stays
 * last so ffmpeg still picks the container from it.
 */
export function partialPathFor(output: string): string {
  const ext = path.extname(output)
  return `${output.slice(0, output.length - ext.length)}.partial${ext}`
}

/** Bytes a compressed result of this length takes (what the window estimates too). */
export const compressedBytes = (videoKbps: number, seconds: number): number =>
  ((videoKbps + COMPRESS_AUDIO_KBPS) * 1000 * seconds) / 8

/**
 * ffmpeg arguments for one job, reading a concat list. Original quality copies
 * the video stream (fast, nothing lost); .avi clips get their audio re-encoded
 * to AAC, as a recording's own join does. Compressing re-encodes to H.264 at a
 * target bitrate, so the size is predictable, with the index at the front of the
 * file so it starts playing before it has all arrived.
 */
export function videoJobArgs(
  listPath: string,
  output: string,
  opts: {
    compress: boolean
    videoKbps?: number
    /** The inputs are .mp4 (AAC audio already): a pure copy. */
    sourceIsMp4: boolean
    /** The recording bitrate setting, for the .avi copy path. */
    bitrateKbps: number
  },
): string[] {
  const args = [
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listPath,
    '-fflags',
    '+genpts',
  ]
  if (opts.compress) {
    args.push(
      '-c:v',
      'libx264',
      '-b:v',
      `${opts.videoKbps ?? 4000}k`,
      '-preset',
      'medium',
      '-pix_fmt',
      'yuv420p',
      '-af',
      'aresample=async=1:first_pts=0',
      '-c:a',
      'aac',
      '-b:a',
      `${COMPRESS_AUDIO_KBPS}k`,
      '-movflags',
      '+faststart',
    )
  } else {
    args.push('-c:v', 'copy')
    if (opts.sourceIsMp4) {
      args.push('-c:a', 'copy')
    } else {
      args.push(
        '-b:v',
        `${opts.bitrateKbps}k`,
        '-af',
        'aresample=async=1:first_pts=0',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
      )
    }
  }
  args.push('-y', output)
  return args
}
