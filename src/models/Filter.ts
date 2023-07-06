import {
  FilterInterface,
  FileInterface,
  ClipInterface,
} from '../constants/types'

export default class Filter {
  label: string
  type: string
  params: {}
  results: ClipInterface[] | FileInterface[]
  constructor(filterJSON: FilterInterface) {
    this.label = filterJSON.label
    this.type = filterJSON.type
    this.params = filterJSON.params
    this.results = filterJSON.results
  }

  generateJSON() {
    return {
      label: this.label,
      type: this.type,
      params: this.params,
      results: this.results,
    }
  }
}
