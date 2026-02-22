/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import { useEffect, useState, Dispatch, SetStateAction } from 'react'
import { IoSettingsSharp } from 'react-icons/io5'
import { videoConfig, settingsCategories } from 'constants/config'

import '../styles/Top.css'
import { ConfigInterface, ShallowArchiveInterface } from '../../constants/types'
import ipcBridge from '../ipcBridge'
import { useTestModeInfo } from '../testModeStore'

type TopProps = {
  archive: ShallowArchiveInterface | null
  config: ConfigInterface
  setConfig: Dispatch<SetStateAction<ConfigInterface | null>>
}

export default function Top({ archive, config, setConfig }: TopProps) {
  const [configModalOpen, setConfigModalOpen] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [importCurrent, setImportCurrent] = useState(0)
  const [importTotal, setImportTotal] = useState<number | null>(null)
  const showTestModeUi = false
  const testModeInfo = useTestModeInfo()
  const imageSizeLabel = Number.isFinite(testModeInfo.imageSize)
    ? Math.round(testModeInfo.imageSize)
    : 0
  const processLabel = testModeInfo.processLabel || 'web render'
  const taskLabel = testModeInfo.taskLabel || 'idle'
  const debugLines = Array.isArray(testModeInfo.debugLines)
    ? testModeInfo.debugLines
    : []

  useEffect(() => {
    const applyStatus = (status: any) => {
      if (!status || typeof status !== 'object') return
      const isImportingNext = !!status.isImporting
      const current = typeof status.current === 'number' ? status.current : 0
      const total = typeof status.total === 'number' ? status.total : null
      setIsImporting(isImportingNext)
      setImportCurrent(isImportingNext ? current : 0)
      setImportTotal(isImportingNext ? total : null)
    }

    const removeListener = window.electron.ipcRenderer.on(
      'importStatus',
      (status) => {
        applyStatus(status)
      },
    )

    ipcBridge.getImportStatus((status) => {
      applyStatus(status)
    })

    return () => {
      removeListener()
    }
  }, [])

  function handleChange(key: string, value: string | number | boolean) {
    setConfig({
      ...config,
      [key]: value,
    })
    ipcBridge.updateConfig({ key, value })
  }

  function handleGetPath(key: string, type: string) {
    ipcBridge.getPath(type as 'openFile' | 'openDirectory', (path) => {
      if (!path) return
      setConfig({
        ...config,
        [key]: path,
      })
      ipcBridge.updateConfig({ key, value: path })
    })
  }

  function renderInput(c: any) {
    switch (c.type) {
      case 'checkbox':
        return (
          <label className="settings-toggle">
            <input
              type="checkbox"
              id={c.id}
              checked={config[c.id]}
              onChange={(e) => handleChange(c.id, e.target.checked)}
            />
            <span className="settings-toggle-slider" />
          </label>
        )
      case 'openFile':
      case 'openDirectory':
        return (
          <div className="settings-path-row">
            <input
              type="text"
              id={c.id}
              className="settings-path-input"
              value={config[c.id] || ''}
              placeholder={
                c.type === 'openDirectory'
                  ? '/path/to/directory'
                  : '/path/to/file'
              }
              onChange={(e) => handleChange(c.id, e.target.value)}
            />
            <button
              type="button"
              className="settings-path-browse"
              onClick={() => handleGetPath(c.id, c.type)}
            >
              Browse
            </button>
          </div>
        )
      case 'textInput':
        return (
          <input
            type="text"
            id={c.id}
            className="settings-input"
            value={config[c.id]}
            onChange={(e) => handleChange(c.id, e.target.value)}
          />
        )
      case 'int':
        return (
          <input
            type="number"
            id={c.id}
            className="settings-input settings-input--number"
            value={config[c.id]}
            onChange={(e) => handleChange(c.id, parseInt(e.target.value, 10))}
          />
        )
      case 'dropdown':
        return (
          <select
            id={c.id}
            value={config[c.id]}
            className="settings-select"
            onChange={(e) => handleChange(c.id, parseInt(e.target.value, 10))}
          >
            {c.options.map((o: { value: number; label: string }) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )
      case 'button':
        return (
          <button
            type="button"
            className="settings-action-btn"
            onClick={() => {
              if (c.id === 'testDolphin') {
                ipcBridge.testDolphin()
              }
            }}
          >
            {c.buttonLabel || c.label}
          </button>
        )
      default:
        return null
    }
  }

  function renderConfigModal() {
    if (!configModalOpen) return null

    return (
      <div
        className="settings-overlay"
        onClick={() => setConfigModalOpen(false)}
      >
        <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
          <div className="settings-header">
            <h2 className="settings-title">Settings</h2>
            <button
              type="button"
              className="settings-close"
              onClick={() => setConfigModalOpen(false)}
              aria-label="Close settings"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path
                  d="M1 1L13 13M1 13L13 1"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
          <div className="settings-body">
            {settingsCategories.map((cat) => {
              const items = videoConfig.filter(
                (c: any) => c.category === cat.key,
              )
              if (items.length === 0) return null
              const isPathCategory = items.every(
                (c: any) => c.type === 'openFile' || c.type === 'openDirectory',
              )
              return (
                <div className="settings-section" key={cat.key}>
                  <h3 className="settings-section-title">{cat.label}</h3>
                  <div
                    className={`settings-list${isPathCategory ? '' : ' settings-list--grid'}`}
                  >
                    {items.map((c: any) => {
                      const isPath =
                        c.type === 'openFile' || c.type === 'openDirectory'
                      return (
                        <div
                          className={`settings-item${isPath ? ' settings-item--path' : ''}`}
                          key={c.id}
                        >
                          <div className="settings-item-info">
                            <label
                              className="settings-item-label"
                              htmlFor={c.id}
                            >
                              {c.label}
                            </label>
                            {c.warning && config[c.id] && (
                              <span className="settings-item-warning">
                                {c.warning}
                              </span>
                            )}
                          </div>
                          <div className="settings-item-control">
                            {renderInput(c)}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="settings-footer">
            <button
              type="button"
              className="settings-done-btn"
              onClick={() => setConfigModalOpen(false)}
            >
              Done
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="top">
      {renderConfigModal()}
      {archive ? (
        <div className="archive-count">Total SLP files: {archive.files}</div>
      ) : null}
      {config.testMode && showTestModeUi ? (
        <>
          <div className="test-mode-pill">Test Mode</div>
          <div className="test-mode-debug">
            <div className="test-mode-line">
              Current image size: {imageSizeLabel}px
            </div>
            <div className="test-mode-line">
              Current process: {processLabel}
            </div>
            <div className="test-mode-line">Current task: {taskLabel}</div>
            {debugLines.map((line, index) => (
              <div className="test-mode-line" key={`${index}-${line}`}>
                {line}
              </div>
            ))}
          </div>
        </>
      ) : null}
      <div className="top-actions">
        {isImporting ? (
          <div className="import-msg">
            <span className="import-spinner" />
            <span className="import-msg-text">Importing</span>
            <span className="import-count">{importCurrent}</span>
            <span className="import-count-divider">/</span>
            {importTotal !== null ? (
              <span className="import-count">{importTotal}</span>
            ) : (
              <span className="import-total-spinner" />
            )}
          </div>
        ) : null}
        {isImporting ? (
          <>
            <button
              type="button"
              className="import-stop"
              onClick={() => ipcBridge.stopImport()}
            >
              Stop
            </button>
            <button
              type="button"
              className="import-cancel"
              onClick={() => ipcBridge.cancelImport()}
            >
              Cancel
            </button>
          </>
        ) : null}
        <div className="gear-icon" onClick={() => setConfigModalOpen(true)}>
          <IoSettingsSharp />
        </div>
      </div>
    </div>
  )
}
