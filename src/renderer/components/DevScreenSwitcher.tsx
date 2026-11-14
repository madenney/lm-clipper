import { CSSProperties, useEffect, useState } from 'react'
import { ConfirmModal } from './FilterModals'
import { setFiltersStyle, useFiltersStyle } from '../lib/filtersStyle'
import { OwnerViewSwitch } from '../../owner/renderer'

// Dev-only screen forcer. Pins one onboarding screen so it renders exclusively
// while you iterate on it — no config reset, no faking first-run conditions.
// "new user" does the real thing: resets config to a fresh install (backed up)
// so the whole flow can be walked; "restore my settings" undoes it.
// Gated by App on NODE_ENV === 'development' (never in a packaged build); persisted to
// config.devForceScreen so it survives an HMR full reload. Never shown to
// normal users.

// The forceable screens. Keep the ids in sync with App.tsx's forced-render
// branch. '' = normal app flow.
// Labels mirror APP_FLOW.md's flow table. "reference" = how-it-works (passive),
// "guidance" = what-to-do-now (active). Keep ids in sync with App.tsx's forced
// branch and with APP_FLOW.md.
export const DEV_SCREENS: { id: string; label: string }[] = [
  { id: '', label: 'Normal (live app)' },
  { id: 'loading', label: '1 · Loading screen' },
  { id: 'empty', label: '2 · Start screen (no project)' },
  { id: 'consent', label: '3 · Usage notice' },
  { id: 'welcome', label: '— · Getting Started (Help→Welcome) — reference' },
  { id: 'whats-new', label: '— · What\u2019s new (the one-time update popup)' },
  {
    id: 'whats-new-history',
    label: '— · What\u2019s new (full history, Settings → About)',
  },
  { id: 'setup-play', label: '7 · Setup wizard — Play' },
  { id: 'setup-record', label: '7 · Setup wizard — Record' },
]

const box: CSSProperties = {
  position: 'fixed',
  left: 10,
  bottom: 10,
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

const COLLAPSED_KEY = 'devScreenSwitcherCollapsed'

export default function DevScreenSwitcher({
  value,
  onChange,
  quickProjects = [],
  onOpenProject,
}: {
  value: string
  onChange: (_value: string) => void
  /** Development builds: config.devProjects, opened in one click. */
  quickProjects?: { label: string; path: string }[]
  onOpenProject?: (_path: string) => void
}) {
  const forcing = value !== ''
  // A saved pre-preview config means you're currently looking at the app as
  // a new user and can go back.
  const [hasBackup, setHasBackup] = useState(false)
  const filtersStyle = useFiltersStyle()
  const [confirmReset, setConfirmReset] = useState(false)
  // Collapsed to just its dot + label (click the left end); remembered.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })
  const toggle = () =>
    setCollapsed((c) => {
      try {
        window.localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1')
      } catch {
        /* storage unavailable: just this session */
      }
      return !c
    })
  useEffect(() => {
    const remove = window.electron.ipcRenderer.on('hasDevBackup', (has) =>
      setHasBackup(has === true),
    )
    window.electron.ipcRenderer.sendMessage('hasDevBackup', null)
    return remove
  }, [])
  const button: CSSProperties = {
    ...select,
    cursor: 'pointer',
    padding: '3px 8px',
  }
  const handle = (
    <button
      type="button"
      onClick={toggle}
      title={
        collapsed
          ? 'Dev screen switcher (click to expand)'
          : 'Collapse the dev screen switcher'
      }
      aria-expanded={!collapsed}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: 'none',
        border: 'none',
        padding: 0,
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
      }}
    >
      <span style={{ ...dot, background: forcing ? '#f0836b' : '#5ec98d' }} />
      <span style={{ letterSpacing: '0.06em', opacity: 0.85 }}>
        {collapsed ? 'DEV' : 'DEV SCREEN'}
      </span>
      <span style={{ opacity: 0.6 }}>{collapsed ? '▸' : '◂'}</span>
    </button>
  )
  if (collapsed) return <div style={box}>{handle}</div>
  return (
    <div style={box} title="Dev-only: force an onboarding screen">
      {handle}
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
      <button
        type="button"
        onClick={() =>
          window.electron.ipcRenderer.sendMessage('resetApp', {
            devPreview: true,
          })
        }
        style={button}
        title="Reset settings to a fresh install and restart, to see what a new user sees. Your real settings are saved; projects on disk are untouched."
      >
        new user
      </button>
      {hasBackup && (
        <button
          type="button"
          onClick={() =>
            window.electron.ipcRenderer.sendMessage('restoreDevBackup', null)
          }
          style={{ ...button, color: '#5ec98d' }}
          title="Put back the settings saved by the last 'new user' reset"
        >
          restore my settings
        </button>
      )}
      <OwnerViewSwitch style={button} />
      <button
        type="button"
        onClick={() =>
          setFiltersStyle(filtersStyle === 'compact' ? 'classic' : 'compact')
        }
        style={button}
        title="Switch the filter list between the compact mock-up and the classic look"
      >
        filters: {filtersStyle}
      </button>
      <button
        type="button"
        onClick={() => setConfirmReset(true)}
        style={{ ...button, color: '#f0836b' }}
        title="Factory reset: settings, paths, Replay Library, My Replays and projects in Documents/Lunar Clipper (to the Trash), then restart. Unlike 'new user', nothing is saved to restore."
      >
        reset all
      </button>
      {confirmReset && (
        <ConfirmModal
          title="Full reset to a brand-new user, then restart"
          body={
            '• every setting and path back to defaults (a copy is kept as config .bak)\n• your Replay Library (index, downloaded replays, downloads), My Replays, the projects in Documents/Lunar Clipper and the transfer history go to the Trash\n\nYour Slippi replay folder and projects saved elsewhere are not touched.'
          }
          confirmLabel="Reset all"
          onConfirm={() => {
            setConfirmReset(false)
            window.electron.ipcRenderer.sendMessage('resetApp', {
              wipeData: true,
            })
          }}
          onCancel={() => setConfirmReset(false)}
        />
      )}
      {quickProjects.map((p) => (
        <button
          key={p.path}
          type="button"
          onClick={() => onOpenProject?.(p.path)}
          style={{ ...button, color: '#8ab4f8' }}
          title={`Open ${p.path}`}
        >
          {p.label}
        </button>
      ))}
    </div>
  )
}
