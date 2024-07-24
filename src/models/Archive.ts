// import path from 'path'
import fs from 'fs'
import {
  ArchiveInterface,
  FileInterface,
  FilterInterface,
  EventEmitterInterface,
  ShallowArchiveInterface,
  PlayerInterface,
  ClipInterface,
} from 'constants/types'
import File, { fileProcessor } from './File'
import Filter from './Filter'

const { getSlpFilePaths } = require('../lib/file')
import { dbExists, createDB, getMetaData, getFileByPath, insertFile, getFiles, getItems2 } from '../main/db'
import { asyncForEach } from 'lib'

// const fileTemplate = JSON.parse(
//   fs.readFileSync(path.resolve('src/constants/jsonTemplates/fileTemplate.json'))
// )

export default class Archive {
  path: string
  name: string
  createdAt: number
  files: number
  filters: FilterInterface[]
  constructor(archiveJSON: ArchiveInterface) {
    this.path = archiveJSON.path
    this.name = archiveJSON.name
    this.createdAt = archiveJSON.createdAt
    this.files = archiveJSON.files
    this.filters = archiveJSON.filters
    // this.files = archiveJSON.files.map((fileJSON) => new File(fileJSON))
    // this.filters = archiveJSON.filters.map(
    //   (filterJSON) => new Filter(filterJSON)
    // )
  }
  // constructor(archivePath: string) {
  //   this.path = archivePath
  // }

  // async init(archiveName: string){
  //   console.log("Archive.init()")
  //   const fileExists = fs.existsSync(this.path)
  //   let metadata
  //   if(fileExists){
  //     try {
  //       metadata = await getMetaData(this.path)
  //     } catch(e){
  //       console.log("Error fetching metadata from ", this.path)
  //       throw new Error("Failed to open given db filepath")
  //     }
  //   } else {
  //     await createDB(this.path, archiveName)
  //     metadata = await getMetaData(this.path)
  //   }

  //   console.log("METADATA: ", metadata)
  //   this.name = metadata.name 
  //   this.createdAt = metadata.createdAt
  //   this.filters = metadata.filters.map(
  //     (filterJSON: FilterInterface) => new Filter(filterJSON)
  //   )
  //   return metadata
  // }

  async addFiles(_paths: string | string[], eventEmitter: EventEmitterInterface) {
    const paths = Array.isArray(_paths) ? _paths : [_paths]
    const filePaths = getSlpFilePaths(paths)
    let index = 0
    await asyncForEach(filePaths, async (path: string) => {
      index++

      // await new Promise((resolve) => {
      //   setTimeout(resolve, 1000)
      // })
 
    // })
    // filePaths.forEach((path: string, index: number) => {

      // check if it already exists in this archive
      const existingFile = await getFileByPath(this.path, path)
      //const existingFile = this.files.find(file => file.path == path)
      if(existingFile){
        console.log('already exists in db - ', path)
        eventEmitter({
          current: index,
          total: filePaths.length
        })
      } else {
        const fileJSON = fileProcessor(path)
        if(fileJSON.isValid){
          try {
            const response = await insertFile(this.path, fileJSON)
            eventEmitter({
              current: index,
              total: filePaths.length,
              newItem: fileJSON
            })
          } catch(e){
            console.log("Error inserting file :(")
            console.log(path)
            console.log(e)
          }
        }
      }
      //this.files.push(new File(fileJSON))
    })
  }

  // save() {
  //   const jsonToSave = {
  //     name: this.name,
  //     path: this.path,
  //     createdAt: this.createdAt,
  //     updatedAt: new Date().getTime().toString(),
  //     files: this.files.map((file) => file.generateJSON()),
  //     filters: this.filters.map((filter) => {
  //       if (!filter.generateJSON) throw Error('generateJSON not defined')
  //       return filter.generateJSON()
  //     }),
  //   }
  //   fs.writeFileSync(this.path, JSON.stringify(jsonToSave))
  // }

  async shallowCopy() {

    const metadata = await getMetaData(this.path)
    
    const shallowArchive: ShallowArchiveInterface = {
      path: this.path,
      name: metadata.name,
      createdAt: metadata.createdAt,
      files: metadata.files,
      filters: metadata.filters
    }

    return shallowArchive

    // return {
    //   name: this.name,
    //   totalFiles: 1000,
    //   validFiles: 500,
    //   filters: [{
    //     label: 'placeholder',
    //     type: 'placeholder',
    //     isProcessed: false,
    //     params: {},
    //     results: 10
    //   }]
    // }
    // const shallowArchive: ShallowArchiveInterface = {
    //   path: this.path,
    //   name: this.name,
    //   createdAt: this.createdAt,
    //   updatedAt: this.updatedAt,
    //   totalFiles: this.files.length,
    //   validFiles: this.files.filter((file) => file.isValid).length,
    //   filters: this.filters.map((filter) => {
    //     return {
    //       ...filter,
    //       results: filter.results.length,
    //     }
    //   }),
    // }
    // return shallowArchive
  }

