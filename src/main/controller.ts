import { app, ipcMain, dialog, IpcMainEvent, BrowserWindow } from 'electron'
import path from 'path'
import fs, { promises as fsPromises }from 'fs'
import { getSlpFilePaths } from '../lib/file'
import { shuffleArray } from '../lib'
import {
  config as defaultConfig,
  archive as defaultArchive,
} from '../constants/defaults'
import { filtersConfig } from '../constants/config'
import {
  ArchiveInterface,
  ClipInterface,
  FileInterface,
  ConfigInterface,
  FilterInterface,
  ShallowFilterInterface,
  ReplayInterface,
} from '../constants/types'
import Archive from '../models/Archive'
import Filter from '../models/Filter'
import slpToVideo from './slpToVideo'
import { getMetaData, createDB } from './db'

export default class Controller {
  mainWindow: BrowserWindow
  configDir: string
  configPath: string
  archive: ArchiveInterface | null
  config: ConfigInterface

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow
    this.configDir = path.resolve(app.getPath('appData'), 'lm-clipper')
    if (!fs.existsSync(this.configDir)) fs.mkdirSync(this.configDir)
    this.configPath = path.resolve(this.configDir, 'lm-clipper.json')
    if (!fs.existsSync(this.configPath))
      fs.writeFileSync(this.configPath, JSON.stringify(defaultConfig, null, 2))

    this.config = JSON.parse(fs.readFileSync(this.configPath).toString())
    this.archive = null

