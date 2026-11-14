import { useState, useEffect, useMemo, useRef } from 'react'

import './styles/App.css'
import { ArchiveContext, ConfigContext } from './context/AppContext'
import Main from './components/Main'
import LoadingScreen from './components/LoadingScreen'
import UpdateBanner from './components/UpdateBanner'
import ConsentNotice from './components/ConsentNotice'
import SetupWizard from './components/SetupWizard'
import DevScreenSwitcher from './components/DevScreenSwitcher'
import { WelcomeModal } from './components/GettingStarted'
import { importResultNotice, NOTICE_EVENT, showNotice } from './importNotice'
import ErrorBoundary from './components/ErrorBoundary'
import { openFailureNotice } from './lib/openNotice'
import DatabaseDock from './components/DatabaseDock'
import { OwnerDock } from '../owner/renderer'
import SlpzWizard from './components/SlpzWizard'
import ZipWizard from './components/ZipWizard'
import {
  ConfigInterface,
  SavedCustomFilter,
  ShallowArchiveInterface,
} from '../constants/types'
import { initPerfObservers } from './perfLogger'

import ipcBridge from './ipcBridge'
import { SHOW_WELCOME_EVENT, shouldAutoShowWelcome } from './lib/welcome'
import { CHANGELOG } from '../constants/changelog'
import { entriesToShow } from '../lib/changelog'
import WhatsNew, { SHOW_CHANGELOG_EVENT } from './components/WhatsNew'
import { chooseStartOption, type StartOption } from './lib/startOptions'
// Motion last, so its entrances win over older per-dialog ones.
import './styles/Motion.css'
// Focus rings and high-contrast rules last, over the per-component outline resets.
import './styles/Accessibility.css'

