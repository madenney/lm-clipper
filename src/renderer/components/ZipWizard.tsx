import { useState } from 'react'
import Modal from './Modal'
import ipcBridge from '../ipcBridge'
import PathBox from './PathBox'
import '../styles/SetupWizard.css'
import '../styles/SlpzWizard.css'

type ZipWizardProps = {
  zipFiles: string[]
  defaultOutputDir: string
  onDismiss: () => void
}

export default function ZipWizard({
  zipFiles,
  defaultOutputDir,
  onDismiss,
}: ZipWizardProps) {
  const [outputDir, setOutputDir] = useState(defaultOutputDir)
  const [deleteOriginal, setDeleteOriginal] = useState(false)

  const handleConfirm = () => {
    window.electron.ipcRenderer.sendMessage('zipWizardResponse', {
      outputDir,
      deleteOriginal,
    })
    onDismiss()
  }

  const handleSkip = () => {
    window.electron.ipcRenderer.sendMessage('zipWizardResponse', {
      outputDir: '',
      deleteOriginal: false,
      skip: true,
    })
    onDismiss()
  }

  const handleCancel = () => {
    window.electron.ipcRenderer.sendMessage('zipWizardResponse', null)
    onDismiss()
  }

  const handleBrowse = () => {
    ipcBridge.getPath('openDirectory', (selectedPath: string) => {
      if (selectedPath) setOutputDir(selectedPath)
    })
  }

  const fileLabel =
    zipFiles.length === 1
      ? zipFiles[0].split(/[\\/]/).pop()
      : `${zipFiles.length} zip files`

  return (
    <Modal
      overlayClassName="setup-overlay"
      className="setup-card"
      label="Zip file detected"
    >
      <div className="setup-header">
        <span className="setup-header-title">Zip File Detected</span>
      </div>

      <div className="slpz-body">
        <p className="slpz-description">
          <strong>{fileLabel}</strong> needs to be extracted before the replays
          inside can be imported.
        </p>

        <div className="slpz-options">
          <div className="slpz-dir-row" style={{ marginLeft: 0 }}>
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
        </div>

        <label className="slpz-remember">
          <input
            type="checkbox"
            checked={deleteOriginal}
            onChange={(e) => setDeleteOriginal(e.target.checked)}
          />
          <span>Delete zip file after extraction</span>
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
          Skip .zip files
        </button>
        <button
          type="button"
          className="setup-next-btn"
          onClick={handleConfirm}
          disabled={!outputDir}
        >
          Extract & Import
        </button>
      </div>
    </Modal>
  )
}
