import { useState, useEffect, Dispatch, SetStateAction } from 'react'
import { ConfigInterface } from '../../constants/types'
import ipcBridge from '../ipcBridge'
import '../styles/SetupWizard.css'

type Step = {
  key: keyof ConfigInterface
  title: string
  description: string
  dialogType: 'openFile' | 'openDirectory'
}

const allSteps: Step[] = [
  {
    key: 'dolphinPath',
    title: 'Playback Dolphin Path',
    description:
      'LM Clipper requires the Playback build of Slippi Dolphin — this is NOT the same as the regular Slippi Dolphin you use for online play.',
    dialogType: 'openFile',
  },
  {
    key: 'ssbmIsoPath',
    title: 'Melee ISO',
    description: 'You can also drag and drop your ISO file onto this window.',
    dialogType: 'openFile',
  },
  {
    key: 'outputPath',
    title: 'Output Directory',
    description:
      'Recorded clips will be saved here. You can change this or hit Finish to use the default.',
    dialogType: 'openDirectory',
  },
]

// Hard = blocks Next until valid. Soft = warns but allows proceeding.
const HARD_VALIDATED_STEPS = new Set(['dolphinPath'])
const SOFT_VALIDATED_STEPS = new Set(['ssbmIsoPath'])
const ALL_VALIDATED_STEPS = new Set([
  ...HARD_VALIDATED_STEPS,
  ...SOFT_VALIDATED_STEPS,
])

type Platform = 'linux' | 'win32' | 'darwin'

const dolphinInstructions: Record<Platform, { path: string; folder: string }> =
  {
    linux: {
      path: '~/.config/Slippi Launcher/playback/Slippi_Playback-x86_64.AppImage',
      folder: '~/.config/Slippi Launcher/playback',
    },
    win32: {
      path: '%APPDATA%\\Slippi Launcher\\playback\\Slippi Dolphin.exe',
      folder: '%APPDATA%/Slippi Launcher/playback',
    },
    darwin: {
      path: '~/Library/Application Support/Slippi Launcher/playback/Slippi Dolphin.app',
      folder: '~/Library/Application Support/Slippi Launcher/playback',
    },
  }

type ValidationStatus = 'idle' | 'validating' | 'valid' | 'invalid'

type SetupWizardProps = {
  config: ConfigInterface
  setConfig: Dispatch<SetStateAction<ConfigInterface | null>>
  mode: 'play' | 'record'
  onDismiss: (_completed: boolean) => void
}

function validatePath(
  stepKey: string,
  pathValue: string,
  onResult: (_result: { valid: boolean; message: string }) => void,
) {
  if (stepKey === 'dolphinPath') {
    ipcBridge.validateDolphinPath(pathValue, onResult)
  } else if (stepKey === 'ssbmIsoPath') {
    ipcBridge.validateIsoPath(pathValue, onResult)
  }
}

