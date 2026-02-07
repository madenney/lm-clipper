import { parentPort } from 'worker_threads'
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

function postMessage(message: ImportResponse) {
  parentPort?.postMessage(message)
}

if (!parentPort) {
  throw new Error('Import worker missing parent port')
}

parentPort.on('message', (message: ImportRequest) => {
  if (!message || message.type !== 'process') return
  try {
    const fileJSON = fileProcessor(message.filePath)
    postMessage({ type: 'result', id: message.id, fileJSON })
  } catch (error) {
    const errorText = error instanceof Error ? error.message : String(error)
    postMessage({ type: 'error', id: message.id, error: errorText })
  }
})
