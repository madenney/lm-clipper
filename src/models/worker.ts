import { WorkerMessage } from 'constants/types'
import { parentPort, workerData } from 'worker_threads'

import methods from './methods'

function postMessage(message: WorkerMessage) {
  parentPort?.postMessage(message)
}

const results = methods[workerData.type](
  workerData.prevResults,
  workerData.params,
  (message: any) => {
    const { current, total } = message
    postMessage({ type: 'progress', current: current, total: total })
  }
)

postMessage({ type: 'results', results: results })
