import { parentPort } from 'worker_threads'
import { streamSlpFilePaths } from '../lib/file'

type CountRequest = {
  type: 'count'
  paths: string[]
}

type CountResponse =
  | { type: 'done'; total: number }
  | { type: 'error'; error: string }

const postMessage = (message: CountResponse) => {
  parentPort?.postMessage(message)
}

if (!parentPort) {
  throw new Error('Import count worker missing parent port')
}

parentPort.on('message', async (message: CountRequest) => {
  if (!message || message.type !== 'count') return
  try {
    let total = 0
    const paths = Array.isArray(message.paths) ? message.paths : []
    for await (const _path of streamSlpFilePaths(paths)) {
      total += 1
    }
    postMessage({ type: 'done', total })
  } catch (error) {
    const errorText = error instanceof Error ? error.message : String(error)
    postMessage({ type: 'error', error: errorText })
  }
})
