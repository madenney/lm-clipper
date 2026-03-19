import { useState } from 'react'
import ipcBridge from '../ipcBridge'
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
  const [mode, setMode] = useState<'extract' | 'replace'>('replace')
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

  const canConfirm = mode === 'replace' || (mode === 'extract' && outputDir)

  return (
    <div className="setup-overlay">
      <div className="setup-card">
        <div className="setup-header">
          <span className="setup-header-title">SLPZ Files Detected</span>
        </div>

        <div className="slpz-body">
          <p className="slpz-description">
            Some of the files you are importing are compressed .slpz replays.
            These need to be decompressed to .slp before they can be used.
          </p>

          <div className="slpz-options">
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
                  Decompress next to the original .slpz file and delete the
                  .slpz
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
                  Decompress all .slp files into a specific folder
                </span>
              </div>
            </label>

            {mode === 'extract' && (
              <div className="slpz-dir-row">
                <input
                  type="text"
                  className="slpz-dir-input"
                  value={outputDir}
                  placeholder="Select output directory..."
                  readOnly
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
            Decompress & Import
          </button>
        </div>
      </div>
    </div>
  )
}
