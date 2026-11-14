import { Worker } from 'worker_threads'
import path from 'path'
import fs from 'fs'
import type { ControllerCore } from './context'
import { askDialog } from '../askRenderer'
import { closeDbAsync } from '../dbAsync'
import { logMain } from '../logger'
import { buildShallowArchive } from '../ipcUtils'
import {
  CompactionPlan,
  SpaceInfo,
  compactTempPath,
  formatBytes,
  planCompaction,
} from '../projectCompaction'

export type Ctx = Pick<
  ControllerCore,
  | 'archive'
  | 'compactingPath'
  | 'countWorkerExecArgv'
  | 'filterExecutor'
  | 'importManager'
  | 'mainWindow'
  | 'missingWorker'
  | 'reloadArchiveFrom'
  | 'setArchiveInternal'
  | 'stopCpuScan'
  | 'stopNameCountWorker'
  | 'updateWindowTitle'
  | 'videoManager'
>

export function runCompactWorker(
  ctx: Ctx,
  dbPath: string,
  mode: 'info' | 'incremental' | 'copy' | 'games',
  tempPath?: string,
): Promise<SpaceInfo & { games?: number }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../CompactWorker.ts', import.meta.url), {
      workerData: { dbPath, mode, tempPath },
      ...(ctx.countWorkerExecArgv ? { execArgv: ctx.countWorkerExecArgv } : {}),
    })
    worker.once(
      'message',
      (m: { type: string; info?: SpaceInfo; message?: string }) => {
        if (m.type === 'done' && m.info) resolve(m.info)
        else reject(new Error(m.message || 'Compaction failed.'))
        worker.terminate()
      },
    )
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Compaction stopped (exit ${code}).`))
    })
  })
}

/**
 * File > Compact Project…: give back the unused space in the open project
 * (projectCompaction.ts). The project is closed while it runs, so nothing can
 * write to it, and reopened afterwards.
 */
export async function compactProject(ctx: Ctx) {
  const archive = ctx.archive
  const win = ctx.mainWindow
  const notice = (
    type: 'info' | 'warning' | 'error',
    message: string,
    detail?: string,
  ) =>
    askDialog(win, {
      type,
      title: 'Compact Project',
      message,
      detail,
    })
  if (!archive) return notice('info', 'Open a project to compact it.')
  if (ctx.compactingPath)
    return notice('info', 'A project is already being compacted.')
  if (
    ctx.filterExecutor.runningFilterIds.size > 0 ||
    ctx.importManager.importInProgress ||
    ctx.videoManager.activeVideoJob
  )
    return notice(
      'warning',
      'Finish or stop running filters, imports and recordings first.',
    )

  const projectPath = archive.path
  let plan: CompactionPlan
  try {
    const info = await runCompactWorker(ctx, projectPath, 'info')
    const stat = await (
      fs.promises as unknown as {
        statfs: (_p: string) => Promise<{ bavail: number; bsize: number }>
      }
    ).statfs(path.dirname(projectPath))
    plan = planCompaction(info, stat.bavail * stat.bsize)
  } catch (error) {
    return notice(
      'error',
      'Could not read the project.',
      (error as Error).message,
    )
  }
  if (plan.mode === 'none')
    return notice(
      'info',
      `“${archive.name}” has no unused space to give back.`,
      `It uses ${formatBytes(plan.fileBytes)}.`,
    )
  if (!plan.enoughDisk)
    return notice(
      'warning',
      'Not enough free disk space to compact this project.',
      `Compacting writes a new copy (${formatBytes(plan.liveBytes)}) next to the project before replacing it. Free up ${formatBytes(plan.needBytes)} on that drive and try again.`,
    )
  const { response } = await askDialog(win, {
    type: 'question',
    title: 'Compact Project',
    message: `Give back ${formatBytes(plan.reclaimBytes)} of unused space in “${archive.name}”?`,
    detail:
      plan.mode === 'copy'
        ? `The project goes from ${formatBytes(plan.fileBytes)} to about ${formatBytes(plan.liveBytes)}. Clipper writes a compacted copy next to it, checks it, then swaps it in; your project is untouched until then. It closes while this runs (minutes for large projects) and reopens when done. Later compactions of this project are quick.`
        : `The project goes from ${formatBytes(plan.fileBytes)} to about ${formatBytes(plan.liveBytes)}. It closes briefly while this runs.`,
    buttons: ['Compact', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  })
  if (response !== 0) return undefined

  // Close the project (as closeArchive does, but it reopens afterwards).
  ctx.compactingPath = projectPath
  ctx.stopNameCountWorker()
  ctx.stopCpuScan()
  ctx.missingWorker?.terminate()
  await ctx.stopCpuScan()
  await closeDbAsync()
  ctx.setArchiveInternal(null)
  if (!win.isDestroyed()) win.webContents.send('archiveUpdated', null)
  const tempPath = compactTempPath(projectPath)
  const title = (text: string) => {
    if (!win.isDestroyed()) win.setTitle(`Lunar Clipper — ${text}`)
  }
  title(`Compacting ${archive.name}…`)
  if (!win.isDestroyed()) win.setProgressBar(2) // indeterminate
  // Progress for a copy: how much of the compacted size is written.
  const timer =
    plan.mode === 'copy'
      ? setInterval(() => {
          fs.promises
            .stat(tempPath)
            .then((s) => {
              const f = Math.min(0.99, s.size / Math.max(1, plan.liveBytes))
              if (!win.isDestroyed()) win.setProgressBar(f)
              title(`Compacting ${archive.name} — ${Math.round(f * 100)}%`)
            })
            .catch(() => {})
        }, 1000)
      : null
  let result: { ok: true; size: number } | { ok: false; error: string }
  try {
    if (plan.mode === 'incremental') {
      await runCompactWorker(ctx, projectPath, 'incremental')
    } else {
      await runCompactWorker(ctx, projectPath, 'copy', tempPath)
      // Nothing may hold the project open across the swap.
      await closeDbAsync()
      const wal = `${projectPath}-wal`
      if (fs.existsSync(wal) && fs.statSync(wal).size > 0)
        throw new Error('The project changed while it was being compacted.')
      fs.renameSync(tempPath, projectPath)
      for (const f of [wal, `${projectPath}-shm`]) fs.rmSync(f, { force: true })
    }
    result = { ok: true, size: fs.statSync(projectPath).size }
  } catch (error) {
    fs.rmSync(tempPath, { force: true })
    result = { ok: false, error: (error as Error).message }
  } finally {
    if (timer) clearInterval(timer)
    if (!win.isDestroyed()) win.setProgressBar(-1)
    ctx.compactingPath = null
  }

  // Reopen the project (the original, if compacting failed).
  try {
    await ctx.reloadArchiveFrom(projectPath)
    if (!win.isDestroyed())
      win.webContents.send('archiveUpdated', buildShallowArchive(ctx.archive))
  } catch (error) {
    logMain('compactProject: reopen failed', error)
  }
  ctx.updateWindowTitle()
  logMain('compactProject', { projectPath, mode: plan.mode, result })
  return result.ok
    ? notice(
        'info',
        `Gave back ${formatBytes(plan.fileBytes - result.size)}.`,
        `“${archive.name}” is now ${formatBytes(result.size)}.`,
      )
    : notice(
        'error',
        'Compacting failed. Your project is unchanged.',
        result.error,
      )
}
