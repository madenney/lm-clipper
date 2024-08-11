import { app, ipcMain, dialog, IpcMainEvent, BrowserWindow } from 'electron'
import path from 'path'
import fs, { promises as fsPromises }from 'fs'
import { getSlpFilePaths } from '../lib/file'
import { shuffleArray } from '../lib'

import { ArchiveInterface, ConfigInterface } from "constants/types";
import {
  config as defaultConfig,
  archive as defaultArchive,
  defaults
} from '../constants/defaults'
import Archive from '../models/Archive'
import Filter from '../models/Filter'


export default class Controller {
    mainWindow: BrowserWindow
    configPath: string
    archive: ArchiveInterface | null
    config: ConfigInterface

    constructor(mainWindow: BrowserWindow){
        this.mainWindow = mainWindow
        const configDir = path.resolve(app.getPath('appData'), 'lm-clipper')
        if (!fs.existsSync(configDir)){ 
            fs.mkdirSync(configDir) 
        }
        this.configPath = path.resolve(configDir, defaults.configName)
        if (!fs.existsSync(this.configPath)){
          fs.writeFileSync(this.configPath, JSON.stringify(defaultConfig, null, 2))
        }

        this.config = JSON.parse(fs.readFileSync(this.configPath).toString())
        this.archive = null
    }

    async getResults(
        event: IpcMainEvent,
        params: {
            filterId: string
            currentPage: number
            numPerPage: number
        }
    ) {
        if(!this.archive || !this.archive.getItems) return 
        console.log('Selected filter: ', params.filterId)
        const items = await this.archive.getItems(params)
        if(!items){ console.log("Error getting items")}
        event.reply('getResults', items)
    }

    async initArchive(){
        if( this.config.lastArchivePath ){
          if( fs.existsSync(this.config.lastArchivePath) ){
                try {
                    console.log("Attempting to open existing DB...")
                    const newArchive = new Archive(this.config.lastArchivePath)
                    await newArchive.init()
                    this.archive = newArchive
                    console.log("Successfully opened existing DB")
                    return this.archive
                } catch(e){
                    console.log('Error loading from existing DB: ', e)
                    this.config.lastArchivePath = ""
                    this.saveConfig()
                    this.archive = null
                }
            } else {
                console.log('Nothing found at saved archive path')
                this.config.lastArchivePath = ""
                this.saveConfig()
                this.archive = null
            }
        } else {
            console.log("No previous archive found")
            this.archive = null
        }
    }

    async createNewArchive(
        event: IpcMainEvent,
        payload: { name?: string; location?: string }
      ) {
        try {
            const archiveLocation = payload.location ? payload.location: app.getPath('documents')
            const archiveName = payload.name ? payload.name : defaults.archiveName
            const archivePath = path.resolve(archiveLocation, archiveName)

            console.log("New Archive Path: ", archivePath)
    
            // temporary, delete existing default project and overwrite it
            const defaultArchivePath = path.resolve(app.getPath('documents'), defaults.archiveName)
            if( archivePath == defaultArchivePath){
                if(fs.existsSync(defaultArchivePath)){
                    console.log("Deleting default db")
                    fs.rmSync(defaultArchivePath)
                }
            }

            const archive = new Archive(archivePath)
            archive.name = archiveName
            archive.createdAt = Date.now()
            archive.files = 0
            archive.filters = []
            await archive.init()

            this.archive = archive
    
            // update config
            this.config.projectName = archiveName
            this.config.lastArchivePath = archivePath
            this.saveConfig()

            event.reply('createNewArchive', true)
        } catch (error) {
            console.log("createNewArchive Error: ", error)
            event.reply('createNewArchive', { error })
        }
    }

    async addDroppedFiles(event: IpcMainEvent, filePaths: string[]) {
        if (!this.archive || !this.archive.addFiles )
            return event.reply('addDroppedFiles', null)

        const slpFilePaths = getSlpFilePaths(filePaths)
        await this.archive.addFiles(slpFilePaths, ({ current, total, newItem }) => {
            this.mainWindow.webContents.send('importingFileUpdate', {
                total,
                current,
                newItem
            })
        })
        this.mainWindow.webContents.send('importingFileUpdate', { finished: true })
        return event.reply('addDroppedFiles', true)
    }

