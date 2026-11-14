import type { BrowserWindow } from 'electron'
import type { Transfer } from '../../constants/database'
import type { LunarClip } from '../../constants/clipSearch'
import type { ArchiveInterface } from '../../constants/types'
import type { DatabaseClient } from '../databaseClient'
import type { LibraryAccess } from '../replayExtraction'
import type { Coalesce } from '../directDownload'
import type ImportManager from '../managers/ImportManager'
import type ConsoleManager from '../managers/ConsoleManager'
import type { SavedTransfer } from './savedTransfer'

export type TransferDeps = {
  configDir: string
  /** Lists up to this many games download one by one (default ONE_BY_ONE_MAX_GAMES;
   *  Find replays / Find clips: from storage, more by range; other lists: more in a
   *  bundle, 0 = always a bundle). */
  directMaxGames?: number
  /** Direct snapshot downloads: parallel range requests (default 16), decoders,
   *  coalescing, and (tests) the storage hosts allowed and retry waits. */
  direct?: {
    concurrency?: number
    decoders?: number
    coalesce?: Coalesce
    allowUrl?: (_url: string) => boolean
    backoffMs?: (_attempt: number) => number
    /** false: never try it (the old paths only). */
    enabled?: boolean
    /** The prebuilt plans' manifest (prebuiltPlans.ts; default
     *  PREBUILT_PLANS_URL), null to always list through the website. */
    plansUrl?: string | null
  }
  getArchive: () => ArchiveInterface | null
  ensureProject: () => Promise<unknown>
  getSlpzBinary: () => string
  /** The replay library (Settings > Paths > Replay Library). */
  getLibrary: () => LibraryAccess
  /** Add Find clips results to the open project (controller.ts). */
  addClips?: (
    _projectPath: string,
    _clips: LunarClip[],
    _pathByReplayId: Record<string, string>,
  ) => Promise<{ added: number; unavailable: number }>
  /** A transfer finished (e.g. to re-check a project's missing replays). */
  onCompleted?: (_job: Transfer) => void
  /** How often transfers paused for maintenance check if it's over (tests). */
  maintenancePollMs?: number
  importer: ImportManager
  /** Where a download's start, finish and failure are written (the console). */
  console?: Pick<ConsoleManager, 'pushConsoleLog'>
}

/**
 * What the download runners need from the TransferManager: its state (read
 * through getters, since the manager replaces its job list and deps) and the
 * two things that change it. The manager owns all state; modules never keep any.
 */
export interface TransferContext {
  readonly client: DatabaseClient
  readonly deps: TransferDeps
  readonly window: BrowserWindow
  readonly jobs: SavedTransfer[]
  update(
    _job: SavedTransfer,
    _patch: Partial<SavedTransfer>,
    _persist?: boolean,
  ): void
  save(): void
}
