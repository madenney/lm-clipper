import { useEffect, useRef, useState } from 'react'
import type { OverlayFont } from '../../constants/types'
import ipcBridge from '../ipcBridge'

/**
 * Settings > Overlay: the font the label is drawn in. The bundled font, or one
 * the user imported; Clipper keeps its own copy of an imported file (main
 * process: src/main/overlayFonts.ts), so this only stores the file's name.
 */
export function OverlayFontRow({
  value,
  onChange,
}: {
  /** config.overlayFont: an imported font's file name, '' for the bundled one. */
  value: string
  onChange: (_file: string) => void
}) {
  const [fonts, setFonts] = useState<OverlayFont[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null)

  useEffect(() => {
    ipcBridge.overlayFontsList((res) => setFonts(res?.fonts ?? []))
  }, [])

  const missing =
    !!value && fonts !== null && !fonts.some((f) => f.file === value)

  const importFonts = () => {
    if (busy) return
    setBusy(true)
    setNote(null)
    ipcBridge.overlayFontsImport((res) => {
      setBusy(false)
      if (!res) {
        setNote({ text: 'The fonts could not be imported.', bad: true })
        return
      }
      setFonts(res.fonts ?? [])
      if (res.canceled) return
      // The font just brought in is the one wanted.
      if (res.imported.length > 0) onChange(res.imported[0].file)
      const failed = res.failed ?? []
      if (failed.length > 0) {
        setNote({
          text: failed.map((f) => `${f.name}: ${f.reason}`).join('. '),
          bad: true,
        })
      } else if (res.imported.length > 1) {
        setNote({ text: `${res.imported.length} fonts imported.`, bad: false })
      }
    })
  }

  const removeFont = () => {
    if (!value || busy) return
    setBusy(true)
    setNote(null)
    ipcBridge.overlayFontsRemove(value, (res) => {
      setBusy(false)
      setFonts(res?.fonts ?? [])
      if (res?.removed || missing) onChange('')
      else setNote({ text: 'That font could not be removed.', bad: true })
    })
  }

  return (
    <div className="pattern-editor-row overlay-font-row">
      <label className="settings-item-label" htmlFor="overlay-font">
        Font
      </label>
      <div className="overlay-font-controls">
        <select
          id="overlay-font"
          className="settings-select"
          value={value}
          disabled={busy}
          onChange={(e) => {
            setNote(null)
            onChange(e.target.value)
          }}
        >
          <option value="">Default (Liberation Mono Bold)</option>
          {(fonts ?? []).map((f) => (
            <option key={f.file} value={f.file}>
              {f.name}
            </option>
          ))}
          {missing && <option value={value}>{value} (missing)</option>}
        </select>
        <button
          type="button"
          className="overlay-font-btn"
          onClick={importFonts}
          disabled={busy}
        >
          Import font…
        </button>
        {value && (
          <button
            type="button"
            className="overlay-font-btn overlay-font-btn--quiet"
            onClick={removeFont}
            disabled={busy}
            title="Remove this font from Clipper. Your original file is not touched."
          >
            Remove
          </button>
        )}
      </div>
      <div className="settings-item-desc overlay-font-desc">
        {missing
          ? 'This font is no longer in Clipper, so the default is used. Import it again or pick another.'
          : 'Use your own .ttf, .otf, .ttc, .woff or .woff2 file. Clipper keeps its own copy.'}
      </div>
      {note && (
        <div
          className={`overlay-font-note${note.bad ? ' overlay-font-note--bad' : ''}`}
          role={note.bad ? 'alert' : 'status'}
        >
          {note.text}
        </div>
      )}
    </div>
  )
}

/**
 * The label exactly as a recording draws it (same renderer, 1080p size), in the
 * chosen font. `fallback` is shown until the first picture arrives or when the
 * main process cannot draw one.
 */
export function OverlayPreviewImage({
  text,
  font,
  size,
  fallback,
}: {
  text: string
  font: string
  /** config.overlayFontSize: pixels on a 1080p video. */
  size: number
  fallback: JSX.Element
}) {
  const [shown, setShown] = useState<string | null>(null)
  const latest = useRef('')

  useEffect(() => {
    const key = `${font}\n${size}\n${text}`
    latest.current = key
    if (!text.trim()) {
      setShown(null)
      return undefined
    }
    const t = setTimeout(() => {
      ipcBridge.overlayPreview({ text, font, size }, (res) => {
        if (latest.current === key) setShown(res?.dataUrl ?? null)
      })
    }, 150)
    return () => clearTimeout(t)
  }, [text, font, size])

  if (!shown) return fallback
  return (
    <img
      className="overlay-preview-img"
      src={shown}
      alt={`Overlay preview: ${text}`}
    />
  )
}
