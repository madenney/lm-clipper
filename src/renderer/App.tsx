import { useState, useEffect } from 'react'

import './styles/App.css'
import Main from './components/Main'
import LoadingScreen from './components/LoadingScreen'
import OpenScreen from './components/OpenScreen'
import { ConfigInterface, ShallowArchiveInterface } from '../constants/types'

import ipcBridge from './ipcBridge'

export default function App() {
  const [archive, setArchive] = useState<ShallowArchiveInterface | null>()
  const [config, setConfig] = useState<ConfigInterface | null>()
  const [areListenersDefined, setAreListenersDefined] = useState(false)

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

  useEffect(() => {
    if (!areListenersDefined) {
      setAreListenersDefined(true)
      window.electron.ipcRenderer.on('importSlpClicked', async () => {
        const newArchive = await ipcBridge.importSlpFiles()
        if (newArchive && !newArchive.error) {
          return setArchive(newArchive)
        }
        return console.log('Error', newArchive.error)
      })

      document.addEventListener('drop', async (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (event.dataTransfer) {
          const newArchive = await ipcBridge.importDroppedSlpFiles(
            Array.from(event.dataTransfer?.files).map((file) => file.path)
          )
          setArchive(newArchive)
        }
      })
      document.addEventListener('dragover', (e) => {
        e.preventDefault()
      })
      console.log('Added event listeners')
    }
  }, [areListenersDefined])

  if (!config) {
    return <LoadingScreen />
  }
  if (!archive) {
    return <OpenScreen setArchive={setArchive} />
  }
  return (
    <Main
      archive={archive}
      setArchive={setArchive}
      config={config}
      setConfig={setConfig}
    />
  )
}
