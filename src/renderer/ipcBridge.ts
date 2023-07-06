export default {
  getConfig() {
    return new Promise<any>((resolve) => {
      window.electron.ipcRenderer.sendMessage('getConfig', {})
      window.electron.ipcRenderer.once('config', resolve)
    })
  },
  getArchive() {
    return new Promise<any>((resolve) => {
      window.electron.ipcRenderer.sendMessage('getArchive', {})
      window.electron.ipcRenderer.once('archive', resolve)
    })
  },
  getDirectory() {
    return new Promise<any>((resolve) => {
      window.electron.ipcRenderer.sendMessage('getDirectory', {})
      window.electron.ipcRenderer.once('directory', resolve)
    })
  },
  createNewArchive(params: { name: string; location: string }) {
    return new Promise<any>((resolve) => {
      window.electron.ipcRenderer.sendMessage('createNewArchive', params)
      window.electron.ipcRenderer.once('createNewArchive', resolve)
    })
  },
  openExistingArchive() {
    return new Promise<any>((resolve) => {
      window.electron.ipcRenderer.sendMessage('openExistingArchive', {})
      window.electron.ipcRenderer.once('openExistingArchive', resolve)
    })
  },
  importSlpFiles() {
    return new Promise<any>((resolve) => {
      window.electron.ipcRenderer.sendMessage('addFilesManual', {})
      window.electron.ipcRenderer.once('addFilesManual', resolve)
    })
  },
  importDroppedSlpFiles(files: string[]) {
    return new Promise<any>((resolve) => {
      window.electron.ipcRenderer.sendMessage('addDroppedFiles', files)
      window.electron.ipcRenderer.once('addDroppedFiles', resolve)
    })
  },
  closeArchive() {
    return new Promise<any>((resolve) => {
      window.electron.ipcRenderer.sendMessage('closeArchive', {})
      window.electron.ipcRenderer.once('closeArchive', resolve)
    })
  },
  addFilter(type: string) {
    return new Promise<any>((resolve) => {
      window.electron.ipcRenderer.sendMessage('addFilter', type)
      window.electron.ipcRenderer.once('addFilter', resolve)
    })
  },
  saveArchive() {
    return new Promise<any>((resolve) => {
      window.electron.ipcRenderer.sendMessage('saveArchive', {})
      window.electron.ipcRenderer.once('saveArchive', resolve)
    })
  },
  removeFilter(index: number) {
    return new Promise<any>((resolve) => {
      window.electron.ipcRenderer.sendMessage('removeFilter', index)
      window.electron.ipcRenderer.once('removeFilter', resolve)
    })
  },
  getResults(params: {
    selectedFilterIndex: number
    currentPage: number
    numPerPage: number
  }) {
    return new Promise<any>((resolve) => {
      window.electron.ipcRenderer.sendMessage('getResults', params)
      window.electron.ipcRenderer.once('getResults', resolve)
    })
  },
}
