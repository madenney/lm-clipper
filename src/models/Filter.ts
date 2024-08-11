import {
  FilterInterface,
  FileInterface,
  ClipInterface,
  WorkerMessage,
  EventEmitterInterface
} from '../constants/types'
import * as db from './db'
import { getSqlitePath } from '../main/util'
const sqlite3Path = getSqlitePath()
import { Worker } from 'worker_threads'
import { ipcMain } from 'electron'
import methods from './methods'
import { asyncForEach } from '../lib'

export default class Filter {
  id: string
  label: string
  type: string
  isProcessed: boolean
  params: { [key: string]: any }
  results: number
  constructor(filterJSON: FilterInterface) {
    this.id = filterJSON.id
    this.label = filterJSON.label
    this.type = filterJSON.type
    this.isProcessed = filterJSON.isProcessed
    this.params = filterJSON.params
    this.results = filterJSON.results
  }

  async init(dbPath: string){
    await db.createFilterTable(dbPath, this.id)
  }

  async delete(dbPath: string){
    await db.deleteFilterTable(dbPath, this.id)
  }


  async run3(
    dbPath: string,
    prevTableId: string,
    numFilterThreads: number,
    eventEmitter: EventEmitterInterface
  ){
    console.log("================ RUN 3 ====================== ")
    const thread_count = numFilterThreads

    const prevResultsLength = await getTableLength(dbPath, prevTableId)
    console.log("PREV LENGTH: ", prevResultsLength)

    let maxFiles = prevResultsLength
    if(this.params.maxFiles && this.params.maxFiles < prevResultsLength){
      maxFiles = this.params.maxFiles
    }

    maxFiles = 1000
    const slices = createSlices(maxFiles, thread_count);

    console.log("SLICES: ", slices)

    // // split previous results into sections, one for each thread
    // const splitPrevResults: (ClipInterface[] | FileInterface[])[] = []
    // const completeds: number[] = []
    // for (let i = 0; i < thread_count; i++) {
    //   const len = maxFiles
    //   splitPrevResults.push(
    //     prevResults.slice(
    //       Math.floor((len * i) / thread_count),
    //       Math.floor((len * (i + 1)) / thread_count)
    //     )
    //   )
    //   completeds.push(0)
    // }
    
    let terminated = false
    const promises = slices.map((slice, i) => {
      const worker = new Worker(new URL('./Worker.ts', import.meta.url), {
        workerData: {
          sqlite3Path,
          dbPath: dbPath,
          prevTableId: prevTableId,
          nextTableId: this.id,
          type: this.type,
          slice,
          params: this.params,
        },
        //execArgv: ['--require', 'ts-node/register'],
      })

      const promise: Promise<any> = new Promise((resolve) => {
        worker.addListener('message', (e: WorkerMessage) => {
          if (e.type == 'progress') {
            slices[i].completed = e.current
            console.log('total: ', slices.reduce((acc, slice) => acc + slice.completed, 0))
            // eventEmitter({
            //   current: slices.reduce((acc, slice) => acc + slice.completed, 0),
            //   total: maxFiles,
            // })
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
      //this.results = newResults
      return false
    }


  }













  // async run2(
  //   dbPath: string,
  //   prevTableId: string,
  //   numFilterThreads: number,
  //   eventEmitter: EventEmitterInterface
  // ) {

  //   let prevResults
  //   try {
  //     prevResults = await getAllFromTable(dbPath, prevTableId)
  //   } catch(e){
  //     console.log("Error getting prev results", e)
  //     throw new Error("Error getting prev results")
  //   }

  //   if(!prevResults) throw new Error("Error getting prev results")

  //   console.log(prevResults)

  //   // convert results from array back to object
  //   const convertedPrevResults = this.convertResults(prevResults)

  //   console.log(convertedPrevResults.length)
  //   console.log(convertedPrevResults[0])

  //   const methodsThatNeedMultithread = ['slpParser', 'removeStarKOFrames', 'actionStateFilter']
  //   let terminated = false
  //   //const savedResults = this.results

  //   if(methodsThatNeedMultithread.indexOf(this.type) > -1 ){

  //     const thread_count = numFilterThreads

  //     let maxFiles = prevResults.length
  //     if(this.params.maxFiles && this.params.maxFiles < prevResults.length){
  //       maxFiles = this.params.maxFiles
  //     }

  //     // split previous results into sections, one for each thread
  //     const splitPrevResults: (ClipInterface[] | FileInterface[])[] = []
  //     const completeds: number[] = []
  //     for (let i = 0; i < thread_count; i++) {
  //       const len = maxFiles
  //       splitPrevResults.push(
  //         prevResults.slice(
  //           Math.floor((len * i) / thread_count),
  //           Math.floor((len * (i + 1)) / thread_count)
  //         )
  //       )
  //       completeds.push(0)
  //     }

  //     const promises = splitPrevResults.map((prevResultsSection, i) => {
  //       const worker = new Worker(new URL('./Worker.ts', import.meta.url), {
  //         workerData: {
  //           type: this.type,
  //           prevResults: prevResultsSection,
  //           params: this.params,
  //         },
  //         //execArgv: ['--require', 'ts-node/register'],
  //       })

  //       const promise: Promise<any> = new Promise((resolve) => {
  //         worker.addListener('message', (e: WorkerMessage) => {
  //           if (e.type == 'progress') {
  //             completeds[i] = e.current
  //             eventEmitter({
  //               current: completeds.reduce((a, b) => a + b, 0),
  //               total: maxFiles,
  //             })
  //           } else if (e.type == 'results') {
  //             resolve(e.results)
  //             worker.terminate().then(() => {
  //               console.log('Worker terminated');
  //             })
  //           }
  //         })


  //         ipcMain.on('terminateWorkers', () => {
  //           worker.terminate()
  //           terminated = true

  //           // TODO: Return partially completed results
  //           resolve([])
  //         })

  //       })
  //       return promise
  //     })

  //     const newResults = (await Promise.all(promises)).flat()

  //     console.log("New Results: ", newResults)
  //     return 'whatever'
  //     if( terminated ){
  //       this.isProcessed = false
  //       return true
  //     } else {
  //       this.isProcessed = true
  //       this.results = newResults
  //       return false
  //     }

  //   // if not a multi-thread method
  //   } else {

  //     const results = methods[this.type](convertedPrevResults, this.params, eventEmitter)

  //     // save results
  //     await asyncForEach(results, async result => {
  //       try {
  //         await insertRow(dbPath, this.id, result)
  //       } catch(e){
  //         console.log("ERROR OCCURED DURING RESULT INSERT: ", e)
  //       }
  //     })

  //     this.results = results.length
  //     this.isProcessed = true

  //     return false
  //   }
  // }


  // async run(
  //   prevResults: ClipInterface[] | FileInterface[],
  //   numFilterThreads: number,
  //   eventEmitter: EventEmitterInterface
  // ) {

  //   const methodsThatNeedMultithread = ['slpParser', 'removeStarKOFrames', 'actionStateFilter']
  //   let terminated = false
  //   const savedResults = this.results

  //   if(methodsThatNeedMultithread.indexOf(this.type) > -1 ){

  //     const thread_count = numFilterThreads

  //     let maxFiles = prevResults.length
  //     if(this.params.maxFiles && this.params.maxFiles < prevResults.length){
  //       maxFiles = this.params.maxFiles
  //     }

  //     // split previous results into sections, one for each thread
  //     const splitPrevResults: (ClipInterface[] | FileInterface[])[] = []
  //     const completeds: number[] = []
  //     for (let i = 0; i < thread_count; i++) {
  //       const len = maxFiles
  //       splitPrevResults.push(
  //         prevResults.slice(
  //           Math.floor((len * i) / thread_count),
  //           Math.floor((len * (i + 1)) / thread_count)
  //         )
  //       )
  //       completeds.push(0)
  //     }

  //     const promises = splitPrevResults.map((prevResultsSection, i) => {
  //       const worker = new Worker(new URL('./Worker.ts', import.meta.url), {
  //         workerData: {
  //           type: this.type,
  //           prevResults: prevResultsSection,
  //           params: this.params,
  //         },
  //         //execArgv: ['--require', 'ts-node/register'],
  //       })

  //       const promise: Promise<any> = new Promise((resolve) => {
  //         worker.addListener('message', (e: WorkerMessage) => {
  //           if (e.type == 'progress') {
  //             completeds[i] = e.current
  //             eventEmitter({
  //               current: completeds.reduce((a, b) => a + b, 0),
  //               total: maxFiles,
  //             })
  //           } else if (e.type == 'results') {
  //             resolve(e.results)
  //             worker.terminate().then(() => {
  //               console.log('Worker terminated');
  //             })
  //           }
  //         })


  //         ipcMain.on('terminateWorkers', () => {
  //           worker.terminate()
  //           terminated = true

  //           // TODO: Return partially completed results
  //           resolve([])
  //         })

  //       })
  //       return promise
  //     })

  //     const newResults = (await Promise.all(promises)).flat()
  //     if( terminated ){
  //       this.isProcessed = false
  //       return true
  //     } else {
  //       this.isProcessed = true
  //       this.results = newResults
  //       return false
  //     }

  //   } else {
  //     this.results = methods[this.type](prevResults, this.params, eventEmitter)
  //     this.isProcessed = true
  //     return false
  //   }
  // }

  convertResults(prevResults: string[][]){

    const convertedResults: (FileInterface[] | ClipInterface[])  = []

    
    prevResults.forEach((prevResult: string[]) => {
      if( this.type == 'files'){
        const fileObj: FileInterface = {
          id: prevResult[0],
          path: prevResult[1],
          players: JSON.parse(prevResult[2]),
          winner: parseInt(prevResult[3]),
          stage: parseInt(prevResult[4]),
          startedAt: parseInt(prevResult[5]),
          lastFrame: parseInt(prevResult[6]),
          isValid: prevResult[7] == '1' ? true : false,
          isProcessed: prevResult[8] == '1' ? true : false,
          info: prevResult[9],
          startFrame: -123,
          endFrame: parseInt(prevResult[6])
        }
        convertedResults.push(fileObj)
      } else {
        console.log("HEYL:,", prevResults[0])
        const obj = JSON.parse(prevResults[0])
        convertedResults.push(obj)
      }
    })

    return convertedResults

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


function createSlices(totalRows: number, numberOfSlices: number) {
  // If N is greater than totalRows, set numberOfSlices to totalRows
  const slicesCount = Math.min(totalRows, numberOfSlices);
  const sliceSize = Math.floor(totalRows / slicesCount);
  const remainder = totalRows % slicesCount;
  const slices = [];

  let currentBottom = 1;

  for (let i = 0; i < slicesCount; i++) {
    let currentTop = currentBottom + sliceSize - 1;
    if (i < remainder) {
      currentTop += 1;
    }

    slices.push({ bottom: currentBottom, top: currentTop, completed: 0, id: i+1 });
    currentBottom = currentTop + 1;
  }

  return slices;
}