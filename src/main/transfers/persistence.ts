import fs from 'fs'
import path from 'path'
import { logMain } from '../logger'
import { retryFsSync } from '../fsRetry'
import {
  parseSavedTransfer,
  recoverTransfer,
  type SavedTransfer,
} from './savedTransfer'

/** What loading transfers.json found. */
export type LoadedTransfers = {
  jobs: SavedTransfer[]
  /** Records that could not be read; copied to transfers.json.bad and left out. */
  skipped: number
}

/**
 * transfers.json → jobs. One record that fails its checks (a path that no longer
 * lies inside its folder, a field a newer or older build wrote differently) is
 * left out and kept in `transfers.json.bad`; the rest load, so a single bad job
 * never disables every download (launch review DL-18 / XC-8). Throws only when
 * the file is not a transfer history at all; null when there is none.
 */
export function loadSavedTransfersDetailed(
  statePath: string,
): LoadedTransfers | null {
  if (!fs.existsSync(statePath)) return null
  let text = fs.readFileSync(statePath, 'utf8')
  let saved: { version?: unknown; jobs?: unknown }
  try {
    saved = JSON.parse(text)
  } catch (error) {
    // A half-written file (power loss mid-save): the previous copy is whole.
    const backup = `${statePath}.bak`
    if (!fs.existsSync(backup)) throw error
    logMain('transfers.json unreadable, using transfers.json.bak', {
      error: String(error),
    })
    text = fs.readFileSync(backup, 'utf8')
    saved = JSON.parse(text)
  }
  // A newer file format than this build knows (a downgrade): read what still
  // parses as it is, never refuse. Only a missing job list is invalid.
  if (!saved || typeof saved !== 'object' || !Array.isArray(saved.jobs))
    throw new Error('Invalid transfer history')
  const jobs: SavedTransfer[] = []
  const bad: unknown[] = []
  for (const raw of saved.jobs as unknown[]) {
    try {
      jobs.push(recoverTransfer(parseSavedTransfer(raw)))
    } catch (error) {
      logMain('transfers.json: skipped an unreadable record', {
        error: String(error),
      })
      bad.push(raw)
    }
  }
  if (bad.length) {
    try {
      fs.writeFileSync(
        `${statePath}.bad`,
        JSON.stringify({ version: saved.version, jobs: bad }),
        { mode: 0o600 },
      )
    } catch {
      /* the list still loads */
    }
  }
  return { jobs, skipped: bad.length }
}

/** transfers.json → jobs (null when there is no history). */
export function loadSavedTransfers(statePath: string): SavedTransfer[] | null {
  return loadSavedTransfersDetailed(statePath)?.jobs ?? null
}

const lastBackup = new Map<string, number>()
const BACKUP_EVERY_MS = 60_000

/** Write the history atomically, keeping the previous copy as transfers.json.bak.
 *  A momentary lock on the file (antivirus, indexer) is retried. */
export function writeSavedTransfers(statePath: string, jobs: SavedTransfer[]) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  const tmp = `${statePath}.tmp`
  retryFsSync(
    () =>
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, jobs }), {
        mode: 0o600,
      }),
    `write ${tmp}`,
  )
  try {
    // Best effort: only worth having while the history is whole.
    const now = Date.now()
    if (
      fs.existsSync(statePath) &&
      now - (lastBackup.get(statePath) ?? 0) > BACKUP_EVERY_MS
    ) {
      fs.copyFileSync(statePath, `${statePath}.bak`)
      lastBackup.set(statePath, now)
    }
  } catch {
    /* no backup this time */
  }
  retryFsSync(() => fs.renameSync(tmp, statePath), `rename ${tmp}`)
}
