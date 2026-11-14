import { parentPort, workerData } from 'worker_threads'
import { FileInterface } from 'constants/types'
import { fileProcessor } from './File'
import {
  decompressSlpzForImport,
  keepsSlpz,
  type SlpzConfig,
} from '../lib/slpzDecompress'

type ImportRequest = {
  type: 'process'
  id: number
  filePath: string
}

type ImportResponse =
  | { type: 'result'; id: number; fileJSON: FileInterface }
  | { type: 'error'; id: number; error: string }

const slpzConfig: SlpzConfig | null = workerData?.slpzConfig || null

function decompressSlpz(slpzPath: string): string {
  if (!slpzConfig) {
    throw new Error('No slpz config provided — cannot decompress .slpz files')
  }
  if (keepsSlpz(slpzPath, slpzConfig)) return slpzPath
  return decompressSlpzForImport(slpzPath, slpzConfig)
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
