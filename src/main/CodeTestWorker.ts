/**
 * Runs the Code Editor's "Test run" off the main thread, with the same custom
 * filter code path as a real run (models/methods/custom.ts), so a loop that never
 * ends or a slow replay read freezes only this worker (which the caller stops
 * after its time limit), not the whole app (launch review SEC-2).
 * workerData: { code, items, customParams, timeoutMs }.
 * Replies { type: 'done', logs, outputClips, outputCount } or { type: 'error', message }.
 */
import { parentPort, workerData } from 'worker_threads'
import custom from '../models/methods/custom'

const { code, items, customParams, timeoutMs } = workerData as {
  code: string
  items: any[]
  customParams?: any[]
  timeoutMs: number
}

try {
  const result: any = custom(
    items,
    { code, maxFiles: '', customParams, __timeoutMs: timeoutMs } as any,
    () => {},
  )
  const clips = Array.isArray(result) ? result : (result?.clips ?? [])
  parentPort?.postMessage({
    type: 'done',
    logs: Array.isArray(result?.logs) ? result.logs : [],
    outputClips: clips.slice(0, 20),
    outputCount: clips.length,
  })
} catch (error: any) {
  parentPort?.postMessage({
    type: 'error',
    message: error?.message || String(error),
    logs: Array.isArray(error?.logs) ? error.logs : [],
  })
}
