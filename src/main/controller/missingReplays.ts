import { dialog, IpcMainEvent } from 'electron'
import { Worker } from 'worker_threads'
import type { ControllerCore } from './context'
import { askDialog } from '../askRenderer'
import { logMain } from '../logger'
import { RequestEnvelope, unpackRequest, reply } from '../ipcUtils'
import type { MissingReport } from '../missingReplays'

export type Ctx = Pick<
  ControllerCore,
  | 'archive'
  | 'clipManager'
  | 'countWorkerExecArgv'
  | 'library'
  | 'mainWindow'
  | 'missingReport'
  | 'missingWorker'
  | 'startCpuScan'
  | 'transferManager'
>

export function runMissingWorker(
  ctx: Ctx,
  dbPath: string,
  mode: 'check' | 'locate' | 'missingIds',
  folder?: string,
): Promise<{ report?: MissingReport; ids?: number[] }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('../MissingCheckWorker.ts', import.meta.url),
      {
        workerData: {
          dbPath,
          libraryFolder: ctx.library().folder,
          mode,
          folder,
        },
        ...(ctx.countWorkerExecArgv
          ? { execArgv: ctx.countWorkerExecArgv }
          : {}),
      },
    )
    if (mode === 'check') ctx.missingWorker = worker
    worker.on(
      'message',
      (m: {
        type: string
        report?: MissingReport
        ids?: number[]
        message?: string
      }) => {
        if (m.type === 'progress') return
        if (m.type === 'done') resolve(m)
        else reject(new Error(m.message || 'Checking replays failed.'))
        worker.terminate()
      },
    )
    worker.once('error', reject)
    worker.once('exit', () => {
      if (ctx.missingWorker === worker) ctx.missingWorker = null
      reject(new Error('stopped'))
    })
  })
}

export function publishMissing(ctx: Ctx, report: MissingReport | null) {
  ctx.missingReport = report
  if (!ctx.mainWindow.isDestroyed())
    ctx.mainWindow.webContents.send('missingReplays', report)
}

/** Check the open project's replays are still on disk (in the background). */
export function startMissingCheck(ctx: Ctx) {
  const projectPath = ctx.archive?.path
  ctx.missingWorker?.terminate()
  publishMissing(ctx, null)
  if (!projectPath) return
  runMissingWorker(ctx, projectPath, 'check')
    .then(({ report }) => {
      if (!report || ctx.archive?.path !== projectPath) return
      if (report.missing || report.repointed)
        logMain('missing replays', {
          projectPath,
          missing: report.missing,
          repointed: report.repointed,
          folders: report.folders.slice(0, 5),
        })
      publishMissing(ctx, report)
    })
    .catch((error) => {
      if ((error as Error).message !== 'stopped')
        logMain('missing replays check failed', error)
    })
    // Then (missing games marked, so they aren't tried) look for CPU players
    // in games imported before Clipper recorded them.
    .finally(() => {
      if (ctx.archive?.path === projectPath) ctx.startCpuScan()
    })
}

export async function getMissingReplays(
  ctx: Ctx,
  event: IpcMainEvent,
  data?: RequestEnvelope<null>,
) {
  const { requestId } = unpackRequest<null>(data)
  const report =
    ctx.missingReport?.projectPath === ctx.archive?.path
      ? ctx.missingReport
      : null
  return reply(event, 'getMissingReplays', requestId, report)
}

/** The warning's buttons: Locate…, Download again, Remove from project. */
export async function missingReplaysAction(
  ctx: Ctx,
  event: IpcMainEvent,
  data?: RequestEnvelope<{ action: 'locate' | 'download' | 'remove' }>,
) {
  const { requestId, payload } = unpackRequest<{
    action: 'locate' | 'download' | 'remove'
  }>(data)
  const archive = ctx.archive
  const done = (body: unknown) =>
    reply(event, 'missingReplaysAction', requestId, body)
  if (!archive) return done({ error: 'No project open.' })
  const report = ctx.missingReport
  try {
    if (payload?.action === 'locate') {
      const picked = await dialog.showOpenDialog(ctx.mainWindow, {
        title: 'Where are the missing replays now?',
        properties: ['openDirectory'],
      })
      if (picked.canceled || !picked.filePaths[0])
        return done({ cancelled: true })
      const { report: next } = await runMissingWorker(
        ctx,
        archive.path,
        'locate',
        picked.filePaths[0],
      )
      if (next && ctx.archive?.path === archive.path) publishMissing(ctx, next)
      const found = (report?.missing ?? 0) - (next?.missing ?? 0)
      return done({ found: Math.max(0, found), report: next })
    }
    if (payload?.action === 'download') {
      const ids = report?.downloadable ?? []
      if (!ids.length) return done({ error: 'Nothing to download.' })
      ctx.transferManager.downloadReplays(
        ids,
        `Download ${ids.length.toLocaleString()} missing replays again`,
      )
      return done({ started: ids.length })
    }
    if (payload?.action === 'remove') {
      const count = report?.missing ?? 0
      const { response } = await askDialog(ctx.mainWindow, {
        type: 'warning',
        title: 'Remove missing replays',
        message: `Remove ${count.toLocaleString()} missing replays and their clips from “${archive.name}”?`,
        detail:
          'Only this project changes; no files are deleted. If they come back later, import them again.',
        buttons: ['Remove', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      })
      if (response !== 0) return done({ cancelled: true })
      const { ids = [] } = await runMissingWorker(
        ctx,
        archive.path,
        'missingIds',
      )
      const removed = await ctx.clipManager.removeGames(ids)
      startMissingCheck(ctx)
      return done({ removed })
    }
    return done({ error: 'Unknown action.' })
  } catch (error) {
    return done({ error: (error as Error).message })
  }
}
