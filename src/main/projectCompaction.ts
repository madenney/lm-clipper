/**
 * Compact Project: give back the space a project file keeps after filters are
 * deleted, re-run or cleared (SQLite never shrinks a file by itself; real
 * projects were up to 78% empty pages).
 *
 * - Projects made with incremental auto-vacuum (every project created since
 *   2026-10-01, and any project compacted once) shrink in place:
 *   `PRAGMA incremental_vacuum`, fast, no extra disk.
 * - Older projects are rewritten with `VACUUM INTO` a new file next to the
 *   original, which then replaces it. The original is untouched until the copy
 *   is complete, and the copy has incremental auto-vacuum, so it only needs this
 *   once. It needs free disk about the size of the project's live data.
 */

export type SpaceInfo = {
  pageSize: number
  pageCount: number
  freePages: number
  /** 0 none, 1 full, 2 incremental. */
  autoVacuum: number
}

export type CompactionPlan = {
  mode: 'none' | 'incremental' | 'copy'
  fileBytes: number
  /** Bytes the file will shrink by. */
  reclaimBytes: number
  /** Size of the compacted project. */
  liveBytes: number
  /** Free disk needed next to the project. */
  needBytes: number
  enoughDisk: boolean
}

const MB = 1024 * 1024
/** Below this there is nothing worth a rewrite. */
export const MIN_RECLAIM_BYTES = 64 * MB

export function planCompaction(
  info: SpaceInfo,
  diskFreeBytes: number,
): CompactionPlan {
  const fileBytes = info.pageSize * info.pageCount
  const reclaimBytes = info.pageSize * info.freePages
  const liveBytes = fileBytes - reclaimBytes
  if (reclaimBytes < MIN_RECLAIM_BYTES)
    return {
      mode: 'none',
      fileBytes,
      reclaimBytes,
      liveBytes,
      needBytes: 0,
      enoughDisk: true,
    }
  if (info.autoVacuum === 2)
    return {
      mode: 'incremental',
      fileBytes,
      reclaimBytes,
      liveBytes,
      needBytes: 0,
      enoughDisk: true,
    }
  // The copy, plus a margin for the filesystem and the rest of the system.
  const needBytes = Math.ceil(liveBytes * 1.05) + 256 * MB
  return {
    mode: 'copy',
    fileBytes,
    reclaimBytes,
    liveBytes,
    needBytes,
    enoughDisk: diskFreeBytes >= needBytes,
  }
}

export { formatBytes } from '../lib/format'

/** Path of the compacted copy while it is being written. */
export const compactTempPath = (projectPath: string) =>
  `${projectPath}.compacting`
