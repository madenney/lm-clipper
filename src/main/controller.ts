import { app, ipcMain, dialog, IpcMainEvent, BrowserWindow } from 'electron'
import path from 'path'
import fs from 'fs'
import { getSlpFilePaths } from '../lib/file'
import {
  config as defaultConfig,
  archive as defaultArchive,
} from '../constants/defaults'
import { filtersConfig } from '../constants/config'
import {
  ArchiveInterface,
  ConfigInterface,
  FilterInterface,
} from '../constants/types'
import Archive from '../models/Archive'
import Filter from '../models/Filter'

export default class Controller {
  mainWindow: BrowserWindow
  configDir: string
  configPath: string
  archive: ArchiveInterface | null
  config: ConfigInterface
  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow
    this.configDir = path.resolve(app.getPath('appData'), 'lm-clipper')
    this.configPath = path.resolve(this.configDir, 'lm-clipper.json')
    console.log(this.configDir)
    console.log(this.configPath)
    if (!fs.existsSync(this.configDir)) fs.mkdirSync(this.configDir)
    if (!fs.existsSync(this.configPath))
      fs.writeFileSync(this.configPath, JSON.stringify(defaultConfig, null, 2))

    this.config = JSON.parse(fs.readFileSync(this.configPath).toString())
    if (this.config.lastArchivePath) {
      this.archive = new Archive(
        JSON.parse(fs.readFileSync(this.config.lastArchivePath).toString())
      )
    } else {
      this.archive = new Archive(defaultArchive)
    }
  }

  async getConfig(event: IpcMainEvent) {
    event.reply('config', this.config)
  }

  async saveConfig(e: IpcMainEvent, payload: string) {
    fs.writeFileSync(this.configPath, JSON.stringify(payload, null, 2))
    this.config = JSON.parse(payload)
  }

  async getArchive(event: IpcMainEvent) {
    if (this.archive && this.archive.shallowCopy) {
      event.reply('archive', this.archive.shallowCopy())
    } else {
      event.reply('archive')
    }
  }

  async createNewArchive(
    event: IpcMainEvent,
    payload: { name: string; location: string }
  ) {
    try {
      const newArchivePath = path.resolve(
        payload.location || app.getPath('documents'),
        `${payload.name}.lmc`
      )
      const newArchiveJSON = {
        ...defaultArchive,
        path: newArchivePath,
        name: payload.name,
      }
      fs.writeFileSync(newArchivePath, JSON.stringify(newArchiveJSON))
      this.archive = new Archive(newArchiveJSON)
      // update config
      const newConfig = JSON.parse(fs.readFileSync(this.configPath).toString())
      newConfig.lastArchivePath = newArchivePath
      fs.writeFileSync(this.configPath, JSON.stringify(newConfig, null, 2))

      event.reply('createNewArchive', newArchiveJSON)
    } catch (error) {
      event.reply('createNewArchive', { error: true, info: error })
    }
  }

  async saveArchive(event: IpcMainEvent) {
    try {
      if (this.archive && this.archive.save) this.archive.save()
      event.reply('saveArchive')
    } catch (error) {
      event.reply('saveArchive', { error })
    }
  }

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
        filters: [{ name: 'lmc files', extensions: ['lmc'] }],
      })
      if (canceled) return event.reply('openExistingArchive')

      this.archive = new Archive(
        JSON.parse(fs.readFileSync(filePaths[0]).toString())
      )
      if (!this.archive || !this.archive.shallowCopy)
        throw new Error('Something went wrong :(')
      return event.reply('openExistingArchive', this.archive.shallowCopy())
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
    if (canceled) return event.reply('addFilesManual')
    console.log(filePaths)
    this.archive.addFiles(filePaths, ({ current, total }) => {
      this.mainWindow.webContents.send('importingFileUpdate', {
        total,
        current,
      })
    })
    this.mainWindow.webContents.send('importingFileUpdate', { finished: true })
    return event.reply('addFilesManual', this.archive.shallowCopy())
  }

  async addDroppedFiles(event: IpcMainEvent, filePaths: string[]) {
    if (!this.archive || !this.archive.addFiles || !this.archive.shallowCopy)
      return event.reply('addDroppedFiles', { error: 'archive undefined' })
    const slpFilePaths = getSlpFilePaths(filePaths)
    this.archive.addFiles(slpFilePaths, ({ current, total }) => {
      this.mainWindow.webContents.send('importingFileUpdate', {
        total,
        current,
      })
    })
    this.mainWindow.webContents.send('importingFileUpdate', { finished: true })
    return event.reply('addDroppedFiles', this.archive.shallowCopy())
  }

  async closeArchive(event: IpcMainEvent) {
    this.archive = null
    return event.reply('closeArchive')
  }

  async addFilter(event: IpcMainEvent, type: string) {
    if (!this.archive || !this.archive.addFiles || !this.archive.shallowCopy)
      return event.reply('addFilter', { error: 'archive undefined' })
    const template = filtersConfig.find((p) => p.id === type)
    if (!template) {
      throw Error(`Invalid Pattern Type ${type}`)
    }
    const newFilterJSON: FilterInterface = {
      results: [],
      type: template.id,
      label: template.label,
      params: {},
    }
    template.options.forEach((option) => {
      newFilterJSON.params[option.id] = option.default
    })
    this.archive.filters.push(new Filter(newFilterJSON))
    return event.reply('addFilter', this.archive.shallowCopy())
  }

  async removeFilter(event: IpcMainEvent, index: number) {
    if (!this.archive || !this.archive.shallowCopy)
      return event.reply({ error: 'archive undefined' })

    this.archive.filters.splice(index, 1)
    return event.reply('removeFilter', this.archive.shallowCopy())
  }

  async getResults(
    event: IpcMainEvent,
    params: {
      selectedFilterIndex: number
      currentPage: number
      numPerPage: number
    }
  ) {
    const { selectedFilterIndex, numPerPage, currentPage } = params
    const slicedResults = this.archive?.filters[
      selectedFilterIndex
    ].results.slice(
      currentPage * numPerPage,
      currentPage * numPerPage + numPerPage
    )
    event.reply('getResults', slicedResults)
  }

  initiateListeners() {
    ipcMain.on('getConfig', this.getConfig.bind(this))
    ipcMain.on('saveConfig', this.saveConfig.bind(this))
    ipcMain.on('getDirectory', this.getDirectory.bind(this))
    ipcMain.on('getArchive', this.getArchive.bind(this))
    ipcMain.on('createNewArchive', this.createNewArchive.bind(this))
    ipcMain.on('openExistingArchive', this.openExistingArchive.bind(this))
    ipcMain.on('saveArchive', this.saveArchive.bind(this))
    ipcMain.on('addFilesManual', this.addFilesManual.bind(this))
    ipcMain.on('addDroppedFiles', this.addDroppedFiles.bind(this))
    ipcMain.on('closeArchive', this.closeArchive.bind(this))
    ipcMain.on('addFilter', this.addFilter.bind(this))
    ipcMain.on('removeFilter', this.removeFilter.bind(this))
    ipcMain.on('getResults', this.getResults.bind(this))
  }
}
