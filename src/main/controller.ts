import { app, ipcMain, dialog, IpcMainEvent } from 'electron'
import path from 'path'
import fs from 'fs'

import {
  config as defaultConfig,
  archive as defaultArchive,
} from '../constants/defaults'
import Archive from '../models/Archive'
import { ArchiveInterface, ShallowArchiveInterface } from '../constants/types'

const configDir = path.resolve(app.getPath('appData'), 'lm-clipper')
const configPath = path.resolve(configDir, 'lm-clipper.json')
if (!fs.existsSync(configDir)) fs.mkdirSync(configDir)
if (!fs.existsSync(configPath))
  fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2))

let config = JSON.parse(fs.readFileSync(configPath).toString())
let archive: ArchiveInterface | null = null
if (config.lastArchivePath) {
  archive = new Archive(
    JSON.parse(fs.readFileSync(config.lastArchivePath).toString())
  )
} else {
  archive = new Archive(defaultArchive)
}

async function getConfig(event: IpcMainEvent) {
  event.reply('config', config)
}

async function saveConfig(e: IpcMainEvent, payload: string) {
  fs.writeFileSync(configPath, JSON.stringify(payload, null, 2))
  config = payload
}

async function getArchive(event: IpcMainEvent) {
  if (archive) {
    const shallowArchive: ShallowArchiveInterface = {
      path: archive.path,
      name: archive.name,
      createdAt: archive.createdAt,
      updatedAt: archive.updatedAt,
      files: archive.files.length,
      filters: archive.filters.map((filter) => {
        return {
          ...filter,
          results: filter.results.length,
        }
      }),
    }
    event.reply('archive', shallowArchive)
  } else {
    event.reply('archive')
  }
}

async function createNewArchive(
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
    archive = new Archive(newArchiveJSON)
    // update config
    const newConfig = JSON.parse(fs.readFileSync(configPath).toString())
    newConfig.lastArchivePath = newArchivePath
    fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2))

    event.reply('createNewArchive', newArchiveJSON)
  } catch (error) {
    event.reply('createNewArchive', { error: true, info: error })
  }
}

async function saveArchive(event: IpcMainEvent) {
  try {
    if (archive && archive.save) archive.save()
    event.reply('saveArchive')
  } catch (error) {
    event.reply('saveArchive', error)
  }
}

async function getDirectory(event: IpcMainEvent) {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    defaultPath: config.lastArchivePath ? config.lastArchivePath : '',
  })
  if (canceled) event.reply('directory')
  event.reply('directory', filePaths[0])
}

async function openExistingArchive(event: IpcMainEvent) {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'lmc files', extensions: ['lmc'] }],
    })
    if (canceled) return event.reply('openExistingArchive')

    archive = JSON.parse(fs.readFileSync(filePaths[0]).toString())
    if (!archive) throw new Error('Something went wrong :(')
    const shallowArchive: ShallowArchiveInterface = {
      ...archive,
      files: archive.files.length,
      filters: archive.filters.map((filter) => {
        return {
          ...filter,
          results: filter.results.length,
        }
      }),
    }
    return event.reply('openExistingArchive', shallowArchive)
  } catch (error) {
    return event.reply('openExistingArchive', { error })
  }
}

export default function Controller() {
  ipcMain.on('getConfig', getConfig)
  ipcMain.on('saveConfig', saveConfig)
  ipcMain.on('getDirectory', getDirectory)
  ipcMain.on('getArchive', getArchive)
  ipcMain.on('createNewArchive', createNewArchive)
  ipcMain.on('openExistingArchive', openExistingArchive)
  ipcMain.on('saveArchive', saveArchive)
}
