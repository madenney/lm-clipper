import {
  FilterInterface,
  FileInterface,
  ClipInterface,
} from '../constants/types'

import methods from './methods'

export default class Filter {
  label: string
  type: string
  isProcessed: boolean
  params: {}
  results: ClipInterface[] | FileInterface[]
  constructor(filterJSON: FilterInterface) {
    this.label = filterJSON.label
    this.type = filterJSON.type
    this.isProcessed = filterJSON.isProcessed
    this.params = filterJSON.params
    this.results = filterJSON.results
  }

  run(prevResults: ClipInterface[] | FileInterface[], eventEmitter: any) {
    console.log("running: ", this.type)
    this.results = methods[this.type](prevResults, this.params, eventEmitter)
    this.isProcessed = true
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
