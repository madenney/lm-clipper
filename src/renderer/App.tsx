import { useState, useEffect } from 'react'

import './styles/App.css'
import Main from './pages/Main'
import LoadingScreen from './pages/LoadingScreen'
import OpenScreen from './pages/OpenScreen'
import { ConfigInterface, ArchiveInterface } from '../constants/types'

import ipcBridge from './ipcBridge'

export default function App() {
  const [archive, setArchive] = useState<ArchiveInterface | null>()
  const [config, setConfig] = useState<ConfigInterface | null>()

  useEffect(() => {
    async function getInitialData() {
      setConfig(await ipcBridge.getConfig())
      setArchive(await ipcBridge.getArchive())
    }
    getInitialData()

    window.electron.ipcRenderer.on('closeProject', () => {
      setArchive(null)
    })
  }, [])

  if (!config) {
    return <LoadingScreen />
  }
  if (!archive) {
    return <OpenScreen setArchive={setArchive} />
  }
  return <Main archive={archive} />
}
