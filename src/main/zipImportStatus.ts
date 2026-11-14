/**
 * A ZIP import shows what it's doing from the moment the ZIP wizard closes
 * (there used to be nothing until the import itself started): the top bar's
 * import status says "Extracting <zip>" with the entries done, and the app
 * console runs with the same label and logs the result. Both hand over to the
 * import (phase cleared) once the ZIP is unpacked. Used by ImportManager.
 */
import path from 'path'
import { extractReplayZip } from './replayExtraction'

export type ExtractStatus = {
  isImporting?: boolean
  current?: number
  total?: number | null
  phase?: 'extracting' | null
  label?: string
}

type ExtractConsole = {
  startConsole: (
    _operation: 'import',
    _label: string,
    _opts?: { live?: boolean },
  ) => number | undefined
  stopConsole: (_id?: number) => void
  pushConsoleLog: (_level: 'info' | 'error', _message: string) => void
}

// Progress goes to the renderer at most this often.
const PROGRESS_MS = 150

export async function extractZipWithStatus(
  zipPath: string,
  outputDir: string,
  deps: {
    signal: AbortSignal
    setStatus: (_next: ExtractStatus) => void
    console: ExtractConsole
  },
): Promise<number> {
  const label = path.basename(zipPath)
  deps.setStatus({
    isImporting: true,
    current: 0,
    total: null,
    phase: 'extracting',
    label,
  })
  const consoleId = deps.console.startConsole('import', `Extracting ${label}`, {
    live: false,
  })
  deps.console.pushConsoleLog('info', `Extracting ${label}…`)
  let lastSent = 0
  const latest: { current: number; total: number | null; seen: boolean } = {
    current: 0,
    total: null,
    seen: false,
  }
  try {
    const count = await extractReplayZip(zipPath, outputDir, {
      signal: deps.signal,
      onProgress: (current, total) => {
        latest.current = current
        latest.total = total
        latest.seen = true
        const now = Date.now()
        if (now - lastSent < PROGRESS_MS) return
        lastSent = now
        deps.setStatus({ current, total })
      },
    })
    if (latest.seen)
      deps.setStatus({ current: latest.current, total: latest.total })
    deps.console.pushConsoleLog(
      'info',
      `Extracted ${count.toLocaleString()} ${count === 1 ? 'replay' : 'replays'} from ${label}`,
    )
    return count
  } catch (error) {
    // Logged here so it goes out with this console, before it stops.
    if (deps.signal.aborted)
      deps.console.pushConsoleLog('info', `Stopped extracting ${label}`)
    else
      deps.console.pushConsoleLog(
        'error',
        `Could not extract ${label}: ${error instanceof Error ? error.message : String(error)}`,
      )
    throw error
  } finally {
    deps.setStatus({ phase: null, label: '', current: 0, total: null })
    deps.console.stopConsole(consoleId)
  }
}
