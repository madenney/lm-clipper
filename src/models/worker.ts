import { ClipInterface, FileInterface, WorkerMessage } from 'constants/types'
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads'

// import methods from './methods'
import methods from './methods'

console.error('started worker')

function postMessage(message: WorkerMessage) {
  parentPort?.postMessage(message)
}

const results = methods[workerData.type](
  workerData.prevResults,
  workerData.params,
  (message: any) => {
    const { current, total } = message
    // console.error(current + ' out of ' + total)
    postMessage({ type: 'progress', current: current, total: total })
  }
)

postMessage({ type: 'results', results: results })

// postMessage('fuck you')
// onmessage =

// Worker.onmessage = function (e) {
// console.error('Message received from main script')
// // const workerResult = `Result: ${e.data[0] * e.data[1]}`
// console.error('Posting message back to main script')
// postMessage(e.data)
// }
//

// globalThis.addEventListener('message', )

// onmessage({ data: ['1', '2'] })
