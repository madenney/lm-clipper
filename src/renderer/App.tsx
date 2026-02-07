import { useState, useEffect } from 'react'

import './styles/App.css'
import Main from './components/Main'
import LoadingScreen from './components/LoadingScreen'
import { ConfigInterface, ShallowArchiveInterface } from '../constants/types'
import { initPerfObservers } from './perfLogger'

import ipcBridge from './ipcBridge'

export default function App() {
  const [archive, setArchive] = useState<ShallowArchiveInterface | null>(null)
  const [config, setConfig] = useState<ConfigInterface | null>(null)

  useEffect(() => {
    initPerfObservers()
    ipcBridge.getConfig((nextConfig) => {
      setConfig(nextConfig || null)
    })
    ipcBridge.getArchive((nextArchive) => {
      setArchive(nextArchive || null)
    })

    const removeCloseListener = window.electron.ipcRenderer.on(
      'closeProject',
      () => {
        setArchive(null)
        ipcBridge.closeArchive()
      }
    )

    const removeOpenListener = window.electron.ipcRenderer.on(
      'openProject',
      () => {
        ipcBridge.openExistingArchive((newArchive) => {
          if (!newArchive) return
          if (newArchive.error) {
            console.log('Error: ', newArchive.error)
            return
          }
          setArchive(newArchive)
        })
      }
    )

    const removeImportListener = window.electron.ipcRenderer.on(
      'importSlpClicked',
      () => {
        ipcBridge.importSlpFiles((newArchive) => {
          if (newArchive?.error) {
            console.log('Error importing files: ', newArchive.error)
            return
          }
          setArchive(newArchive)
        })
      }
    )

    const removeNewProjectListener = window.electron.ipcRenderer.on(
      'newProject',
      () => {
        ipcBridge.newProject((newArchive) => {
          if (!newArchive || newArchive.error) {
            console.log('Error creating new project:', newArchive?.error)
            return
          }
          setArchive(newArchive)
        })
      }
    )

    const removeSaveAsListener = window.electron.ipcRenderer.on(
      'saveAsProject',
      () => {
        ipcBridge.saveAsArchive((result) => {
          if (!result) return
          if (result.error) {
            console.log('Error saving project as:', result.error)
            return
          }
          setArchive(result)
        })
      }
    )

    return () => {
      removeCloseListener()
      removeOpenListener()
      removeImportListener()
      removeNewProjectListener()
      removeSaveAsListener()
    }
  }, [])

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      window.electron.ipcRenderer.sendMessage('rendererError', {
        type: 'error',
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error?.stack,
      })
    }

    const handleRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason
      window.electron.ipcRenderer.sendMessage('rendererError', {
        type: 'unhandledrejection',
        reason:
          reason instanceof Error
            ? { name: reason.name, message: reason.message, stack: reason.stack }
            : { message: String(reason) },
      })
    }

    window.addEventListener('error', handleError)
    window.addEventListener('unhandledrejection', handleRejection)

    return () => {
      window.removeEventListener('error', handleError)
      window.removeEventListener('unhandledrejection', handleRejection)
    }
  }, [])

  useEffect(() => {
    const removeListener = window.electron.ipcRenderer.on(
      'importingFileUpdate',
      ({ finished, archive: freshArchive }) => {
        if (finished && freshArchive) {
          setArchive(freshArchive)
        }
      }
    )

    return () => {
      removeListener()
    }
  }, [])

  if (!config) {
    return <LoadingScreen />
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
