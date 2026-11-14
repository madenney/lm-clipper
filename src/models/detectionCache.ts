/**
 * Detector cache for filter worker threads (docs/library-workspaces.md, Part A):
 * a thin layer over replayLibrary's detections table, with its own connection
 * in this thread. Writes are batched; call flush() before the worker finishes.
 */
import fs from 'fs'
import {
  DetectionKey,
  DetectionPut,
  FileSeen,
  libraryDetectionGet,
  libraryDetectionPut,
} from '../main/replayLibrary'

/**
 * The combo detector's version. Bump it whenever `detectCombos`
 * (packages/replay-analysis/src/combos.ts) changes what it finds, so cached
 * results from the old code are never used. A test pins this to the source's
 * hash (detectionCache.test.ts) so a change can't slip through unbumped.
 */
export const COMBO_DETECTOR = { detector: 'combos', version: 1 }

/** Same for the Edgeguards Parser's `findEdgeguards` (edgeguard.ts, with the
 *  stage geometry and recovery data it uses). */
export const EDGEGUARD_DETECTOR = { detector: 'edgeguards', version: 1 }

export class DetectionCache {
  private pending: DetectionPut[] = []

  private folder: string

  constructor(folder: string) {
    this.folder = folder
  }

  /** Cached rows for an unchanged file, plus what was seen of the file (pass
   *  it to put() on a miss so it isn't stat'ed twice). */
  get<T>(
    filePath: string,
    key: DetectionKey,
  ): { data: T | null; seen: FileSeen | null } {
    let seen: FileSeen | null = null
    try {
      const st = fs.statSync(filePath)
      seen = { path: filePath, size: st.size, mtime: Math.floor(st.mtimeMs) }
      const rows = libraryDetectionGet(this.folder, seen, key)
      return { data: rows ? (JSON.parse(rows) as T) : null, seen }
    } catch {
      // Missing file or unreadable cache: detect normally (and report as usual).
      return { data: null, seen }
    }
  }

  put(seen: FileSeen, contentHash: string, key: DetectionKey, data: unknown) {
    this.pending.push({
      ...seen,
      ...key,
      contentHash,
      rows: JSON.stringify(data),
    })
    if (this.pending.length >= 100) this.flush()
  }

  flush() {
    if (this.pending.length === 0) return
    const batch = this.pending
    this.pending = []
    try {
      libraryDetectionPut(this.folder, batch)
    } catch (error) {
      // The cache is an optimisation: never fail a filter run over it.
      console.error('Detector cache write failed:', error)
    }
  }
}
