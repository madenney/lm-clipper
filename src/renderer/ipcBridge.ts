import { ShallowFilterInterface } from 'constants/types'

export default {
  getConfig() {
    console.log("ipcBridge.getConfig")
    return new Promise<any>((resolve) => {
      window.electron.ipcRenderer.sendMessage('getConfig', {})
      window.electron.ipcRenderer.once('config', resolve)
    })
  },
  getArchive() {
    console.log("ipcBridge.getArchive")
    return new Promise<any>((resolve) => {
      window.electron.ipcRenderer.sendMessage('getArchive', {})
      window.electron.ipcRenderer.once('archive', resolve)
    })
  },
  // getDirectory() {
  //   return new Promise<any>((resolve) => {
  //     window.electron.ipcRenderer.sendMessage('getDirectory', {})
  //     window.electron.ipcRenderer.once('directory', resolve)
  //   })
  // },
  createNewArchive(params: { name?: string; location?: string }) {
    console.log("ipcBridge.createNewArchive")
    return new Promise<any>((resolve) => {
      window.electron.ipcRenderer.sendMessage('createNewArchive', params)
      window.electron.ipcRenderer.once('createNewArchive', resolve)
    })
  },
  openExistingArchive() {
    console.log("ipcBridge.openExistingArchive")
    return new Promise<any>((resolve) => {
      window.electron.ipcRenderer.sendMessage('openExistingArchive', {})
      window.electron.ipcRenderer.once('openExistingArchive', resolve)
    })
  },
  // importSlpFiles() {
  //   return new Promise<any>((resolve) => {
  //     window.electron.ipcRenderer.sendMessage('addFilesManual', {})
  //     window.electron.ipcRenderer.once('addFilesManual', resolve)
  //   })
  // },
  addDroppedFiles(files: string[]) {
    console.log("ipcBridge.addDroppedFiles")
    return new Promise<any>((resolve) => {
      window.electron.ipcRenderer.sendMessage('addDroppedFiles', files)
      window.electron.ipcRenderer.once('addDroppedFiles', resolve)
    })
  },
  closeArchive() {
    console.log("ipcBridge.closeArchive")
    return new Promise<any>((resolve) => {
      window.electron.ipcRenderer.sendMessage('closeArchive', {})
      window.electron.ipcRenderer.once('closeArchive', resolve)
    })
  },
  addFilter(type: string) {
    console.log("ipcBridge.addFilter")
    return new Promise<any>((resolve) => {
      window.electron.ipcRenderer.sendMessage('addFilter', type)
      window.electron.ipcRenderer.once('addFilter', resolve)
    })
  },
  // saveArchive() {
  //   return new Promise<any>((resolve) => {
  //     window.electron.ipcRenderer.sendMessage('saveArchive', {})
  //     window.electron.ipcRenderer.once('saveArchive', resolve)
  //   })
  // },
  removeFilter(id: string) {
    console.log("ipcBridge.removeFilter")
    return new Promise<any>((resolve) => {
      window.electron.ipcRenderer.sendMessage('removeFilter', id)
      window.electron.ipcRenderer.once('removeFilter', resolve)
    })
  },
  getResults(params: {
    filterId: string
    currentPage?: number
    numPerPage?: number
  }) {
    console.log("ipcBridge.getResults")
    return new Promise<any>((resolve) => {
      window.electron.ipcRenderer.sendMessage('getResults', params)
      window.electron.ipcRenderer.once('getResults', resolve)
    })
  },
  // getNames() {
  //   return new Promise<any>((resolve) => {
  //     window.electron.ipcRenderer.sendMessage('getNames', {})
  //     window.electron.ipcRenderer.once('getNames', resolve)
  //   })
  // },
  // updateFilter(params: {
  //   filterIndex: number
  //   newFilter: ShallowFilterInterface
  // }) {
  //   return new Promise<any>((resolve) => {
  //     window.electron.ipcRenderer.sendMessage('updateFilter', params)
  //     window.electron.ipcRenderer.once('updateFilter', resolve)
  //   })
  // },
  runFilter(filterId: string) {
    console.log("ipcBridge.runFilter")
    return new Promise<any>((resolve) => {
      window.electron.ipcRenderer.sendMessage('runFilter', filterId)
      window.electron.ipcRenderer.once('runFilter', resolve)
    })
  },
  // runFilters() {
  //   return new Promise<any>((resolve) => {
  //     window.electron.ipcRenderer.sendMessage('runFilters', {})
  //     window.electron.ipcRenderer.once('runFilters', resolve)
  //   })
  // },
  // cancelRunningFilters() {
  //   return new Promise<any>((resolve) => {
  //     window.electron.ipcRenderer.sendMessage('terminateWorkers', {})
  //     window.electron.ipcRenderer.once('cancelRunningFilters', resolve)
  //   })
  // },
  updateConfig(config: { key: string; value: string | number | boolean | null }) {
    console.log("ipcBridge.updateConfig")
    return new Promise<any>((resolve) => {
      window.electron.ipcRenderer.sendMessage('updateConfig', config)
      window.electron.ipcRenderer.once('updateConfig', resolve)
    })
  },
  // getPath(type: string) {
  //   return new Promise<any>((resolve) => {
  //     window.electron.ipcRenderer.sendMessage('getPath', type)
  //     window.electron.ipcRenderer.once('getPath', resolve)
  //   })
  // },
  // generateVideo() {
  //   return new Promise<any>((resolve) => {
  //     window.electron.ipcRenderer.sendMessage('generateVideo', {})
  //     window.electron.ipcRenderer.once('generateVideo', resolve)
  //   })
  // },
}
