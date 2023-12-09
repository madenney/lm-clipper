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

const { getSlpFilePaths } = require('../lib/file')
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
      eventEmitter({
        current: index,
        total: filePaths.length,
      })
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
      totalFiles: this.files.length,
      validFiles: this.files.filter((file) => file.isValid).length,
      filters: this.filters.map((filter) => {
        return {
          ...filter,
          results: filter.results.length,
        }
      }),
    }
    return shallowArchive
  }

  async runFilters(
    currentFilterEventEmitter: EventEmitterInterface,
    filterMsgEventEmitter: EventEmitterInterface
  ) {
    const firstUnprocessed = this.filters.find((filter) => !filter.isProcessed)
    if (!firstUnprocessed) return false

    const index = this.filters.indexOf(firstUnprocessed)

    let prevResults = index === 0 ? this.files : this.filters[index - 1].results

    for (const filter of this.filters.slice(index)) {
      if (!filter.run) throw Error('filter.run() not defined?')
      currentFilterEventEmitter({
        current: this.filters.indexOf(filter),
        total: this.filters.length,
      })
      console.log('before results')
      filter.results = await filter.run(prevResults, filterMsgEventEmitter)
      console.log('after results')
      console.log('shallow copy filter: ', this.shallowCopy().filters)
      filter.isProcessed = true
      prevResults = filter.results
    }
    return false
  }

  names() {
    const namesObj: { [key: string]: number } = {}
    this.files.forEach((file) => {
      if (file.isValid) {
        file.players.forEach((player) => {
          const name = player.displayName
          if (namesObj[name]) {
            namesObj[name] += 1
          } else {
            namesObj[name] = 1
          }
        })
      }
    })
    const names: { name: string; total: number }[] = []
    Object.keys(namesObj).forEach((key) => {
      names.push({ name: key, total: namesObj[key] })
    })
    const sortedNames = names.sort((a, b) => b.total - a.total)
    return sortedNames
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