export default function App() {
  // Set when an updater error should reach the user (see the update listeners below).
  const updateWantedRef = useRef(false)
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
        showNotice(
          "Couldn't open the last project. Open it again from the start screen, or start a new one.",
        )
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
            showNotice(
              openFailureNotice('open', newArchive) ??
                "Couldn't open that project.",
            )
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
            showNotice(
              openFailureNotice('import', newArchive) ??
                "Couldn't add those replays.",
            )
            return
          }
          if (newArchive) setArchive(newArchive)
        })
      },
    )

    const removeNewProjectListener = window.electron.ipcRenderer.on(
      'menu:newProject',
      () => {
        ipcBridge.newProject((newArchive) => {
          if (!newArchive || newArchive.error) {
            console.error('Error creating new project:', newArchive?.error)
            const failed = openFailureNotice('new', newArchive)
            if (failed) showNotice(failed)
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
            showNotice(
              openFailureNotice('open', result) ??
                "Couldn't open that project.",
            )
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
            showNotice(
              openFailureNotice('saveAs', result) ??
                "Couldn't save the project there.",
            )
            return
          }
          setArchive(result)
        })
      },
    )

    // A failed launch check (offline, firewall, no update file published yet) stays quiet: main
    // forwards every updater error, so only show one the user asked for (Help > Check for
    // Updates) or one that hits an update that was found and is downloading.
    const removeUpdateAvailable = window.electron.ipcRenderer.on(
      'update-available',
      (version: string) => {
        updateWantedRef.current = true
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
        if (!updateWantedRef.current) {
          console.warn('[update] check failed (not shown):', message)
          return
        }
        updateWantedRef.current = false
        setUpdateStatus({ state: 'error', message })
      },
    )

    const removeUpdateChecking = window.electron.ipcRenderer.on(
      'update-checking',
      () => setUpdateStatus({ state: 'checking' }),
    )

    const removeUpdateNotAvailable = window.electron.ipcRenderer.on(
      'update-not-available',
      () => {
        updateWantedRef.current = false
        setUpdateStatus({ state: 'not-available' })
      },
    )

    // Help → Check for Updates. Runs a user-initiated (non-silent) check so the
    // "checking…" / "up to date" / error states surface, not just a found one.
    const removeTriggerUpdateCheck = window.electron.ipcRenderer.on(
      'trigger-update-check',
      () => {
        updateWantedRef.current = true
        window.electron.ipcRenderer.sendMessage('check-for-updates', {})
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

  // One short line at the bottom for things the user should know but that
  // don't deserve a modal (e.g. an import that added nothing, and why).
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    const onNotice = (e: Event) => {
      const message = (e as CustomEvent<string>).detail
      if (typeof message === 'string' && message) setNotice(message)
    }
    window.addEventListener(NOTICE_EVENT, onNotice)
    return () => window.removeEventListener(NOTICE_EVENT, onNotice)
  }, [])
  useEffect(() => {
    if (!notice) return undefined
    // Long messages (why an import failed) get longer to read.
    const timer = setTimeout(
      () => setNotice(null),
      Math.min(20000, Math.max(6000, notice.length * 90)),
    )
    return () => clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    const removeListener = window.electron.ipcRenderer.on(
      'importingFileUpdate',
      (update) => {
        const { finished, archive: freshArchive } = update || {}
        if (finished && freshArchive) {
          setArchive(freshArchive)
        }
        if (finished) {
          const message = importResultNotice(update)
          if (message) setNotice(message)
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
  // A start option chosen in the Welcome while no project was open: it waits for My Replays to
  // open, then runs (the steps it acts on only exist once a project is).
  const pendingStartOptionRef = useRef<StartOption | null>(null)
  useEffect(() => {
    const option = pendingStartOptionRef.current
    if (!option || !archive?.path) return undefined
    pendingStartOptionRef.current = null
    const t = setTimeout(() => chooseStartOption(option), 0)
    return () => clearTimeout(t)
  }, [archive?.path])
  // The welcome opens by itself the first time a project is open in each session, but only
  // for a new project (no steps beyond the Replays pool: a project already worked in does not
  // need the four starting points), and not after "Don't show this again" (config.hideWelcome).
  const welcomeAutoShownRef = useRef(false)
  useEffect(() => {
    if (!archive?.path || !config || welcomeAutoShownRef.current) return
    welcomeAutoShownRef.current = true
    if (shouldAutoShowWelcome(archive.filters, config.hideWelcome))
      setWelcomeOpen(true)
  }, [archive?.path, archive?.filters, config])
  // The top bar's ? button (and anything else) opens it with this event.
  useEffect(() => {
    const open = () => setWelcomeOpen(true)
    window.addEventListener(SHOW_WELCOME_EVENT, open)
    return () => window.removeEventListener(SHOW_WELCOME_EVENT, open)
  }, [])
  const triggerSetupWizard = (mode: 'play' | 'record') => setWizardMode(mode)

  // "What's new": once after an update (what changed since the version the user last
  // saw), and the whole history from Settings > About or Help > What's New.
  const [appVersion, setAppVersion] = useState('')
  const [whatsNew, setWhatsNew] = useState<'update' | 'history' | null>(null)
  useEffect(() => {
    const remove = window.electron.ipcRenderer.on('appVersion', (v: string) =>
      setAppVersion(v),
    )
    window.electron.ipcRenderer.sendMessage('getAppVersion', null)
    return remove
  }, [])
  const updateNotesCheckedRef = useRef(false)
  const updateNotes = useMemo(
    () =>
      config && appVersion
        ? entriesToShow(CHANGELOG, config.lastSeenVersion, appVersion)
        : [],
    // Decided once per launch: closing the popup records the version, which must not re-open it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [Boolean(config), appVersion],
  )
  useEffect(() => {
    if (updateNotesCheckedRef.current || !config || !appVersion) return
    updateNotesCheckedRef.current = true
    if (updateNotes.length) setWhatsNew('update')
  }, [config, appVersion, updateNotes])
  useEffect(() => {
    const open = () => setWhatsNew('history')
    window.addEventListener(SHOW_CHANGELOG_EVENT, open)
    const removeIpc = window.electron.ipcRenderer.on('showChangelog', open)
    return () => {
      window.removeEventListener(SHOW_CHANGELOG_EVENT, open)
      removeIpc()
    }
  }, [])
  const closeWhatsNew = () => {
    if (whatsNew === 'update' && appVersion) {
      setConfig((prev) =>
        prev ? { ...prev, lastSeenVersion: appVersion } : prev,
      )
      ipcBridge.updateConfig({ key: 'lastSeenVersion', value: appVersion })
    }
    setWhatsNew(null)
  }

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
  // iterating on it. Development builds only: a packaged build never shows it, whatever
  // lm-clipper.json says (config.testMode used to switch it on). See DevScreenSwitcher /
  // config.devForceScreen.
  const devScreensEnabled = process.env.NODE_ENV === 'development'
  const forced = devScreensEnabled ? config.devForceScreen || '' : ''
  const forcing = forced !== ''
  const setForced = (value: string) => {
    setConfig((prev) => (prev ? { ...prev, devForceScreen: value } : prev))
    ipcBridge.updateConfig({ key: 'devForceScreen', value })
  }
  const devSwitcher = devScreensEnabled ? (
    <DevScreenSwitcher
      value={forced}
      onChange={setForced}
      // One-click projects from this machine's settings: development builds only.
      quickProjects={
        process.env.NODE_ENV === 'development' ? (config.devProjects ?? []) : []
      }
      onOpenProject={(projectPath) =>
        ipcBridge.openRecentProject(projectPath, (result) => {
          if (!result || result.error) {
            console.error('Could not open project:', result?.error)
            return
          }
          setArchive(result)
        })
      }
    />
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
  // The usage-stats notice shows on the start screen and in a project alike until the user
  // clicks OK (it used to vanish the moment a project opened, unread).
  const showConsent = forcing ? forced === 'consent' : !config.consentNoticeSeen
  const showWelcome = forcing ? forced === 'welcome' : welcomeOpen
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
      <ErrorBoundary area="dialogs" fallback="inline">
        {updateStatus && (
          <UpdateBanner
            status={updateStatus}
            onDismiss={() => setUpdateStatus(null)}
          />
        )}
        {showConsent && (
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
            triggerSetupWizard={triggerSetupWizard}
            onClose={() => (forcing ? setForced('') : setWelcomeOpen(false))}
            onChoose={(option) => {
              if (forcing) setForced('')
              else setWelcomeOpen(false)
              if (archive) {
                chooseStartOption(option)
                return
              }
              // No project yet (Help > Welcome on the start screen): open My Replays, then act.
              pendingStartOptionRef.current = option
              ipcBridge.openMyReplays((result) => {
                const failed = openFailureNotice('new', result)
                if (failed || !result || result.error) {
                  pendingStartOptionRef.current = null
                  if (failed) showNotice(failed)
                  return
                }
                setArchive(result)
              })
            }}
            hidden={config.hideWelcome === true}
            onHiddenChange={(hidden) => {
              setConfig((prev) =>
                prev ? { ...prev, hideWelcome: hidden } : prev,
              )
              ipcBridge.updateConfig({ key: 'hideWelcome', value: hidden })
            }}
          />
        )}
        {whatsNew && !showWelcome && !forcing && (
          <WhatsNew
            entries={whatsNew === 'history' ? CHANGELOG : updateNotes}
            history={whatsNew === 'history'}
            onClose={closeWhatsNew}
          />
        )}
        {/* Dev screen switcher: look at the popup and the history without updating. */}
        {(forced === 'whats-new' || forced === 'whats-new-history') && (
          <WhatsNew
            entries={forced === 'whats-new' ? CHANGELOG.slice(0, 1) : CHANGELOG}
            history={forced === 'whats-new-history'}
            onClose={() => setForced('')}
          />
        )}
      </ErrorBoundary>
      <div role="status" aria-live="polite">
        {notice && (
          <button
            type="button"
            className="app-notice"
            onClick={() => setNotice(null)}
            title="Dismiss"
          >
            {notice}
          </button>
        )}
      </div>
      {devSwitcher}
      <ArchiveContext.Provider value={archiveCtx}>
        <ConfigContext.Provider value={configCtx}>
          <ErrorBoundary area="Lunar Database panel" fallback="inline">
            <DatabaseDock />
          </ErrorBoundary>
          <ErrorBoundary area="owner tools" fallback="inline">
            <OwnerDock />
          </ErrorBoundary>
          <ErrorBoundary
            area="workspace"
            onCloseProject={() => {
              setArchive(null)
              ipcBridge.closeArchive()
            }}
            onOpenLogs={() => ipcBridge.openLogsFolder()}
          >
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
