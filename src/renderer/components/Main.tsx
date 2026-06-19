import { useState, Dispatch, SetStateAction, useEffect, useRef } from 'react'
import { FaFolder, FaPlay, FaCircle } from 'react-icons/fa'
import { FiTerminal, FiAlertTriangle } from 'react-icons/fi'

import ipcBridge from 'renderer/ipcBridge'
import { videoConfig } from 'constants/config'
import Tooltip from './Tooltip'
import AppConsole from './AppConsole'
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
import { GettingStarted } from './GettingStarted'
import { Tray } from './Tray/Tray'
import useSelection from '../hooks/useSelection'
import useIpcListener from '../hooks/useIpcListener'
import logo from '../../images/logo.png'
import '../styles/Main.css'

// Format duration in frames to Xd Xh Xm Xs format
const formatDuration = (frames: number): string => {
  const totalSeconds = Math.round(frames / 60)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`)

  return parts.join(' ')
}

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

function EmptyState({
  setArchive,
  config,
  setConfig,
  triggerSetupWizard,
}: {
  setArchive: Dispatch<SetStateAction<ShallowArchiveInterface | null>>
  config: ConfigInterface
  setConfig: Dispatch<SetStateAction<ConfigInterface | null>>
  triggerSetupWizard: (_mode: 'play' | 'record') => void
}) {
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([])
  const showGettingStarted = config.showGettingStarted !== false

  const setShowGettingStarted = (value: boolean) => {
    setConfig((prev) => (prev ? { ...prev, showGettingStarted: value } : prev))
    ipcBridge.updateConfig({ key: 'showGettingStarted', value })
  }

  useEffect(() => {
    ipcBridge.getRecentProjects((projects) => {
      if (Array.isArray(projects)) setRecentProjects(projects)
    })
  }, [])

  const handleNewProject = () => {
    ipcBridge.newProject((newArchive) => {
      if (!newArchive || newArchive.error) return
      setArchive(newArchive)
    })
  }

  const handleOpenProject = () => {
    ipcBridge.openExistingArchive((newArchive) => {
      if (!newArchive || newArchive.error) return
      setArchive(newArchive)
    })
  }

  const handleOpenRecent = (projectPath: string) => {
    ipcBridge.openRecentProject(projectPath, (result) => {
      if (!result || result.error) {
        // Remove stale entry from list
        setRecentProjects((prev) => prev.filter((p) => p.path !== projectPath))
        return
      }
      setArchive(result)
    })
  }

  const truncatePath = (p: string, maxLen = 60) => {
    if (p.length <= maxLen) return p
    return `...${p.slice(p.length - maxLen + 3)}`
  }

  return (
    <div className="empty-state">
      <div
        className={`empty-state-inner${showGettingStarted ? ' empty-state-inner--wide' : ''}`}
      >
        <div className="empty-state-brand">
          <img className="empty-state-logo" src={logo} alt="Lunar Clipper" />
          <span className="empty-state-title">Lunar Clipper</span>
        </div>
        <div className="empty-state-columns">
          <div className="empty-state-col empty-state-col--start">
            <div className="empty-state-section-title">Start</div>
            <div className="empty-state-actions">
              <button
                type="button"
                className="empty-state-btn"
                onClick={handleNewProject}
              >
                New Project
              </button>
              <button
                type="button"
                className="empty-state-btn empty-state-btn--secondary"
                onClick={handleOpenProject}
              >
                Open Project
              </button>
            </div>
            {recentProjects.length > 0 && (
              <div className="empty-state-recent">
                <div className="empty-state-recent-title">Recent Projects</div>
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
          {showGettingStarted && (
            <div className="empty-state-col empty-state-col--gs">
              <GettingStarted
                config={config}
                triggerSetupWizard={triggerSetupWizard}
              />
              <label className="empty-state-gs-toggle">
                <input
                  type="checkbox"
                  checked={showGettingStarted}
                  onChange={(e) => setShowGettingStarted(e.target.checked)}
                />
                Show getting started
              </label>
            </div>
          )}
        </div>
      </div>
    </div>
  )
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

// Number input that allows clearing/intermediate edits while typing and only
// coerces to a valid (>= min) integer on blur/Enter. A plain controlled
// `parseInt(value) || min` input snaps back to min the instant the field is
// emptied, which makes it impossible to backspace and retype.
function FooterNumberInput({
  value,
  min,
  onCommit,
}: {
  value: number
  min: number
  onCommit: (_n: number) => void
}) {
  const [local, setLocal] = useState(String(value))
  useEffect(() => {
    setLocal(String(value))
  }, [value])
  const commit = () => {
    const n = parseInt(local, 10)
    const next = Number.isNaN(n) ? min : Math.max(min, n)
    if (next !== value) onCommit(next)
    setLocal(String(next))
  }
  return (
    <input
      type="number"
      className="footer-input"
      value={local}
      min={min}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
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
    selectedIds,
    setSelectedIds,
    lastSelectedIndex,
    setLastSelectedIndex,
    selectionDuration,
    setSelectionDuration,
  } = useSelection(activeFilterId)

  // Playback state
  const [isPlaying, setIsPlaying] = useState(false)

  // Video generation state
  const [isGenerating, setIsGenerating] = useState(false)
  const [videoMsg, setVideoMsg] = useState('')
  const [videoOutputPaths, setVideoOutputPaths] = useState<string[]>([])
  const [videoCompletedInfo, setVideoCompletedInfo] = useState<{
    outputPath: string
    files: string[]
    totalSize: number
    clipCount: number
    duration: number | null
  } | null>(null)
  const [consoleLogCount, setConsoleLogCount] = useState(0)
  const [consoleHasError, setConsoleHasError] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [geckoModalOpen, setGeckoModalOpen] = useState(false)
  const [consoleHeight, setConsoleHeight] = useState(200)
  const [consoleLogEntries, setConsoleLogEntries] = useState<ConsoleLogEntry[]>(
    [],
  )
  const [consoleSnapshot, setConsoleSnapshot] =
    useState<ConsoleSnapshot | null>(null)

  // Listen for video job completion
  useIpcListener('videoJobFinished', () => {
    setVideoMsg((prev) => {
      const wasCancelled = prev === 'Stopped.' || prev === 'Cancelled.'
      if (wasCancelled) {
        setTimeout(() => {
          setIsGenerating(false)
          setVideoMsg('')
        }, 1000)
      } else {
        setTimeout(() => {
          setIsGenerating(false)
          setVideoMsg('')
        }, 2000)
      }
      return wasCancelled ? prev : 'Done :)'
    })
  })

  useIpcListener('videoMsg', (msg: string) => {
    setVideoMsg(msg)
  })

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
      duration: number | null
    }) => {
      setVideoCompletedInfo(info)
    },
  )

  // Close video completed modal on Escape
  useEffect(() => {
    if (!videoCompletedInfo) return undefined
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setVideoCompletedInfo(null)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [videoCompletedInfo])

  // Track console log entries, count, error state, and snapshot
  useIpcListener('consoleLog', (entries: ConsoleLogEntry[]) => {
    if (Array.isArray(entries)) {
      setConsoleLogCount((prev) => prev + entries.length)
      setConsoleLogEntries((prev) => {
        const next = [...prev, ...entries]
        return next.length > 2000 ? next.slice(-1500) : next
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
      if (paths.length === 0) return

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

  function playClips() {
    if (!config.dolphinPath || !config.ssbmIsoPath) {
      triggerSetupWizard('play')
      return
    }
    ipcBridge.playClips({
      filterId: activeFilterId,
      selectedIds: Array.from(selectedIds),
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
    setConsoleLogCount(0)
    setConsoleHasError(false)
    setIsGenerating(true)
    ipcBridge.generateVideo({
      filterId: activeFilterId,
      selectedIds: Array.from(selectedIds),
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
    if (!config.dolphinPath || !config.ssbmIsoPath) {
      triggerSetupWizard('play')
      return
    }
    ipcBridge.playClip(payload)
  }

  function handleClipRecord(clipId: string) {
    if (!config.dolphinPath || !config.ssbmIsoPath || !config.outputPath) {
      triggerSetupWizard('record')
      return
    }
    setConsoleLogCount(0)
    setConsoleHasError(false)
    setIsGenerating(true)
    ipcBridge.generateVideo({
      filterId: activeFilterId,
      selectedIds: [clipId],
    })
  }

  function handleImportClick() {
    ipcBridge.importSlpFiles((newArchive) => {
      if (!newArchive || newArchive.error) return
      setArchive(newArchive)
    })
  }

  function handleImportFolder(dir: string) {
    ipcBridge.importDroppedSlpFiles([dir], (newArchive) => {
      if (!newArchive || newArchive.error) return
      setArchive(newArchive)
    })
  }

  function handleOpenFolder(dir: string) {
    ipcBridge.openFolder(dir)
  }

  function stopVideo() {
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
          triggerSetupWizard={triggerSetupWizard}
        />
      </div>
    )
  }

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
      <Top
        config={config}
        setConfig={setConfig}
        onRunSetupWizard={() => triggerSetupWizard('record')}
      />
      <div className="mid">
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
          selectedIds={selectedIds}
          setSelectedIds={setSelectedIds}
          lastSelectedIndex={lastSelectedIndex}
          setLastSelectedIndex={setLastSelectedIndex}
          setSelectionDuration={setSelectionDuration}
          addStartFrames={config.addStartFrames || 0}
          addEndFrames={config.addEndFrames || 0}
          onClipPlay={handleClipPlay} // eslint-disable-line react/jsx-no-bind
          onClipRecord={handleClipRecord} // eslint-disable-line react/jsx-no-bind
          onImport={handleImportClick} // eslint-disable-line react/jsx-no-bind
          onImportFolder={handleImportFolder} // eslint-disable-line react/jsx-no-bind
          onOpenFolder={handleOpenFolder} // eslint-disable-line react/jsx-no-bind
        />
      </div>
      <div className="footer">
        <button
          type="button"
          className={`footer-console-btn${consoleOpen ? ' footer-console-btn--active' : ''}`}
          onClick={() => setConsoleOpen((v) => !v)}
          title="Toggle console"
        >
          <FiTerminal />
          {consoleHasError ? (
            <span className="footer-console-error">
              <FiAlertTriangle />
            </span>
          ) : (
            consoleLogCount > 0 && (
              <span className="footer-console-badge">{consoleLogCount}</span>
            )
          )}
        </button>
        <div className="footer-section">
          <label
            className="footer-setting footer-toggle"
            title="Concatenate clips into one video"
          >
            <span className="footer-setting-label">Concat</span>
            <input
              type="checkbox"
              checked={!!config.concatenate}
              onChange={(e) =>
                handleConfigChange('concatenate', e.target.checked)
              }
            />
          </label>
          <label
            className="footer-setting footer-toggle"
            title="Convert AVI output to MP4"
          >
            <span className="footer-setting-label">MP4</span>
            <input
              type="checkbox"
              checked={!!config.convertToMp4}
              onChange={(e) =>
                handleConfigChange('convertToMp4', e.target.checked)
              }
            />
          </label>
          <button
            type="button"
            className="footer-setting-btn"
            onClick={() => setGeckoModalOpen(true)}
            title="Configure Gecko Codes for recording"
          >
            Gecko Codes
          </button>
          <div
            className="footer-setting"
            title="Number of Dolphin instances for recording"
          >
            <span className="footer-setting-label">Dolphins</span>
            <FooterNumberInput
              value={config.numCPUs}
              min={1}
              onCommit={(n) => handleConfigChange('numCPUs', n)}
            />
          </div>
          <div
            className="footer-setting"
            title="Max clips per Dolphin instance"
          >
            <span className="footer-setting-label">Max Clips</span>
            <FooterNumberInput
              value={config.slice}
              min={1}
              onCommit={(n) => handleConfigChange('slice', n)}
            />
          </div>
        </div>
        <div className="footer-section">
          <div className="footer-setting" title="Playback resolution">
            <span className="footer-setting-label">Play</span>
            <select
              className="footer-select"
              value={config.playbackResolution}
              onChange={(e) =>
                handleConfigChange(
                  'playbackResolution',
                  parseInt(e.target.value, 10),
                )
              }
            >
              {playbackResOptions?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="footer-setting" title="Recording resolution">
            <span className="footer-setting-label">Rec</span>
            <select
              className="footer-select"
              value={config.resolution}
              onChange={(e) =>
                handleConfigChange('resolution', parseInt(e.target.value, 10))
              }
            >
              {resolutionOptions?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="footer-right">
          {isGenerating ? (
            <>
              <div className="footer-gen-status">
                {videoMsg !== 'Done :)' && (
                  <span className="footer-gen-spinner" />
                )}
                <span className="footer-gen-msg">
                  {videoMsg === 'Done :)' ? (
                    'Done :)'
                  ) : videoMsg === 'Concatenating clips...' ? (
                    <span className="footer-dots-anim">Merging videos</span>
                  ) : videoMsg &&
                    /^(recording|encoding) \d+\/\d+$/.test(videoMsg) ? (
                    <>
                      <span className="footer-gen-label footer-dots-anim">
                        {videoMsg.startsWith('recording')
                          ? 'Recording'
                          : 'Encoding'}
                      </span>
                      <span className="footer-gen-progress">
                        {videoMsg.replace(/^\w+ /, '')}{' '}
                        {isShowingGames ? 'games' : 'clips'}
                      </span>
                    </>
                  ) : videoMsg === 'Configuring Dolphin...' ? (
                    <span className="footer-dots-anim">
                      Configuring Dolphin
                    </span>
                  ) : (
                    videoMsg || (
                      <span className="footer-dots-anim">Starting</span>
                    )
                  )}
                </span>
              </div>
              <div className="footer-action-group">
                <Tooltip
                  text="Stop after the current clip finishes — keeps all completed clips"
                  offsetX={-80}
                >
                  <button
                    type="button"
                    className="stop-button"
                    onClick={stopVideo}
                  >
                    Stop
                  </button>
                </Tooltip>
                <Tooltip
                  text="Cancel immediately — kills active Dolphin processes and discards in-progress clips"
                  offsetX={-120}
                >
                  <button
                    type="button"
                    className="cancel-button"
                    onClick={cancelVideo}
                  >
                    Cancel
                  </button>
                </Tooltip>
              </div>
            </>
          ) : (
            <>
              <div className="footer-status">
                {selectedIds.size > 0 ? (
                  <div className="footer-selection">
                    <span className="footer-selection-count">
                      {selectedIds.size} {isShowingGames ? 'game' : 'clip'}
                      {selectedIds.size !== 1 ? 's' : ''}
                    </span>
                    {selectionDuration !== null && selectionDuration > 0 && (
                      <span className="footer-selection-duration">
                        {formatDuration(selectionDuration)}
                      </span>
                    )}
                  </div>
                ) : (
                  <span className="footer-no-selection">No clips selected</span>
                )}
              </div>
              {consoleHasError && (
                <div className="footer-error" title="Check console for details">
                  <FiAlertTriangle /> Error — check console
                  <button
                    type="button"
                    className="footer-error-dismiss"
                    onClick={() => setConsoleHasError(false)}
                  >
                    &times;
                  </button>
                </div>
              )}
              <div className="footer-action-group">
                <button
                  type="button"
                  className="footer-action-button"
                  onClick={playClips}
                  disabled={selectedIds.size === 0 || isPlaying}
                >
                  <FaPlay className="footer-icon footer-icon--play" /> Play
                </button>
                {isPlaying ? (
                  <Tooltip text="Stop playback and close Dolphin" offsetX={-60}>
                    <button
                      type="button"
                      className="cancel-button"
                      onClick={stopPlayback}
                    >
                      Stop
                    </button>
                  </Tooltip>
                ) : (
                  <button
                    type="button"
                    className="footer-action-button"
                    onClick={generateVideo}
                    disabled={selectedIds.size === 0}
                  >
                    <FaCircle className="footer-icon footer-icon--record" />{' '}
                    Record
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        {videoOutputPaths.length > 0 && (
          <div className="footer-output-bar">
            {videoOutputPaths.map((p) => (
              <div key={p} className="footer-output-tab">
                <div
                  className="footer-output"
                  onClick={() =>
                    window.electron.ipcRenderer.sendMessage('openFolder', p)
                  }
                  title={p}
                >
                  <span className="footer-output-text">{p}</span>
                  <FaFolder className="footer-output-folder" />
                </div>
                <button
                  type="button"
                  className="footer-output-dismiss"
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
      {consoleOpen && (
        <AppConsole
          consoleHeight={consoleHeight}
          setConsoleHeight={setConsoleHeight}
          onClose={() => setConsoleOpen(false)}
          logEntries={consoleLogEntries}
          onClearLogs={() => {
            setConsoleLogEntries([])
            setConsoleLogCount(0)
            setConsoleHasError(false)
          }}
          snapshot={consoleSnapshot}
        />
      )}
      {videoCompletedInfo && (
        /* eslint-disable jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */
        <div
          className="video-done-overlay"
          onClick={() => setVideoCompletedInfo(null)}
        >
          <div
            className="video-done-modal"
            onClick={(e) => e.stopPropagation()}
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
              {videoCompletedInfo.duration != null && (
                <div className="video-done-row">
                  <span className="video-done-label">Length</span>
                  <span>
                    {formatVideoDuration(videoCompletedInfo.duration)}
                  </span>
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
          </div>
        </div>
        /* eslint-enable jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */
      )}
    </div>
  )
}
