import { useState, useEffect } from 'react'

import './styles/App.css'
import Main from './components/Main'
import LoadingScreen from './components/LoadingScreen'
import OpenScreen from './components/OpenScreen'
import { ConfigInterface, ShallowArchiveInterface } from '../constants/types'

import ipcBridge from './ipcBridge'

export default function App() {
  const [archive, setArchive] = useState<ShallowArchiveInterface | null>(null)
  const [config, setConfig] = useState<ConfigInterface | null>(null)

  // useful for development purposes
  useEffect(() => {
    console.log('Archive: ', archive)
  }, [archive])
  useEffect(() => {
    console.log('Config: ', config)
  }, [config])

  useEffect(() => {
    async function getInitialData() {
      setConfig(await ipcBridge.getConfig())
      setArchive(await ipcBridge.getArchive())
    }
    getInitialData()

    window.electron.ipcRenderer.on('closeProject', async () => {
      setArchive(null)
      await ipcBridge.closeArchive()
      await ipcBridge.updateConfig({ key: "lastArchivePath", value: null })
    })

    window.electron.ipcRenderer.on('openProject', async () => {
      const archive = await ipcBridge.openExistingArchive()
      if (!archive) return
      if (archive.error) {
        console.log("Error: ", archive.error)
        return
      } else {
        setArchive(archive)
      }
    })
  }, [])


  if (!config) {
    return <LoadingScreen />
  }
  // if (!archive) {
  //   return <OpenScreen setArchive={setArchive} />
  // }
  return (
    <Main
      archive={archive}
      setArchive={setArchive}
      config={config}
      setConfig={setConfig}
    />
  )
}
