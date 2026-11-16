import {
  useState,
  Dispatch,
  SetStateAction,
  useEffect,
  useRef,
  ReactNode,
} from 'react'
import {
  FaFolder,
  FaFolderOpen,
  FaDatabase,
  FaPlus,
  FaPlay,
} from 'react-icons/fa'
import { FiTerminal, FiAlertTriangle } from 'react-icons/fi'
import { IoSettingsSharp } from 'react-icons/io5'

import ipcBridge from 'renderer/ipcBridge'
import { showNotice, NO_PATHS_NOTICE } from 'renderer/importNotice'
import { videoConfig } from 'constants/config'
import AppConsole from './AppConsole'
import Modal from './Modal'
import { openFailureNotice, type OpenKind } from '../lib/openNotice'
import { clipActionBlock } from '../lib/clipActions'
import type { ConsoleLevelFilter } from '../../lib/consoleView'
import Tooltip from './Tooltip'
import {
  openSettings,
  OPEN_SETTINGS_EVENT,
  type OpenSettingsDetail,
} from '../lib/openSettings'
import {
  ConfigInterface,
  ShallowArchiveInterface,
  RecentProject,
  ConsoleSnapshot,
  ConsoleLogEntry,
} from '../../constants/types'
import Filters from './Filters'
import Top from './Top'
import GeckoModal from './GeckoModal'
import SettingsModal from './SettingsModal'
import VideoToolsModal from './VideoToolsModal'
import ActionBar from './ActionBar'
import RecordingOptions from './RecordingOptions'
import { Tray } from './Tray/Tray'
import useSelection from '../hooks/useSelection'
import useIpcListener from '../hooks/useIpcListener'
import logo from '../../images/logo.png'
import '../styles/Main.css'
import MissingReplaysBar from './MissingReplaysBar'
import CpuScanBar from './CpuScanBar'
import GameLengthBar from './GameLengthBar'
import { openLunarDatabase } from '../lib/openDatabase'
import { performanceWarning } from '../lib/performanceWarnings'
import { OwnerResultsActions, OwnerStartActions } from '../../owner/renderer'
import { formatFramesDuration } from '../../lib/format'

/** A video message worth keeping on screen after the job ends. */
export const isVideoNotice = (msg: string) =>
  typeof msg === 'string' && /^(Stopped|Error):/.test(msg)

const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

const formatVideoDuration = (seconds: number): string => {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0)
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

