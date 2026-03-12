import { useState, Dispatch, SetStateAction } from 'react'
import { ConfigInterface } from '../../constants/types'
import ipcBridge from '../ipcBridge'
import '../styles/SetupWizard.css'

type Step = {
  key: keyof ConfigInterface
  title: string
  description: string
  dialogType: 'openFile' | 'openDirectory'
}

const steps: Step[] = [
  {
    key: 'dolphinPath',
    title: 'Slippi Dolphin',
    description:
      'Select your Slippi Dolphin Playback executable. This is the playback build used to render replays. Download from slippi.gg if needed.',
    dialogType: 'openFile',
  },
  {
    key: 'ssbmIsoPath',
    title: 'Melee ISO',
    description:
      'Select your SSBM ISO file (GALE01.iso). Dolphin needs this to render gameplay.',
    dialogType: 'openFile',
  },
  {
    key: 'outputPath',
    title: 'Output Directory',
    description: 'Choose where recorded clips will be saved.',
    dialogType: 'openDirectory',
  },
]

type SetupWizardProps = {
  config: ConfigInterface
  setConfig: Dispatch<SetStateAction<ConfigInterface | null>>
  onDismiss: () => void
}

export default function SetupWizard({
  config,
  setConfig,
  onDismiss,
}: SetupWizardProps) {
  const [stepIndex, setStepIndex] = useState(() => {
    // Start at the first step that has an empty path
    const firstEmpty = steps.findIndex((s) => !config[s.key])
    return firstEmpty >= 0 ? firstEmpty : 0
  })
  const [error, setError] = useState('')

  const step = steps[stepIndex]
  const currentValue = (config[step.key] as string) || ''

  function handleBrowse() {
    ipcBridge.getPath(step.dialogType, (p) => {
      if (!p) return
      setConfig({ ...config, [step.key]: p })
      ipcBridge.updateConfig({ key: step.key, value: p })
      setError('')
    })
  }

  function handleNext() {
    if (!currentValue) {
      setError('Please select a path before continuing.')
      return
    }
    setError('')
    if (stepIndex < steps.length - 1) {
      setStepIndex(stepIndex + 1)
    } else {
      onDismiss()
    }
  }

  function handleBack() {
    setError('')
    if (stepIndex > 0) {
      setStepIndex(stepIndex - 1)
    }
  }

  const isLast = stepIndex === steps.length - 1

  return (
    <div className="setup-overlay">
      <div className="setup-card">
        <div className="setup-step-indicator">
          Step {stepIndex + 1} of {steps.length}
        </div>
        <h2 className="setup-title">{step.title}</h2>
        <p className="setup-description">{step.description}</p>

        <div className="setup-path-row">
          <div className="setup-path-display" title={currentValue}>
            {currentValue || 'No path selected'}
          </div>
          <button type="button" className="setup-browse-btn" onClick={handleBrowse}>
            Browse
          </button>
        </div>

        {error && <div className="setup-error">{error}</div>}

        <div className="setup-actions">
          <button
            type="button"
            className="setup-skip"
            onClick={onDismiss}
          >
            Skip
          </button>
          <div className="setup-nav">
            {stepIndex > 0 && (
              <button type="button" className="setup-back-btn" onClick={handleBack}>
                Back
              </button>
            )}
            <button type="button" className="setup-next-btn" onClick={handleNext}>
              {isLast ? 'Finish' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
