import fs from 'fs'
import { asyncForEach } from '../lib'
import {
    ArchiveInterface,
    FileInterface,
    FilterInterface,
    EventEmitterInterface,
    ShallowArchiveInterface,
    PlayerInterface,
    ClipInterface,
} from 'constants/types'
import Filter from './Filter'
import { filtersConfig } from '../constants/config'

import { fileProcessor } from './File'

import * as db from './db'


export default class Archive {
    path: string
    name: string | undefined
    createdAt: number | undefined
    files: number | undefined
    filters: FilterInterface[] | undefined
    constructor(path: string ){
      this.path = path
    }
  
    async init(){
      // check if db exists at path
      //const dbExists = await db.dbExists(this.path)
      const dbExists = fs.existsSync(this.path)
      if(dbExists) {
        console.log("Archive.init() - opening existing db")
        try {
            const metadata = await db.getMetaData(this.path)
            this.name = metadata.name
            this.createdAt = metadata.createdAt
            this.files = metadata.files
            this.filters = metadata.filters.map((f: FilterInterface) => new Filter(f))
        } catch(e){
            console.log("Error opening existing db", e)
            throw e
        }

      } else {
        console.log("Archive.init() - creating new db")
        if(!this.name) throw "Archive.init error, no archive name"
        if(!this.createdAt) throw "Archive.init error, no archive createdAt"
        if(typeof this.files != 'number') throw "Archive.init error, no archive files"
        if(!this.filters) throw "Archive.init error, no archive filters"
        const metadata = { 
            path: this.path,
            name: this.name,
            createdAt: this.createdAt,
            files: this.files,
            filters: this.filters
        }
        await db.createDB(this.path, metadata)
      }
    }

    async getItems(params: { filterId: string, numPerPage: number, currentPage: number }){
        const { filterId, numPerPage, currentPage } = params
        const response = await db.getItems(this.path, filterId, numPerPage, currentPage*numPerPage)
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



    async addFiles(_paths: string | string[], eventEmitter: EventEmitterInterface) {
        const filePaths = Array.isArray(_paths) ? _paths : [_paths]

        let index = 0
        await asyncForEach(filePaths, async (path: string) => {
          index++
            console.log("INDEX: ", index)
          // for UI testing purposes
          // await new Promise((resolve) => {
          //   setTimeout(resolve, 1000)
          // })
     
          // check if it already exists in this archive
          const existingFile = await db.getFileByPath(this.path, path)
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
                const response = await db.insertFile(this.path, fileJSON)
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
            } else {
                console.log("Invalid File JSON")
            }
          }
        })
    }

    async addFilter(type: string){

        const template = filtersConfig.find((p) => p.id === type)
        if (!template) {
          throw Error(`Invalid Filter Type ${type}`)
        }
    
        // TODO: better way to determine filter id
        // for now, generate a big random number
        const randomNum = Math.floor(1000 + Math.random() * 900000);
        const newFilterId = `filter_${randomNum.toString()}`
    
        const newFilterJSON: FilterInterface = {
          id: newFilterId,
          results: 0,
          type: template.id,
          isProcessed: false,
          label: template.label,
          params: {},
        }
        template.options.forEach((option) => {
          newFilterJSON.params[option.id] = option.default
        })

        const newFilter = new Filter(newFilterJSON)
        try {
          await newFilter.init(this.path)
          this.filters?.push(newFilter)
          await this.saveMetaData()
        } catch(e){
          console.log("Archive Error: newFilter", e)
        }
    }

    async deleteFilter(filterId: string){
        if(!this.filters) throw "Archive.deleteFilter error, no filters"
        const selectedFilter = this.filters.find(f => f.id == filterId)
    
        if(!selectedFilter){
          throw `Archive.deleteFilter error - no filter id found ${filterId}`
        }
    
        const filter = new Filter(selectedFilter)
    
        try {
          await filter.delete(this.path)
          this.filters.splice(this.filters.indexOf(selectedFilter),1)
          await this.saveMetaData()
        } catch(e){
          console.log("Archive Error: removeFilter", e)
        }
    
    }
    
    async saveMetaData(){
        if(!this.name) throw "Archive.saveMetaData error: no name"
        if(!this.createdAt) throw "Archive.saveMetaData error: no createdAt"
        if(!this.files) throw "Archive.saveMetaData error: no files"
        if(!this.filters) throw "Archive.saveMetaData error: no filters"
        const jsonToSave: ArchiveInterface = {
            path: this.path,
            name: this.name,
            createdAt: this.createdAt,
            files: this.files,
            filters: this.filters,
        }
        await db.updateMetaData(this.path, JSON.stringify(jsonToSave))
    }

    async shallowCopy() {

        const metadata = await db.getMetaData(this.path)

        if(!metadata){ return null }
        
        const shallowArchive: ShallowArchiveInterface = {
          path: this.path,
          name: metadata.name,
          createdAt: metadata.createdAt,
          files: metadata.files,
          filters: metadata.filters
        }
    
        return shallowArchive
    }
  }
  