/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import { DragEvent, useCallback, useEffect, useRef, useState } from 'react'
import { FaFolder, FaFolderOpen, FaCheckCircle } from 'react-icons/fa'
import { ConfigInterface, StitchFolder } from '../../constants/types'
import ipcBridge from '../ipcBridge'
import useIpcListener from '../hooks/useIpcListener'
import '../styles/StitchModal.css'

type StitchModalProps = {
  config: ConfigInterface
  // Output sub-folders that hold >= 2 finished clips (computed by Main via the
  // checkStitchable IPC). Used only to seed the modal; while it's open the modal
  // re-scans on its own (see the poll below) so on-disk changes show up live.
  folders: StitchFolder[]
  onClose: () => void
}

type FolderUI = { order: string[]; checked: Record<string, boolean> }
type StitchResult = {
  ok: boolean
  output?: string
  dir?: string
  error?: string
}

// Output-quality presets. `copy` stream-copies (lossless, huge); the rest
// re-encode H.264 at a target bitrate so the output is small and its size is
// predictable — which is exactly what the estimate below reports.
const QUALITY = [
  { key: 'copy', label: 'Original', sub: 'lossless', kbps: 0 },
  { key: 'high', label: 'High', sub: '8 Mbps', kbps: 8000 },
  { key: 'medium', label: 'Medium', sub: '4 Mbps', kbps: 4000 },
  { key: 'small', label: 'Small', sub: '2 Mbps', kbps: 2000 },
] as const
type QualityKey = (typeof QUALITY)[number]['key']
const AUDIO_KBPS = 160

// 1px transparent GIF — a drag image that hides the browser's default ghost so
// the live-reflow preview reads cleanly.
const DRAG_GHOST =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

const basename = (p: string) => p.split(/[\\/]/).pop() || p

// output / output_1 / output_2 … are the auto-generated recording folders.
// Returns the number (output = 0, output_N = N), or null for any other folder.
const outputNum = (name: string): number | null => {
  if (name === 'output') return 0
  const m = /^output_(\d+)$/.exec(name)
  return m ? parseInt(m[1], 10) : null
}

// Default display order: auto-generated output_X folders first, highest number
// (most recent) at the top; any other folders below, alphabetical.
const sortFolders = (fs: StitchFolder[]): StitchFolder[] =>
  [...fs].sort((a, b) => {
    const na = outputNum(a.name)
    const nb = outputNum(b.name)
    if (na !== null && nb !== null) return nb - na
    if (na !== null) return -1
    if (nb !== null) return 1
    return a.name.localeCompare(b.name)
  })

const formatBytes = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return '0 MB'
  const gib = n / 1024 ** 3
  if (gib >= 1) return `${gib.toFixed(gib >= 10 ? 0 : 1)} GB`
  const mib = n / 1024 ** 2
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`
}

const formatDuration = (sec: number): string => {
  if (!Number.isFinite(sec) || sec <= 0) return '0s'
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${r}s`
  return `${r}s`
}

/**
 * Stitch Clips — join clips from the output folders into one video (ffmpeg
 * concat), for when a recording was stopped early or the user wants to merge an
 * existing folder. Check whole folders or individual clips (drag to reorder
 * within a folder, drag folders to reorder across folders), pick a quality
 * (Original = lossless, or a compressed size for uploading), then hit Stitch.
 * A single-folder selection writes final.mp4 in that folder; a cross-folder
 * selection writes stitched.mp4 in the output root. The folder list re-scans
 * live, so clips deleted on disk drop out on their own.
 */