    async getArchive(event: IpcMainEvent) {
        if (this.archive && this.archive.shallowCopy) {
          const shallowArchive = await this.archive.shallowCopy()
          event.reply('archive', shallowArchive)
        } else {
          event.reply('archive', null)
        }
    }

    async closeArchive(event: IpcMainEvent) {
        this.archive = null
        this.config.lastArchivePath = ""
        this.saveConfig()
        return event.reply('closeArchive')
      }

    async getConfig(event: IpcMainEvent) {
        event.reply('config', this.config)
    }

    async updateConfig(
        event: IpcMainEvent,
        { key, value }: { key: string; value: string | number | boolean }
    ) {
        this.config[key] = value
        this.saveConfig()
        return event.reply('updateConfig')
    }

    saveConfig(){
        fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
    }


    async addFilter(event: IpcMainEvent, type: string) {
        if (!this.archive || !this.archive.shallowCopy || !this.archive.addFilter)
          return event.reply('addFilter')
        
        await this.archive.addFilter(type)
        return event.reply('addFilter', true )
    }

    async removeFilter(event: IpcMainEvent, filterId: string) {
        if (!this.archive || !this.archive.deleteFilter){
          return event.reply('removeFilter')
        }
        await this.archive.deleteFilter(filterId)
        return event.reply('removeFilter', true)
    }


    async runFilter(event: IpcMainEvent, filterId: string){
        if(!this.archive)
          return event.reply('runFilter', { error: 'archive undefined' })
        

        // this shouldn't be necessary if Filter objects are properly created
        const filterJSON = this.archive.filters.find(filter => filter.id == filterId)
    
        if(!filterJSON)
          return event.reply('runFilter', {error: `no filter with id: '${filterId}' found`})
    
        const filterIndex = this.archive.filters.indexOf(filterJSON)


        const filter = new Filter(filterJSON)
        if(!filter.run3)
          return event.reply('runFilter', {error: `filter creation error: '${filterId}'`})
    
    
        console.log("Filter Index: ", filterIndex)
        
        // get prev results
        let prevResultsTableId
        if(filterIndex == 0){
          prevResultsTableId = 'files'
        } else {
          prevResultsTableId = this.archive.filters[filterIndex-1].id
        }
        console.log("Prev Results Table: ", prevResultsTableId)
        const { numFilterThreads } = this.config
    
        return
    
        await filter.run3(
          this.archive.path,
          prevResultsTableId,
          numFilterThreads,
          (eventUpdate: { current: number; total: number }) => {
            const { total, current } = eventUpdate
            this.mainWindow.webContents.send('filterUpdate', {
              total,
              current,
            })
          }
        )
    
    }

    initiateListeners() {
        ipcMain.on('getConfig', this.getConfig.bind(this))
        ipcMain.on('updateConfig', this.updateConfig.bind(this))
        // ipcMain.on('getDirectory', this.getDirectory.bind(this))
        ipcMain.on('getArchive', this.getArchive.bind(this))
        ipcMain.on('createNewArchive', this.createNewArchive.bind(this))
        // ipcMain.on('openExistingArchive', this.openExistingArchive.bind(this))
        // ipcMain.on('saveArchive', this.saveArchive.bind(this))
        // ipcMain.on('addFilesManual', this.addFilesManual.bind(this))
        ipcMain.on('addDroppedFiles', this.addDroppedFiles.bind(this))
        ipcMain.on('closeArchive', this.closeArchive.bind(this))
        ipcMain.on('addFilter', this.addFilter.bind(this))
        // ipcMain.on('updateFilter', this.updateFilter.bind(this))
        ipcMain.on('removeFilter', this.removeFilter.bind(this))
        ipcMain.on('getResults', this.getResults.bind(this))
        // ipcMain.on('getNames', this.getNames.bind(this))
        ipcMain.on('runFilter', this.runFilter.bind(this))
        // ipcMain.on('runFilters', this.runFilters.bind(this))
        // ipcMain.on('getPath', this.getPath.bind(this))
        // ipcMain.on('generateVideo', this.generateVideo.bind(this))
      }
}


