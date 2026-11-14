import { useState, type CSSProperties } from 'react'
import { updateErrorDetails, updateErrorText } from '../lib/updateStatus'

type UpdateStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'ready' }
  | { state: 'not-available' }
  | { state: 'error'; message: string }

type Props = {
  status: UpdateStatus
  onDismiss: () => void
}

// A pill floating above everything at the top centre. It used to be a block at the top of the
// layout, which the start screen and the top bar covered: an available update was never seen.
// It wraps (a long message no longer runs off both edges) and announces itself to screen readers.
const bannerStyle: CSSProperties = {
  position: 'fixed',
  top: 12,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 7000,
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '6px 12px',
  maxWidth: 'min(560px, calc(100vw - 24px))',
  padding: '8px 14px',
  borderRadius: 8,
  boxShadow: '0 4px 18px rgba(0, 0, 0, 0.5)',
  background: '#1a5fc4',
  color: '#fff',
  fontSize: 13,
  lineHeight: 1.4,
  fontFamily: 'sans-serif',
  cursor: 'default',
  textAlign: 'center',
}

const errorBannerStyle: CSSProperties = {
  ...bannerStyle,
  background: '#a93226',
}

const btnStyle: CSSProperties = {
  padding: '3px 10px',
  border: '1px solid rgba(255,255,255,0.6)',
  borderRadius: 4,
  background: 'transparent',
  color: '#fff',
  fontSize: 12,
  cursor: 'pointer',
}

const detailsStyle: CSSProperties = {
  flexBasis: '100%',
  fontSize: 11,
  opacity: 0.9,
  wordBreak: 'break-word',
  userSelect: 'text',
}

export default function UpdateBanner({ status, onDismiss }: Props) {
  const [details, setDetails] = useState(false)
  // "Restart now" stops whatever is running (a recording, a download, an import): ask first.
  const [confirmRestart, setConfirmRestart] = useState(false)

  if (status.state === 'checking') {
    return (
      <div style={bannerStyle} role="status">
        <span>Checking for updates…</span>
      </div>
    )
  }

  if (status.state === 'not-available') {
    return (
      <div style={bannerStyle} role="status">
        <span>You&apos;re up to date ✓</span>
        <button type="button" style={btnStyle} onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    )
  }

  if (status.state === 'available') {
    return (
      <div style={bannerStyle} role="status">
        <span>Update v{status.version} available</span>
        <button
          type="button"
          style={btnStyle}
          onClick={() =>
            window.electron.ipcRenderer.sendMessage('download-update', {})
          }
        >
          Download
        </button>
        <button type="button" style={btnStyle} onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    )
  }

  if (status.state === 'downloading') {
    return (
      <div style={bannerStyle} role="status">
        <span>Downloading update... {status.percent}%</span>
      </div>
    )
  }

  if (status.state === 'error') {
    const raw = updateErrorDetails(status.message)
    return (
      <div style={errorBannerStyle} role="alert">
        <span>{updateErrorText(status.message)}</span>
        {raw && (
          <button
            type="button"
            style={btnStyle}
            aria-expanded={details}
            onClick={() => setDetails((v) => !v)}
          >
            {details ? 'Hide details' : 'Details'}
          </button>
        )}
        <button type="button" style={btnStyle} onClick={onDismiss}>
          Dismiss
        </button>
        {details && raw && <div style={detailsStyle}>{raw}</div>}
      </div>
    )
  }

  // ready
  if (confirmRestart) {
    return (
      <div style={bannerStyle} role="alert">
        <span>
          Restart to update? A recording, download or import that is still
          running will be stopped.
        </span>
        <button
          type="button"
          style={btnStyle}
          onClick={() =>
            window.electron.ipcRenderer.sendMessage('install-update', {})
          }
        >
          Restart
        </button>
        <button
          type="button"
          style={btnStyle}
          onClick={() => setConfirmRestart(false)}
        >
          Not yet
        </button>
      </div>
    )
  }
  return (
    <div style={bannerStyle} role="status">
      <span>Update ready</span>
      <button
        type="button"
        style={btnStyle}
        onClick={() => setConfirmRestart(true)}
      >
        Restart now
      </button>
      <button type="button" style={btnStyle} onClick={onDismiss}>
        Later
      </button>
    </div>
  )
}