export default function StitchModal({
  config,
  folders,
  onClose,
}: StitchModalProps) {
  // Live copy of the scan; seeded from the prop, refreshed by the poll below.
  const [liveFolders, setLiveFolders] = useState<StitchFolder[]>(folders)

  // The most recently made auto-generated folder = highest output_X. Only it is
  // selected when the modal opens.
  const mostRecentPath = liveFolders.reduce<{ path: string; n: number }>(
    (best, f) => {
      const n = outputNum(f.name)
      return n !== null && n > best.n ? { path: f.path, n } : best
    },
    { path: '', n: -1 },
  ).path

  const [ui, setUi] = useState<Record<string, FolderUI>>(() => {
    const initialMostRecent = sortFolders(folders).find(
      (f) => outputNum(f.name) !== null,
    )?.path
    const s: Record<string, FolderUI> = {}
    for (const f of folders) {
      const on = f.path === initialMostRecent
      s[f.path] = {
        order: [...f.clips],
        checked: Object.fromEntries(f.clips.map((c) => [c, on])),
      }
    }
    return s
  })
  // Folder display/stitch order (paths). Reorderable by dragging folder rows.
  const [folderOrder, setFolderOrder] = useState<string[]>(() =>
    sortFolders(folders).map((f) => f.path),
  )
  // All folders start collapsed.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<StitchResult | null>(null)
  const [quality, setQuality] = useState<QualityKey>('copy')
  // Header info from the ffmpeg probe of the current selection. `seconds` is
  // usually 0 (concat reports Duration: N/A); `bitrateKbps` (the source
  // bitrate) is paired with the total byte size to derive a duration below.
  // `probing` marks a measurement in flight.
  const [probeInfo, setProbeInfo] = useState({ seconds: 0, bitrateKbps: 0 })
  const [probing, setProbing] = useState(false)
  // Live clip drag-reorder (within one folder). `drag` = the clip being dragged;
  // `over` = the insertion index. Non-dragged clips slide via translateY.
  const [drag, setDrag] = useState<{ folder: string; from: number } | null>(
    null,
  )
  const [over, setOver] = useState<number | null>(null)
  const clipHeight = useRef(0)
  // Folder drag-reorder (across folders). Live-splices folderOrder as you drag.
  const [folderDrag, setFolderDrag] = useState<string | null>(null)

  // Refs so the poll interval can read current interaction state without being
  // torn down and rebuilt on every render.
  const busyRef = useRef(busy)
  busyRef.current = busy
  const dragRef = useRef<boolean>(!!drag)
  dragRef.current = !!drag
  const folderDragRef = useRef<boolean>(!!folderDrag)
  folderDragRef.current = !!folderDrag

  // Merge a fresh scan into the current UI state, preserving selection and
  // order for clips that still exist, dropping ones that vanished, and adding
  // new ones (unchecked). This is what makes on-disk deletes/additions show up.
  const applyScan = useCallback((scanned: StitchFolder[]) => {
    setLiveFolders(scanned)
    const byPath = new Map(scanned.map((f) => [f.path, f]))
    setUi((prev) => {
      const next: Record<string, FolderUI> = {}
      for (const f of scanned) {
        const ex = prev[f.path]
        if (ex) {
          const order = ex.order.filter((c) => f.clips.includes(c))
          for (const c of f.clips) if (!order.includes(c)) order.push(c)
          const checked: Record<string, boolean> = {}
          for (const c of order) checked[c] = ex.checked[c] ?? false
          next[f.path] = { order, checked }
        } else {
          next[f.path] = {
            order: [...f.clips],
            checked: Object.fromEntries(f.clips.map((c) => [c, false])),
          }
        }
      }
      return next
    })
    setFolderOrder((prev) => {
      const kept = prev.filter((p) => byPath.has(p))
      for (const f of sortFolders(scanned))
        if (!kept.includes(f.path)) kept.push(f.path)
      return kept
    })
  }, [])

  // Re-scan the output folders on a timer while open, so files deleted or added
  // on disk are reflected without reopening. Skipped mid-interaction so it can't
  // yank state out from under a drag or an in-progress stitch.
  useEffect(() => {
    const id = setInterval(() => {
      if (busyRef.current || dragRef.current || folderDragRef.current) return
      ipcBridge.checkStitchable((res) => {
        if (res?.folders) applyScan(res.folders)
      })
    }, 2000)
    return () => clearInterval(id)
  }, [applyScan])

  // Close on Escape (but not mid-stitch).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  // ffmpeg stitch progress (0–100), pushed from the main process.
  useIpcListener('stitchProgress', (p: number) => setProgress(p))

  const byPath = new Map(liveFolders.map((f) => [f.path, f]))
  const orderedFolders = folderOrder
    .map((p) => byPath.get(p))
    .filter((f): f is StitchFolder => !!f)

  // Full selection across every folder, in display order (folder order, then
  // clip order within each folder).
  const selection: {
    folder: string
    name: string
    ext: string
    size: number
  }[] = []
  for (const f of orderedFolders) {
    const st = ui[f.path]
    if (!st) continue
    for (const c of st.order) {
      if (st.checked[c])
        selection.push({
          folder: f.path,
          name: c,
          ext: f.ext,
          size: f.sizes?.[c] ?? 0,
        })
    }
  }
  const folderCount = new Set(selection.map((s) => s.folder)).size
  const sourceBytes = selection.reduce((sum, s) => sum + s.size, 0)
  const selKey = selection.map((s) => `${s.folder}|${s.name}`).join('\n')

  // Probe the selection's total duration (debounced) so the estimate can show a
  // running time and, for compressed output, a predicted size.
  const probeKeyRef = useRef('')
  useEffect(() => {
    if (selection.length < 2) {
      setProbeInfo({ seconds: 0, bitrateKbps: 0 })
      setProbing(false)
      probeKeyRef.current = ''
      return undefined
    }
    probeKeyRef.current = selKey
    setProbing(true)
    const clips = selection.map((s) => ({ folder: s.folder, name: s.name }))
    const t = setTimeout(() => {
      ipcBridge.probeStitchDuration({ clips }, (res) => {
        if (probeKeyRef.current !== selKey) return // selection moved on
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
  // Total run time of the selection. The probe rarely returns a real duration
  // (concat = Duration: N/A), so we usually derive it from the source's total
  // size and bitrate — accurate for these near-constant-bitrate clips.
  const durationSec =
    probeInfo.seconds > 0
      ? probeInfo.seconds
      : probeInfo.bitrateKbps > 0 && sourceBytes > 0
        ? (sourceBytes * 8) / (probeInfo.bitrateKbps * 1000)
        : 0
  // Estimated output size. Lossless ≈ the sum of the source files (exact, and
  // available instantly). Compressed = target bitrate × duration, so it needs
  // the probe result first.
  const estBytes: number | null =
    qKbps === 0
      ? sourceBytes
      : durationSec > 0
        ? ((qKbps + AUDIO_KBPS) * 1000 * durationSec) / 8
        : null

  const toggleFolder = (p: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })

  const toggleClip = (folder: string, clip: string) => {
    setResult(null)
    setUi((prev) => ({
      ...prev,
      [folder]: {
        ...prev[folder],
        checked: {
          ...prev[folder].checked,
          [clip]: !prev[folder].checked[clip],
        },
      },
    }))
  }

  const setAll = (folder: string, value: boolean) => {
    setResult(null)
    setUi((prev) => ({
      ...prev,
      [folder]: {
        ...prev[folder],
        checked: Object.fromEntries(prev[folder].order.map((c) => [c, value])),
      },
    }))
  }

  // Check/clear every clip across every folder at once.
  const setEvery = (value: boolean) => {
    setResult(null)
    setUi((prev) => {
      const next: Record<string, FolderUI> = {}
      for (const p of Object.keys(prev)) {
        next[p] = {
          ...prev[p],
          checked: Object.fromEntries(prev[p].order.map((c) => [c, value])),
        }
      }
      return next
    })
  }

  const onClipDragStart = (
    folder: string,
    index: number,
    e: DragEvent<HTMLLIElement>,
  ) => {
    clipHeight.current = e.currentTarget.offsetHeight
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      const img = new Image()
      img.src = DRAG_GHOST
      e.dataTransfer.setDragImage(img, 0, 0)
    }
    setDrag({ folder, from: index })
    setOver(index)
  }

  const onClipDragOver = (
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
      if (to > from) to -= 1 // account for removing the item first
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

  // translateY for a non-dragged clip so the list opens a gap at the drop spot.
  const clipShift = (folder: string, index: number): string => {
    if (!drag || drag.folder !== folder || over === null || index === drag.from)
      return ''
    const h = clipHeight.current
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

  // Live-splice: as the dragged folder passes over another, move it there.
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

  const doStitch = () => {
    if (selection.length < 2 || busy) return
    setBusy(true)
    setProgress(0)
    setResult(null)
    ipcBridge.stitchClips(
      {
        clips: selection.map((s) => ({ folder: s.folder, name: s.name })),
        ext: selection[0].ext,
        compress: qKbps > 0,
        videoKbps: qKbps > 0 ? qKbps : undefined,
      },
      (res: StitchResult) => {
        setBusy(false)
        setResult(res)
      },
    )
  }

  const estimateValue = (() => {
    if (selection.length < 2) return '—'
    const sizePart =
      estBytes != null ? `≈ ${formatBytes(estBytes)}` : probing ? '…' : '—'
    const durPart =
      durationSec > 0 ? formatDuration(durationSec) : probing ? '…' : '—'
    return `${sizePart} · ${durPart}`
  })()
  const estimateHint =
    quality === 'copy'
      ? 'Estimated size and running time of the stitched file. Original quality copies the clips as-is, so the size is the sum of the selected files.'
      : 'Estimated size and running time of the stitched file, re-encoded to the selected bitrate for a smaller, upload-friendly video.'

  return (
    <div
      className="settings-overlay"
      role="presentation"
      onClick={() => !busy && onClose()}
    >
      <div
        className="settings-modal settings-modal--stitch"
        role="presentation"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-header">
          <h2 className="settings-title">Stitch Clips</h2>
          <div className="stitch-header-actions">
            <button
              type="button"
              className="stitch-open-folder"
              onClick={() =>
                window.electron.ipcRenderer.sendMessage(
                  'openFolder',
                  config.outputPath,
                )
              }
              title={`Open the output folder\n${config.outputPath}`}
              aria-label="Open output folder in file explorer"
            >
              <FaFolderOpen />
            </button>
            <button
              type="button"
              className="settings-close"
              onClick={onClose}
              aria-label="Close stitch clips"
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
          <div className="stitch-content">
            <p className="stitch-root" title={config.outputPath}>
              {liveFolders.length} folder{liveFolders.length === 1 ? '' : 's'}{' '}
              with clips in{' '}
              <span className="stitch-root-path">{config.outputPath}</span>
            </p>

            <div className="stitch-toolbar">
              <button
                type="button"
                className="stitch-link"
                onClick={() => setEvery(true)}
              >
                Select all
              </button>
              <button
                type="button"
                className="stitch-link"
                onClick={() => setEvery(false)}
              >
                Clear
              </button>
              <span className="stitch-toolbar-count">
                {selection.length} selected
                {folderCount > 1 ? ` · ${folderCount} folders` : ''}
              </span>
            </div>

            <div className="stitch-tree">
              {orderedFolders.map((f) => {
                const open = expanded.has(f.path)
                const st = ui[f.path]
                if (!st) return null
                const sel = st.order.filter((c) => st.checked[c]).length
                const allSel = sel === f.clips.length
                const noneSel = sel === 0
                return (
                  <div
                    key={f.path}
                    className={`stitch-folder${
                      folderDrag === f.path ? ' stitch-folder--dragging' : ''
                    }`}
                  >
                    <div
                      className="stitch-folder-row"
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
                        className="stitch-folder-handle"
                        title="Drag to reorder folders"
                        draggable
                        onClick={(e) => e.stopPropagation()}
                        onDragStart={(e) => onFolderDragStart(f.path, e)}
                        onDragEnd={() => setFolderDrag(null)}
                      >
                        ⠿
                      </span>
                      <span className="stitch-caret">{open ? '▾' : '▸'}</span>
                      <input
                        type="checkbox"
                        className="stitch-check"
                        checked={allSel}
                        ref={(el) => {
                          if (el) el.indeterminate = !allSel && !noneSel
                        }}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => setAll(f.path, !allSel)}
                        aria-label={`Select all clips in ${f.name}`}
                      />
                      {open ? (
                        <FaFolderOpen className="stitch-folder-icon" />
                      ) : (
                        <FaFolder className="stitch-folder-icon" />
                      )}
                      <span className="stitch-folder-name">{f.name}</span>
                      {f.path === mostRecentPath && (
                        <span className="stitch-latest">latest</span>
                      )}
                      <span className="stitch-folder-count">
                        {sel}/{f.clips.length}
                      </span>
                    </div>

                    {open && (
                      <ul
                        className={`stitch-clip-list${
                          drag?.folder === f.path
                            ? ' stitch-clip-list--dragging'
                            : ''
                        }`}
                      >
                        {st.order.map((c, i) => (
                          <li
                            key={c}
                            className={`stitch-clip${
                              drag?.folder === f.path && drag.from === i
                                ? ' stitch-clip--dragging'
                                : ''
                            }`}
                            style={{ transform: clipShift(f.path, i) }}
                            draggable
                            onDragStart={(e) => onClipDragStart(f.path, i, e)}
                            onDragOver={(e) => onClipDragOver(f.path, i, e)}
                            onDragEnd={commitDrag}
                          >
                            <span className="stitch-drag-handle">⠿</span>
                            <label className="stitch-clip-label">
                              <input
                                type="checkbox"
                                className="stitch-check"
                                checked={!!st.checked[c]}
                                onChange={() => toggleClip(f.path, c)}
                              />
                              <span className="stitch-clip-name">{c}</span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        <div className="stitch-options">
          <div
            className="stitch-quality"
            role="radiogroup"
            aria-label="Quality"
          >
            <span className="stitch-quality-label">Quality</span>
            {QUALITY.map((q) => (
              <button
                key={q.key}
                type="button"
                role="radio"
                aria-checked={quality === q.key}
                disabled={busy}
                className={`stitch-quality-opt${
                  quality === q.key ? ' stitch-quality-opt--on' : ''
                }`}
                onClick={() => {
                  setQuality(q.key)
                  setResult(null)
                }}
                title={
                  q.kbps === 0
                    ? 'Stream-copy — identical to the source, largest file'
                    : `Re-encode to ~${q.sub} — smaller, good for uploading`
                }
              >
                {q.label}
                <span className="stitch-quality-sub">{q.sub}</span>
              </button>
            ))}
          </div>
          <div className="stitch-estimate" title={estimateHint}>
            <span className="stitch-estimate-label">Est. output</span>
            <span className="stitch-estimate-val">{estimateValue}</span>
          </div>
        </div>

        <div className="stitch-footer">
          <div className="stitch-footer-status">
            {busy ? (
              <div className="stitch-progress">
                <div className="stitch-progress-track">
                  {progress > 0 ? (
                    <div
                      className="stitch-progress-fill"
                      style={{ width: `${progress}%` }}
                    />
                  ) : (
                    <div className="stitch-progress-indet" />
                  )}
                </div>
                <span className="stitch-progress-pct">
                  {progress > 0 ? `${progress}%` : 'Estimating time…'}
                </span>
              </div>
            ) : result?.ok ? (
              <span className="stitch-result--ok">
                <FaCheckCircle className="stitch-result-icon" />
                <span className="stitch-result-msg">
                  Saved <strong>{basename(result.output || '')}</strong>
                </span>
                <button
                  type="button"
                  className="stitch-show-btn"
                  onClick={() =>
                    window.electron.ipcRenderer.sendMessage(
                      'openFolder',
                      result.dir || config.outputPath,
                    )
                  }
                  title="Reveal the stitched file in your file explorer"
                >
                  <FaFolderOpen />
                  Show in folder
                </button>
              </span>
            ) : result && !result.ok ? (
              <span className="stitch-result--err">
                {result.error || 'Stitch failed'}
              </span>
            ) : (
              <span className="stitch-status-count">
                {selection.length} clip{selection.length === 1 ? '' : 's'}{' '}
                selected
                {folderCount > 1 ? ` across ${folderCount} folders` : ''}
              </span>
            )}
          </div>
          <div className="stitch-footer-actions">
            <button
              type="button"
              className="stitch-close-btn"
              onClick={onClose}
              disabled={busy}
            >
              Close
            </button>
            <button
              type="button"
              className="stitch-go-btn"
              onClick={doStitch}
              disabled={selection.length < 2 || busy}
            >
              {busy
                ? 'Stitching…'
                : `Stitch ${selection.length} clip${
                    selection.length === 1 ? '' : 's'
                  }`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
