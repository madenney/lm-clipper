import {
  FilterInterface,
  FileInterface,
  ClipInterface,
  WorkerMessage,
} from '../constants/types'
import { Worker } from 'worker_threads'

import methods from './methods'
import { exit } from 'process'

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
    eventEmitter: any
  ): Promise<ClipInterface[] | FileInterface[]> {
    console.log('running: ', this.type)

    const thread_count = 5
    const maxFiles = this.params.maxFiles ?? prevResults.length

    const splitPrevResults = []
    const completeds: number[] = []
    // const results: FileInterface[][] | ClipInterface[][] = []
    const results: any[][] = []
    for (let i = 0; i < thread_count; i++) {
      const len = maxFiles
      splitPrevResults.push(
        prevResults.slice(
          Math.floor((len * i) / thread_count),
          Math.floor((len * (i + 1)) / thread_count)
        )
      )
      completeds.push(0)
      results.push([])
    }

    const promises = splitPrevResults.map((prevResultsSection, i) => {
      console.error('About to start worker' + i)
      const worker = new Worker('./src/models/worker.ts', {
        workerData: {
          type: this.type,
          prevResults: prevResultsSection,
          params: this.params,
        },
        execArgv: ['--require', 'ts-node/register'],
      })

      const promise: Promise<any> = new Promise((resolve, reject) => {
        worker.addListener('message', (e: WorkerMessage) => {
          if (e.type == 'progress') {
            completeds[i] = e.current
            //TODO total maybe should also update
            // console.log('cteds' + completeds)
            eventEmitter({
              current: completeds.reduce((a, b) => a + b, 0),
              total: maxFiles,
            })
          } else if (e.type == 'results') {
            results[i] = e.results
            // console.log( 'results: ', results.map((r) => r?.length))
            resolve(e.results)
          }
        })
      })
      return promise
    })

    console.log('before the promise.all')
    //TODO make this better (not any)
    // this.results = (await Promise.all(promises)).flat()

    return (await Promise.all(promises)).flat()

    // this.results = methods[this.type](prevResults, this.params, eventEmitter)
    // this.isProcessed = true
    /*
    (eventUpdate: { current: number; total: number }) => {
        const { total, current } = eventUpdate
        this.mainWindow.webContents.send('filterUpdate', {
        total,
        current,
    })
      */
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
