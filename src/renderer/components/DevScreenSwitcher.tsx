import { CSSProperties } from 'react'

// Dev-only screen forcer. Pins one onboarding screen so it renders exclusively
// while you iterate on it — no config reset, no faking first-run conditions.
// Gated by App on (NODE_ENV === 'development' || config.testMode); persisted to
// config.devForceScreen so it survives an HMR full reload. Never shown to
// normal users.

// The forceable screens. Keep the ids in sync with App.tsx's forced-render
// branch. '' = normal app flow.
export const DEV_SCREENS: { id: string; label: string }[] = [
  { id: '', label: 'Normal (live app)' },
  { id: 'loading', label: 'Loading screen' },
  { id: 'consent', label: 'Consent notice' },
  { id: 'welcome', label: 'Welcome modal' },
  { id: 'project-ideas', label: 'Project ideas (1st project)' },
  { id: 'setup-play', label: 'Setup wizard — Play' },
  { id: 'setup-record', label: 'Setup wizard — Record' },
  { id: 'empty', label: 'Empty / start screen' },
]

const box: CSSProperties = {
  position: 'fixed',
  left: 10,
  bottom: 60,
  zIndex: 100000,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 10px',
  borderRadius: 8,
  background: 'rgba(20,25,34,0.92)',
  border: '1px solid #3a4658',
  boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
  font: '12px/1.2 ui-monospace, monospace',
  color: '#cfd6e0',
  pointerEvents: 'auto',
}

const dot: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: '50%',
  background: '#f0836b',
  boxShadow: '0 0 6px #f0836b',
}

const select: CSSProperties = {
  font: '12px ui-monospace, monospace',
  color: '#e7ebf2',
  background: '#0f151d',
  border: '1px solid #3a4658',
  borderRadius: 5,
  padding: '3px 6px',
}

export default function DevScreenSwitcher({
  value,
  onChange,
}: {
  value: string
  onChange: (_value: string) => void
}) {
  const forcing = value !== ''
  return (
    <div style={box} title="Dev-only: force an onboarding screen">
      <span style={{ ...dot, background: forcing ? '#f0836b' : '#5ec98d' }} />
      <span style={{ letterSpacing: '0.06em', opacity: 0.85 }}>DEV SCREEN</span>
      <select
        style={select}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {DEV_SCREENS.map((s) => (
          <option key={s.id || 'normal'} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      {forcing && (
        <button
          type="button"
          onClick={() => onChange('')}
          style={{
            ...select,
            cursor: 'pointer',
            padding: '3px 8px',
            color: '#f0836b',
          }}
          title="Stop forcing — back to normal"
        >
          clear
        </button>
      )}
    </div>
  )
}
