import {
  Component,
  useState,
  useEffect,
  useMemo,
  useRef,
  ReactNode,
} from 'react'

import './styles/App.css'
import { ArchiveContext, ConfigContext } from './context/AppContext'
import Main from './components/Main'
import LoadingScreen from './components/LoadingScreen'
import UpdateBanner from './components/UpdateBanner'
import ConsentNotice from './components/ConsentNotice'
import SetupWizard from './components/SetupWizard'
import { WelcomeModal } from './components/GettingStarted'
import SlpzWizard from './components/SlpzWizard'
import ZipWizard from './components/ZipWizard'
import {
  ConfigInterface,
  SavedCustomFilter,
  ShallowArchiveInterface,
} from '../constants/types'
import { initPerfObservers } from './perfLogger'

import ipcBridge from './ipcBridge'

class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  render() {
    const { hasError } = this.state
    const { children } = this.props
    if (hasError) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            gap: 12,
            color: '#ccc',
          }}
        >
          <p>Something went wrong.</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ padding: '6px 16px', cursor: 'pointer' }}
          >
            Reload
          </button>
        </div>
      )
    }
    return children
  }
}

export default function App() {
  const [archive, setArchive] = useState<ShallowArchiveInterface | null>(null)
  const [config, setConfig] = useState<ConfigInterface | null>(null)
  const [updateStatus, setUpdateStatus] = useState<
    | { state: 'available'; version: string }
    | { state: 'downloading'; percent: number }
    | { state: 'ready' }
    | { state: 'error'; message: string }
    | null
  >(null)

  useEffect(() => {
    initPerfObservers()
    ipcBridge.getConfig((nextConfig) => {
      setConfig(nextConfig || null)
    })
    ipcBridge.getArchive((nextArchive) => {
      if (nextArchive?.error) {
        console.error('Error loading archive:', nextArchive.error)
        return
      }
      setArchive(nextArchive || null)
    })

    const removeCloseListener = window.electron.ipcRenderer.on(
      'closeProject',
      () => {
        setArchive(null)
        ipcBridge.closeArchive()
      },
    )

    const removeOpenListener = window.electron.ipcRenderer.on(
      'openProject',
      () => {
        ipcBridge.openExistingArchive((newArchive) => {
          if (!newArchive) return
          if (newArchive.error) {
            console.error('Error: ', newArchive.error)
            return
          }
          setArchive(newArchive)
        })
      },
    )

    const removeImportListener = window.electron.ipcRenderer.on(
      'importSlpClicked',
      () => {
        ipcBridge.importSlpFiles((newArchive) => {
          if (newArchive?.error) {
            console.error('Error importing files: ', newArchive.error)
            return
          }
          setArchive(newArchive)
        })
      },
    )

    const removeNewProjectListener = window.electron.ipcRenderer.on(
      'menu:newProject',
      () => {
        ipcBridge.newProject((newArchive) => {
          if (!newArchive || newArchive.error) {
            console.error('Error creating new project:', newArchive?.error)
            return
          }
          setArchive(newArchive)
        })
      },
    )

    const removeRefreshListener = window.electron.ipcRenderer.on(
      'refreshProject',
      () => {
        ipcBridge.cancelRunningFilters()
        ipcBridge.cancelImport()
        ipcBridge.cancelVideo()
        ipcBridge.getArchive((nextArchive) => {
          if (nextArchive?.error) {
            console.error('Error refreshing archive:', nextArchive.error)
            return
          }
          setArchive(nextArchive || null)
        })
      },
    )

    const removeArchiveUpdatedListener = window.electron.ipcRenderer.on(
      'archiveUpdated',
      (nextArchive: ShallowArchiveInterface) => {
        setArchive(nextArchive || null)
      },
    )

    const removeRecentFromMenuListener = window.electron.ipcRenderer.on(
      'openRecentFromMenu',
      (projectPath: string) => {
        ipcBridge.openRecentProject(projectPath, (result) => {
          if (!result || result.error) {
            console.error('Error opening recent project:', result?.error)
            return
          }
          setArchive(result)
        })
      },
    )

    const removeSaveAsListener = window.electron.ipcRenderer.on(
      'saveAsProject',
      () => {
        ipcBridge.saveAsArchive((result) => {
          if (!result) return
          if (result.error) {
            console.error('Error saving project as:', result.error)
            return
          }
          setArchive(result)
        })
      },
    )

    const removeUpdateAvailable = window.electron.ipcRenderer.on(
      'update-available',
      (version: string) => {
        setUpdateStatus({ state: 'available', version })
      },
    )

    const removeUpdateProgress = window.electron.ipcRenderer.on(
      'update-progress',
      (percent: number) => {
        setUpdateStatus({ state: 'downloading', percent })
      },
    )

    const removeUpdateDownloaded = window.electron.ipcRenderer.on(
      'update-downloaded',
      () => {
        setUpdateStatus({ state: 'ready' })
      },
    )

    const removeUpdateError = window.electron.ipcRenderer.on(
      'update-error',
      (message: string) => {
        setUpdateStatus({ state: 'error', message })
      },
    )

    const removeTemplatesUpdated = window.electron.ipcRenderer.on(
      'config-templates-updated',
      (templates: SavedCustomFilter[]) => {
        setConfig((prev) =>
          prev ? { ...prev, savedCustomFilters: templates } : prev,
        )
      },
    )

    const removeShowWelcomeListener = window.electron.ipcRenderer.on(
      'showWelcome',
      () => setWelcomeOpen(true),
    )

    return () => {
      removeCloseListener()
      removeOpenListener()
      removeImportListener()
      removeNewProjectListener()
      removeRefreshListener()
      removeArchiveUpdatedListener()
      removeRecentFromMenuListener()
      removeSaveAsListener()
      removeUpdateAvailable()
      removeUpdateProgress()
      removeUpdateDownloaded()
      removeUpdateError()
      removeTemplatesUpdated()
      removeShowWelcomeListener()
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
      const { reason } = event
      window.electron.ipcRenderer.sendMessage('rendererError', {
        type: 'unhandledrejection',
        reason:
          reason instanceof Error
            ? {
                name: reason.name,
                message: reason.message,
                stack: reason.stack,
              }
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

  // Lazy count hydration. getMetadata returns instantly with unknown counts left
  // as null (so opening a huge project never blocks). Here we fill those counts
  // in after the fact — one background request per filter — and patch them into
  // the archive as each resolves, so the UI shows spinners that turn into numbers
  // instead of freezing on open. A per-path ref prevents duplicate requests.
  const countHydrationRef = useRef<{
    path: string | null
    requested: Set<string>
    recounted: Set<string>
  }>({ path: null, requested: new Set(), recounted: new Set() })
  useEffect(() => {
    if (!archive?.path || !Array.isArray(archive.filters)) return
    const state = countHydrationRef.current
    if (state.path !== archive.path) {
      state.path = archive.path
      state.requested = new Set()
      state.recounted = new Set()
    }
    const archivePath = archive.path
    // `force` lets us overwrite an existing (possibly stale) count, not just
    // fill a null one — used for the processed-but-zero recheck below.
    const requestCount = (id: string, force = false) => {
      if (state.requested.has(id)) return
      state.requested.add(id)
      ipcBridge.getFilterCount(id, (res) => {
        if (!res || res.filterId == null) return
        // Treat `requested` as in-flight only: clear it once the response lands
        // so the count can be re-fetched when the data changes later (e.g. an
        // import adds files after an empty auto-created project was hydrated).
        state.requested.delete(id)
        setArchive((prev) => {
          if (!prev || prev.path !== archivePath) return prev
          if (id === 'files') {
            return prev.files == null ? { ...prev, files: res.count } : prev
          }
          const target = prev.filters.find((f) => f.id === id)
          if (!target) return prev
          // Only patch when it actually changes value — returning `prev`
          // unchanged otherwise avoids a re-render → re-request loop.
          const shouldPatch =
            (target.results == null || force) && target.results !== res.count
          if (!shouldPatch) return prev
          return {
            ...prev,
            filters: prev.filters.map((f) =>
              f.id === id ? { ...f, results: res.count } : f,
            ),
          }
        })
      })
    }
    // Request the filter counts first (downstream filters are usually tiny and
    // return instantly), then the SLP files count last — it's a full scan of
    // the (often huge) files table, and the single DB worker processes these
    // serially, so doing it last keeps the cheap counts from waiting behind it.
    for (const f of archive.filters) {
      if (f.results == null) {
        requestCount(f.id)
      } else if (
        f.isProcessed &&
        f.results === 0 &&
        !state.recounted.has(f.id)
      ) {
        // A processed filter showing 0 may be a stale cached count: a run's
        // final COUNT occasionally lands before the worker's last commit is
        // visible, persisting 0 over real rows. Re-verify once per open — a
        // genuine empty result just re-counts an empty table instantly.
        state.recounted.add(f.id)
        requestCount(f.id, true)
      }
    }
    if (archive.files == null) requestCount('files')
  }, [archive, setArchive])

  useEffect(() => {
    const removeListener = window.electron.ipcRenderer.on(
      'importingFileUpdate',
      ({ finished, archive: freshArchive }) => {
        if (finished && freshArchive) {
          setArchive(freshArchive)
        }
      },
    )

    return () => {
      removeListener()
    }
  }, [])

  const [wizardMode, setWizardMode] = useState<'play' | 'record' | null>(null)
  const [pendingAction, setPendingAction] = useState<'play' | 'record' | null>(
    null,
  )
  const [welcomeOpen, setWelcomeOpen] = useState(false)

  const triggerSetupWizard = (mode: 'play' | 'record') => setWizardMode(mode)

  const [slpzDefaultOutputDir, setSlpzDefaultOutputDir] = useState<
    string | null
  >(null)

  useEffect(() => {
    const removeShow = window.electron.ipcRenderer.on(
      'showSlpzWizard',
      ({ defaultOutputDir }: { defaultOutputDir: string }) => {
        setSlpzDefaultOutputDir(defaultOutputDir || '')
      },
    )
    const removeDismiss = window.electron.ipcRenderer.on(
      'dismissSlpzWizard',
      () => {
        setSlpzDefaultOutputDir(null)
      },
    )
    return () => {
      removeShow()
      removeDismiss()
    }
  }, [])

  const [zipWizardData, setZipWizardData] = useState<{
    zipFiles: string[]
    defaultOutputDir: string
  } | null>(null)

  useEffect(() => {
    const removeShow = window.electron.ipcRenderer.on(
      'showZipWizard',
      (data: { zipFiles: string[]; defaultOutputDir: string }) => {
        setZipWizardData(data)
      },
    )
    const removeDismiss = window.electron.ipcRenderer.on(
      'dismissZipWizard',
      () => {
        setZipWizardData(null)
      },
    )
    return () => {
      removeShow()
      removeDismiss()
    }
  }, [])

  const archiveCtx = useMemo(
    () => ({ archive, setArchive }),
    [archive, setArchive],
  )
  const configCtx = useMemo(
    () => ({ config: config!, setConfig }),
    [config, setConfig],
  )

  if (!config) {
    return <LoadingScreen />
  }

  return (
    <>
      {updateStatus && (
        <UpdateBanner
          status={updateStatus}
          onDismiss={() => setUpdateStatus(null)}
        />
      )}
      {config && !config.consentNoticeSeen && (
        <ConsentNotice
          onDismiss={() => {
            setConfig((prev) =>
              prev ? { ...prev, consentNoticeSeen: true } : prev,
            )
            ipcBridge.updateConfig({ key: 'consentNoticeSeen', value: true })
          }}
        />
      )}
      {slpzDefaultOutputDir !== null && (
        <SlpzWizard
          defaultOutputDir={slpzDefaultOutputDir}
          onDismiss={() => setSlpzDefaultOutputDir(null)}
        />
      )}
      {zipWizardData && (
        <ZipWizard
          zipFiles={zipWizardData.zipFiles}
          defaultOutputDir={zipWizardData.defaultOutputDir}
          onDismiss={() => setZipWizardData(null)}
        />
      )}
      {wizardMode && (
        <SetupWizard
          config={config}
          setConfig={setConfig}
          mode={wizardMode}
          onDismiss={(completed) => {
            if (completed) setPendingAction(wizardMode)
            setWizardMode(null)
          }}
        />
      )}
      {welcomeOpen && (
        <WelcomeModal
          config={config}
          setConfig={setConfig}
          triggerSetupWizard={triggerSetupWizard}
          onClose={() => setWelcomeOpen(false)}
        />
      )}
      <ArchiveContext.Provider value={archiveCtx}>
        <ConfigContext.Provider value={configCtx}>
          <ErrorBoundary>
            <Main
              archive={archive}
              setArchive={setArchive}
              config={config}
              setConfig={setConfig}
              triggerSetupWizard={triggerSetupWizard}
              pendingAction={pendingAction}
              clearPendingAction={() => setPendingAction(null)}
            />
          </ErrorBoundary>
        </ConfigContext.Provider>
      </ArchiveContext.Provider>
    </>
  )
}
