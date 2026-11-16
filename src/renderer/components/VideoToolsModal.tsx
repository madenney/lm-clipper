/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import { DragEvent, useCallback, useEffect, useRef, useState } from 'react'
import {
  FaCheckCircle,
  FaChevronDown,
  FaChevronRight,
  FaFilm,
  FaFolder,
  FaFolderOpen,
  FaGripVertical,
} from 'react-icons/fa'
import Modal from './Modal'
import { ConfigInterface, VideoFolder } from '../../constants/types'
import ipcBridge from '../ipcBridge'
import useIpcListener from '../hooks/useIpcListener'
import { formatBytes, formatDurationSec } from '../../lib/format'
import {
  FolderUI,
  QUALITY,
  QualityKey,
  describeAction,
  estimateBytes,
  folderLabel,
  latestFolderPath,
  mergeScan,
  readQuality,
  sortFolders,
  writeQuality,
} from '../lib/videoTools'
import '../styles/VideoTools.css'

type Props = {
  config: ConfigInterface
  onClose: () => void
}

type JobResult = {
  ok: boolean
  output?: string
  dir?: string
  error?: string
  cancelled?: boolean
}

// 1px transparent GIF: a drag image that hides the browser's default ghost, so
// the rows sliding apart are the only preview.
const DRAG_GHOST =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

const basename = (p: string) => p.split(/[\\/]/).pop() || p

/**
 * Video Tools: work on the videos already in the output folder. Tick several to
 * combine them into one (drag clips and folders into the order you want), and
 * pick a quality: Original joins them untouched, the others re-encode to a
 * smaller file for uploading. One video on its own can be compressed too,
 * including a combined one made earlier.
 *
 * Results never overwrite: several videos from one folder make `final` there,
 * from several folders `stitched` in the output folder, one compressed video
 * `<name>-compressed` beside it. The list re-reads the folder while the window
 * is open, so files added or deleted on disk show up by themselves.
 */
