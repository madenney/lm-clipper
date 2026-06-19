import type { CSSProperties } from 'react'

type Props = {
  onDismiss: () => void
}

const bannerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 12,
  padding: '6px 12px',
  background: '#2b2f3a',
  color: '#e7e9ee',
  fontSize: 12.5,
  fontFamily: 'sans-serif',
  flexShrink: 0,
  borderBottom: '1px solid rgba(255,255,255,0.08)',
}

const btnStyle: CSSProperties = {
  padding: '3px 10px',
  border: '1px solid rgba(255,255,255,0.35)',
  borderRadius: 4,
  background: 'transparent',
  color: '#e7e9ee',
  fontSize: 12,
  cursor: 'pointer',
  flexShrink: 0,
}

// One-time first-run disclosure that the app sends anonymous usage stats.
// Dismissal is persisted via the `consentNoticeSeen` config flag.
export default function ConsentNotice({ onDismiss }: Props) {
  return (
    <div style={bannerStyle}>
      <span>
        Lunar Clipper sends anonymous usage stats to help improve it — no
        personal data is collected. You can turn this off any time in Settings.
      </span>
      <button type="button" style={btnStyle} onClick={onDismiss}>
        Got it
      </button>
    </div>
  )
}
