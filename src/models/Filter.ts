import {
  FilterInterface,
  FileInterface,
  ClipInterface,
  WorkerMessage,
} from '../constants/types'
import { Worker } from 'worker_threads'

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
    const thread_count = 5
    const maxFiles = this.params.maxFiles ?? prevResults.length

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
      const resultsSoFar = splitPrevResults.slice(0, i).reduce((acc, c) => {
        return acc + c.length
      }, 0)
      console.log(
        'starting worker for ' +
          resultsSoFar +
          ' to ' +
          (resultsSoFar + prevResultsSection.length - 1)
      )

      const worker = new Worker('./src/models/worker.ts', {
        workerData: {
          type: this.type,
          prevResults: prevResultsSection,
          params: this.params,
        },
        execArgv: ['--require', 'ts-node/register'],
      })

      //TODO make this not any
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
          }
        })
      })
      return promise
    })

    return (await Promise.all(promises)).flat()
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
