import { useCallback, useRef, useState, type ReactNode } from 'react'
import { FaBolt, FaFilm, FaRobot } from 'react-icons/fa'
import { useModal } from '../hooks/useModal'
import type { StartOption } from '../lib/startOptions'
import { ConfigInterface } from '../../constants/types'
import logo from '../../images/logo.png'
import '../styles/GettingStarted.css'

type GettingStartedProps = {
  config: ConfigInterface
  triggerSetupWizard: (_mode: 'play' | 'record') => void
}

// Look for edgeguards: a stage with a block on its ledge and one below and to
// the side (user's pick, 2026-10-06: "Downloads/edgeguard icons/blocks/023").
function EdgeguardIcon() {
  return (
    <svg viewBox="6 16 52 42" width="36" height="29" aria-hidden>
      <path d="M10 34 H34 V38 L28 50 H10 Z" fill="#2f6f86" />
      <rect x="24" y="23" width="9" height="9" rx="1.5" fill="#5fb7d4" />
      <rect x="42" y="44" width="9" height="9" rx="1.5" fill="#f0a04b" />
    </svg>
  )
}

const START_OPTIONS: {
  id: StartOption
  icon: ReactNode
  title: string
}[] = [
  {
    id: 'combos',
    icon: <FaBolt />,
    title: 'Look for combos',
  },
  {
    id: 'games',
    icon: <FaFilm />,
    title: 'Record full games',
  },
  {
    id: 'edgeguards',
    icon: <EdgeguardIcon />,
    title: 'Look for edgeguards',
  },
  {
    id: 'ai',
    icon: <FaRobot />,
    title: 'Use AI',
  },
]

/** Setup still needed for Play/Record, shown under the options only when
 *  Dolphin or the ISO wasn't found. */
function SetupLine({ config, triggerSetupWizard }: GettingStartedProps) {
  const dolphinReady = !!config.dolphinPath
  const isoReady = !!config.ssbmIsoPath
  if (dolphinReady && isoReady) return null
  return (
    <div className="gs-start-setup">
      <span>
        To play or record clips, Clipper needs{' '}
        {[
          !dolphinReady && 'Slippi’s Playback Dolphin',
          !isoReady && 'your Melee ISO',
        ]
          .filter(Boolean)
          .join(' and ')}
        .
      </span>
      <button
        type="button"
        className="gs-status-setup"
        onClick={() => triggerSetupWizard('record')}
      >
        Set up
      </button>
    </div>
  )
}

type WelcomeModalProps = GettingStartedProps & {
  onClose: () => void
  /** One of the four start options was clicked (App acts, then closes). */
  onChoose: (_option: StartOption) => void
  /** "Don't show this again" ticked (config.hideWelcome). */
  hidden: boolean
  onHiddenChange: (_hidden: boolean) => void
}

// Welcome / getting started. Opens by itself the first time a project is open
// in each session until "Don't show this again" is ticked (user, 2026-10-03);
// also from the top bar's ? button and Help → Welcome.
/** How long the card takes to shrink into the ? (matches gs-modal-fly in GettingStarted.css). */
const LEAVE_MS = 340

export function WelcomeModal({
  config,
  triggerSetupWizard,
  onClose,
  onChoose,
  hidden,
  onHiddenChange,
}: WelcomeModalProps) {
  // Leaving, the card shrinks into the ? in the top bar (and the ? glows once):
  // it's a layer over the project, and that's where it lives (user, 2026-10-08).
  const modalRef = useRef<HTMLDivElement>(null)
  const [leaving, setLeaving] = useState(false)
  const leave = useCallback(
    (then: () => void) => {
      if (leaving) return
      const modal = modalRef.current
      const help = document.querySelector<HTMLElement>('.top-help-btn')
      const still =
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ||
        !modal ||
        !help
      if (modal && help && !still) {
        const m = modal.getBoundingClientRect()
        const t = help.getBoundingClientRect()
        modal.style.setProperty(
          '--fly-x',
          `${t.left + t.width / 2 - (m.left + m.width / 2)}px`,
        )
        modal.style.setProperty(
          '--fly-y',
          `${t.top + t.height / 2 - (m.top + m.height / 2)}px`,
        )
        window.setTimeout(() => {
          help.classList.add('top-help-btn--glow')
          window.setTimeout(
            () => help.classList.remove('top-help-btn--glow'),
            1000,
          )
        }, LEAVE_MS - 60)
      }
      setLeaving(true)
      window.setTimeout(then, still ? 120 : LEAVE_MS)
    },
    [leaving],
  )
  const close = useCallback(() => leave(onClose), [leave, onClose])

  // Focus in, Tab kept inside, Esc closes (hooks/useModal.ts); the box is also what flies to the ?.
  useModal({ ref: modalRef, onEscape: close })

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      className={`gs-modal-overlay${leaving ? ' gs-modal-overlay--leaving' : ''}`}
      onClick={close}
    >
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions, jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={modalRef}
        className={`gs-modal${leaving ? ' gs-modal--leaving' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gs-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="gs-modal-header">
          <span className="gs-modal-title" id="gs-modal-title">
            Welcome
            <img className="gs-modal-logo" src={logo} alt="" />
          </span>
          <button
            type="button"
            className="gs-modal-close"
            onClick={close}
            title="Close"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="gs-start-lead">What do you want to do first?</div>
        <div className="gs-start-grid">
          {START_OPTIONS.map((o) => (
            <button
              key={o.id}
              type="button"
              className={`gs-start-option gs-start-option--${o.id}`}
              onClick={() => leave(() => onChoose(o.id))}
            >
              <span className="gs-start-icon">{o.icon}</span>
              <span className="gs-start-text">
                <span className="gs-start-title">{o.title}</span>
              </span>
              <span className="gs-start-go" aria-hidden>
                →
              </span>
            </button>
          ))}
        </div>
        <SetupLine config={config} triggerSetupWizard={triggerSetupWizard} />
        <div className="gs-start-note">
          A <strong>replay</strong> is a saved game (.slp or .slpz); a{' '}
          <strong>clip</strong> is a moment found in one, like a combo. No
          replays yet? The Lunar Database (the globe in the top bar) has
          millions to download.
        </div>
        <div className="gs-modal-footer">
          <label className="gs-modal-dontshow">
            <input
              type="checkbox"
              checked={hidden}
              onChange={(e) => onHiddenChange(e.target.checked)}
            />
            Don&apos;t show this again
          </label>
          <span className="gs-modal-reopen">
            Open it any time with ? in the top bar.
          </span>
          <button type="button" className="gs-modal-done" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
