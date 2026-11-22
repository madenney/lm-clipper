import { CSSProperties, useEffect, useRef, useState } from 'react'
import { openSettings } from '../lib/openSettings'

type Props = {
  onDismiss: () => void
}

// The first-run disclosure that Clipper sends anonymous usage stats. It stays in view, on the
// start screen and in a project alike, until the user clicks OK: it used to be a 12 px grey line
// that only the start screen showed, so someone who imported straight away never saw it. Fixed
// and small, so nothing paints over it and it does not compete with the import action; the text
// is light on dark (about 9:1) rather than grey.
const cardStyle: CSSProperties = {
  position: 'fixed',
  left: '50%',
  bottom: 14,
  transform: 'translateX(-50%)',
  zIndex: 5000,
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '4px 12px',
  maxWidth: 'min(640px, calc(100vw - 24px))',
  padding: '8px 14px',
  borderRadius: 8,
  border: '1px solid #3a3a3a',
  background: 'rgba(22, 22, 22, 0.97)',
  boxShadow: '0 4px 16px rgba(0, 0, 0, 0.45)',
  fontSize: 13,
  lineHeight: 1.4,
  color: '#d4d4d4',
  textAlign: 'center',
}

const linkStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  color: '#b8d4ff',
  cursor: 'pointer',
  textDecoration: 'underline',
  textUnderlineOffset: 3,
}

// OK is the main action, so it is a real button that lights up on hover and keyboard focus; "Turn off"
// and "Privacy" stay as plain links beside it, as visible as before (the owner's choice, 2026-11-19: make
// OK clearer, never hide the opt-out).
const okStyle = (lit: boolean): CSSProperties => ({
  padding: '3px 14px',
  borderRadius: 6,
  border: `1px solid ${lit ? '#8fb8ff' : '#5a5a5a'}`,
  background: lit ? '#3d6fd8' : '#2c2c2c',
  color: '#fff',
  font: 'inherit',
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'background 120ms ease, border-color 120ms ease',
})

// Dismissal is persisted via the `consentNoticeSeen` config flag.
export default function ConsentNotice({ onDismiss }: Props) {
  const [okLit, setOkLit] = useState(false)
  // The line has been on screen: that counts as shown even when it goes away
  // because a project opened. Main holds the first-launch usage pings until
  // this is recorded (launch review PRIV-1).
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  useEffect(
    () => () => {
      dismiss.current()
    },
    [],
  )
  return (
    <div style={cardStyle} role="region" aria-label="Usage statistics notice">
      <span>
        Clipper sends anonymous usage stats (no replays, names or file paths).
      </span>
      <button
        type="button"
        style={linkStyle}
        onClick={() => openSettings('diagnostics')}
      >
        Turn off
      </button>
      <button
        type="button"
        style={linkStyle}
        onClick={() => window.open('https://www.lunarmelee.com/privacy')}
      >
        Privacy
      </button>
      <button
        type="button"
        style={okStyle(okLit)}
        onClick={onDismiss}
        onMouseEnter={() => setOkLit(true)}
        onMouseLeave={() => setOkLit(false)}
        onFocus={() => setOkLit(true)}
        onBlur={() => setOkLit(false)}
      >
        OK
      </button>
    </div>
  )
}
