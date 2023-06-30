import {
  FilterInterface,
  FileInterface,
  ClipInterface,
} from '../constants/types'

export default class Filter {
  id: string
  params: {}
  results: ClipInterface[] | FileInterface[]
  constructor(filterJSON: FilterInterface) {
    this.id = filterJSON.id
    this.params = filterJSON.params
    this.results = filterJSON.results
  }

  generateJSON() {
    return {
      id: this.id,
      params: this.params,
      results: this.results,
    }
  }
}
