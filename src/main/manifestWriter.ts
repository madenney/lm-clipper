import path from 'path'
import { promises as fsPromises } from 'fs'
import { logMain } from './logger'

// A per-clip record in the manifest. Everything an overlay/post-processing job
// on another machine needs to identify a clip file and render on top of it.
export type ManifestClip = {
  outputFile: string // relative to outputDir, e.g. "0001.mp4"
  index: number
  status: 'pending' | 'done' | 'failed'
  [key: string]: unknown
}

export type ManifestData = {
  manifestVersion: number
  project?: string
  createdAt: string
  outputDir: string
  recording: Record<string, unknown>
  counts: { total: number; done: number; failed: number; pending: number }
  concatenatedInto?: string
  clips: ManifestClip[]
}

// Writes a manifest.json describing every clip in a recording. Two properties
// matter and shape the whole design:
//   1. Crash-resistant. The full per-clip metadata is written UP FRONT (every
//      clip 'pending'), so an interrupted recording still leaves a manifest that
//      lists every intended clip with all its data — only statuses may be stale.
//   2. Cheap under load. Writes are COALESCED (at most one every `flushMs`) and
//      ATOMIC (temp file + rename), so 5000 clip completions don't mean 5000
//      full rewrites, and a crash mid-write never corrupts the file.
export default class ManifestWriter {
  private readonly manifestPath: string

  private readonly tmpPath: string

  private data: ManifestData

  private readonly byIndex = new Map<number, ManifestClip>()

  private dirty = false

  private timer: ReturnType<typeof setTimeout> | null = null

  private writing: Promise<void> = Promise.resolve()

  private readonly flushMs: number

  constructor(manifestPath: string, data: ManifestData, flushMs = 1000) {
    this.manifestPath = manifestPath
    this.tmpPath = `${manifestPath}.tmp`
    this.data = data
    this.flushMs = flushMs
    for (const clip of data.clips) this.byIndex.set(clip.index, clip)
    this.recount()
  }

  // Write the initial skeleton right away (awaited), so the file exists with all
  // clip data before the first clip is even recorded.
  async init(): Promise<void> {
    this.dirty = true
    await this.flush()
  }

  markDone(index: number, patch: Partial<ManifestClip> = {}): void {
    const clip = this.byIndex.get(index)
    if (!clip) return
    Object.assign(clip, patch, { status: 'done' })
    this.scheduleWrite()
  }

  markFailed(index: number, patch: Partial<ManifestClip> = {}): void {
    const clip = this.byIndex.get(index)
    if (!clip) return
    Object.assign(clip, patch, { status: 'failed' })
    this.scheduleWrite()
  }

  setConcatenatedInto(relName: string): void {
    this.data.concatenatedInto = relName
    this.scheduleWrite()
  }

  private recount(): void {
    let done = 0
    let failed = 0
    for (const clip of this.data.clips) {
      if (clip.status === 'done') done += 1
      else if (clip.status === 'failed') failed += 1
    }
    this.data.counts = {
      total: this.data.clips.length,
      done,
      failed,
      pending: this.data.clips.length - done - failed,
    }
  }

  private scheduleWrite(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush().catch(() => {})
    }, this.flushMs)
  }

  // Force a write now (serialized so two writes never interleave). Safe to call
  // repeatedly; a no-op when nothing changed since the last write.
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty) {
      await this.writing
      return
    }
    this.dirty = false
    this.recount()
    const json = JSON.stringify(this.data, null, 2)
    this.writing = this.writing
      .then(async () => {
        await fsPromises.writeFile(this.tmpPath, json)
        await fsPromises.rename(this.tmpPath, this.manifestPath)
      })
      .catch((err) => {
        logMain('manifest: write failed', {
          path: this.manifestPath,
          err: String(err),
        })
      })
    await this.writing
  }

  get filePath(): string {
    return this.manifestPath
  }

  static outputDirName(manifestPath: string): string {
    return path.dirname(manifestPath)
  }
}
