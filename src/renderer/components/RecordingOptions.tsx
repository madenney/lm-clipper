import { useEffect, useRef, useState } from 'react'
import { FiSliders } from 'react-icons/fi'

import '../styles/ActionBar.css'
import '../styles/TopBar.css'
import { ConfigInterface } from '../../constants/types'
import Tooltip from './Tooltip'
import { openSettings } from '../lib/openSettings'

// A number field that saves as you type (every valid number is committed at once, so
// closing the popover or clicking elsewhere never loses an edit) and tidies on blur or
// Enter. A plain controlled `parseInt(value) || min` input snaps back to min the instant
// the field is emptied, which makes it impossible to backspace and retype: an empty or
// too-small entry is simply not committed until you leave the field.
export function NumberField({
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
      onChange={(e) => {
        setLocal(e.target.value)
        const n = parseInt(e.target.value, 10)
        if (!Number.isNaN(n) && n >= min && n !== value) onCommit(n)
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

type Option = { value: number; label: string }

type Props = {
  config: ConfigInterface
  onChange: (_key: string, _value: any) => void
  playbackResOptions?: Option[]
  resolutionOptions?: Option[]
  dolphinsWarning?: string | null
  onOpenGecko: () => void
}

/**
 * Everything that used to sit along the bottom bar and is set once: playback and
 * recording quality, how many Dolphins record at once, clips per Dolphin, joining
 * into one video, MP4, Gecko Codes. One popover next to Record.
 */
export default function RecordingOptions({
  config,
  onChange,
  playbackResOptions,
  resolutionOptions,
  dolphinsWarning,
  onOpenGecko,
}: Props) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!buttonRef.current?.contains(t) && !popRef.current?.contains(t))
        setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <Tooltip text="Recording options">
        <button
          ref={buttonRef}
          type="button"
          className={`tb tb--icon${open ? ' is-on' : ''}`}
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label="Recording options"
        >
          <FiSliders aria-hidden />
        </button>
      </Tooltip>
      {open && (
        <div
          ref={popRef}
          className="rec-options-pop"
          role="dialog"
          aria-label="Recording options"
        >
          <div className="rec-options-row" title="Playback resolution">
            <span className="rec-options-label">Play quality</span>
            <select
              className="footer-select"
              value={config.playbackResolution}
              onChange={(e) =>
                onChange('playbackResolution', parseInt(e.target.value, 10))
              }
            >
              {playbackResOptions?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="rec-options-row" title="Recording resolution">
            <span className="rec-options-label">Record quality</span>
            <select
              className="footer-select"
              value={config.resolution}
              onChange={(e) =>
                onChange('resolution', parseInt(e.target.value, 10))
              }
            >
              {resolutionOptions?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div
            className="rec-options-row"
            title="Number of Dolphin instances for recording"
          >
            <span className="rec-options-label">Dolphins</span>
            <span className="rec-options-field">
              <NumberField
                value={config.numCPUs}
                min={1}
                onCommit={(n) => onChange('numCPUs', n)}
              />
              {dolphinsWarning && (
                <Tooltip text={dolphinsWarning} offsetX={-120}>
                  <span
                    className="footer-setting-warning"
                    role="img"
                    aria-label={dolphinsWarning}
                  >
                    ⚠
                  </span>
                </Tooltip>
              )}
            </span>
          </div>
          <label
            className="rec-options-row"
            title="Concatenate clips into one video"
          >
            <span className="rec-options-label">Join into one video</span>
            <input
              type="checkbox"
              checked={!!config.concatenate}
              onChange={(e) => onChange('concatenate', e.target.checked)}
            />
          </label>
          <label className="rec-options-row" title="Convert AVI output to MP4">
            <span className="rec-options-label">Convert to MP4</span>
            <input
              type="checkbox"
              checked={!!config.convertToMp4}
              onChange={(e) => onChange('convertToMp4', e.target.checked)}
            />
          </label>
          <div className="rec-options-links">
            <button
              type="button"
              className="rec-options-gecko"
              onClick={() => {
                setOpen(false)
                onOpenGecko()
              }}
              title="Configure Gecko Codes for recording"
            >
              Gecko Codes…
            </button>
            <button
              type="button"
              className="rec-options-gecko"
              onClick={() => {
                setOpen(false)
                openSettings('recording')
              }}
              title="Open Settings on the Recording section: resolution, codec and more"
            >
              Video settings…
            </button>
          </div>
        </div>
      )}
    </>
  )
}
