import { parentPort, workerData } from 'worker_threads'
import { execFileSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import { FileInterface } from 'constants/types'
import { fileProcessor } from './File'

type ImportRequest = {
  type: 'process'
  id: number
  filePath: string
}

type ImportResponse =
  | { type: 'result'; id: number; fileJSON: FileInterface }
  | { type: 'error'; id: number; error: string }

type SlpzConfig = {
  slpzBinaryPath: string
  slpzMode: 'extract' | 'replace'
  slpzOutputDir: string
}

const slpzConfig: SlpzConfig | null = workerData?.slpzConfig || null

function decompressSlpz(slpzPath: string): string {
  if (!slpzConfig) {
    throw new Error('No slpz config provided — cannot decompress .slpz files')
  }

  let outputPath: string
  if (slpzConfig.slpzMode === 'extract' && slpzConfig.slpzOutputDir) {
    const basename = `${path.basename(slpzPath, '.slpz')}.slp`
    outputPath = path.join(slpzConfig.slpzOutputDir, basename)
    // Avoid collisions from different source directories with same filename
    if (fs.existsSync(outputPath)) {
      const parentName = path.basename(path.dirname(slpzPath))
      outputPath = path.join(
        slpzConfig.slpzOutputDir,
        `${parentName}_${basename}`,
      )
    }
    fs.mkdirSync(slpzConfig.slpzOutputDir, { recursive: true })
  } else {
    outputPath = slpzPath.replace(/\.slpz$/i, '.slp')
  }

  try {
    execFileSync(
      slpzConfig.slpzBinaryPath,
      ['-d', '-o', outputPath, slpzPath],
      { timeout: 60000 },
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      `slpz decompression failed for ${path.basename(slpzPath)}: ${msg}`,
    )
  }

  // In replace mode, delete the original .slpz
  if (slpzConfig.slpzMode === 'replace') {
    try {
      fs.unlinkSync(slpzPath)
    } catch {
      // Non-fatal
    }
  }

  return outputPath
}

function postMessage(message: ImportResponse) {
  parentPort?.postMessage(message)
}

if (!parentPort) {
  throw new Error('Import worker missing parent port')
}

parentPort.on('message', (message: ImportRequest) => {
  if (!message || message.type !== 'process') return
  try {
    let filePath = message.filePath
    if (filePath.toLowerCase().endsWith('.slpz')) {
      filePath = decompressSlpz(filePath)
    }
    const fileJSON = fileProcessor(filePath)
    postMessage({ type: 'result', id: message.id, fileJSON })
  } catch (error) {
    const errorText = error instanceof Error ? error.message : String(error)
    postMessage({ type: 'error', id: message.id, error: errorText })
  }
})
