// import path from 'path'
import fs from 'fs'
import {
  ArchiveInterface,
  FileInterface,
  FilterInterface,
  EventEmitterInterface,
  ShallowArchiveInterface,
} from 'constants/types'
import File, { fileProcessor } from './File'
import Filter from './Filter'
// import { patternsConfig } from '../constants/config.js'

const { getSlpFilePaths } = require('../lib').default
// const fileTemplate = JSON.parse(
//   fs.readFileSync(path.resolve('src/constants/jsonTemplates/fileTemplate.json'))
// )

export default class Archive {
  path: string
  name: string
  createdAt: number
  updatedAt: number
  files: FileInterface[]
  filters: FilterInterface[]
  constructor(archiveJSON: ArchiveInterface) {
    this.path = archiveJSON.path
    this.name = archiveJSON.name
    this.createdAt = archiveJSON.createdAt
    this.updatedAt = archiveJSON.updatedAt
    this.files = archiveJSON.files.map((fileJSON) => new File(fileJSON))
    this.filters = archiveJSON.filters.map(
      (filterJSON) => new Filter(filterJSON)
    )
  }

  addFiles(_paths: string | string[], eventEmitter: EventEmitterInterface) {
    const paths = Array.isArray(_paths) ? _paths : [_paths]
    const filePaths = getSlpFilePaths(paths)
    filePaths.forEach((path: string, index: number) => {
      const fileJSON = fileProcessor(path)
      this.files.push(new File(fileJSON))
      eventEmitter({ current: index, total: filePaths.length })
    })
    return filePaths.length
  }

  save() {
    const jsonToSave = {
      name: this.name,
      path: this.path,
      createdAt: this.createdAt,
      updatedAt: new Date().getTime().toString(),
      files: this.files.map((file) => file.generateJSON()),
      filters: this.filters.map((filter) => {
        if (!filter.generateJSON) throw Error('generateJSON not defined')
        return filter.generateJSON()
      }),
    }
    fs.writeFileSync(this.path, JSON.stringify(jsonToSave))
  }

  shallowCopy() {
    const shallowArchive: ShallowArchiveInterface = {
      path: this.path,
      name: this.name,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      files: this.files.length,
      filters: this.filters.map((filter) => {
        return {
          ...filter,
          results: filter.results.length,
        }
      }),
    }
    return shallowArchive
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
