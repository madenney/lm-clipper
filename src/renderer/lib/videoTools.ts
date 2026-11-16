/**
 * Video Tools window: the parts that are plain logic (no React), so they can be
 * tested. The window itself is components/VideoToolsModal.tsx; the main-process
 * half is src/main/videoTools.ts.
 */
import type { VideoFolder } from '../../constants/types'

/**
 * Output quality. `copy` joins the videos as they are (nothing re-encoded, the
 * biggest file); the others re-encode to H.264 at a target bitrate, so the size
 * is predictable and small enough to upload.
 */
export const QUALITY = [
  { key: 'copy', label: 'Original', sub: 'no re-encode', kbps: 0 },
  { key: 'high', label: 'High', sub: '8 Mbps', kbps: 8000 },
  { key: 'medium', label: 'Medium', sub: '4 Mbps', kbps: 4000 },
  { key: 'small', label: 'Small', sub: '2 Mbps', kbps: 2000 },
] as const
export type QualityKey = (typeof QUALITY)[number]['key']

/** Audio bitrate of a compressed result (src/main/videoTools.ts COMPRESS_AUDIO_KBPS). */
export const AUDIO_KBPS = 160

const QUALITY_PREF = 'lunar.videoTools.quality'

/** The quality picked last time (this machine only); Original the first time. */
export function readQuality(): QualityKey {
  try {
    const v = window.localStorage.getItem(QUALITY_PREF)
    return QUALITY.some((q) => q.key === v) ? (v as QualityKey) : 'copy'
  } catch {
    return 'copy'
  }
}

export function writeQuality(key: QualityKey) {
  try {
    window.localStorage.setItem(QUALITY_PREF, key)
  } catch {
    // Private mode or a full store: the choice just is not remembered.
  }
}

/**
 * Size of the result at a quality. Original is the sum of the sources (known at
 * once); a compressed one is bitrate x length, so it needs the length first
 * (null until then).
 */
export function estimateBytes(
  kbps: number,
  sourceBytes: number,
  durationSec: number,
): number | null {
  if (kbps === 0) return sourceBytes
  if (durationSec <= 0) return null
  return ((kbps + AUDIO_KBPS) * 1000 * durationSec) / 8
}

/** output / output_1 / output_2 … are the folders recording makes: the number, or null. */
export const outputNum = (name: string): number | null => {
  if (name === 'output') return 0
  const m = /^output_(\d+)$/.exec(name)
  return m ? parseInt(m[1], 10) : null
}

/**
 * Display order: recording folders first, newest (highest number) on top; other
 * folders by name; the output folder's own loose videos last.
 */
export const sortFolders = (folders: VideoFolder[]): VideoFolder[] =>
  [...folders].sort((a, b) => {
    if (a.isRoot !== b.isRoot) return a.isRoot ? 1 : -1
    const na = outputNum(a.name)
    const nb = outputNum(b.name)
    if (na !== null && nb !== null) return nb - na
    if (na !== null) return -1
    if (nb !== null) return 1
    return a.name.localeCompare(b.name)
  })

/** The newest recording folder that has clips: the one ticked when the window opens. */
export const latestFolderPath = (folders: VideoFolder[]): string =>
  folders.reduce<{ path: string; n: number }>(
    (best, f) => {
      const n = outputNum(f.name)
      return n !== null && n > best.n && f.clips.length > 0
        ? { path: f.path, n }
        : best
    },
    { path: '', n: -1 },
  ).path

export const folderLabel = (f: VideoFolder): string =>
  f.isRoot ? 'Output folder' : f.name

export type VideoAction = {
  /** The main button. */
  label: string
  /** The same, while it runs. */
  busyLabel: string
  enabled: boolean
  /** Why it is off, or what to do next. */
  hint: string
}

/**
 * What the main button does for a selection: several videos are combined (and
 * compressed when a smaller quality is picked); one video can only be compressed.
 */
export function describeAction(
  count: number,
  anyFinished: boolean,
  quality: QualityKey,
): VideoAction {
  const compress = quality !== 'copy'
  if (count === 0)
    return {
      label: 'Combine clips',
      busyLabel: 'Working…',
      enabled: false,
      hint: 'Tick clips to combine them into one video, or one video to compress it.',
    }
  if (count === 1)
    return {
      label: 'Compress 1 video',
      busyLabel: 'Compressing…',
      enabled: compress,
      hint: compress
        ? '1 video selected'
        : 'Pick High, Medium or Small to compress this video, or tick more to combine.',
    }
  const noun = anyFinished ? 'videos' : 'clips'
  return {
    label: compress
      ? `Combine and compress ${count} ${noun}`
      : `Combine ${count} ${noun}`,
    busyLabel: compress ? 'Combining and compressing…' : 'Combining…',
    enabled: true,
    hint: `${count} ${noun} selected`,
  }
}

export type FolderUI = { order: string[]; checked: Record<string, boolean> }

/**
 * Fold a fresh scan into the window's state: files still there keep their tick
 * and their place, vanished ones drop out, new ones are added unticked (ticked
 * in `tickClipsOf`, the folder chosen on the first scan).
 */
export function mergeScan(
  prev: Record<string, FolderUI>,
  scanned: VideoFolder[],
  tickClipsOf = '',
): Record<string, FolderUI> {
  const next: Record<string, FolderUI> = {}
  for (const f of scanned) {
    const names = [...f.clips, ...f.finished]
    const ex = prev[f.path]
    const order = ex ? ex.order.filter((c) => names.includes(c)) : []
    for (const c of names) if (!order.includes(c)) order.push(c)
    const checked: Record<string, boolean> = {}
    for (const c of order)
      checked[c] =
        ex?.checked[c] ?? (f.path === tickClipsOf && f.clips.includes(c))
    next[f.path] = { order, checked }
  }
  return next
}
