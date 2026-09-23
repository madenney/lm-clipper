import { Dispatch, SetStateAction, useEffect, useState } from 'react'
import ipcBridge from '../ipcBridge'
import { ConfigInterface, ShallowArchiveInterface } from '../../constants/types'
import logo from '../../images/logo.png'
import '../styles/ProjectIdeas.css'

// First-project welcome / starter picker: three "what could I make?" cards shown
// once the user first lands on the main screen (a project is open). Picking one
// builds the matching filter chain (applyStarterChain) and drops the user onto a
// ready-to-run setup. Fires once ever → config.projectIdeasSeen. Distinct from
// the Help → Welcome / Getting Started panel, which is setup/reference.

type Idea = {
  key: string
  // maps to a controller starter-chain key
  chain: 'combos' | 'edgeguards' | 'custom'
  tagline: string
  title: string
  body: string
  bullets: string[]
  cta: string
}

const IDEAS: Idea[] = [
  {
    key: 'combos',
    chain: 'combos',
    tagline: 'The nastiest punishes',
    title: 'Combo compilations',
    body: 'Parse every combo in your replays, then narrow to exactly the ones worth watching.',
    bullets: [
      'Filter by character, damage, hit count, or killing move',
      'e.g. “Falco 4+ hit kills” or “every combo over 80%”',
      'Ranked by damage-per-second, ready to export',
    ],
    cta: 'Start with combos',
  },
  {
    key: 'edgeguards',
    chain: 'edgeguards',
    tagline: 'Offstage kills & gimps',
    title: 'Edgeguard reels',
    body: 'The Edgeguards parser finds offstage sequences on its own — no combo counting required.',
    bullets: [
      'Deep offstage reads, ledge steals, hard gimps',
      'Refine by depth, hits, recovery attempts & more',
      'Ranked by edgeguard score for a “best of” supercut',
    ],
    cta: 'Start with edgeguards',
  },
  {
    key: 'custom',
    chain: 'custom',
    tagline: 'Write your own filter',
    title: 'Anything else',
    body: 'Drop into JavaScript and query the raw frame data for whatever you can dream up.',
    bullets: [
      'Specific tech: phantom hits, rests, wavedashes',
      'Matchup studies, situational stats, your ideas',
      'Full access to each game’s frames + stats',
    ],
    cta: 'Start with custom code',
  },
]

type Props = {
  config: ConfigInterface
  setConfig: Dispatch<SetStateAction<ConfigInterface | null>>
  setArchive: Dispatch<SetStateAction<ShallowArchiveInterface | null>>
  // Replays currently in the project (this fires right after the first import).
  fileCount: number | null
  onClose: () => void
  // Dev screen-switcher preview: don't persist projectIdeasSeen, don't mutate
  // the real filter chain — just close.
  preview?: boolean
}

export default function ProjectIdeas({
  config,
  setConfig,
  setArchive,
  fileCount,
  onClose,
  preview,
}: Props) {
  const [busy, setBusy] = useState<string | null>(null)

  // Any exit path marks the welcome as seen (it's a once-ever first-run screen).
  const markSeen = () => {
    if (preview || config.projectIdeasSeen) return
    setConfig((prev) => (prev ? { ...prev, projectIdeasSeen: true } : prev))
    ipcBridge.updateConfig({ key: 'projectIdeasSeen', value: true })
  }

  const handleClose = () => {
    markSeen()
    onClose()
  }

  const handlePick = (idea: Idea) => {
    if (busy) return
    if (preview) {
      onClose()
      return
    }
    setBusy(idea.chain)
    ipcBridge.applyStarterChain(idea.chain, (response) => {
      if (!response || response?.error) {
        console.error('applyStarterChain error:', response?.error)
        setBusy(null)
        return
      }
      setArchive(response)
      markSeen()
      onClose()
    })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div className="pi-overlay" onClick={handleClose}>
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div className="pi-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pi-header">
          <span className="pi-title">
            <img className="pi-logo" src={logo} alt="" /> What do you want to
            make?
          </span>
          <button
            type="button"
            className="pi-close"
            onClick={handleClose}
            title="Close"
          >
            ×
          </button>
        </div>
        <div className="pi-sub">
          {fileCount && fileCount > 0 ? (
            <>
              You’ve got <strong>{fileCount.toLocaleString()}</strong> replays
              loaded. Pick a starting point and we’ll set up the filters — then
              just run it.
            </>
          ) : (
            <>
              Pick a starting point and we’ll set up the filters for you — then
              import your <code>.slp</code> replays and run it.
            </>
          )}
        </div>

        <div className="pi-cols">
          {IDEAS.map((idea) => (
            <button
              type="button"
              className="pi-col"
              key={idea.key}
              data-busy={busy === idea.chain}
              onClick={() => handlePick(idea)}
              disabled={busy !== null}
            >
              <div className="pi-col-tag">{idea.tagline}</div>
              <div className="pi-col-title">{idea.title}</div>
              <div className="pi-col-body">{idea.body}</div>
              <ul className="pi-col-bullets">
                {idea.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
              <span className="pi-col-cta">
                {busy === idea.chain ? 'Setting up…' : `${idea.cta} →`}
              </span>
            </button>
          ))}
        </div>

        <div className="pi-footer">
          <button
            type="button"
            className="pi-skip"
            onClick={handleClose}
            disabled={busy !== null}
          >
            Skip — I’ll set it up myself
          </button>
        </div>
      </div>
    </div>
  )
}
