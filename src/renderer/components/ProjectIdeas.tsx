import { Dispatch, SetStateAction, useEffect, useRef, useState } from 'react'
import ipcBridge from '../ipcBridge'
import { ConfigInterface } from '../../constants/types'
import logo from '../../images/logo.png'
import '../styles/ProjectIdeas.css'

// First-project welcome: three "what could I make?" columns, shown once the user
// first lands on the main screen (a project is open). Distinct from the Help →
// Welcome / Getting Started panel, which is setup/reference. Dismissed for good
// via "Don't show this again" (default on) → config.projectIdeasSeen.

type Idea = {
  key: string
  tagline: string
  title: string
  body: string
  bullets: string[]
}

const IDEAS: Idea[] = [
  {
    key: 'combos',
    tagline: 'The nastiest punishes',
    title: 'Combo compilations',
    body: 'Parse every combo in your replays, then narrow to exactly the ones worth watching.',
    bullets: [
      'Filter by character, damage, hit count, or killing move',
      'e.g. “Falco 4+ hit kills” or “every combo over 80%”',
      'Sort by damage-per-second and export the best',
    ],
  },
  {
    key: 'edgeguards',
    tagline: 'Offstage kills & gimps',
    title: 'Edgeguard reels',
    body: 'The Edgeguards parser finds offstage sequences on its own — no combo counting required.',
    bullets: [
      'Deep offstage reads, ledge steals, hard gimps',
      'Refine by depth, hits, recovery attempts & more',
      'Perfect for a “best edgeguards” supercut',
    ],
  },
  {
    key: 'custom',
    tagline: 'Write your own filter',
    title: 'Anything else',
    body: 'Drop into JavaScript and query the raw frame data for whatever you can dream up.',
    bullets: [
      'Specific tech: phantom hits, rests, wavedashes',
      'Matchup studies, situational stats, your ideas',
      'Full access to each game’s frames + stats',
    ],
  },
]

type Props = {
  config: ConfigInterface
  setConfig: Dispatch<SetStateAction<ConfigInterface | null>>
  onClose: () => void
  // Dev screen-switcher preview: don't persist projectIdeasSeen on close.
  preview?: boolean
}

export default function ProjectIdeas({
  config,
  setConfig,
  onClose,
  preview,
}: Props) {
  const [dontShow, setDontShow] = useState(true)
  const dontShowRef = useRef(dontShow)
  dontShowRef.current = dontShow

  const handleClose = () => {
    if (!preview && dontShowRef.current && !config.projectIdeasSeen) {
      setConfig((prev) => (prev ? { ...prev, projectIdeasSeen: true } : prev))
      ipcBridge.updateConfig({ key: 'projectIdeasSeen', value: true })
    }
    onClose()
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
          Lunar Clipper turns your <code>.slp</code> replays into clips. Three
          ways to start —
        </div>

        <div className="pi-cols">
          {IDEAS.map((idea) => (
            <div className="pi-col" key={idea.key}>
              <div className="pi-col-tag">{idea.tagline}</div>
              <div className="pi-col-title">{idea.title}</div>
              <div className="pi-col-body">{idea.body}</div>
              <ul className="pi-col-bullets">
                {idea.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="pi-footer">
          <label className="pi-dontshow">
            <input
              type="checkbox"
              checked={dontShow}
              onChange={(e) => setDontShow(e.target.checked)}
            />
            Don’t show this again
          </label>
          <button type="button" className="pi-got-it" onClick={handleClose}>
            Got it — let’s go
          </button>
        </div>
      </div>
    </div>
  )
}
