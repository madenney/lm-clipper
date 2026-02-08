import type { CSSProperties } from 'react'

type UpdateStatus =
  | { state: 'available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'ready' }

type Props = {
  status: UpdateStatus
  onDismiss: () => void
}

const bannerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 12,
  padding: '6px 12px',
  background: '#1a73e8',
  color: '#fff',
  fontSize: 13,
  fontFamily: 'sans-serif',
  cursor: 'default',
  flexShrink: 0,
}

const btnStyle: CSSProperties = {
  padding: '3px 10px',
  border: '1px solid rgba(255,255,255,0.5)',
  borderRadius: 4,
  background: 'transparent',
  color: '#fff',
  fontSize: 12,
  cursor: 'pointer',
}

export default function UpdateBanner({ status, onDismiss }: Props) {
  if (status.state === 'available') {
    return (
      <div style={bannerStyle}>
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
      <div style={bannerStyle}>
        <span>Downloading update... {status.percent}%</span>
      </div>
    )
  }

  // ready
  return (
    <div style={bannerStyle}>
      <span>Update ready</span>
      <button
        type="button"
        style={btnStyle}
        onClick={() =>
          window.electron.ipcRenderer.sendMessage('install-update', {})
        }
      >
        Restart now
      </button>
      <button type="button" style={btnStyle} onClick={onDismiss}>
        Later
      </button>
    </div>
  )
}
