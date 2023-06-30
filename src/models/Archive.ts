// import path from 'path'
import fs from 'fs'
import {
  ArchiveInterface,
  FileInterface,
  FilterInterface,
} from 'constants/types'
import File from './File'
import Filter from './Filter'
// import { patternsConfig } from '../constants/config.js'

// const fs = require('fs')
// const File = require('./File').default
// const Pattern = require('./Pattern').default
// const { patternsConfig } = require('../constants/config.js')
// const { getSlpFilePaths } = require('../lib').default
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

  save() {
    const jsonToSave = {
      name: this.name,
      createdAt: this.createdAt,
      updatedAt: new Date().getTime().toString(),
      files: this.files.map((file) => file.generateJSON()),
      filters: this.filters.map((filter) => filter.generateJSON()),
    }
    fs.writeFileSync(this.path, JSON.stringify(jsonToSave))
  }
}
// constructor(archivePath: String) {
//   this.path = archivePath
//   this.files = []
//   this.patterns = []
//   const archiveJSON = JSON.parse(fs.readFileSync(archivePath))
//   if (!archiveJSON.name) throw 'Archive has no name'
//   this.name = archiveJSON.name
//   this.createdAt = archiveJSON.createdAt
//     ? archiveJSON.createdAt
//     : new Date().getTime().toString()
//   this.updatedAt = archiveJSON.updatedAt
//     ? archiveJSON.createdAt
//     : new Date().getTime().toString()
//   if (archiveJSON.files && archiveJSON.files.length > 0) {
//     archiveJSON.files.forEach(file => this.files.push(new File(file)))
//   }
//   if (archiveJSON.patterns && archiveJSON.patterns.length > 0) {
//     archiveJSON.patterns.forEach(pattern =>
//       this.patterns.push(new Pattern(pattern))
//     )
//   }
// }

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
