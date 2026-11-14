/**
 * Test runs only (scripts/win-rig's clipper-smoke suite): LM_CLIPPER_AUTORUN_DOWNLOAD
 * runs a small Find replays download through the same main-process path the
 * Lunar Database panel uses: TransferManager.handle with action "start" (the
 * renderer's databaseRequest), which searches /api/getList, then fetches the
 * games one by one into the library and imports them into My Replays.
 *
 * The value is a game count ("3": the newest games of every source) or JSON
 * filters laid over defaultDatabaseFilters ({"maxFiles":3,"sources":["tournament"]}).
 * Stored games only, like the panel: up to ONE_BY_ONE_MAX_GAMES one by one from
 * storage, more straight from storage by range (never a bundle). At most
 * AUTORUN_MAX_GAMES, unless LM_CLIPPER_AUTORUN_DOWNLOAD_MAX raises it (test runs of
 * 100,000 games or a whole character).
 *
 * LM_CLIPPER_AUTORUN_DOWNLOAD_RESUME=N: a transfer that ends failed or paused is
 * resumed (the panel's Resume button) up to N times, 20 s apart, the way a user
 * would after a dropped connection. LM_CLIPPER_AUTORUN_DOWNLOAD_TIMEOUT_MIN
 * overrides the 10 min limit.
 */
import { setTimeout as delay } from 'timers/promises'
import type { IpcMainEvent } from 'electron'
import type TransferManager from './managers/TransferManager'
import { defaultDatabaseFilters } from '../constants/database'
import type { DatabaseFilters, Transfer } from '../constants/database'

export type DownloadSummary = {
  ok: boolean
  error?: string
  filters?: DatabaseFilters
  ms?: number
  transfer?: Transfer | null
  /** Every stage the transfer went through, in order, with when (ms from start). */
  stages?: { stage: string; detail: string; atMs: number }[]
  /** Resumes asked for after a failed/paused end (LM_CLIPPER_AUTORUN_DOWNLOAD_RESUME). */
  resumes?: { atMs: number; from: string; error?: string }[]
  /** LM_CLIPPER_AUTORUN_DOWNLOAD_CONTINUE: the transfer resumed after a restart. */
  continued?: { id: string; from: string }
}

/** One request through TransferManager.handle, as the renderer sends it. */
function ask(
  transfers: TransferManager,
  payload: Record<string, unknown>,
): Promise<{ error?: string; [key: string]: unknown }> {
  return new Promise((resolve) => {
    const event = {
      reply: (
        _channel: string,
        msg: { payload?: { error?: string; [key: string]: unknown } },
      ) => resolve(msg?.payload ?? {}),
    } as unknown as IpcMainEvent
    transfers
      .handle(event, { requestId: `autorun-${Date.now()}`, payload })
      .catch((e) => resolve({ error: String(e) }))
  })
}

/** LM_CLIPPER_AUTORUN_FULLDB_INFO: what Find replays offers for the whole database (no download). */
export async function runAutorunFullDbInfo(transfers: TransferManager) {
  const t0 = Date.now()
  const answer = await ask(transfers, { action: 'fullDbInfo' })
  return { ms: Date.now() - t0, ...answer }
}

/** The test rig never asks for more than this. */
const AUTORUN_MAX_GAMES = 10_000

const FINAL = new Set(['completed', 'failed', 'canceled', 'paused'])

export function autorunDownloadFilters(raw: string): DatabaseFilters {
  const trimmed = raw.trim()
  const partial: Partial<DatabaseFilters> = /^\d+$/.test(trimmed)
    ? { maxFiles: Number(trimmed) }
    : JSON.parse(trimmed)
  const filters = { ...defaultDatabaseFilters, ...partial }
  const max = Math.max(
    AUTORUN_MAX_GAMES,
    Number(process.env.LM_CLIPPER_AUTORUN_DOWNLOAD_MAX) || 0,
  )
  if (!(filters.maxFiles >= 1 && filters.maxFiles <= max))
    throw new Error(`maxFiles must be 1-${max}`)
  return filters
}

export async function runAutorunDownload(
  transfers: TransferManager,
  raw: string,
  {
    log = console.log,
    timeoutMs = (Number(process.env.LM_CLIPPER_AUTORUN_DOWNLOAD_TIMEOUT_MIN) ||
      10) * 60_000,
    resumes = Number(process.env.LM_CLIPPER_AUTORUN_DOWNLOAD_RESUME) || 0,
  }: {
    log?: (_msg: string) => void
    timeoutMs?: number
    resumes?: number
  } = {},
): Promise<DownloadSummary> {
  const t0 = Date.now()
  const summary: DownloadSummary = { ok: false, stages: [], resumes: [] }
  try {
    const filters = autorunDownloadFilters(raw)
    summary.filters = filters
    const before = new Set(transfers.list().map((t) => t.id))
    // LM_CLIPPER_AUTORUN_DOWNLOAD_CONTINUE=1: Clipper was closed mid-transfer;
    // press Resume on the newest transfer it left paused instead of starting one.
    const left =
      process.env.LM_CLIPPER_AUTORUN_DOWNLOAD_CONTINUE === '1'
        ? transfers
            .list()
            .filter((t) => t.stage === 'paused' || t.stage === 'failed')
            .pop()
        : undefined
    if (left) {
      before.delete(left.id)
      summary.continued = { id: left.id, from: `${left.stage}: ${left.detail}` }
      const r = await ask(transfers, { action: 'resume', id: left.id })
      if (r.error) throw new Error(r.error)
      log(`Download: resumed ${left.id} (${left.stage}: ${left.detail})`)
    } else {
      // What the renderer sends; the reply comes back through event.reply.
      const answer = await ask(transfers, { action: 'start', filters })
      if (answer.error) throw new Error(answer.error)
      log(`Download: started (${filters.maxFiles} games)`)
    }
    let job: Transfer | undefined
    let last = ''
    while (Date.now() - t0 < timeoutMs) {
      job = transfers.list().find((t) => !before.has(t.id))
      if (job) {
        const line = `${job.stage}: ${job.detail}`
        if (line !== last) {
          summary.stages!.push({
            stage: job.stage,
            detail: job.detail,
            atMs: Date.now() - t0,
          })
          log(`Download: ${line}`)
          last = line
        }
        if (
          (job.stage === 'failed' || job.stage === 'paused') &&
          summary.resumes!.length < resumes
        ) {
          // What a user does after a dropped connection: wait, press Resume.
          await delay(20_000)
          const from = `${job.stage}: ${job.error || job.detail}`
          const r = await ask(transfers, { action: 'resume', id: job.id })
          summary.resumes!.push({
            atMs: Date.now() - t0,
            from,
            ...(r.error ? { error: r.error } : {}),
          })
          log(
            `Download: resumed after ${from}${r.error ? ` (${r.error})` : ''}`,
          )
          last = ''
          continue
        }
        if (FINAL.has(job.stage)) break
      }
      await delay(500)
    }
    summary.transfer = job ?? null
    summary.ms = Date.now() - t0
    if (!job) throw new Error('no transfer appeared')
    if (job.stage !== 'completed')
      throw new Error(
        FINAL.has(job.stage)
          ? `ended ${job.stage}: ${job.error || job.detail}`
          : `timed out at ${job.stage}: ${job.detail}`,
      )
    summary.ok = true
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error)
    summary.ms = Date.now() - t0
    log(`Download error: ${summary.error}`)
  }
  return summary
}
