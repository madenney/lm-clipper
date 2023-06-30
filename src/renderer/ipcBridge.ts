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
}
