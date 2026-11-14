import { IpcMainEvent } from 'electron'
import { Worker } from 'worker_threads'
import type { ControllerCore } from './context'
import { logMain } from '../logger'
import { RequestEnvelope, unpackRequest, reply } from '../ipcUtils'
import CpuScanControl from '../cpuScanControl'
import type { LastFrameScanCounts } from '../../lib/lastFrame'

export type Ctx = Pick<
  ControllerCore,
  | 'archive'
  | 'countWorkerExecArgv'
  | 'cpuScan'
  | 'filterExecutor'
  | 'importManager'
  | 'lastFrameScan'
  | 'mainWindow'
>

export function createCpuScan(ctx: Ctx) {
  return new CpuScanControl({
    spawn: (dbPath) =>
      new Worker(new URL('../CpuScanWorker.ts', import.meta.url), {
        workerData: { dbPath },
        ...(ctx.countWorkerExecArgv
          ? { execArgv: ctx.countWorkerExecArgv }
          : {}),
      }),
    isBusy: () =>
      ctx.importManager.importStatus.isImporting ||
      ctx.filterExecutor.runningFilterControllers.size > 0,
    publish: (status) => {
      if (!ctx.mainWindow.isDestroyed())
        ctx.mainWindow.webContents.send('cpuScanStatus', status)
    },
    log: (message, data) => logMain(message, data),
  })
}

export function createLastFrameScan(ctx: Ctx) {
  return new CpuScanControl<LastFrameScanCounts>({
    spawn: (dbPath) =>
      new Worker(new URL('../LastFrameScanWorker.ts', import.meta.url), {
        workerData: { dbPath },
        ...(ctx.countWorkerExecArgv
          ? { execArgv: ctx.countWorkerExecArgv }
          : {}),
      }),
    isBusy: () =>
      ctx.importManager.importStatus.isImporting ||
      ctx.filterExecutor.runningFilterControllers.size > 0,
    publish: (status) => {
      if (!ctx.mainWindow.isDestroyed())
        ctx.mainWindow.webContents.send('lastFrameScanStatus', status)
    },
    log: (message, data) => logMain(message, data),
    blank: {
      total: 0,
      checked: 0,
      repaired: 0,
      missing: 0,
      unreadable: 0,
      resultsRows: 0,
    },
    name: 'game length scan',
  })
}

export async function getLastFrameScanStatus(
  ctx: Ctx,
  event: IpcMainEvent,
  data?: RequestEnvelope<null>,
) {
  const { requestId } = unpackRequest<null>(data)
  return reply(
    event,
    'getLastFrameScanStatus',
    requestId,
    ctx.lastFrameScan.statusFor(ctx.archive?.path),
  )
}

/** The game-length bar's Stop and Continue. */
export async function lastFrameScanAction(
  ctx: Ctx,
  event: IpcMainEvent,
  data?: RequestEnvelope<{ action: 'stop' | 'continue' }>,
) {
  const { requestId, payload } = unpackRequest<{
    action: 'stop' | 'continue'
  }>(data)
  const projectPath = ctx.archive?.path
  if (projectPath && payload?.action === 'stop')
    await ctx.lastFrameScan.stop({ byUser: true })
  else if (projectPath && payload?.action === 'continue')
    ctx.lastFrameScan.continue(projectPath)
  return reply(
    event,
    'lastFrameScanAction',
    requestId,
    ctx.lastFrameScan.statusFor(projectPath),
  )
}

export async function getCpuScanStatus(
  ctx: Ctx,
  event: IpcMainEvent,
  data?: RequestEnvelope<null>,
) {
  const { requestId } = unpackRequest<null>(data)
  return reply(
    event,
    'getCpuScanStatus',
    requestId,
    ctx.cpuScan.statusFor(ctx.archive?.path),
  )
}

/** The progress bar's buttons: Stop (for this session, until Continue) and Continue. */
export async function cpuScanAction(
  ctx: Ctx,
  event: IpcMainEvent,
  data?: RequestEnvelope<{ action: 'stop' | 'continue' }>,
) {
  const { requestId, payload } = unpackRequest<{
    action: 'stop' | 'continue'
  }>(data)
  const projectPath = ctx.archive?.path
  if (projectPath && payload?.action === 'stop')
    await ctx.cpuScan.stop({ byUser: true })
  else if (projectPath && payload?.action === 'continue')
    ctx.cpuScan.continue(projectPath)
  return reply(
    event,
    'cpuScanAction',
    requestId,
    ctx.cpuScan.statusFor(projectPath),
  )
}
