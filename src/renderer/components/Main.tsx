import { useState, Dispatch, SetStateAction, useEffect, useRef, useMemo } from 'react'
import { ConfigInterface, ShallowArchiveInterface, ClipInterface, FileInterface, RecentProject } from '../../constants/types'
import Filters from './Filters'
import Top from './Top'
import { Tray } from './Tray/Tray'
import ipcBridge from 'renderer/ipcBridge'
import '../styles/Main.css'

export type SelectionInfo = {
  selectedIds: Set<string>
  lastSelectedIndex: number | null
  totalDuration: number | null  // null = calculating
  isCalculating: boolean
}

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

function EmptyState({ setArchive }: { setArchive: Dispatch<SetStateAction<ShallowArchiveInterface | null>> }) {
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([])

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
    return '...' + p.slice(p.length - maxLen + 3)
  }

  return (
    <div className="empty-state">
      <div className="empty-state-inner">
        <div className="empty-state-title">LM Clipper</div>
        <div className="empty-state-actions">
          <button type="button" className="empty-state-btn" onClick={handleNewProject}>
            New Project
          </button>
          <button type="button" className="empty-state-btn empty-state-btn--secondary" onClick={handleOpenProject}>
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
                  <span className="empty-state-recent-name">{project.name}</span>
                  <span className="empty-state-recent-path">{truncatePath(project.path)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

type MainProps = {
  archive: ShallowArchiveInterface | null
  setArchive: Dispatch<SetStateAction<ShallowArchiveInterface | null>>
  config: ConfigInterface
  setConfig: Dispatch<SetStateAction<ConfigInterface | null>>
}

export default function Main({
  archive,
  setArchive,
  config,
  setConfig,
}: MainProps) {
  const [leftWidth, setLeftWidth] = useState(580)
  const [activeFilterId, setActiveFilterId] = useState('files')
  const minLeftWidth = 100
  const minRightWidth = 500
  const dividerWidth = 3
  const [dragover, setDragover] = useState(false)
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 })
  const dragDepthRef = useRef(0)

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null)
  const [selectionDuration, setSelectionDuration] = useState<number | null>(null)
  const [isCalculatingDuration, setIsCalculatingDuration] = useState(false)

  // Video generation state
  const [isGenerating, setIsGenerating] = useState(false)

  // Import state - track whether files are being imported
  const [isImporting, setIsImporting] = useState(false)

  useEffect(() => {
    const applyStatus = (status: any) => {
      if (!status || typeof status !== 'object') return
      setIsImporting(!!status.isImporting)
    }

    const removeListener = window.electron.ipcRenderer.on(
      'importStatus',
      (status) => applyStatus(status)
    )

    ipcBridge.getImportStatus((status) => applyStatus(status))

    return () => { removeListener() }
  }, [])

  // Clear selection when filter changes
  useEffect(() => {
    setSelectedIds(new Set())
    setLastSelectedIndex(null)
    setSelectionDuration(null)
  }, [activeFilterId])

  // Listen for video job completion
  useEffect(() => {
    const removeListener = window.electron.ipcRenderer.on(
      'videoJobFinished',
      () => {
        setIsGenerating(false)
      }
    )
    return () => {
      removeListener()
    }
  }, [])

  // Determine if showing games or clips
  const activeFilterType = archive?.filters.find(f => f.id === activeFilterId)?.type
  const isShowingGames = activeFilterType === 'files' || activeFilterId === 'files'

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
      const dataTransfer = event.dataTransfer
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
      ipcBridge.importDroppedSlpFiles(paths, (newArchive) => {
        if (!newArchive || newArchive?.error) {
          console.log('Error importing dropped files: ', newArchive?.error)
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
    const gameFilter =
      archive.filters.find((filter) => filter.type === 'files') ||
      archive.filters[0]
    const fallbackId = gameFilter?.id ?? 'files'
    if (activeFilterId === 'files') {
      if (fallbackId !== 'files') {
        setActiveFilterId(fallbackId)
      }
      return
    }
    const exists = archive.filters.some((filter) => filter.id === activeFilterId)
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
    document.addEventListener('mousemove', resize)
    document.addEventListener('mouseup', stopResizing)
  }

  const resize = (e: MouseEvent) => {
    e.preventDefault()
    const newLeftWidth = e.clientX
    const maxLeftWidth = Math.max(
      minLeftWidth,
      window.innerWidth - minRightWidth - dividerWidth
    )
    if (newLeftWidth > minLeftWidth && newLeftWidth < maxLeftWidth) {
      setLeftWidth(newLeftWidth)
    }
  }

  const stopResizing = () => {
    document.removeEventListener('mousemove', resize)
    document.removeEventListener('mouseup', stopResizing)
  }

  useEffect(() => {
    const clampWidths = () => {
      const maxLeftWidth = Math.max(
        minLeftWidth,
        window.innerWidth - minRightWidth - dividerWidth
      )
      setLeftWidth((prev) => Math.min(Math.max(prev, minLeftWidth), maxLeftWidth))
    }
    window.addEventListener('resize', clampWidths)
    clampWidths()
    return () => window.removeEventListener('resize', clampWidths)
  }, [])

  function generateVideo() {
    setIsGenerating(true)
    ipcBridge.generateVideo({
      filterId: activeFilterId,
      selectedIds: Array.from(selectedIds),
    })
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
        <EmptyState setArchive={setArchive} />
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
      <Top archive={archive} config={config} setConfig={setConfig} />
      <div className="mid">
        <div className="sidebar" style={{ width: `${leftWidth}px` }}>
          <Filters
            archive={archive}
            setArchive={setArchive}
            activeFilterId={activeFilterId}
            setActiveFilterId={setActiveFilterId}
          />
        </div>
        <div className="divider" onMouseDown={startResizing} />
        <Tray
          archive={archive}
          activeFilterId={activeFilterId}
          isImporting={isImporting}
          selectedIds={selectedIds}
          setSelectedIds={setSelectedIds}
          lastSelectedIndex={lastSelectedIndex}
          setLastSelectedIndex={setLastSelectedIndex}
          setSelectionDuration={setSelectionDuration}
          setIsCalculatingDuration={setIsCalculatingDuration}
        />
      </div>
      <div className="footer">
        <div className="footer-right">
          {selectedIds.size > 0 ? (
            <div className="footer-selection">
              <span className="footer-selection-count">
                {selectedIds.size} {isShowingGames ? 'game' : 'clip'}{selectedIds.size !== 1 ? 's' : ''}
              </span>
              {selectionDuration !== null && selectionDuration > 0 && (
                <span className="footer-selection-duration">
                  {isCalculatingDuration ? (
                    <span className="footer-spinner" />
                  ) : (
                    formatDuration(selectionDuration)
                  )}
                </span>
              )}
            </div>
          ) : (
            <span className="footer-no-selection">No clips selected</span>
          )}
          {isGenerating ? (
            <>
              <button
                type="button"
                className="stop-button"
                onClick={stopVideo}
              >
                Stop
              </button>
              <button
                type="button"
                className="cancel-button"
                onClick={cancelVideo}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="generate-button"
              onClick={generateVideo}
              disabled={selectedIds.size === 0}
            >
              Generate Video
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
