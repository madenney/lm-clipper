import {
  FilterInterface,
  FileInterface,
  ClipInterface,
  WorkerMessage,
  EventEmitterInterface
} from '../constants/types'
import { Worker } from 'worker_threads'
import { ipcMain } from 'electron'
import methods from './methods'

export default class Filter {
  label: string
  type: string
  isProcessed: boolean
  params: { [key: string]: any }
  results: ClipInterface[] | FileInterface[]
  constructor(filterJSON: FilterInterface) {
    this.label = filterJSON.label
    this.type = filterJSON.type
    this.isProcessed = filterJSON.isProcessed
    this.params = filterJSON.params
    this.results = filterJSON.results
  }

  async run(
    prevResults: ClipInterface[] | FileInterface[],
    numFilterThreads: number,
    eventEmitter: EventEmitterInterface
  ) {

    const methodsThatNeedMultithread = ['slpParser', 'removeStarKOFrames', 'actionStateFilter']
    let terminated = false
    const savedResults = this.results

    if(methodsThatNeedMultithread.indexOf(this.type) > -1 ){

      const thread_count = numFilterThreads

      let maxFiles = prevResults.length
      if(this.params.maxFiles && this.params.maxFiles < prevResults.length){
        maxFiles = this.params.maxFiles
      }

      // split previous results into sections, one for each thread
      const splitPrevResults: (ClipInterface[] | FileInterface[])[] = []
      const completeds: number[] = []
      for (let i = 0; i < thread_count; i++) {
        const len = maxFiles
        splitPrevResults.push(
          prevResults.slice(
            Math.floor((len * i) / thread_count),
            Math.floor((len * (i + 1)) / thread_count)
          )
        )
        completeds.push(0)
      }

      const promises = splitPrevResults.map((prevResultsSection, i) => {
        const worker = new Worker(new URL('./Worker.ts', import.meta.url), {
          workerData: {
            type: this.type,
            prevResults: prevResultsSection,
            params: this.params,
          },
          //execArgv: ['--require', 'ts-node/register'],
        })

        const promise: Promise<any> = new Promise((resolve) => {
          worker.addListener('message', (e: WorkerMessage) => {
            if (e.type == 'progress') {
              completeds[i] = e.current
              eventEmitter({
                current: completeds.reduce((a, b) => a + b, 0),
                total: maxFiles,
              })
            } else if (e.type == 'results') {
              resolve(e.results)
              worker.terminate().then(() => {
                console.log('Worker terminated');
              })
            }
          })


          ipcMain.on('terminateWorkers', () => {
            worker.terminate()
            terminated = true

            // TODO: Return partially completed results
            resolve([])
          })

        })
        return promise
      })

      const newResults = (await Promise.all(promises)).flat()
      if( terminated ){
        this.isProcessed = false
        return true
      } else {
        this.isProcessed = true
        this.results = newResults
        return false
      }

    } else {
      this.results = methods[this.type](prevResults, this.params, eventEmitter)
      this.isProcessed = true
      return false
    }
  }

  generateJSON() {
    return {
      label: this.label,
      type: this.type,
      isProcessed: this.isProcessed,
      params: this.params,
      results: this.results,
    }
  }
}
