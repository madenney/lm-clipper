import path from 'path'
import {
  DatabaseFilters,
  Transfer,
  TransferStage,
  validateDatabaseFilters,
} from '../../constants/database'
import { isInside } from './files'

export type SavedTransfer = Transfer & {
  filters?: DatabaseFilters
  /** Download exactly these Lunar Database replays (instead of `filters`). */
  replayIds?: string[]
  /** Add to project from Find clips: the chosen clips, saved in outputDir. */
  clipsFile?: string
  /** Add to project from Find replays: the chosen replay ids, saved in outputDir. */
  gamesFile?: string
  sources?: string[]
  remoteId?: string
  token?: string
  preparedPath?: string
  /** The whole-database download's record on Lunar (for progress reports). */
  fullDbDownloadId?: string
  /** Its secret for progress reports and for keeping the record on a fresh link. */
  fullDbToken?: string
  /** Direct snapshot download (directDownload.ts): 'done' once its part is over,
   *  'off' when it can't be used (older website, limits): the old paths then. */
  direct?: 'off' | 'done'
  /** The library paths it brought in (outputDir/direct/files.json), merged into the import. */
  directFiles?: string
  /** From Find replays or Find clips: only games stored on storage, and only from
   *  storage (direct by range, or one by one through the website's storage path).
   *  Never a bundle or the Lunar server at home; games in no zip are left out. */
  storedOnly?: boolean
  /** Of those, games left out because no zip holds them yet (said when it's done). */
  notStored?: number
  /** Games that could not be fetched (too large, storage refused them after the
   *  retries): said in the final line so a short count is explained. */
  unreadable?: number
  /** The user chose to start although the drive may be too small for it. */
  spaceOk?: boolean
}

const STAGES: TransferStage[] = [
  'queued',
  'preparing',
  'downloading',
  'extracting',
  'waiting-project',
  'importing',
  'paused',
  'failed',
  'canceled',
  'completed',
]

/**
 * Validate one record from transfers.json. The file lives in the settings folder
 * and paths in it are later opened, extracted into and imported, so every field
 * is checked; any bad record makes the caller refuse the whole history.
 */
export function parseSavedTransfer(raw: unknown): SavedTransfer {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >
  const fail = (field: string): never => {
    throw new Error(`Invalid saved transfer (${field}).`)
  }
  const str = (v: unknown) => typeof v === 'string'
  const absolute = (v: unknown) => str(v) && path.isAbsolute(v as string)
  const optional = (key: string, ok: (_v: unknown) => boolean) => {
    if (r[key] !== undefined && !ok(r[key])) fail(key)
  }
  if (!str(r.id) || !/^[0-9a-f-]{36}$/.test(r.id as string)) fail('id')
  if (r.kind !== 'database' && r.kind !== 'extract') fail('kind')
  if (!STAGES.includes(r.stage as TransferStage)) fail('stage')
  if (!absolute(r.outputDir)) fail('outputDir')
  if (!str(r.title) || !str(r.detail)) fail('title')
  optional('waitingForDatabase', (v) => typeof v === 'boolean')
  if (!Number.isFinite(r.createdAt) || !Number.isFinite(r.current))
    fail('counts')
  if (r.total !== null && !Number.isFinite(r.total)) fail('total')
  optional('projectPath', absolute)
  optional('projectName', str)
  optional('error', str)
  optional('exportGone', (v) => typeof v === 'boolean')
  optional('remoteId', (v) => str(v) && /^[a-f0-9]{24}$/.test(v as string))
  optional('token', str)
  optional(
    'fullDbDownloadId',
    (v) => str(v) && /^[a-f0-9]{24}$/.test(v as string),
  )
  optional(
    'fullDbToken',
    (v) => str(v) && /^[A-Za-z0-9_-]{16,128}$/.test(v as string),
  )
  optional(
    'preparedPath',
    (v) => absolute(v) && isInside(v as string, r.outputDir as string),
  )
  optional('direct', (v) => v === 'off' || v === 'done')
  optional('storedOnly', (v) => typeof v === 'boolean')
  optional('notStored', (v) => Number.isSafeInteger(v) && (v as number) >= 0)
  optional('unreadable', (v) => Number.isSafeInteger(v) && (v as number) >= 0)
  optional('spaceOk', (v) => typeof v === 'boolean')
  optional(
    'directFiles',
    (v) => absolute(v) && isInside(v as string, r.outputDir as string),
  )
  optional('sources', (v) => Array.isArray(v) && v.every(absolute))
  optional(
    'result',
    (v) =>
      !!v &&
      typeof v === 'object' &&
      Number.isFinite((v as { inserted: unknown }).inserted) &&
      Number.isFinite((v as { failed: unknown }).failed),
  )
  if (r.filters !== undefined) {
    try {
      r.filters = validateDatabaseFilters(r.filters as DatabaseFilters)
    } catch {
      fail('filters')
    }
  }
  optional(
    'replayIds',
    (v) =>
      Array.isArray(v) &&
      v.length > 0 &&
      v.length <= 100_000 &&
      v.every((id) => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id)),
  )
  optional(
    'clipsFile',
    (v) => absolute(v) && isInside(v as string, r.outputDir as string),
  )
  optional(
    'gamesFile',
    (v) => absolute(v) && isInside(v as string, r.outputDir as string),
  )
  if (
    r.kind === 'database' &&
    !r.filters &&
    !r.replayIds &&
    !r.clipsFile &&
    !r.gamesFile
  )
    fail('filters')
  return r as unknown as SavedTransfer
}

export function recoverTransfer(job: SavedTransfer): SavedTransfer {
  if (
    !['completed', 'failed', 'paused', 'waiting-project', 'canceled'].includes(
      job.stage,
    )
  ) {
    return {
      ...job,
      stage: 'paused',
      detail: 'Interrupted when Clipper closed. Resume to continue.',
    }
  }
  return job
}