  async getItems(params: { filterId: string, numPerPage: number, currentPage: number }){
    const { filterId, numPerPage, currentPage } = params
    const response = await getItems2(this.path, filterId, numPerPage, currentPage*numPerPage)
    const items: FileInterface[] | ClipInterface[] = []

    if(filterId == 'files'){
      response.forEach((item: any[]) => {
        if(!item[0]) return 
        const file = {
          id: item[0],
          path: item[1],
          players: JSON.parse(item[2]),
          winner: item[3],
          stage: item[4],
          startedAt: item[5],
          lastFrame: item[6],
          isProcessed: item[7],
          startFrame: 0,
          endFrame: 0,
          info: '',
          isValid: true
        }
        items.push(file)
      })
    } else{
      throw new Error("Filter not supported yet")
    }

    return items
  }


  async runFilter(
    filterId: string, 
    numFilterThreads: number, 
    filterMsgEventEmitter: EventEmitterInterface ){

    const filter = this.filters.find(filter => filter.id == filterId)
    if(!filter) throw new Error('No filter found?')
    const filterIndex = this.filters.indexOf(filter)
    console.log("Filter Index: ", filterIndex)


    
    // get prev results
    let prevResultsTable
    if(filterIndex == 0){
      prevResultsTable = 'files'
    } else {
      prevResultsTable = this.filters[filterIndex-1].id
    }
    console.log("Prev Results Table: ", prevResultsTable)
  }


  // async runFilters(
  //   numFilterThreads: number,
  //   currentFilterEventEmitter: EventEmitterInterface,
  //   filterMsgEventEmitter: EventEmitterInterface
  // ) {
  //   let firstUnprocessed = this.filters.find((filter) => !filter.isProcessed)
  //   if (!firstUnprocessed) firstUnprocessed = this.filters[0]
  //   const firstUnprocessedIndex = this.filters.indexOf(firstUnprocessed)
  //   let prevResults = firstUnprocessedIndex === 0 ? this.files : this.filters[firstUnprocessedIndex - 1].results

    
  //   let terminated = false
  //   for (const filter of this.filters.slice(firstUnprocessedIndex)) {
  //     if (!filter.run) throw Error('filter.run() not defined?')
  //     if(terminated) return 
  //     currentFilterEventEmitter({
  //       current: this.filters.indexOf(filter),
  //       total: this.filters.length
  //     })
  //     terminated = await filter.run(prevResults, numFilterThreads, filterMsgEventEmitter)
  //     prevResults = filter.results
  //   }
  //   return false
  // }

  async getNames() {

    const files = await getFiles(this.path)

    const namesObj: { [key: string]: number } = {}
    files.forEach((file: any[]) => {
      const players = JSON.parse(file[2])
      players.forEach((player: PlayerInterface) => {
        const name = player.displayName
        if (namesObj[name]) {
          namesObj[name] += 1
        } else {
          namesObj[name] = 1
        }
      })
    })
    const names: { name: string; total: number }[] = []
    Object.keys(namesObj).forEach((key) => {
      names.push({ name: key, total: namesObj[key] })
    })
    const sortedNames = names.sort((a, b) => b.total - a.total)
    return sortedNames


    
    // const namesObj: { [key: string]: number } = {}
    // this.files.forEach((file) => {
    //   if (file.isValid) {
    //     file.players.forEach((player) => {
    //       const name = player.displayName
    //       if (namesObj[name]) {
    //         namesObj[name] += 1
    //       } else {
    //         namesObj[name] = 1
    //       }
    //     })
    //   }
    // })
    // const names: { name: string; total: number }[] = []
    // Object.keys(namesObj).forEach((key) => {
    //   names.push({ name: key, total: namesObj[key] })
    // })
    // const sortedNames = names.sort((a, b) => b.total - a.total)
    // return sortedNames
  }
}

// addFiles (_paths) {
//   const paths = Array.isArray(_paths) ? _paths : [_paths]
//   const filePaths = getSlpFilePaths(paths)
//   let count = 0
//   filePaths.forEach(path => {
//     count++
//     this.files.push(new File({ ...fileTemplate, path }))
//   })
//   return count
// }

// addNewPattern (type) {
//   const template = patternsConfig.find(p => p.id == type)
//   if (!template) {
//     throw `Error: Invalid Pattern Type ${type}`
//   }
//   const newPattern = {
//     type: template.id,
//     label: template.label,
//     params: {}
//   }
//   template.options.forEach(option => {
//     newPattern.params[option.id] = option.default
//   })
//   this.patterns.push(new Pattern(newPattern))
// }

// processFiles (eventEmitter) {
//   let count = 0
//   this.files.forEach(file => {
//     if (count % 1000 == 0)
//       eventEmitter({ msg: `${count++}/${this.files.length}` })
//     if (file.isProcessed) return
//     file.process()
//   })
// }