    // if (this.config.lastArchivePath && fs.existsSync(this.config.lastArchivePath)) {
    //   try {
    //     this.archive = new Archive(this.config.lastArchivePath)
    //     this.archive.init()
    //   } catch(e){
    //     console.log('error fetching from last archive path')
    //     this.archive = null
    //   }
    // } else {
    //   this.archive = null
    // }
  }

  async initArchive(){
    if (this.config.lastArchivePath){
      if(fs.existsSync(this.config.lastArchivePath)){
        console.log("Loading from existing DB")
        try {
          const metadata = await getMetaData(this.config.lastArchivePath)
          this.archive = new Archive(metadata)
          //this.archive.init()
        } catch(e){
          console.log('error fetching from last archive path')
          this.archive = null
        }
      } else {
        console.log("Creating new DB")
        await createDB(this.config.lastArchivePath, this.config.projectName)
        const metadata = await getMetaData(this.config.lastArchivePath)
        this.archive = new Archive(metadata)
      }
    } else {
      this.archive = null
    }
  }

  async getConfig(event: IpcMainEvent) {
    event.reply('config', this.config)
  }

  async updateConfig(
    event: IpcMainEvent,
    { key, value }: { key: string; value: string | number | boolean }
  ) {
    this.config[key] = value
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
    return event.reply('updateConfig')
  }

  async getArchive(event: IpcMainEvent) {
    if (this.archive ) {
      const metadata = await getMetaData(this.archive.path)
      event.reply('archive', metadata)
    } else {
      event.reply('archive')
    }
  }

  createNewArchive(
    event: IpcMainEvent,
    payload: { name?: string; location?: string }
  ) {
    try {
      const newArchivePath = path.resolve(
        payload.location || app.getPath('documents'),
        `${payload.name ? payload.name : 'lm-clipper-default-db'}`
      )

      // temporary, delete existing default project and overwrite it
      const defaultDBPath = path.resolve(app.getPath('documents'),'lm-clipper-default-db')
      if(fs.existsSync(defaultDBPath)){
        console.log("Deleting default db")
        fs.rmSync(defaultDBPath)
      }

      const newArchiveJSON = {
        ...defaultArchive,
        path: newArchivePath,
        name: payload.name ? payload.name : 'lm-clipper-default',
        createdAt: Date.now()
      }
      this.archive = new Archive(newArchiveJSON)

      // update config
      const newConfig = JSON.parse(fs.readFileSync(this.configPath).toString())
      newConfig.lastArchivePath = newArchivePath
      newConfig.projectName = newArchiveJSON.name
      this.config = newConfig
      fs.writeFileSync(this.configPath, JSON.stringify(newConfig, null, 2))
      
      event.reply('createNewArchive', newArchiveJSON)
    } catch (error) {
      event.reply('createNewArchive', { error: true, info: error })
    }
  }

  // async saveArchive(event: IpcMainEvent) {
  //   try {
  //     if (this.archive && this.archive.save) this.archive.save()
  //     event.reply('saveArchive')
  //   } catch (error) {
  //     event.reply('saveArchive', { error })
  //   }
  // }

  async getDirectory(event: IpcMainEvent) {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      defaultPath: this.config.lastArchivePath
        ? this.config.lastArchivePath
        : '',
    })
    if (canceled) return event.reply('directory')
    return event.reply('directory', filePaths[0])
  }

  async openExistingArchive(event: IpcMainEvent) {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'SQLite3 Database', extensions: [] }],
      })
      if (canceled) return event.reply('openExistingArchive')

      try{
        const metadata = await getMetaData(filePaths[0]) 
        this.archive = new Archive(metadata)
      } catch(e){
        console.log("Error opening archive", e)
        return event.reply('openExistingArchive', {error: "Failed to open given filepath"})
      }
      
      
      if (!this.archive || !this.archive.shallowCopy)
        throw new Error('Something went wrong :(')
      this.config.lastArchivePath = this.archive.path
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
      const metadata = await this.archive.shallowCopy()
      return event.reply('openExistingArchive', metadata)
    } catch (error) {
      return event.reply('openExistingArchive', { error })
    }
  }

  async addFilesManual(event: IpcMainEvent) {
    if (!this.archive || !this.archive.addFiles || !this.archive.shallowCopy)
      return event.reply('addFilesManual', { error: 'archive undefined' })

    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'slp files', extensions: ['slp'] }],
    })
    if (canceled){
      const archive = await this.archive.shallowCopy()
      return event.reply('addFilesManual', archive)
    }

    await this.archive.addFiles(filePaths, ({ current, total }) => {
      this.mainWindow.webContents.send('importingFileUpdate', {
        total,
        current,
      })
    })
    const archive = await this.archive.shallowCopy()
    this.mainWindow.webContents.send('importingFileUpdate', { finished: true })
    return event.reply('addFilesManual', archive)
  }


  async addDroppedFiles(event: IpcMainEvent, filePaths: string[]) {
    if(!this.archive){
      // dropped files onto new project, most likey
      // create archive in temporary spot
      this.createNewArchive(event, {})
      await this.initArchive()
    }
    if (!this.archive || !this.archive.addFiles || !this.archive.shallowCopy)
      return event.reply('addDroppedFiles', { error: 'archive undefined' })
    const slpFilePaths = getSlpFilePaths(filePaths)
    await this.archive.addFiles(slpFilePaths, ({ current, total, newItem }) => {
      this.mainWindow.webContents.send('importingFileUpdate', {
        total,
        current,
        newItem
      })
    })
    const archive = await this.archive.shallowCopy()
    this.mainWindow.webContents.send('importingFileUpdate', { finished: true })
    return event.reply('addDroppedFiles', archive)
  }

  async closeArchive(event: IpcMainEvent) {
    this.archive = null
    return event.reply('closeArchive')
  }

  async addFilter(event: IpcMainEvent, type: string) {
    if (!this.archive || !this.archive.shallowCopy)
      return event.reply('addFilter', { error: 'archive undefined' })
    const template = filtersConfig.find((p) => p.id === type)
    if (!template) {
      throw Error(`Invalid Pattern Type ${type}`)
    }

    // TODO: DETEMINE NEW FILTER ID
    // FOR NOW:
    // Generate a random number between 1000 and 9999
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    // Convert the number to a string
    const randStr = randomNum.toString();


    const newFilterJSON: FilterInterface = {
      id: randStr,
      results: 0,
      type: template.id,
      isProcessed: false,
      label: template.label,
      params: {},
    }
    template.options.forEach((option) => {
      newFilterJSON.params[option.id] = option.default
    })
    this.archive.filters.push(new Filter(newFilterJSON))
    const metadata = await this.archive.shallowCopy()
    return event.reply('addFilter', metadata )
  }

  async updateFilter(
    event: IpcMainEvent,
    params: {
      filterIndex: number
      newFilter: ShallowFilterInterface
    }
  ) {
    const { newFilter, filterIndex } = params
    if (!this.archive || !this.archive.shallowCopy)
      return event.reply('updateFilter', { error: 'archive undefined' })
    this.archive.filters[filterIndex] = new Filter({
      ...newFilter,
      isProcessed: false,
      results: 0,
    })
    this.archive.filters.slice(filterIndex).forEach((filter) => {
      filter.isProcessed = false
      filter.results = 0
    })
    return event.reply('updateFilter', this.archive.shallowCopy())
  }

  async removeFilter(event: IpcMainEvent, index: number) {
    if (!this.archive || !this.archive.shallowCopy)
      return event.reply({ error: 'archive undefined' })

    this.archive.filters.splice(index, 1)
    this.archive.filters.slice(index).forEach((filter) => {
      filter.isProcessed = false
      filter.results = 0
    })
    return event.reply('removeFilter', this.archive.shallowCopy())
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
    const { filterId, numPerPage, currentPage } = params
    console.log('Selected filter: ', filterId)
    // const slicedResults = this.archive?.filters[
    //   selectedFilterIndex
    // ].results
    
    // event.reply('getResults', slicedResults)

    const items = await this.archive.getItems(params)

    event.reply('getResults', items)
  }

  async getNames(event: IpcMainEvent) {
    if (!this.archive || !this.archive.getNames)
      return event.reply({ error: 'archive undefined' })
    const names = await this.archive.getNames()
    
    return event.reply('getNames', names)
  }

  async runFilter(event: IpcMainEvent, filterId: string){
    if(!this.archive || !this.archive.runFilter)
      return event.reply('runFilter', { error: 'archive undefined' })
    console.log(this.archive)
    const filter = this.archive.filters.find(filter => filter.id == filterId)
    if(!filter || !filter.run3)
      return event.reply('runFilter', {error: `no filter with id: '${filterId}' found`})

    const filterIndex = this.archive.filters.indexOf(filter)
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

  async runFilters(event: IpcMainEvent) {
    if (!this.archive || !this.archive.runFilters || !this.archive.shallowCopy)
      return event.reply({ error: 'archive undefined' })

    const { numFilterThreads } = this.config

    await this.archive.runFilters(
      numFilterThreads,
      (eventUpdate: { current: number }) => {
        const { current } = eventUpdate
        this.mainWindow.webContents.send('currentlyRunningFilter', {
          current
        })
      },
      (eventUpdate: { current: number; total: number }) => {
        const { total, current } = eventUpdate
        this.mainWindow.webContents.send('filterUpdate', {
          total,
          current,
        })
      }
    )

    const metadata = await this.archive.shallowCopy()

    return event.reply('runFilters', metadata)
  }

  async getPath(event: IpcMainEvent, type: 'openFile' | 'openDirectory') {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: [type],
    })
    if (canceled) return event.reply('getPath')
    return event.reply('getPath', filePaths[0])
  }

  async generateVideo(event: IpcMainEvent) {
    const selectedResults =
      this.archive?.filters[this.archive.filters.length - 1].results
    if (!selectedResults || selectedResults == 0) {
      this.mainWindow.webContents.send('videoMsg', 'No clips to generate.')
      return event.reply('generateVideo')
    }

    const {
      numCPUs,
      numFilterThreads,
      dolphinPath,
      ssbmIsoPath,
      gameMusic,
      hideHud,
      hideTags,
      hideNames,
      fixedCamera,
      enableChants,
      bitrateKbps,
      resolution,
      outputPath,
      addStartFrames,
      addEndFrames,
      slice,
      shuffle,
      lastClipOffset,
      dolphinCutoff,
      disableScreenShake,
      noElectricSFX,
      noCrowdNoise,
      disableMagnifyingGlass,
      overlaySource,
    } = this.config


    // check if output directory exist
    try {
      await fsPromises.access(outputPath)
    } catch(err){
      this.mainWindow.webContents.send('videoMsg',`Error: Could not access given output path ${outputPath} `)
      return event.reply('generateVideo')
    }

    // make directory
    let outputDirectoryName = 'output'
    let count = 1
    while (
      fs.existsSync(path.resolve(`${outputPath}/${outputDirectoryName}`))
    ) {
      outputDirectoryName = `output_${count}`
      count += 1
    }
    fs.mkdirSync(path.resolve(`${outputPath}/${outputDirectoryName}`))

    const config = {
      ...this.config,
      outputPath: path.resolve(`${outputPath}/${outputDirectoryName}`),
      numProcesses: numCPUs,
      dolphinPath: path.resolve(dolphinPath),
      ssbmIsoPath: path.resolve(ssbmIsoPath),
      gameMusicOn: gameMusic,
      hideHud,
      hideTags,
      hideNames,
      overlaySource,
      disableScreenShake,
      disableChants: !enableChants,
      noElectricSFX,
      noCrowdNoise,
      disableMagnifyingGlass,
      fixedCamera,
      bitrateKbps,
      resolution,
      dolphinCutoff
    }


    // TODO, get results straight from db
    // let finalResults: ClipInterface[] | FileInterface[] = selectedResults
    let finalResults: any[] = []
    if (shuffle) finalResults = shuffleArray(finalResults)
    if (slice) finalResults = finalResults.slice(0, slice)

    const replays: ReplayInterface[] = []
    finalResults.forEach(
      (result: ClipInterface | FileInterface, index: number) => {
        replays.push({
          index,
          path: result.path,
          startFrame: result.startFrame
            ? result.startFrame - addStartFrames
            : -123,
          endFrame: result.endFrame ? result.endFrame + addEndFrames : 99999,
        })
      }
    )
    if (lastClipOffset) replays[replays.length - 1].endFrame += lastClipOffset

    // if (overlaySource) {
    //   await generateOverlays(
    //     replays,
    //     path.resolve(outputPath + '/' + outputDirectoryName)
    //   )
    // }

    console.log('Replays: ', replays)
    console.log('Config: ', config)
    await slpToVideo(replays, config, (msg: string) => {
      this.mainWindow.webContents.send('videoMsg', msg)
    })
    return event.reply('generateVideo')
  }

  initiateListeners() {
    ipcMain.on('getConfig', this.getConfig.bind(this))
    ipcMain.on('updateConfig', this.updateConfig.bind(this))
    ipcMain.on('getDirectory', this.getDirectory.bind(this))
    ipcMain.on('getArchive', this.getArchive.bind(this))
    ipcMain.on('createNewArchive', this.createNewArchive.bind(this))
    ipcMain.on('openExistingArchive', this.openExistingArchive.bind(this))
    //ipcMain.on('saveArchive', this.saveArchive.bind(this))
    ipcMain.on('addFilesManual', this.addFilesManual.bind(this))
    ipcMain.on('addDroppedFiles', this.addDroppedFiles.bind(this))
    ipcMain.on('closeArchive', this.closeArchive.bind(this))
    ipcMain.on('addFilter', this.addFilter.bind(this))
    ipcMain.on('updateFilter', this.updateFilter.bind(this))
    ipcMain.on('removeFilter', this.removeFilter.bind(this))
    ipcMain.on('getResults', this.getResults.bind(this))
    ipcMain.on('getNames', this.getNames.bind(this))
    ipcMain.on('runFilter', this.runFilter.bind(this))
    ipcMain.on('runFilters', this.runFilters.bind(this))
    ipcMain.on('getPath', this.getPath.bind(this))
    ipcMain.on('generateVideo', this.generateVideo.bind(this))
  }
}