export default function SetupWizard({
  config,
  setConfig,
  mode,
  onDismiss,
}: SetupWizardProps) {
  const steps =
    mode === 'play' ? allSteps.filter((s) => s.key !== 'outputPath') : allSteps
  const [stepIndex, setStepIndex] = useState(() => {
    // Start at the first step that has an empty path
    const firstEmpty = steps.findIndex((s) => !config[s.key])
    return firstEmpty >= 0 ? firstEmpty : 0
  })
  const [error, setError] = useState('')
  const [validationStatus, setValidationStatus] =
    useState<ValidationStatus>('idle')
  const [validationMessage, setValidationMessage] = useState('')
  const [autoDetected, setAutoDetected] = useState(false)
  const [helpExpanded, setHelpExpanded] = useState(false)
  const [folderWarning, setFolderWarning] = useState('')
  const [platformOverride, setPlatformOverride] = useState<Platform | ''>('')

  const detectedPlatform = (window.electronPlatform || 'linux') as Platform
  const platform: Platform = platformOverride || detectedPlatform
  const instructions = dolphinInstructions[platform]

  const step = steps[stepIndex]
  const currentValue = (config[step.key] as string) || ''
  const isOutputStep = step.key === 'outputPath'
  const isDolphinStep = step.key === 'dolphinPath'
  const needsValidation = ALL_VALIDATED_STEPS.has(step.key)
  const isHardValidated = HARD_VALIDATED_STEPS.has(step.key)
  const isValidating = needsValidation && validationStatus === 'validating'
  const canProceed =
    !needsValidation ||
    validationStatus === 'valid' ||
    (!isHardValidated && validationStatus !== 'validating' && currentValue)

  function runValidation(stepKey: string, pathValue: string) {
    setValidationStatus('validating')
    setValidationMessage('')
    setError('')
    validatePath(stepKey, pathValue, (result) => {
      setValidationStatus(result.valid ? 'valid' : 'invalid')
      setValidationMessage(result.message)
    })
  }

  // Auto-detect or auto-validate on mount
  useEffect(() => {
    if (isDolphinStep && !config.dolphinPath) {
      ipcBridge.detectDolphinPath((detected) => {
        if (detected) {
          setConfig({ ...config, dolphinPath: detected })
          ipcBridge.updateConfig({ key: 'dolphinPath', value: detected })
          setAutoDetected(true)
          runValidation('dolphinPath', detected)
        }
      })
    } else if (needsValidation && currentValue && validationStatus === 'idle') {
      runValidation(step.key, currentValue)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-validate when config changes externally (e.g. drag-and-drop)
  useEffect(() => {
    if (needsValidation && currentValue) {
      runValidation(step.key, currentValue)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentValue])

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onDismiss])

  function resetValidation() {
    setValidationStatus('idle')
    setValidationMessage('')
  }

  function handleBrowse() {
    const opts: { type: 'openFile' | 'openDirectory'; defaultPath?: string } = {
      type: step.dialogType,
    }
    if (isDolphinStep) {
      opts.defaultPath = instructions.folder
    }
    ipcBridge.getPath(opts, (p) => {
      if (!p) return
      setAutoDetected(false)
      setConfig({ ...config, [step.key]: p })
      ipcBridge.updateConfig({ key: step.key as string, value: p })
      setError('')

      if (needsValidation) {
        runValidation(step.key, p)
      }
    })
  }

  function handleNext() {
    if (!currentValue && !isOutputStep) {
      setError('Please select a path before continuing.')
      return
    }
    if (isHardValidated && validationStatus !== 'valid') {
      setError('Please select a valid Slippi Dolphin Playback executable.')
      return
    }
    setError('')
    if (stepIndex < steps.length - 1) {
      const nextStep = steps[stepIndex + 1]
      const nextValue = config[nextStep.key] as string
      setStepIndex(stepIndex + 1)
      if (ALL_VALIDATED_STEPS.has(nextStep.key) && nextValue) {
        runValidation(nextStep.key, nextValue)
      } else {
        resetValidation()
      }
    } else if (isOutputStep && !currentValue) {
      ipcBridge.setDefaultOutputPath((defaultPath) => {
        if (defaultPath) {
          setConfig({ ...config, outputPath: defaultPath })
        }
        onDismiss(true)
      })
    } else {
      onDismiss(true)
    }
  }

  function handleBack() {
    setError('')
    if (stepIndex > 0) {
      const prevStep = steps[stepIndex - 1]
      const prevValue = config[prevStep.key] as string
      setStepIndex(stepIndex - 1)
      if (ALL_VALIDATED_STEPS.has(prevStep.key) && prevValue) {
        runValidation(prevStep.key, prevValue)
      } else {
        resetValidation()
      }
    }
  }

  const isLast = stepIndex === steps.length - 1

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div className="setup-overlay" onClick={() => onDismiss(false)}>
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div className="setup-card" onClick={(e) => e.stopPropagation()}>
        <div className="setup-header">
          <div className="setup-header-left">
            <div className="setup-header-title">Setup Required</div>
            <div className="setup-step-indicator">
              Step {stepIndex + 1} of {steps.length}
            </div>
          </div>
          <div className="setup-header-subtitle">One-time configuration</div>
        </div>
        <h2 className="setup-title">{step.title}</h2>
        {step.description && (
          <p className="setup-description">{step.description}</p>
        )}

        {isDolphinStep && (
          <div className="setup-dolphin-help">
            <button
              type="button"
              className="setup-help-toggle"
              onClick={() => setHelpExpanded(!helpExpanded)}
            >
              <span
                className={`setup-help-arrow ${helpExpanded ? 'setup-help-arrow-open' : ''}`}
              />
              How to find the Playback build
              {process.env.NODE_ENV === 'development' && (
                <select
                  className="setup-dev-platform-select"
                  value={platformOverride}
                  onChange={(e) => {
                    e.stopPropagation()
                    setPlatformOverride(e.target.value as Platform | '')
                  }}
                  onClick={(e) => e.stopPropagation()}
                  title="DEV: Override OS for testing"
                >
                  <option value="">
                    {detectedPlatform === 'win32'
                      ? 'Windows'
                      : detectedPlatform === 'darwin'
                        ? 'macOS'
                        : 'Linux'}{' '}
                    (detected)
                  </option>
                  <option value="linux">Linux</option>
                  <option value="win32">Windows</option>
                  <option value="darwin">macOS</option>
                </select>
              )}
            </button>
            {helpExpanded && (
              <div className="setup-help-body">
                <p>
                  You are looking for the playback build of Dolphin:{' '}
                  <strong>{instructions.path.split(/[/\\]/).pop()}</strong>
                </p>
                <p>It&apos;s usually located at:</p>
                <div className="setup-help-path-row">
                  <code className="setup-help-path">
                    {instructions.path
                      .split(/(playback)/i)
                      .map((part, i) =>
                        part.toLowerCase() === 'playback' ? (
                          <strong key={i}>{part}</strong>
                        ) : (
                          part
                        ),
                      )}
                  </code>
                  <button
                    type="button"
                    className="setup-open-folder-btn"
                    onClick={() => {
                      setFolderWarning('')
                      ipcBridge.openDolphinFolder(
                        instructions.folder,
                        (result) => {
                          if (!result.found) {
                            setFolderWarning(
                              'Folder not found. Make sure the Slippi Launcher has downloaded the Playback build.',
                            )
                          }
                        },
                      )
                    }}
                    title="Open folder in file explorer"
                  >
                    &#128193;
                  </button>
                </div>
                {folderWarning && (
                  <p className="setup-folder-warning">{folderWarning}</p>
                )}
              </div>
            )}
          </div>
        )}

        <div className="setup-path-row">
          <input
            type="text"
            className="setup-path-display"
            value={currentValue}
            placeholder={
              isOutputStep
                ? '~/Videos/LM Clipper (default)'
                : 'No path selected'
            }
            onChange={(e) => {
              const val = e.target.value
              setConfig({ ...config, [step.key]: val })
              ipcBridge.updateConfig({ key: step.key as string, value: val })
              setError('')
              setAutoDetected(false)
              if (needsValidation) {
                resetValidation()
              }
            }}
            onBlur={() => {
              if (needsValidation && currentValue) {
                runValidation(step.key, currentValue)
              }
            }}
          />
          <button
            type="button"
            className="setup-browse-btn"
            onClick={handleBrowse}
            disabled={isValidating}
          >
            Browse
          </button>
        </div>

        {needsValidation && validationStatus !== 'idle' && (
          <div
            className={`setup-validation setup-validation-${validationStatus}`}
          >
            {validationStatus === 'validating' && (
              <span className="setup-validation-spinner" />
            )}
            <span>
              {validationStatus === 'validating'
                ? isDolphinStep
                  ? 'Verifying this is the Playback build...'
                  : 'Verifying ISO...'
                : autoDetected && validationStatus === 'valid' && isDolphinStep
                  ? 'Playback Dolphin was automatically found. You can continue.'
                  : validationMessage}
            </span>
          </div>
        )}

        {error && <div className="setup-error">{error}</div>}

        <div className="setup-actions">
          {stepIndex > 0 ? (
            <button
              type="button"
              className="setup-back-btn"
              onClick={handleBack}
            >
              Back
            </button>
          ) : (
            <div />
          )}
          <button
            type="button"
            className={`setup-next-btn${!canProceed ? ' setup-next-btn-disabled' : ''}`}
            onClick={handleNext}
            disabled={isValidating}
          >
            {isLast && isOutputStep && !currentValue
              ? 'Use Default'
              : isLast
                ? 'Finish'
                : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}
