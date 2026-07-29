/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import { DragEvent, useEffect, useRef, useState } from 'react'
import { FaFolder, FaFolderOpen } from 'react-icons/fa'
import { ConfigInterface, StitchFolder } from '../../constants/types'
import ipcBridge from '../ipcBridge'
import useIpcListener from '../hooks/useIpcListener'
import '../styles/StitchModal.css'

type StitchModalProps = {
  config: ConfigInterface
  // Output sub-folders that hold >= 2 finished clips (computed by Main via the
  // checkStitchable IPC).
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

const basename = (p: string) => p.split(/[\\/]/).pop() || p

// output / output_1 / output_2 … are the auto-generated recording folders.
// Returns the number (output = 0, output_N = N), or null for any other folder.
const outputNum = (name: string): number | null => {
  if (name === 'output') return 0
  const m = /^output_(\d+)$/.exec(name)
  return m ? parseInt(m[1], 10) : null
}

/**
 * Stitch Clips — join clips from the output folders into one video (ffmpeg
 * concat), for when a recording was stopped early or the user wants to merge an
 * existing folder. Check whole folders or individual clips (drag to reorder
 * within a folder), then hit Stitch. A single-folder selection writes final.mp4
 * in that folder; a cross-folder selection writes stitched.mp4 in the output root.
 */
export default function StitchModal({
  config,
  folders,
  onClose,
}: StitchModalProps) {
  // The most recently made auto-generated folder = highest output_X. It's the
  // only one selected when the modal opens; every other folder starts unchecked.
  const mostRecentPath = folders.reduce<{ path: string; n: number }>(
    (best, f) => {
      const n = outputNum(f.name)
      return n !== null && n > best.n ? { path: f.path, n } : best
    },
    { path: '', n: -1 },
  ).path

  const [ui, setUi] = useState<Record<string, FolderUI>>(() => {
    const s: Record<string, FolderUI> = {}
    for (const f of folders) {
      const on = f.path === mostRecentPath
      s[f.path] = {
        order: [...f.clips],
        checked: Object.fromEntries(f.clips.map((c) => [c, on])),
      }
    }
    return s
  })
  // All folders start collapsed.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<StitchResult | null>(null)
  // Live drag-reorder state. `drag` = the clip being dragged (folder + start
  // index); `over` = the insertion index the cursor is currently over. Non-
  // dragged clips between the two slide via translateY (see clipShift) so the
  // list reflows as you drag — the same mechanic the filter cards use.
  const [drag, setDrag] = useState<{ folder: string; from: number } | null>(
    null,
  )
  const [over, setOver] = useState<number | null>(null)
  const clipHeight = useRef(0)

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

  const onClipDragStart = (
    folder: string,
    index: number,
    e: DragEvent<HTMLLIElement>,
  ) => {
    clipHeight.current = e.currentTarget.offsetHeight
    // Transparent 1px drag image so the browser's default ghost doesn't fight
    // the live-reflow preview — the source row just dims in place instead.
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      const img = new Image()
      img.src =
        'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
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

  // Display order: auto-generated output_X folders first, highest number (most
  // recent) at the top; any other folders below, alphabetical.
  const sortedFolders = [...folders].sort((a, b) => {
    const na = outputNum(a.name)
    const nb = outputNum(b.name)
    if (na !== null && nb !== null) return nb - na
    if (na !== null) return -1
    if (nb !== null) return 1
    return a.name.localeCompare(b.name)
  })

  // Full selection across every folder, in display order (folder order, then
  // the clip order within each folder).
  const selection: { folder: string; name: string; ext: string }[] = []
  for (const f of sortedFolders) {
    const st = ui[f.path]
    for (const c of st.order) {
      if (st.checked[c]) selection.push({ folder: f.path, name: c, ext: f.ext })
    }
  }
  const folderCount = new Set(selection.map((s) => s.folder)).size

  const doStitch = () => {
    if (selection.length < 2 || busy) return
    setBusy(true)
    setProgress(0)
    setResult(null)
    ipcBridge.stitchClips(
      {
        clips: selection.map((s) => ({ folder: s.folder, name: s.name })),
        ext: selection[0].ext,
      },
      (res: StitchResult) => {
        setBusy(false)
        setResult(res)
      },
    )
  }

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

        <div className="settings-body">
          <div className="stitch-content">
            <p className="stitch-root" title={config.outputPath}>
              {folders.length} folder{folders.length === 1 ? '' : 's'} with
              clips in{' '}
              <span className="stitch-root-path">{config.outputPath}</span>
            </p>

            <div className="stitch-tree">
              {sortedFolders.map((f) => {
                const open = expanded.has(f.path)
                const st = ui[f.path]
                const sel = st.order.filter((c) => st.checked[c]).length
                const allSel = sel === f.clips.length
                const noneSel = sel === 0
                return (
                  <div key={f.path} className="stitch-folder">
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
                    >
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
                  {progress > 0 ? `${progress}%` : 'Stitching…'}
                </span>
              </div>
            ) : result?.ok ? (
              <span className="stitch-result--ok">
                Saved {basename(result.output || '')}
                <button
                  type="button"
                  className="stitch-link"
                  onClick={() =>
                    window.electron.ipcRenderer.sendMessage(
                      'openFolder',
                      result.dir || config.outputPath,
                    )
                  }
                >
                  Show
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