export default function VideoToolsModal({ config, onClose }: Props) {
  // null until the first scan answers.
  const [folders, setFolders] = useState<VideoFolder[] | null>(null)
  const [ui, setUi] = useState<Record<string, FolderUI>>({})
  // Folder display/join order (paths). Reorderable by dragging folder rows.
  const [folderOrder, setFolderOrder] = useState<string[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<JobResult | null>(null)
  const [quality, setQualityState] = useState<QualityKey>(readQuality)
  // The selection's running time, from the main process. `seconds` is 0 when
  // the headers could not give it; `bitrateKbps` then derives one from the size.
  const [probeInfo, setProbeInfo] = useState({ seconds: 0, bitrateKbps: 0 })
  const [probing, setProbing] = useState(false)
  // Live drag-reorder within one folder. `drag` = the row being dragged;
  // `over` = the insertion index. The other rows slide via translateY.
  const [drag, setDrag] = useState<{ folder: string; from: number } | null>(
    null,
  )
  const [over, setOver] = useState<number | null>(null)
  const rowHeight = useRef(0)
  // Folder drag-reorder. Live-splices folderOrder as you drag.
  const [folderDrag, setFolderDrag] = useState<string | null>(null)

  // Refs so the poll can read the current state without being rebuilt.
  const busyRef = useRef(busy)
  busyRef.current = busy
  const dragRef = useRef(false)
  dragRef.current = !!drag || !!folderDrag
  const firstScan = useRef(true)

  const applyScan = useCallback((scanned: VideoFolder[]) => {
    const first = firstScan.current
    firstScan.current = false
    setFolders(scanned)
    // Opening: the newest recording's clips are ticked, ready to combine.
    setUi((prev) =>
      mergeScan(prev, scanned, first ? latestFolderPath(scanned) : ''),
    )
    setFolderOrder((prev) => {
      const paths = new Set(scanned.map((f) => f.path))
      const kept = prev.filter((p) => paths.has(p))
      for (const f of sortFolders(scanned))
        if (!kept.includes(f.path)) kept.push(f.path)
      return kept
    })
    // With one folder there is nothing to choose between: show what is in it.
    if (first && scanned.length === 1) setExpanded(new Set([scanned[0].path]))
  }, [])

  const rescan = useCallback(() => {
    ipcBridge.videoToolsList((res) => applyScan(res?.folders ?? []))
  }, [applyScan])

  // Read the output folder on opening and every two seconds after. Skipped
  // mid-drag and mid-job so it cannot pull state out from under either.
  useEffect(() => {
    rescan()
    const id = setInterval(() => {
      if (!busyRef.current && !dragRef.current) rescan()
    }, 2000)
    return () => clearInterval(id)
  }, [rescan])

  // ffmpeg progress (0-100), pushed from the main process.
  useIpcListener('videoToolsProgress', (p: number) => setProgress(p))

  const setQuality = (key: QualityKey) => {
    setQualityState(key)
    writeQuality(key)
    setResult(null)
  }

  const byPath = new Map((folders ?? []).map((f) => [f.path, f]))
  const orderedFolders = folderOrder
    .map((p) => byPath.get(p))
    .filter((f): f is VideoFolder => !!f)
  const latestPath = latestFolderPath(folders ?? [])

  // The whole selection, in display order: folder order, then each folder's own.
  const selection: {
    folder: string
    name: string
    size: number
    finished: boolean
  }[] = []
  for (const f of orderedFolders) {
    const st = ui[f.path]
    if (st)
      for (const c of st.order)
        if (st.checked[c])
          selection.push({
            folder: f.path,
            name: c,
            size: f.sizes?.[c] ?? 0,
            finished: f.finished.includes(c),
          })
  }
  const folderCount = new Set(selection.map((s) => s.folder)).size
  const sourceBytes = selection.reduce((sum, s) => sum + s.size, 0)
  const selKey = selection.map((s) => `${s.folder}|${s.name}`).join('\n')

  // Ask for the selection's running time (debounced): the length shown, and the
  // size each compressed quality would come to.
  const probeKeyRef = useRef('')
  useEffect(() => {
    if (selection.length === 0) {
      setProbeInfo({ seconds: 0, bitrateKbps: 0 })
      setProbing(false)
      probeKeyRef.current = ''
      return undefined
    }
    probeKeyRef.current = selKey
    setProbing(true)
    const items = selection.map((s) => ({ folder: s.folder, name: s.name }))
    const t = setTimeout(() => {
      ipcBridge.videoToolsProbe({ items }, (res) => {
        if (probeKeyRef.current !== selKey) return // the selection moved on
        setProbeInfo({
          seconds: res?.seconds ?? 0,
          bitrateKbps: res?.bitrateKbps ?? 0,
        })
        setProbing(false)
      })
    }, 450)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey])

  const qKbps = QUALITY.find((q) => q.key === quality)?.kbps ?? 0
  const durationSec =
    probeInfo.seconds > 0
      ? probeInfo.seconds
      : probeInfo.bitrateKbps > 0 && sourceBytes > 0
        ? (sourceBytes * 8) / (probeInfo.bitrateKbps * 1000)
        : 0
  const action = describeAction(
    selection.length,
    selection.some((s) => s.finished),
    quality,
  )

  const toggleFolder = (p: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })

  const toggleItem = (folder: string, name: string) => {
    setResult(null)
    setUi((prev) => ({
      ...prev,
      [folder]: {
        ...prev[folder],
        checked: {
          ...prev[folder].checked,
          [name]: !prev[folder].checked[name],
        },
      },
    }))
  }

  // Tick every clip of the given folders (results are left alone: a folder's
  // clips are never combined with their own `final` by accident), or clear all.
  const tickClips = (paths: string[], value: boolean) => {
    setResult(null)
    setUi((prev) => {
      const next = { ...prev }
      for (const p of paths) {
        const f = byPath.get(p)
        if (f && prev[p])
          next[p] = {
            ...prev[p],
            checked: Object.fromEntries(
              prev[p].order.map((c) => [
                c,
                value ? f.clips.includes(c) || prev[p].checked[c] : false,
              ]),
            ),
          }
      }
      return next
    })
  }

  const onItemDragStart = (
    folder: string,
    index: number,
    e: DragEvent<HTMLLIElement>,
  ) => {
    rowHeight.current = e.currentTarget.offsetHeight
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      const img = new Image()
      img.src = DRAG_GHOST
      e.dataTransfer.setDragImage(img, 0, 0)
    }
    setDrag({ folder, from: index })
    setOver(index)
  }

  const onItemDragOver = (
    folder: string,
    index: number,
    e: DragEvent<HTMLLIElement>,
  ) => {
    if (!drag || drag.folder !== folder) return
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const after = e.clientY > rect.top + rect.height / 2
    setOver(index + (after ? 1 : 0))
  }

  const commitDrag = () => {
    if (drag && over !== null) {
      const { folder, from } = drag
      let to = over
      if (to > from) to -= 1 // the row is taken out first
      if (to !== from) {
        setResult(null)
        setUi((prev) => {
          const order = [...prev[folder].order]
          const [moved] = order.splice(from, 1)
          order.splice(to, 0, moved)
          return { ...prev, [folder]: { ...prev[folder], order } }
        })
      }
    }
    setDrag(null)
    setOver(null)
  }

  // translateY for a row that is not being dragged, so the list opens a gap at
  // the drop spot.
  const rowShift = (folder: string, index: number): string => {
    if (!drag || drag.folder !== folder || over === null || index === drag.from)
      return ''
    const h = rowHeight.current
    if (over > drag.from && index > drag.from && index < over)
      return `translateY(${-h}px)`
    if (over < drag.from && index >= over && index < drag.from)
      return `translateY(${h}px)`
    return ''
  }

  const onFolderDragStart = (p: string, e: DragEvent<HTMLSpanElement>) => {
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      const img = new Image()
      img.src = DRAG_GHOST
      e.dataTransfer.setDragImage(img, 0, 0)
    }
    setFolderDrag(p)
  }

  // As the dragged folder passes over another, it moves there.
  const onFolderDragOver = (p: string, e: DragEvent<HTMLDivElement>) => {
    if (!folderDrag || folderDrag === p) return
    e.preventDefault()
    setFolderOrder((prev) => {
      const from = prev.indexOf(folderDrag)
      const to = prev.indexOf(p)
      if (from < 0 || to < 0 || from === to) return prev
      const next = [...prev]
      const [m] = next.splice(from, 1)
      next.splice(to, 0, m)
      return next
    })
  }

  const run = () => {
    if (!action.enabled || busy) return
    setBusy(true)
    setProgress(0)
    setResult(null)
    ipcBridge.videoToolsRun(
      {
        items: selection.map((s) => ({ folder: s.folder, name: s.name })),
        compress: qKbps > 0,
        videoKbps: qKbps > 0 ? qKbps : undefined,
      },
      (res: JobResult) => {
        setBusy(false)
        setResult(res ?? { ok: false, error: 'The video could not be made.' })
        rescan() // the result shows up in the list right away
      },
    )
  }

  const openOutputFolder = () =>
    window.electron.ipcRenderer.sendMessage('openFolder', config.outputPath)

  const sizeAt = (kbps: number): string | null => {
    if (selection.length === 0) return null
    const bytes = estimateBytes(kbps, sourceBytes, durationSec)
    return bytes != null ? `≈ ${formatBytes(bytes)}` : null
  }
  const lengthText =
    selection.length === 0
      ? '—'
      : durationSec > 0
        ? formatDurationSec(durationSec)
        : probing
          ? '…'
          : '—'

  const empty = folders !== null && folders.length === 0

  return (
    <Modal
      overlayClassName="settings-overlay"
      className="settings-modal settings-modal--videotools"
      onClose={busy ? undefined : onClose}
      label="Video Tools"
    >
      <div className="settings-header">
        <div className="vt-heading">
          <h2 className="settings-title">Video Tools</h2>
          <p className="vt-subtitle">
            Combine recorded clips into one video, or compress a video for
            uploading.
          </p>
        </div>
        <div className="vt-header-actions">
          {!empty && (
            <button
              type="button"
              className="vt-open-folder"
              onClick={openOutputFolder}
              title={`Open the output folder\n${config.outputPath}`}
              aria-label="Open output folder"
            >
              <FaFolderOpen />
            </button>
          )}
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
            aria-label="Close Video Tools"
            disabled={busy}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M1 1L13 13M1 13L13 1"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </div>

      <div className="settings-body">
        {empty ? (
          <div className="vt-empty">
            <FaFilm className="vt-empty-icon" />
            <p className="vt-empty-title">No videos yet</p>
            <p className="vt-empty-text">
              Record some clips and they show up here, ready to combine into one
              video or compress for uploading.
            </p>
            <button
              type="button"
              className="vt-show-btn"
              onClick={openOutputFolder}
            >
              <FaFolderOpen />
              Open output folder
            </button>
            <p className="vt-empty-path" title={config.outputPath}>
              {config.outputPath}
            </p>
          </div>
        ) : (
          <div className="vt-content">
            <div className="vt-toolbar">
              <button
                type="button"
                className="vt-link"
                disabled={busy}
                onClick={() => tickClips(folderOrder, true)}
              >
                Select all clips
              </button>
              <button
                type="button"
                className="vt-link"
                disabled={busy}
                onClick={() => tickClips(folderOrder, false)}
              >
                Clear
              </button>
              <span className="vt-toolbar-path" title={config.outputPath}>
                {config.outputPath}
              </span>
            </div>

            <div className={`vt-tree${busy ? ' vt-tree--busy' : ''}`}>
              {folders === null && (
                <p className="vt-loading">Looking for videos…</p>
              )}
              {orderedFolders.map((f) => {
                const open = expanded.has(f.path)
                const st = ui[f.path]
                if (!st) return null
                const sel = st.order.filter((c) => st.checked[c]).length
                const clipsSel = f.clips.filter((c) => st.checked[c]).length
                const allClips =
                  f.clips.length > 0 && clipsSel === f.clips.length
                return (
                  <div
                    key={f.path}
                    className={`vt-folder${
                      folderDrag === f.path ? ' vt-folder--dragging' : ''
                    }`}
                  >
                    <div
                      className="vt-folder-row"
                      role="button"
                      tabIndex={0}
                      aria-expanded={open}
                      onClick={() => toggleFolder(f.path)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          toggleFolder(f.path)
                        }
                      }}
                      onDragOver={(e) => onFolderDragOver(f.path, e)}
                      onDrop={(e) => e.preventDefault()}
                    >
                      <span
                        className="vt-grip"
                        title="Drag to reorder folders"
                        draggable
                        onClick={(e) => e.stopPropagation()}
                        onDragStart={(e) => onFolderDragStart(f.path, e)}
                        onDragEnd={() => setFolderDrag(null)}
                      >
                        <FaGripVertical />
                      </span>
                      <span className="vt-caret">
                        {open ? <FaChevronDown /> : <FaChevronRight />}
                      </span>
                      {f.clips.length > 0 ? (
                        <input
                          type="checkbox"
                          className="vt-check"
                          checked={allClips}
                          ref={(el) => {
                            if (el) el.indeterminate = !allClips && clipsSel > 0
                          }}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => tickClips([f.path], !allClips)}
                          aria-label={`Select all clips in ${folderLabel(f)}`}
                        />
                      ) : (
                        <span className="vt-check-gap" />
                      )}
                      {open ? (
                        <FaFolderOpen className="vt-folder-icon" />
                      ) : (
                        <FaFolder className="vt-folder-icon" />
                      )}
                      <span className="vt-folder-name" title={f.path}>
                        {folderLabel(f)}
                      </span>
                      {f.path === latestPath && (
                        <span className="vt-pill vt-pill--latest">latest</span>
                      )}
                      <span className="vt-folder-count">
                        {sel}/{st.order.length}
                      </span>
                    </div>

                    {open && (
                      <ul
                        className={`vt-list${
                          drag?.folder === f.path ? ' vt-list--dragging' : ''
                        }`}
                      >
                        {st.order.map((c, i) => (
                          <li
                            key={c}
                            className={`vt-item${
                              drag?.folder === f.path && drag.from === i
                                ? ' vt-item--dragging'
                                : ''
                            }`}
                            style={{ transform: rowShift(f.path, i) }}
                            draggable
                            onDragStart={(e) => onItemDragStart(f.path, i, e)}
                            onDragOver={(e) => onItemDragOver(f.path, i, e)}
                            onDragEnd={commitDrag}
                          >
                            <span className="vt-grip" title="Drag to reorder">
                              <FaGripVertical />
                            </span>
                            <label className="vt-item-label">
                              <input
                                type="checkbox"
                                className="vt-check"
                                checked={!!st.checked[c]}
                                onChange={() => toggleItem(f.path, c)}
                              />
                              <span className="vt-item-name" title={c}>
                                {c}
                              </span>
                            </label>
                            {f.finished.includes(c) && (
                              <span
                                className="vt-pill"
                                title="A finished video: tick it by itself to compress it"
                              >
                                video
                              </span>
                            )}
                            <span className="vt-item-size">
                              {formatBytes(f.sizes?.[c] ?? 0)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {!empty && (
        <div className="vt-options">
          <div className="vt-quality" role="radiogroup" aria-label="Quality">
            <span className="vt-quality-label">Quality</span>
            {QUALITY.map((q) => (
              <button
                key={q.key}
                type="button"
                role="radio"
                aria-checked={quality === q.key}
                disabled={busy}
                className={`vt-quality-opt${
                  quality === q.key ? ' vt-quality-opt--on' : ''
                }`}
                onClick={() => setQuality(q.key)}
                title={
                  q.kbps === 0
                    ? 'Joins the videos as they are: nothing is re-encoded, and the file is the biggest'
                    : `Re-encodes at about ${q.sub}: a smaller file, good for uploading`
                }
              >
                {q.label}
                <span className="vt-quality-sub">
                  {sizeAt(q.kbps) ?? q.sub}
                </span>
              </button>
            ))}
          </div>
          <div
            className="vt-length"
            title="Running time of the selected videos together"
          >
            <span className="vt-length-label">Length</span>
            <span className="vt-length-val">{lengthText}</span>
          </div>
        </div>
      )}

      <div className="vt-footer">
        <div className="vt-footer-status" aria-live="polite">
          {busy ? (
            <div className="vt-progress">
              <div className="vt-progress-track">
                {progress > 0 ? (
                  <div
                    className="vt-progress-fill"
                    style={{ width: `${progress}%` }}
                  />
                ) : (
                  <div className="vt-progress-indet" />
                )}
              </div>
              <span className="vt-progress-pct">
                {progress > 0 ? `${progress}%` : 'Starting…'}
              </span>
            </div>
          ) : result?.ok ? (
            <span className="vt-result--ok">
              <FaCheckCircle className="vt-result-icon" />
              <span className="vt-result-msg">
                Saved <strong>{basename(result.output || '')}</strong>
              </span>
              <button
                type="button"
                className="vt-show-btn"
                onClick={() => ipcBridge.videoToolsReveal(result.output || '')}
                title="Show the new video in your file manager"
              >
                <FaFolderOpen />
                Show in folder
              </button>
            </span>
          ) : result?.cancelled ? (
            <span className="vt-status">Cancelled. Nothing was saved.</span>
          ) : result ? (
            <span className="vt-result--err" title={result.error}>
              {result.error || 'The video could not be made.'}
            </span>
          ) : (
            <span className="vt-status">
              {empty ? '' : action.hint}
              {action.enabled && folderCount > 1
                ? ` across ${folderCount} folders`
                : ''}
            </span>
          )}
        </div>
        <div className="vt-footer-actions">
          {busy ? (
            <button
              type="button"
              className="vt-close-btn"
              onClick={() => ipcBridge.videoToolsCancel()}
            >
              Cancel
            </button>
          ) : (
            <button type="button" className="vt-close-btn" onClick={onClose}>
              Close
            </button>
          )}
          {!empty && (
            <button
              type="button"
              className="vt-go-btn"
              onClick={run}
              disabled={!action.enabled || busy}
            >
              {busy ? action.busyLabel : action.label}
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}
