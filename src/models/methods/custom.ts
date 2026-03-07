import { ClipInterface, EventEmitterInterface } from 'constants/types'
import { SlippiGame } from '@slippi/slippi-js'

export interface CustomResult {
  clips: ClipInterface[]
  logs: string[]
}

export default (
  prevResults: ClipInterface[],
  params: { [key: string]: any },
  eventEmitter: EventEmitterInterface,
): ClipInterface[] | CustomResult => {
  const { code, maxFiles } = params

  if (!code || typeof code !== 'string') {
    return prevResults
  }

  const limit =
    maxFiles === '' || maxFiles === undefined
      ? prevResults.length
      : parseInt(maxFiles, 10)

  const sliced = prevResults.slice(
    0,
    Number.isNaN(limit) ? prevResults.length : limit,
  )

  eventEmitter({ current: 0, total: sliced.length })

  // Flatten customParams onto a merged params object for user code
  const reserved = new Set(['code', 'maxFiles', 'customParams'])
  const mergedParams: { [key: string]: any } = { ...params }
  if (Array.isArray(params.customParams)) {
    for (const cp of params.customParams) {
      if (!cp.name || reserved.has(cp.name)) continue
      if (cp.type === 'int') {
        const n = parseInt(cp.value, 10)
        mergedParams[cp.name] = Number.isNaN(n) ? 0 : n
      } else if (cp.type === 'array') {
        mergedParams[cp.name] = (cp.value ?? '')
          .split(',')
          .map((s: string) => s.trim())
          .filter(Boolean)
      } else {
        mergedParams[cp.name] = cp.value ?? ''
      }
    }
  }

  // Capture console output from user code
  const logs: string[] = []
  const fakeConsole = {
    log: (...args: any[]) => {
      logs.push(
        args
          .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
          .join(' '),
      )
    },
    warn: (...args: any[]) => {
      logs.push(
        `[warn] ${args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')}`,
      )
    },
    error: (...args: any[]) => {
      logs.push(
        `[error] ${args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')}`,
      )
    },
  }

  let userFn: Function
  try {
    // eslint-disable-next-line no-new-func
    userFn = new Function('clips', 'params', 'SlippiGame', 'console', code)
  } catch (err: any) {
    throw new Error(
      `Syntax error in custom code: ${err?.message || String(err)}`,
    )
  }

  try {
    const result = userFn(sliced, mergedParams, SlippiGame, fakeConsole)
    if (!Array.isArray(result)) {
      throw new Error(`Custom code must return an array, got ${typeof result}`)
    }
    if (logs.length > 0) {
      return { clips: result, logs }
    }
    return result
  } catch (err: any) {
    const msg = err?.message || String(err)
    const stackLine = err?.stack
      ?.split('\n')
      ?.find((l: string) => l.includes('<anonymous>'))
      ?.trim()
    const error = new Error(
      `Runtime error in custom code: ${msg}${stackLine ? `\n  at ${stackLine}` : ''}`,
    )
    // Attach logs so they're available even on error
    ;(error as any).logs = logs
    throw error
  }
}
