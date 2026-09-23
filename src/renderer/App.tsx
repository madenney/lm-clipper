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
import DevScreenSwitcher from './components/DevScreenSwitcher'
import { WelcomeModal } from './components/GettingStarted'
import ProjectIdeas from './components/ProjectIdeas'
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
    | { state: 'checking' }
    | { state: 'available'; version: string }
    | { state: 'downloading'; percent: number }
    | { state: 'ready' }
    | { state: 'not-available' }
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

    const removeUpdateChecking = window.electron.ipcRenderer.on(
      'update-checking',
      () => setUpdateStatus({ state: 'checking' }),
    )

    const removeUpdateNotAvailable = window.electron.ipcRenderer.on(
      'update-not-available',
      () => setUpdateStatus({ state: 'not-available' }),
    )

    // Help → Check for Updates. Runs a user-initiated (non-silent) check so the
    // "checking…" / "up to date" / error states surface, not just a found one.
    const removeTriggerUpdateCheck = window.electron.ipcRenderer.on(
      'trigger-update-check',
      () => window.electron.ipcRenderer.sendMessage('check-for-updates', {}),
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

    // Kick the update check now that the listeners above are registered. The
    // main process's launch check fires on `ready-to-show`, which can (and on
    // some machines reliably does) beat React mounting — so its resulting
    // `update-available` was landing before anything was listening and getting
    // dropped, i.e. an available update never showed a banner. Re-running it
    // here guarantees a listener exists. `silent` keeps it quiet unless there's
    // actually an update (no "checking…"/"up to date" noise on every launch).
    window.electron.ipcRenderer.sendMessage('check-for-updates', {
      silent: true,
    })

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
      removeUpdateChecking()
      removeUpdateNotAvailable()
      removeTriggerUpdateCheck()
      removeTemplatesUpdated()
      removeShowWelcomeListener()
    }
  }, [])

  // "You're up to date" is informational — auto-clear it after a few seconds.
  useEffect(() => {
    if (updateStatus?.state !== 'not-available') return undefined
    const t = setTimeout(() => setUpdateStatus(null), 4000)
    return () => clearTimeout(t)
  }, [updateStatus])

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
  const [projectIdeasOpen, setProjectIdeasOpen] = useState(false)
  // Guards the first-project welcome to fire at most once per session.
  const projectIdeasFiredRef = useRef(false)

  // Show the "what do you want to make?" onboarding the first time a project
  // actually has replays in it — i.e. right after the first import — NOT merely
  // when a project opens. This keeps it from covering the tray's own import
  // prompt on an empty New Project, and guarantees the cards have data to act on
  // (picking one builds a chain the user can immediately run). Fires once ever
  // (config.projectIdeasSeen), after consent is handled, and never while a dev
  // screen is being force-previewed (that path drives its own visibility below).
  useEffect(() => {
    if (projectIdeasFiredRef.current) return
    if (!config || !archive) return
    if (!archive.files || archive.files <= 0) return
    if (config.devForceScreen) return
    if (config.projectIdeasSeen) return
    if (!config.consentNoticeSeen) return
    projectIdeasFiredRef.current = true
    setProjectIdeasOpen(true)
  }, [archive, config])

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

  // Dev-only screen forcer: pin one onboarding screen exclusively while
  // iterating on it. Honored only in a dev build or with Test Mode on; ignored
  // for normal users. See DevScreenSwitcher / config.devForceScreen.
  const devScreensEnabled =
    process.env.NODE_ENV === 'development' || !!config.testMode
  const forced = devScreensEnabled ? config.devForceScreen || '' : ''
  const forcing = forced !== ''
  const setForced = (value: string) => {
    setConfig((prev) => (prev ? { ...prev, devForceScreen: value } : prev))
    ipcBridge.updateConfig({ key: 'devForceScreen', value })
  }
  const devSwitcher = devScreensEnabled ? (
    <DevScreenSwitcher value={forced} onChange={setForced} />
  ) : null

  // Forcing 'loading' short-circuits to just the loading screen (+ switcher).
  if (forced === 'loading') {
    return (
      <>
        <LoadingScreen />
        {devSwitcher}
      </>
    )
  }

  // Overlay visibility. When forcing, show ONLY the forced overlay; otherwise
  // normal first-run behavior. Dismissing a forced overlay clears the force.
  const showConsent = forcing ? forced === 'consent' : !config.consentNoticeSeen
  const showWelcome = forcing ? forced === 'welcome' : welcomeOpen
  const showProjectIdeas = forcing
    ? forced === 'project-ideas'
    : projectIdeasOpen
  const effectiveWizardMode = forcing
    ? forced === 'setup-play'
      ? 'play'
      : forced === 'setup-record'
        ? 'record'
        : null
    : wizardMode
  const showSlpz = !forcing && slpzDefaultOutputDir !== null
  const showZip = !forcing && zipWizardData !== null

  return (
    <>
      {updateStatus && (
        <UpdateBanner
          status={updateStatus}
          onDismiss={() => setUpdateStatus(null)}
        />
      )}
      {showConsent && (
        // The consent notice is an in-flow top banner; `.main` (absolute,
        // full-viewport) paints over it. When forcing it for preview, lift it
        // into a fixed top-bar layer above `.main` so it's actually visible
        // over the empty-state background.
        <div
          style={
            forcing
              ? { position: 'fixed', top: 0, left: 0, right: 0, zIndex: 5000 }
              : undefined
          }
        >
          <ConsentNotice
            onDismiss={() => {
              if (forcing) {
                setForced('')
                return
              }
              setConfig((prev) =>
                prev ? { ...prev, consentNoticeSeen: true } : prev,
              )
              ipcBridge.updateConfig({ key: 'consentNoticeSeen', value: true })
            }}
          />
        </div>
      )}
      {showSlpz && slpzDefaultOutputDir !== null && (
        <SlpzWizard
          defaultOutputDir={slpzDefaultOutputDir}
          onDismiss={() => setSlpzDefaultOutputDir(null)}
        />
      )}
      {showZip && zipWizardData && (
        <ZipWizard
          zipFiles={zipWizardData.zipFiles}
          defaultOutputDir={zipWizardData.defaultOutputDir}
          onDismiss={() => setZipWizardData(null)}
        />
      )}
      {effectiveWizardMode && (
        <SetupWizard
          config={config}
          setConfig={setConfig}
          mode={effectiveWizardMode}
          onDismiss={(completed) => {
            if (forcing) {
              setForced('')
              return
            }
            if (completed) setPendingAction(effectiveWizardMode)
            setWizardMode(null)
          }}
        />
      )}
      {showWelcome && (
        <WelcomeModal
          config={config}
          setConfig={setConfig}
          triggerSetupWizard={triggerSetupWizard}
          onClose={() => (forcing ? setForced('') : setWelcomeOpen(false))}
        />
      )}
      {showProjectIdeas && (
        <ProjectIdeas
          config={config}
          setConfig={setConfig}
          setArchive={setArchive}
          fileCount={archive?.files ?? null}
          preview={forcing}
          onClose={() => (forcing ? setForced('') : setProjectIdeasOpen(false))}
        />
      )}
      {devSwitcher}
      <ArchiveContext.Provider value={archiveCtx}>
        <ConfigContext.Provider value={configCtx}>
          <ErrorBoundary>
            <Main
              // When forcing an onboarding screen, render Main against the
              // fresh no-project empty state so previews match a new user (and
              // 'empty' works even with a project open). Real archive untouched.
              archive={forcing ? null : archive}
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
