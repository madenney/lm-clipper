import { useState } from 'react'
import Modal from './Modal'
import ipcBridge from '../ipcBridge'
import PathBox from './PathBox'
import '../styles/SetupWizard.css'
import '../styles/SlpzWizard.css'

type SlpzWizardProps = {
  defaultOutputDir: string
  onDismiss: () => void
}

export default function SlpzWizard({
  defaultOutputDir,
  onDismiss,
}: SlpzWizardProps) {
  const [mode, setMode] = useState<'keep' | 'extract' | 'replace'>('keep')
  const [outputDir, setOutputDir] = useState(defaultOutputDir)
  const [remember, setRemember] = useState(false)

  const handleConfirm = () => {
    window.electron.ipcRenderer.sendMessage('slpzWizardResponse', {
      mode,
      outputDir: mode === 'extract' ? outputDir : '',
      remember,
    })
    onDismiss()
  }

  const handleSkip = () => {
    window.electron.ipcRenderer.sendMessage('slpzWizardResponse', {
      mode: 'skip',
      outputDir: '',
      remember: false,
    })
    onDismiss()
  }

  const handleCancel = () => {
    window.electron.ipcRenderer.sendMessage('slpzWizardResponse', null)
    onDismiss()
  }

  const handleBrowse = () => {
    ipcBridge.getPath('openDirectory', (selectedPath: string) => {
      if (selectedPath) setOutputDir(selectedPath)
    })
  }

  const canConfirm = mode !== 'extract' || !!outputDir

  return (
    <Modal
      overlayClassName="setup-overlay"
      className="setup-card"
      label="Compressed replays detected"
    >
      <div className="setup-header">
        <span className="setup-header-title">SLPZ Files Detected</span>
      </div>

      <div className="slpz-body">
        <p className="slpz-description">
          Some of the files you are importing are compressed .slpz replays.
          Clipper can use them as they are, or decompress them to .slp.
        </p>

        <div className="slpz-options">
          <label className="slpz-option">
            <input
              type="radio"
              name="slpzMode"
              checked={mode === 'keep'}
              onChange={() => setMode('keep')}
            />
            <div className="slpz-option-text">
              <span className="slpz-option-label">
                Keep them compressed (recommended)
              </span>
              <span className="slpz-option-desc">
                Import the .slpz files as they are: nothing is written or
                deleted, and they take about 9x less disk than .slp
              </span>
            </div>
          </label>

          <label className="slpz-option">
            <input
              type="radio"
              name="slpzMode"
              checked={mode === 'replace'}
              onChange={() => setMode('replace')}
            />
            <div className="slpz-option-text">
              <span className="slpz-option-label">Replace in-place</span>
              <span className="slpz-option-desc">
                Decompress next to the original .slpz file and delete the .slpz
              </span>
            </div>
          </label>

          <label className="slpz-option">
            <input
              type="radio"
              name="slpzMode"
              checked={mode === 'extract'}
              onChange={() => setMode('extract')}
            />
            <div className="slpz-option-text">
              <span className="slpz-option-label">Extract to directory</span>
              <span className="slpz-option-desc">
                Decompress the .slpz files into this folder and keep the .slpz
                files
              </span>
            </div>
          </label>

          {mode === 'extract' && (
            <div className="slpz-dir-row">
              <PathBox
                className="slpz-dir-input"
                path={outputDir}
                placeholder="Select output directory..."
              />
              <button
                type="button"
                className="slpz-dir-browse"
                onClick={handleBrowse}
              >
                Browse
              </button>
            </div>
          )}
        </div>

        <label className="slpz-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>Remember this choice</span>
        </label>
      </div>

      <div className="slpz-actions">
        <button
          type="button"
          className="slpz-cancel-btn"
          onClick={handleCancel}
        >
          Cancel
        </button>
        <button type="button" className="slpz-skip-btn" onClick={handleSkip}>
          Skip .slpz files
        </button>
        <button
          type="button"
          className="setup-next-btn"
          onClick={handleConfirm}
          disabled={!canConfirm}
        >
          {mode === 'keep' ? 'Import' : 'Decompress & Import'}
        </button>
      </div>
    </Modal>
  )
}