// Start screen. A brand-new user (no recent projects) sees one action picked
// from what they have — import their Slippi folder if we found one, otherwise
// choose files — and nothing else; importing creates the project. Returning
// users get their recent projects. See APP_FLOW.md (Target flow, screen 2/2b).
function EmptyState({
  setArchive,
  config,
  setConfig,
  onRunSetupWizard,
}: {
  setArchive: Dispatch<SetStateAction<ShallowArchiveInterface | null>>
  config: ConfigInterface
  setConfig: Dispatch<SetStateAction<ConfigInterface | null>>
  onRunSetupWizard: () => void
}) {
  // Settings from the start screen too (the top bar only exists with a
  // project open, and the consent line points here).
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<string | undefined>()
  // The usage-stats notice's "Turn off" opens Settings on Diagnostics (the top bar, which does
  // this with a project open, does not exist here).
  useEffect(() => {
    const open = (event: Event) => {
      setSettingsSection(
        (event as CustomEvent<OpenSettingsDetail>).detail?.section,
      )
      setSettingsOpen(true)
    }
    window.addEventListener(OPEN_SETTINGS_EVENT, open)
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, open)
  }, [])
  const [geckoOpen, setGeckoOpen] = useState(false)
  const [recentProjects, setRecentProjects] = useState<RecentProject[] | null>(
    null,
  )
  const [slippiReplays, setSlippiReplays] = useState<{
    dir: string
    count: number
  } | null>(null)
  const [slippiChecked, setSlippiChecked] = useState(false)

  useEffect(() => {
    ipcBridge.getRecentProjects((projects) => {
      setRecentProjects(Array.isArray(projects) ? projects : [])
    })
    ipcBridge.detectSlippiReplays((res) => {
      setSlippiReplays(res && res.count > 0 ? res : null)
      setSlippiChecked(true)
    })
  }, [])

  // A cancelled dialog replies null: nothing to say. A failure says why (it used to do nothing).
  const openResult = (kind: OpenKind) => (result: any) => {
    const failed = openFailureNotice(kind, result)
    if (failed) {
      console.error('[start] could not open:', result?.error)
      showNotice(failed)
      return
    }
    if (!result || result.error) return
    setArchive(result)
  }

  const handleImportSlippi = () => {
    if (slippiReplays)
      ipcBridge.importDroppedSlpFiles([slippiReplays.dir], openResult('import'))
  }
  const handleChooseFiles = () => ipcBridge.importSlpFiles(openResult('import'))
  const handleNewProject = () => ipcBridge.newProject(openResult('new'))
  const handleStartEmpty = () => ipcBridge.openMyReplays(openResult('new'))
  const handleOpenProject = () =>
    ipcBridge.openExistingArchive(openResult('open'))

  const handleOpenRecent = (projectPath: string) => {
    ipcBridge.openRecentProject(projectPath, (result) => {
      if (!result || result.error) {
        // Remove the stale entry from the list, and say why it went.
        setRecentProjects((prev) =>
          (prev || []).filter((p) => p.path !== projectPath),
        )
        showNotice(
          openFailureNotice('open', result) ??
            "Couldn't open that project, so it was removed from the Recent list.",
        )
        return
      }
      setArchive(result)
    })
  }

  const truncatePath = (p: string, maxLen = 60) => {
    if (p.length <= maxLen) return p
    return `...${p.slice(p.length - maxLen + 3)}`
  }

  // The logo and the ways in show at once; only the Slippi folder search (a big folder on a slow
  // disk takes a while) and the recent list fill in when they answer.
  const checking = !slippiChecked
  const isNewUser = recentProjects === null || recentProjects.length === 0
  const slippiCount = slippiReplays
    ? `${slippiReplays.count.toLocaleString()}${slippiReplays.count >= 50000 ? '+' : ''}`
    : ''

  // The other ways in, as a short list of rows under the main action (user,
  // 2026-10-03/04: visible options, an empty project, labels on one line).
  const option = (icon: ReactNode, label: string, onClick: () => void) => (
    <button
      key={label}
      type="button"
      className="empty-state-option"
      onClick={onClick}
    >
      <span className="empty-state-option-icon">{icon}</span>
      <span className="empty-state-option-label">{label}</span>
      <span className="empty-state-option-go" aria-hidden>
        →
      </span>
    </button>
  )
  const databaseOption = option(
    <FaDatabase />,
    'Download games from the Lunar Database',
    // Importing means whole games: the Download games tab (user, 2026-10-04).
    () => openLunarDatabase('search'),
  )
  const chooseOption = option(
    <FaFolderOpen />,
    slippiReplays ? 'Choose other local replays' : 'Choose local replays',
    handleChooseFiles,
  )
  const emptyOption = option(
    <FaPlus />,
    'Start empty project',
    handleStartEmpty,
  )

  // One card (user, 2026-10-04: more cohesive): the main way in as a
  // highlighted top row with its own button, the other ways in below it.
  const lead = checking ? (
    <div
      className="start-primary start-primary--checking"
      role="status"
      aria-live="polite"
    >
      <span className="start-primary-icon">
        <FaFolder />
      </span>
      <div className="start-primary-text">
        <div className="start-primary-title">
          Looking for your Slippi replays...
        </div>
        <div className="start-primary-sub">
          This can take a moment on a big folder. You can already choose files
          or browse the database below.
        </div>
      </div>
    </div>
  ) : slippiReplays ? (
    <div className="start-primary">
      <span className="start-primary-icon start-primary-icon--slippi">
        <FaFolder />
      </span>
      <div className="start-primary-text">
        <div className="start-primary-title">Import your Slippi replays</div>
        <div className="start-primary-sub">
          {slippiCount} found in your Slippi folder ·{' '}
          <button
            type="button"
            className="start-primary-link"
            onClick={() => ipcBridge.openFolder(slippiReplays.dir)}
            title={slippiReplays.dir}
          >
            show folder
          </button>
        </div>
      </div>
      <button
        type="button"
        className="start-primary-btn"
        onClick={handleImportSlippi}
      >
        Import
      </button>
    </div>
  ) : (
    // No replays here: the database gives a new user something to clip right
    // away (APP_FLOW.md, first screen). Pre-parsed moments is the fastest first clip.
    <div className="start-primary">
      <span className="start-primary-icon">
        <FaDatabase />
      </span>
      <div className="start-primary-text">
        <div className="start-primary-title">Browse the Lunar Database</div>
        <div className="start-primary-sub">
          No Slippi replays found on this PC. Start with pre-parsed moments
          (combos and edgeguards) from every public game.
        </div>
      </div>
      <button
        type="button"
        className="start-primary-btn"
        onClick={() => openLunarDatabase('clips')}
      >
        Browse
      </button>
    </div>
  )

  const primary = (
    <>
      <div className="start-card">
        {lead}
        <div className="empty-state-options">
          {(slippiReplays || checking) && databaseOption}
          {chooseOption}
          {emptyOption}
        </div>
      </div>
      <OwnerStartActions />
      <div className="empty-state-quiet">
        You can also drop replays anywhere on this screen.
      </div>
    </>
  )

  return (
    <div className="empty-state">
      <button
        type="button"
        className="empty-state-settings"
        onClick={() => {
          setSettingsSection(undefined)
          setSettingsOpen(true)
        }}
        aria-label="Settings"
        title="Settings"
      >
        <IoSettingsSharp />
      </button>
      {settingsOpen && (
        <SettingsModal
          config={config}
          setConfig={setConfig}
          onClose={() => setSettingsOpen(false)}
          onOpenGeckoModal={() => {
            setSettingsOpen(false)
            setGeckoOpen(true)
          }}
          onRunSetupWizard={onRunSetupWizard}
          initialSection={settingsSection}
        />
      )}
      {geckoOpen && (
        <GeckoModal
          config={config}
          setConfig={setConfig}
          onClose={() => setGeckoOpen(false)}
        />
      )}
      <div className="empty-state-inner">
        <div className="empty-state-brand">
          <a
            href="https://www.lunarmelee.com"
            className="empty-state-logo-link"
            title="lunarmelee.com"
            onClick={(e) => {
              e.preventDefault()
              window.open('https://www.lunarmelee.com')
            }}
          >
            <img className="empty-state-logo" src={logo} alt="Lunar Clipper" />
          </a>
        </div>
        <div className="empty-state-primary">{primary}</div>
        {recentProjects === null ? null : isNewUser ? (
          <button
            type="button"
            className="empty-state-link empty-state-link--corner"
            onClick={handleOpenProject}
          >
            Open project
          </button>
        ) : (
          <div className="empty-state-recent">
            <div className="empty-state-recent-head">
              <span className="empty-state-recent-title">Recent</span>
              <span className="empty-state-recent-actions">
                <button
                  type="button"
                  className="empty-state-link"
                  onClick={handleNewProject}
                >
                  New
                </button>
                <button
                  type="button"
                  className="empty-state-link"
                  onClick={handleOpenProject}
                >
                  Open
                </button>
              </span>
            </div>
            <div className="empty-state-recent-list">
              {recentProjects.map((project) => (
                <button
                  key={project.path}
                  type="button"
                  className="empty-state-recent-item"
                  onClick={() => handleOpenRecent(project.path)}
                >
                  <span className="empty-state-recent-name">
                    {project.name}
                  </span>
                  <span className="empty-state-recent-path">
                    {truncatePath(project.path)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const CONSOLE_MAX_LINES = 5000
const CONSOLE_KEEP_LINES = 4000

/** The console's height and filter are remembered between runs (this machine only). */
function readConsolePref<T>(
  key: string,
  fallback: T,
  parse: (_v: string) => T,
): T {
  try {
    const v = window.localStorage.getItem(`lunar.console.${key}`)
    return v === null ? fallback : parse(v)
  } catch {
    return fallback
  }
}

function writeConsolePref(key: string, value: string) {
  try {
    window.localStorage.setItem(`lunar.console.${key}`, value)
  } catch {
    // not remembered
  }
}

type MainProps = {
  archive: ShallowArchiveInterface | null
  setArchive: Dispatch<SetStateAction<ShallowArchiveInterface | null>>
  config: ConfigInterface
  setConfig: Dispatch<SetStateAction<ConfigInterface | null>>
  triggerSetupWizard: (_mode: 'play' | 'record') => void
  pendingAction: 'play' | 'record' | null
  clearPendingAction: () => void
}

export default function Main({
  archive,
  setArchive,
  config,
  setConfig,
  triggerSetupWizard,
  pendingAction,
  clearPendingAction,
}: MainProps) {
  const [leftWidth, setLeftWidth] = useState(580)
  const [activeFilterId, setActiveFilterId] = useState('files')
  const minLeftWidth = 400
  const minRightWidth = 500
  const dividerWidth = 5
  const [dragover, setDragover] = useState(false)
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 })
  const dragDepthRef = useRef(0)

  // Selection state
  const {
    selection,
    setSelection,
    lastSelectedIndex,
    setLastSelectedIndex,
    selectionDuration,
    setSelectionDuration,
  } = useSelection(activeFilterId)

  // Playback state
  const [isPlaying, setIsPlaying] = useState(false)

  // Video generation state
  const [isGenerating, setIsGenerating] = useState(false)
  // True from when Stop is pressed until the job actually ends — drives the
  // "Stopping…" button state so the graceful stop doesn't look frozen.
  const [stopping, setStopping] = useState(false)
  const [videoMsg, setVideoMsg] = useState('')
  const [videoOutputPaths, setVideoOutputPaths] = useState<string[]>([])
  const [videoCompletedInfo, setVideoCompletedInfo] = useState<{
    outputPath: string
    files: string[]
    totalSize: number
    clipCount: number
    failedCount?: number
    duration: number | null
  } | null>(null)
  // Warnings and errors that came in while the console was closed (the badge).
  const [consoleUnread, setConsoleUnread] = useState(0)
  const [consoleHasError, setConsoleHasError] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const consoleOpenRef = useRef(false)
  consoleOpenRef.current = consoleOpen
  const [geckoModalOpen, setGeckoModalOpen] = useState(false)
  const [videoToolsOpen, setVideoToolsOpen] = useState(false)
  const [consoleHeight, setConsoleHeightState] = useState(() =>
    readConsolePref('height', 200, (v) =>
      Math.min(500, Math.max(80, Number(v)) || 200),
    ),
  )
  const setConsoleHeight = (h: number) => {
    setConsoleHeightState(h)
    writeConsolePref('height', String(h))
  }
  const [consoleLevel, setConsoleLevelState] = useState<ConsoleLevelFilter>(
    () =>
      readConsolePref<ConsoleLevelFilter>('level', 'all', (v) =>
        v === 'problems' || v === 'errors' ? v : 'all',
      ),
  )
  const setConsoleLevel = (l: ConsoleLevelFilter) => {
    setConsoleLevelState(l)
    writeConsolePref('level', l)
  }
  const [consoleDropped, setConsoleDropped] = useState(0)
  const [consoleLogEntries, setConsoleLogEntries] = useState<ConsoleLogEntry[]>(
    [],
  )
  const [consoleSnapshot, setConsoleSnapshot] =
    useState<ConsoleSnapshot | null>(null)

  // A recording that stopped on its own ("Stopped: disk full on …") or failed
  // ("Error: …"), and preview / Test Dolphin errors: kept in the bottom bar
  // until dismissed, since videoMsg itself only shows while recording.
  const [videoNotice, setVideoNotice] = useState('')
  const dolphinsWarning = performanceWarning(
    'numCPUs',
    config.numCPUs,
    config.hardwareProfile?.threads,
    config.hardwareProfile,
  )

  // Listen for video job completion. The footer shows the result for a moment, then goes back
  // to Play / Record; a new job started inside that moment must not be cut short by the timer.
  const videoMsgRef = useRef('')
  videoMsgRef.current = videoMsg
  const finishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearFinishTimer = () => {
    if (finishTimerRef.current) clearTimeout(finishTimerRef.current)
    finishTimerRef.current = null
  }
  useEffect(() => clearFinishTimer, [])
  useIpcListener('videoJobFinished', () => {
    const prev = videoMsgRef.current
    const wasCancelled =
      prev === 'Stopped.' || prev === 'Cancelled.' || isVideoNotice(prev)
    if (!wasCancelled) {
      videoMsgRef.current = 'Done :)'
      setVideoMsg('Done :)')
    }
    clearFinishTimer()
    finishTimerRef.current = setTimeout(
      () => {
        finishTimerRef.current = null
        setIsGenerating(false)
        setVideoMsg('')
      },
      wasCancelled ? 1000 : 2000,
    )
  })

  useIpcListener('videoMsg', (msg: string) => {
    videoMsgRef.current = msg
    setVideoMsg(msg)
    if (isVideoNotice(msg)) setVideoNotice(msg)
  })

  // Clear the "Stopping…" state whenever a job isn't running (it ended, or a
  // fresh one started).
  useEffect(() => {
    if (!isGenerating) setStopping(false)
  }, [isGenerating])

  useIpcListener('videoOutputPath', (p: string) => {
    if (p) {
      setVideoOutputPaths((prev) => (prev.includes(p) ? prev : [...prev, p]))
    }
  })

  useIpcListener('playbackStarted', () => setIsPlaying(true))
  useIpcListener('playbackDone', () => setIsPlaying(false))

  useIpcListener(
    'videoCompleted',
    (info: {
      outputPath: string
      files: string[]
      totalSize: number
      clipCount: number
      failedCount?: number
      duration: number | null
    }) => {
      setVideoCompletedInfo(info)
    },
  )

  // Track console log entries, count, error state, and snapshot
  useIpcListener('consoleLog', (entries: ConsoleLogEntry[]) => {
    if (Array.isArray(entries)) {
      const problems = entries.filter((e) => e.level !== 'info').length
      if (problems > 0 && !consoleOpenRef.current)
        setConsoleUnread((prev) => prev + problems)
      setConsoleLogEntries((prev) => {
        const next = [...prev, ...entries]
        if (next.length <= CONSOLE_MAX_LINES) return next
        const cut = next.length - CONSOLE_KEEP_LINES
        setConsoleDropped((d) => d + cut)
        return next.slice(cut)
      })
      if (entries.some((e) => e.level === 'error')) {
        setConsoleHasError(true)
        setConsoleOpen(true)
      }
    }
  })

  useIpcListener('consoleSnapshot', (data: ConsoleSnapshot) => {
    setConsoleSnapshot(data)
  })

  // Determine if showing games or clips
  const activeFilterType = archive?.filters?.find(
    (f) => f.id === activeFilterId,
  )?.type
  const isShowingGames =
    activeFilterType === 'files' || activeFilterId === 'files'
  useEffect(() => {
    const hasFiles = (event: DragEvent) => {
      const transfer = event.dataTransfer
      if (!transfer) return false
      if (transfer.types && Array.from(transfer.types).includes('Files')) {
        return true
      }
      if (transfer.items && transfer.items.length > 0) {
        return Array.from(transfer.items).some((item) => item.kind === 'file')
      }
      if (transfer.files && transfer.files.length > 0) {
        return true
      }
      return false
    }

    const showOverlay = () => {
      setDragover(true)
    }

    const hideOverlay = () => {
      dragDepthRef.current = 0
      setDragover(false)
    }

    const handleDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragDepthRef.current += 1
      showOverlay()
    }

    const handleDragLeave = (event: DragEvent) => {
      if (dragDepthRef.current === 0) return
      event.preventDefault()
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0) {
        setDragover(false)
      }
    }

    const handleDragOver = (event: DragEvent) => {
      event.preventDefault()
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy'
      }
      if (hasFiles(event)) {
        showOverlay()
      }
    }

    const handleDrop = (event: DragEvent) => {
      event.preventDefault()
      event.stopPropagation()
      hideOverlay()

      const getPath = (window as any).electronWebUtils?.getPathForFile
      const paths: string[] = []
      const { dataTransfer } = event
      const items = dataTransfer?.items
      if (items && items.length > 0) {
        for (let i = 0; i < items.length; i += 1) {
          if (items[i]?.kind !== 'file') continue
          const file = items[i]?.getAsFile?.()
          if (!file) continue
          const p = getPath ? getPath(file) : file.path
          if (p) paths.push(p)
        }
      }
      if (paths.length === 0) {
        const fileList = dataTransfer?.files
        if (fileList && fileList.length > 0) {
          for (let i = 0; i < fileList.length; i += 1) {
            const file = fileList.item(i)
            if (!file) continue
            const p = getPath ? getPath(file) : (file as any).path
            if (p) paths.push(p)
          }
        }
      }
      if (paths.length === 0) {
        showNotice(NO_PATHS_NOTICE)
        return
      }

      // Single file drop: check extension + name, then validate if suspicious
      if (paths.length === 1) {
        const p = paths[0]
        const name = p.split(/[/\\]/).pop()?.toLowerCase() || ''
        const ext = name.slice(name.lastIndexOf('.'))
        const execExts = new Set(['.exe', '.appimage', '.app'])
        const maybeIso = ext === '.iso' || ext === '.gcm'
        const maybeDolphin =
          execExts.has(ext) &&
          (name.includes('dolphin') || name.includes('slippi'))

        if (maybeDolphin) {
          ipcBridge.validateDolphinPath(p, (result) => {
            if (result.valid) {
              setConfig((prev) => (prev ? { ...prev, dolphinPath: p } : prev))
              ipcBridge.updateConfig({ key: 'dolphinPath', value: p })
            }
          })
          return
        }

        if (maybeIso) {
          ipcBridge.validateIsoPath(p, (result) => {
            if (result.valid) {
              setConfig((prev) => (prev ? { ...prev, ssbmIsoPath: p } : prev))
              ipcBridge.updateConfig({ key: 'ssbmIsoPath', value: p })
            }
          })
          return
        }
      }

      ipcBridge.importDroppedSlpFiles(paths, (newArchive) => {
        if (!newArchive || newArchive?.error) {
          console.error('Error importing dropped files: ', newArchive?.error)
          const failed = openFailureNotice('import', newArchive)
          if (failed) showNotice(failed)
          return
        }
        setArchive(newArchive)
      })
    }

    document.addEventListener('dragenter', handleDragEnter)
    document.addEventListener('dragleave', handleDragLeave)
    document.addEventListener('dragover', handleDragOver)
    document.addEventListener('drop', handleDrop)

    return () => {
      document.removeEventListener('dragenter', handleDragEnter)
      document.removeEventListener('dragleave', handleDragLeave)
      document.removeEventListener('dragover', handleDragOver)
      document.removeEventListener('drop', handleDrop)
    }
  }, [setArchive])

  // Lunar Database clips were added: show them (controller.addLunarClips).
  useEffect(
    () =>
      window.electron.ipcRenderer.on('selectFilter', (filterId: string) => {
        if (typeof filterId === 'string') setActiveFilterId(filterId)
      }),
    [],
  )

  useEffect(() => {
    if (!archive) {
      if (activeFilterId !== 'files') {
        setActiveFilterId('files')
      }
      return
    }
    const lastFilter = archive.filters[archive.filters.length - 1]
    const fallbackId = lastFilter?.id ?? 'files'
    if (activeFilterId === 'files') {
      // On first load, focus the Game Filter (import stage) for an empty
      // project so new users start by importing. Only jump to the end of the
      // chain (to show results) once the project actually has imported files.
      const hasFiles = typeof archive.files === 'number' && archive.files > 0
      const gameFilter = archive.filters.find((f) => f.type === 'files')
      const targetId = hasFiles ? fallbackId : (gameFilter?.id ?? 'files')
      if (targetId !== 'files') {
        setActiveFilterId(targetId)
      }
      return
    }
    const exists = archive.filters.some(
      (filter) => filter.id === activeFilterId,
    )
    if (!exists && activeFilterId !== fallbackId) {
      setActiveFilterId(fallbackId)
    }
  }, [archive, activeFilterId])

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      setMousePosition({
        x: event.clientX,
        y: event.clientY,
      })
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('dragover', handleMouseMove)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('dragover', handleMouseMove)
    }
  }, [])

  const startResizing = (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
    e.preventDefault()
    const onResize = (ev: MouseEvent) => {
      ev.preventDefault()
      const newLW = ev.clientX
      const maxLW = Math.max(
        minLeftWidth,
        window.innerWidth - minRightWidth - dividerWidth,
      )
      if (newLW > minLeftWidth && newLW < maxLW) {
        setLeftWidth(newLW)
      }
    }
    const onStop = () => {
      document.removeEventListener('mousemove', onResize)
      document.removeEventListener('mouseup', onStop)
    }
    document.addEventListener('mousemove', onResize)
    document.addEventListener('mouseup', onStop)
  }

  useEffect(() => {
    const clampWidths = () => {
      const maxLeftWidth = Math.max(
        minLeftWidth,
        window.innerWidth - minRightWidth - dividerWidth,
      )
      setLeftWidth((prev) =>
        Math.min(Math.max(prev, minLeftWidth), maxLeftWidth),
      )
    }
    window.addEventListener('resize', clampWidths)
    clampWidths()
    return () => window.removeEventListener('resize', clampWidths)
  }, [])

  function handleConfigChange(key: string, value: string | number | boolean) {
    setConfig({ ...config, [key]: value })
    ipcBridge.updateConfig({ key, value })
  }

  const resolutionOptions = videoConfig.find((c: any) => c.id === 'resolution')
    ?.options as { value: number; label: string }[] | undefined

  const playbackResOptions = videoConfig.find(
    (c: any) => c.id === 'playbackResolution',
  )?.options as { value: number; label: string }[] | undefined

  // Owner actions take a short id list (empty: the first clips in order), so
  // they get the chosen ids only, capped; Select All stays a flag.
  function playClips() {
    if (!config.dolphinPath || !config.ssbmIsoPath) {
      triggerSetupWizard('play')
      return
    }
    // Main resolves the selection (Select All is never sent as ids).
    ipcBridge.playClips({
      filterId: activeFilterId,
      selection: selection.toWire(),
    })
  }

  function stopPlayback() {
    ipcBridge.stopPlayback()
  }

  function generateVideo() {
    if (!config.dolphinPath || !config.ssbmIsoPath || !config.outputPath) {
      triggerSetupWizard('record')
      return
    }
    clearFinishTimer()
    setConsoleUnread(0)
    setConsoleHasError(false)
    setVideoMsg('')
    setIsGenerating(true)
    ipcBridge.generateVideo({
      filterId: activeFilterId,
      selection: selection.toWire(),
    })
  }

  const playClipsRef = useRef(playClips)
  playClipsRef.current = playClips
  const generateVideoRef = useRef(generateVideo)
  generateVideoRef.current = generateVideo

  useEffect(() => {
    if (!pendingAction) return
    clearPendingAction()
    if (pendingAction === 'play') playClipsRef.current()
    else if (pendingAction === 'record') generateVideoRef.current()
  }, [pendingAction, clearPendingAction])

  function handleClipPlay(payload: {
    path: string
    startFrame?: number
    endFrame?: number
    lastFrame?: number
  }) {
    const blocked = clipActionBlock({ isGenerating, isPlaying }, 'play')
    if (blocked) {
      showNotice(blocked)
      return
    }
    if (!config.dolphinPath || !config.ssbmIsoPath) {
      triggerSetupWizard('play')
      return
    }
    // The card's own Play can be reached while a recording runs (main refuses it
    // too): don't start a second Dolphin (launch review CR-2).
    if (isGenerating) return
    ipcBridge.playClip(payload)
  }

  function handleClipRecord(clipId: string) {
    const blocked = clipActionBlock({ isGenerating, isPlaying }, 'record')
    if (blocked) {
      showNotice(blocked)
      return
    }
    if (!config.dolphinPath || !config.ssbmIsoPath || !config.outputPath) {
      triggerSetupWizard('record')
      return
    }
    // Already recording: a second job would orphan the first.
    if (isGenerating) return
    clearFinishTimer()
    setConsoleUnread(0)
    setConsoleHasError(false)
    setVideoMsg('')
    setIsGenerating(true)
    ipcBridge.generateVideo({
      filterId: activeFilterId,
      selectedIds: [clipId],
    })
  }

  function stopVideo() {
    // Reflect immediately that the request landed — the graceful stop only
    // takes effect after the current clip finishes, which can be many seconds,
    // and without feedback the button reads as frozen.
    setStopping(true)
    ipcBridge.stopVideo()
  }

  function cancelVideo() {
    ipcBridge.cancelVideo()
  }

  if (!archive) {
    return (
      <div className="main">
        {dragover ? (
          <div
            className="drop-overlay drop-overlay--drop"
            style={{
              backgroundImage: `radial-gradient(at ${mousePosition.x}px ${mousePosition.y}px, rgba(255, 255, 255, 0.15), rgba(10, 10, 10, 0.9) 55%)`,
            }}
          >
            <div className="drop-overlay-card">
              <div className="drop-overlay-ring" />
              <div className="drop-overlay-title">Drop to import</div>
              <div className="drop-overlay-subtitle">Release to start</div>
            </div>
          </div>
        ) : null}
        <EmptyState
          setArchive={setArchive}
          config={config}
          setConfig={setConfig}
          onRunSetupWizard={() => triggerSetupWizard('record')}
        />
      </div>
    )
  }

  const generatingProgress =
    videoMsg === 'Done :)' ? (
      'Done :)'
    ) : videoMsg === 'Concatenating clips...' ? (
      <span className="footer-dots-anim">Merging videos</span>
    ) : videoMsg &&
      /^(recording|encoding) \d+\/\d+( · \d+%)?$/.test(videoMsg) ? (
      <>
        <span className="footer-gen-label footer-dots-anim">
          {videoMsg.startsWith('recording') ? 'Recording' : 'Encoding'}
        </span>
        <span className="footer-gen-progress">
          {videoMsg.replace(/^\w+ /, '').replace(/ · .*/, '')}{' '}
          {isShowingGames ? 'games' : 'clips'}
          {/ · \d+%$/.test(videoMsg) && ` · ${videoMsg.replace(/.* · /, '')}`}
        </span>
      </>
    ) : videoMsg === 'Configuring Dolphin...' ? (
      <span className="footer-dots-anim">Configuring Dolphin</span>
    ) : (
      videoMsg || <span className="footer-dots-anim">Starting</span>
    )

  return (
    <div className="main">
      {dragover ? (
        <div
          className="drop-overlay drop-overlay--drop"
          style={{
            backgroundImage: `radial-gradient(at ${mousePosition.x}px ${mousePosition.y}px, rgba(255, 255, 255, 0.15), rgba(10, 10, 10, 0.9) 55%)`,
          }}
        >
          <div className="drop-overlay-card">
            <div className="drop-overlay-ring" />
            <div className="drop-overlay-title">Drop to import</div>
            <div className="drop-overlay-subtitle">Release to start</div>
          </div>
        </div>
      ) : null}
      {geckoModalOpen && (
        <GeckoModal
          config={config}
          setConfig={setConfig}
          onClose={() => setGeckoModalOpen(false)}
        />
      )}
      {videoToolsOpen && (
        <VideoToolsModal
          config={config}
          onClose={() => setVideoToolsOpen(false)}
        />
      )}
      <Top
        config={config}
        setConfig={setConfig}
        onRunSetupWizard={() => triggerSetupWizard('record')}
        actions={
          <ActionBar
            selectedCount={selection.count}
            selectionLabel={isShowingGames ? 'game' : 'clip'}
            selectionLength={
              selectionDuration !== null && selectionDuration > 0
                ? formatFramesDuration(selectionDuration)
                : null
            }
            isGenerating={isGenerating}
            isPlaying={isPlaying}
            stopping={stopping}
            progress={generatingProgress}
            showSpinner={videoMsg !== 'Done :)'}
            onPlay={playClips} // eslint-disable-line react/jsx-no-bind
            onRecord={generateVideo} // eslint-disable-line react/jsx-no-bind
            onStopPlayback={stopPlayback} // eslint-disable-line react/jsx-no-bind
            onStopRecording={stopVideo} // eslint-disable-line react/jsx-no-bind
            onCancelRecording={cancelVideo} // eslint-disable-line react/jsx-no-bind
            onVideoTools={() => setVideoToolsOpen(true)} // eslint-disable-line react/jsx-no-bind
            onOpenOutput={() => {
              // No output folder chosen yet: Settings > Paths is where to pick one.
              if (config.outputPath)
                ipcBridge.openFolder(config.outputPath, { create: true })
              else openSettings('paths')
            }}
            options={
              <RecordingOptions
                config={config}
                onChange={handleConfigChange} // eslint-disable-line react/jsx-no-bind
                playbackResOptions={playbackResOptions}
                resolutionOptions={resolutionOptions}
                dolphinsWarning={dolphinsWarning}
                onOpenGecko={() => setGeckoModalOpen(true)}
              />
            }
            extras={
              <OwnerResultsActions
                filterId={activeFilterId}
                filterLabel={
                  activeFilterId === 'files'
                    ? 'All games'
                    : archive?.filters?.find((f) => f.id === activeFilterId)
                        ?.label || 'Results'
                }
                filters={archive?.filters ?? []}
                selectedCount={selection.count}
                getSelection={() => selection.toWire()}
                total={
                  activeFilterId === 'files'
                    ? (archive?.files ?? null)
                    : (archive?.filters?.find((f) => f.id === activeFilterId)
                        ?.results ?? null)
                }
              />
            }
          />
        }
        trailing={
          <Tooltip text="Toggle console">
            <button
              type="button"
              className={`tb tb--icon${consoleOpen ? ' is-on' : ''}`}
              onClick={() => {
                setConsoleOpen((v) => !v)
                setConsoleUnread(0)
                setConsoleHasError(false)
              }}
              aria-label="Toggle console"
              aria-pressed={consoleOpen}
            >
              <FiTerminal />
              {consoleHasError ? (
                <span className="footer-console-error">
                  <FiAlertTriangle />
                </span>
              ) : (
                consoleUnread > 0 && (
                  <span className="footer-console-badge">{consoleUnread}</span>
                )
              )}
            </button>
          </Tooltip>
        }
      />
      <div className="mid">
        <MissingReplaysBar archivePath={archive?.path} />
        <div className="sidebar" style={{ width: `${leftWidth}px` }}>
          <Filters
            archive={archive}
            setArchive={setArchive}
            activeFilterId={activeFilterId}
            setActiveFilterId={setActiveFilterId}
            config={config}
            setConfig={setConfig}
          />
        </div>
        <div className="divider" onMouseDown={startResizing} />
        <Tray
          archive={archive}
          activeFilterId={activeFilterId}
          selection={selection}
          setSelection={setSelection}
          lastSelectedIndex={lastSelectedIndex}
          setLastSelectedIndex={setLastSelectedIndex}
          setSelectionDuration={setSelectionDuration}
          addStartFrames={config.addStartFrames || 0}
          addEndFrames={config.addEndFrames || 0}
          // No per-clip Play / Record while a recording or a preview runs (clipActionBlock).
          onClipPlay={isGenerating || isPlaying ? undefined : handleClipPlay} // eslint-disable-line react/jsx-no-bind
          onClipRecord={
            isGenerating || isPlaying ? undefined : handleClipRecord // eslint-disable-line react/jsx-no-bind
          }
          confirmDeleteReplays={config.confirmDeleteReplays !== false}
          onStopConfirmingDeletes={() =>
            handleConfigChange('confirmDeleteReplays', false)
          }
          footer={
            <>
              <CpuScanBar archivePath={archive?.path} />
              <GameLengthBar archivePath={archive?.path} />
            </>
          }
        />
      </div>
      {(videoNotice ||
        (consoleHasError && !videoNotice && !consoleOpen) ||
        videoOutputPaths.length > 0) && (
        <div className="status-dock">
          {videoNotice && (
            <div className="footer-error" title={videoNotice}>
              <FiAlertTriangle />{' '}
              <span className="footer-notice-text">{videoNotice}</span>
              <button
                type="button"
                className="footer-error-dismiss"
                aria-label="Dismiss"
                onClick={() => setVideoNotice('')}
              >
                &times;
              </button>
            </div>
          )}
          {consoleHasError && !videoNotice && !consoleOpen && (
            <div className="footer-error" title="Check console for details">
              <FiAlertTriangle /> Error — check console
              <button
                type="button"
                className="footer-error-dismiss"
                aria-label="Dismiss"
                onClick={() => setConsoleHasError(false)}
              >
                &times;
              </button>
            </div>
          )}
          {videoOutputPaths.length > 0 && (
            <div className="footer-output-bar">
              {videoOutputPaths.map((p) => (
                <div key={p} className="footer-output-tab">
                  <button
                    type="button"
                    className="footer-output"
                    onClick={() =>
                      window.electron.ipcRenderer.sendMessage('openFolder', p)
                    }
                    title={p}
                    aria-label={`Open folder ${p}`}
                  >
                    <span className="footer-output-text">{p}</span>
                    <FaFolder className="footer-output-folder" />
                  </button>
                  <button
                    type="button"
                    className="footer-output-dismiss"
                    aria-label="Dismiss"
                    onClick={(e) => {
                      e.stopPropagation()
                      setVideoOutputPaths((prev) => prev.filter((x) => x !== p))
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {consoleOpen && (
        <AppConsole
          consoleHeight={consoleHeight}
          setConsoleHeight={setConsoleHeight}
          onClose={() => setConsoleOpen(false)}
          logEntries={consoleLogEntries}
          droppedCount={consoleDropped}
          onClearLogs={() => {
            setConsoleLogEntries([])
            setConsoleDropped(0)
            setConsoleUnread(0)
            setConsoleHasError(false)
          }}
          snapshot={consoleSnapshot}
          level={consoleLevel}
          setLevel={setConsoleLevel}
        />
      )}
      {videoCompletedInfo && (
        <Modal
          overlayClassName="video-done-overlay"
          className="video-done-modal"
          onClose={() => setVideoCompletedInfo(null)}
          label="Recording complete"
        >
          <div className="video-done-header">
            <div className="video-done-title">Recording Complete</div>
            <button
              type="button"
              className="video-done-close"
              onClick={() => setVideoCompletedInfo(null)}
            >
              &#10005;
            </button>
          </div>
          <div className="video-done-details">
            <div className="video-done-row">
              <span className="video-done-label">Clips</span>
              <span>{videoCompletedInfo.clipCount}</span>
            </div>
            {!!videoCompletedInfo.failedCount &&
              videoCompletedInfo.failedCount > 0 && (
                <div className="video-done-row">
                  <span className="video-done-label">Failed</span>
                  <span style={{ color: '#e06c6c' }}>
                    {videoCompletedInfo.failedCount} (see failures.json)
                  </span>
                </div>
              )}
            {videoCompletedInfo.duration != null && (
              <div className="video-done-row">
                <span className="video-done-label">Length</span>
                <span>{formatVideoDuration(videoCompletedInfo.duration)}</span>
              </div>
            )}
            <div className="video-done-row">
              <span className="video-done-label">Size</span>
              <span>{formatFileSize(videoCompletedInfo.totalSize)}</span>
            </div>
            <div className="video-done-row">
              <span className="video-done-label">Location</span>
              <span
                className="video-done-path"
                title={videoCompletedInfo.outputPath}
              >
                {videoCompletedInfo.outputPath}
              </span>
            </div>
          </div>
          <div className="video-done-actions">
            <button
              type="button"
              className="video-done-btn video-done-btn--play"
              onClick={() => {
                const info = videoCompletedInfo
                if (info.files.length > 0) {
                  const lastFile =
                    info.files.find((f) => f.startsWith('final')) ||
                    info.files[info.files.length - 1]
                  window.electron.ipcRenderer.sendMessage(
                    'openFolder',
                    `${info.outputPath}/${lastFile}`,
                  )
                }
              }}
            >
              <FaPlay className="footer-icon footer-icon--play" /> Play
            </button>
            <button
              type="button"
              className="video-done-btn video-done-btn--folder"
              onClick={() => {
                window.electron.ipcRenderer.sendMessage(
                  'openFolder',
                  videoCompletedInfo.outputPath,
                )
              }}
            >
              <FaFolder className="footer-icon" /> Show Folder
            </button>
          </div>
          <label className="video-done-auto-open">
            <input
              type="checkbox"
              checked={!!config.autoOpenOutputFolder}
              onChange={(e) =>
                handleConfigChange('autoOpenOutputFolder', e.target.checked)
              }
            />
            <span>Auto-open folder when recording finishes</span>
          </label>
        </Modal>
      )}
    </div>
  )
}
