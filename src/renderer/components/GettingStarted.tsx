import { Dispatch, SetStateAction, useEffect } from 'react'
import ipcBridge from '../ipcBridge'
import { ConfigInterface } from '../../constants/types'
import logo from '../../images/logo.png'
import '../styles/GettingStarted.css'

const LUNAR_DB_URL = 'https://www.lunarmelee.com'

type GettingStartedProps = {
  config: ConfigInterface
  triggerSetupWizard: (_mode: 'play' | 'record') => void
}

function StatusRow({
  label,
  ready,
  onSetup,
}: {
  label: string
  ready: boolean
  onSetup: () => void
}) {
  return (
    <div className="gs-status-row">
      <span
        className={`gs-status-dot ${ready ? 'gs-status-dot--ok' : 'gs-status-dot--missing'}`}
      />
      <span className="gs-status-label">{label}</span>
      {ready ? (
        <span className="gs-status-ready">Ready</span>
      ) : (
        <button type="button" className="gs-status-setup" onClick={onSetup}>
          Set up
        </button>
      )}
    </div>
  )
}

// The reusable onboarding content: the 1-2-3 workflow, the playback/ISO setup
// status + launcher, and the Lunar Database link. Rendered both in the Start
// screen's right column and inside the Help → Welcome modal.
export function GettingStarted({
  config,
  triggerSetupWizard,
}: GettingStartedProps) {
  const dolphinReady = !!config.dolphinPath
  const isoReady = !!config.ssbmIsoPath
  const runSetup = () => triggerSetupWizard('record')

  return (
    <div className="gs">
      <div className="gs-heading">Getting started</div>

      <ol className="gs-steps">
        <li className="gs-step">
          <span className="gs-num">1</span>
          <div className="gs-step-body">
            <div className="gs-step-title">Import replays</div>
            <div className="gs-step-desc">
              Drag your <code>.slp</code> / <code>.slpz</code> files — or a
              whole folder — anywhere onto the window, or use{' '}
              <strong>File → Import</strong>.
            </div>
          </div>
        </li>
        <li className="gs-step">
          <span className="gs-num">2</span>
          <div className="gs-step-body">
            <div className="gs-step-title">Filter</div>
            <div className="gs-step-desc">
              Find combos, edgeguards, matchups — or write your own JavaScript
              filters.
            </div>
          </div>
        </li>
        <li className="gs-step">
          <span className="gs-num">3</span>
          <div className="gs-step-body">
            <div className="gs-step-title">Play or record</div>
            <div className="gs-step-desc">
              Watch clips in Dolphin or export MP4s. This uses Slippi&apos;s{' '}
              <strong>Playback</strong> build of Dolphin — installed by the
              Slippi Launcher, and separate from the Netplay build you play
              online with. Lunar Clipper finds it automatically.
            </div>
          </div>
        </li>
      </ol>

      {/* Only show setup when something actually needs it — if Dolphin + ISO
          were auto-detected from Slippi, there's nothing to do here. */}
      {!(dolphinReady && isoReady) && (
        <div className="gs-setup">
          <div className="gs-setup-title">Playback &amp; recording setup</div>
          <StatusRow
            label="Playback Dolphin"
            ready={dolphinReady}
            onSetup={runSetup}
          />
          <StatusRow label="Melee ISO" ready={isoReady} onSetup={runSetup} />
          <button type="button" className="gs-setup-btn" onClick={runSetup}>
            Set up Dolphin &amp; ISO
          </button>
        </div>
      )}

      <button
        type="button"
        className="gs-lunar-btn"
        onClick={() => window.open(LUNAR_DB_URL)}
        title="Browse and download Slippi replays"
      >
        Browse Lunar Database <span className="gs-lunar-arrow">↗</span>
      </button>
    </div>
  )
}

type WelcomeModalProps = GettingStartedProps & {
  setConfig: Dispatch<SetStateAction<ConfigInterface | null>>
  onClose: () => void
}

// Help → Welcome: the same getting-started content as a dismissible overlay,
// available whether or not a project is open. Also lets the user re-enable the
// Start-screen column if they'd hidden it.
export function WelcomeModal({
  config,
  setConfig,
  triggerSetupWizard,
  onClose,
}: WelcomeModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const showOnStart = config.showGettingStarted !== false
  const setShowOnStart = (value: boolean) => {
    setConfig((prev) => (prev ? { ...prev, showGettingStarted: value } : prev))
    ipcBridge.updateConfig({ key: 'showGettingStarted', value })
  }

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div className="gs-modal-overlay" onClick={onClose}>
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div className="gs-modal" onClick={(e) => e.stopPropagation()}>
        <div className="gs-modal-header">
          <span className="gs-modal-title">
            <img className="gs-modal-logo" src={logo} alt="" /> Welcome to Lunar
            Clipper
          </span>
          <button
            type="button"
            className="gs-modal-close"
            onClick={onClose}
            title="Close"
          >
            ×
          </button>
        </div>
        <GettingStarted
          config={config}
          triggerSetupWizard={triggerSetupWizard}
        />
        <label className="gs-modal-toggle">
          <input
            type="checkbox"
            checked={showOnStart}
            onChange={(e) => setShowOnStart(e.target.checked)}
          />
          Show this on the start screen
        </label>
      </div>
    </div>
  )
}
