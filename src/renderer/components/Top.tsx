/* eslint-disable jsx-a11y/no-noninteractive-element-interactions */
/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import { useEffect, useState, Dispatch, SetStateAction } from 'react'
import { IoSettingsSharp } from 'react-icons/io5'
import { videoConfig } from 'constants/config'

import '../styles/Top.css'
import {
  ConfigInterface,
  ShallowArchiveInterface,
  CustomGeckoCode,
} from '../../constants/types'
import ipcBridge from '../ipcBridge'
import GeckoCodeList from './GeckoCodeList'

type TopProps = {
  archive: ShallowArchiveInterface | null
  config: ConfigInterface
  setConfig: Dispatch<SetStateAction<ConfigInterface | null>>
}

// IDs that moved out of the settings modal
const hiddenFromSettings = new Set([
  'advancedMode',
  'testMode',
  'testDolphin',
  'outputFilenamePattern', // rendered custom in Output section
])

// Sidebar sections for settings modal
const settingsSections = [
  { key: 'paths', label: 'Paths' },
  { key: 'output', label: 'Output' },
  { key: 'video', label: 'Video' },
  { key: 'rendering', label: 'Gecko Codes' },
  { key: 'performance', label: 'Performance' },
  { key: 'general', label: 'General' },
  { key: 'diagnostics', label: 'Diagnostics' },
  { key: 'about', label: 'About' },
] as const

type SettingsSection = (typeof settingsSections)[number]['key']

export default function Top({
  archive: _archive,
  config,
  setConfig,
}: TopProps) {
  const [configModalOpen, setConfigModalOpen] = useState(false)
  const [geckoModalOpen, setGeckoModalOpen] = useState(false)
  const [activeSection, setActiveSection] = useState<SettingsSection>('paths')
  const [isImporting, setIsImporting] = useState(false)
  const [importCurrent, setImportCurrent] = useState(0)
  const [importTotal, setImportTotal] = useState<number | null>(null)
  const [appVersion, setAppVersion] = useState('')
  const [logsPath, setLogsPath] = useState('')
  const [resetConfirm, setResetConfirm] = useState(false)
  const [expandedGeckoIdx, setExpandedGeckoIdx] = useState<number | null>(null)

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

    const removeVersionListener = window.electron.ipcRenderer.on(
      'appVersion',
      (version) => {
        if (typeof version === 'string') setAppVersion(version)
      },
    )

    const removeLogsListener = window.electron.ipcRenderer.on(
      'logsPath',
      (p) => {
        if (typeof p === 'string') setLogsPath(p)
      },
    )

    window.electron.ipcRenderer.sendMessage('getAppVersion', null)
    window.electron.ipcRenderer.sendMessage('getLogsPath', null)

    return () => {
      removeListener()
      removeVersionListener()
      removeLogsListener()
    }
  }, [])

  function handleChange(key: string, value: any) {
    setConfig({
      ...config,
      [key]: value,
    })
    ipcBridge.updateConfig({ key, value })
  }

  function handleGetPath(key: string, type: string) {
    ipcBridge.getPath(type as 'openFile' | 'openDirectory', (p) => {
      if (!p) return
      setConfig({
        ...config,
        [key]: p,
      })
      ipcBridge.updateConfig({ key, value: p })
    })
  }

  function handleResetConfig() {
    if (!resetConfirm) {
      setResetConfirm(true)
      return
    }
    setResetConfirm(false)
    const removeListener = window.electron.ipcRenderer.on('config', (cfg) => {
      if (cfg && typeof cfg === 'object') {
        setConfig(cfg as ConfigInterface)
      }
      removeListener()
    })
    window.electron.ipcRenderer.sendMessage('resetConfig', null)
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
          <>
            <input
              type="text"
              id={c.id}
              className="settings-input"
              value={config[c.id]}
              onChange={(e) => handleChange(c.id, e.target.value)}
            />
            {c.hint && <span className="settings-item-hint">{c.hint}</span>}
          </>
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
            {c.options?.map((o: { value: number; label: string }) => (
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

  const patternVariables = [
    { key: 'character1', label: 'Character 1', example: 'Fox' },
    { key: 'character2', label: 'Character 2', example: 'Falco' },
    { key: 'player1', label: 'Player 1', example: 'Mang0' },
    { key: 'player2', label: 'Player 2', example: 'Zain' },
    { key: 'stage', label: 'Stage', example: 'FD' },
    { key: 'date', label: 'Date', example: '2026-03-07' },
    { key: 'time', label: 'Time', example: '1430' },
    { key: 'index', label: 'Index', example: '0001' },
    { key: 'damage', label: 'Damage', example: '84' },
    { key: 'moves', label: 'Moves', example: '6' },
  ]

  function insertVariable(key: string) {
    const input = document.getElementById(
      'pattern-input',
    ) as HTMLInputElement | null
    if (!input) return
    const start = input.selectionStart ?? input.value.length
    const end = input.selectionEnd ?? start
    const val = input.value
    const token = `{${key}}`
    const newVal = val.slice(0, start) + token + val.slice(end)
    handleChange('outputFilenamePattern', newVal)
    // Restore cursor after React re-renders
    requestAnimationFrame(() => {
      input.focus()
      const pos = start + token.length
      input.setSelectionRange(pos, pos)
    })
  }

  function getPatternPreview(pattern: string): string {
    const exampleVars: Record<string, string> = {}
    for (const v of patternVariables) {
      exampleVars[v.key] = v.example
    }
    return pattern.replace(
      /\{(\w+)\}/g,
      (match, key) => exampleVars[key] ?? match,
    )
  }

  function renderOutputSection() {
    const pattern = config.outputFilenamePattern || '{index}'
    const preview = getPatternPreview(pattern)
    const hasSlash = pattern.includes('/')
    const previewParts = hasSlash
      ? {
          folder: preview.slice(0, preview.lastIndexOf('/')),
          file: preview.slice(preview.lastIndexOf('/') + 1),
        }
      : { folder: null, file: preview }

    return (
      <div className="pattern-editor">
        <div className="pattern-editor-desc">
          Control how recorded clips are named and organized. Use variables
          below to build dynamic filenames. Add <code>/</code> to create folder
          structures — e.g.{' '}
          <code>{'{stage}/{character1}_vs_{character2}_{index}'}</code> will
          sort clips into folders by stage.
        </div>

        <div className="pattern-editor-row">
          <label className="settings-item-label" htmlFor="pattern-input">
            Pattern
          </label>
          <input
            type="text"
            id="pattern-input"
            className="settings-path-input"
            value={pattern}
            onChange={(e) =>
              handleChange('outputFilenamePattern', e.target.value)
            }
            placeholder="{index}"
          />
        </div>

        <div className="pattern-variables">
          <span className="pattern-variables-label">Click to insert:</span>
          {patternVariables.map((v) => (
            <button
              key={v.key}
              type="button"
              className="pattern-var-btn"
              onClick={() => insertVariable(v.key)}
              title={`${v.label} — e.g. "${v.example}"`}
            >
              {`{${v.key}}`}
            </button>
          ))}
        </div>

        <div className="pattern-preview">
          <span className="pattern-preview-label">Example output:</span>
          <div className="pattern-preview-path">
            {previewParts.folder && (
              <span className="pattern-preview-folder">
                {previewParts.folder}/
              </span>
            )}
            <span className="pattern-preview-file">{previewParts.file}</span>
            <span className="pattern-preview-ext">.mp4</span>
          </div>
        </div>

        {hasSlash && (
          <div className="pattern-folder-note">
            Folders will be created automatically inside your output directory.
          </div>
        )}
      </div>
    )
  }

  function renderSectionContent(section: SettingsSection) {
    switch (section) {
      case 'output':
        return renderOutputSection()

      case 'rendering': {
        const renderingItems = videoConfig.filter(
          (c: any) =>
            c.category === 'rendering' && !hiddenFromSettings.has(c.id),
        )
        const customCodes: CustomGeckoCode[] = config.customGeckoCodes || []
        return (
          <>
            <div className="settings-list settings-list--grid">
              {renderingItems.map((c: any) => (
                <div className="settings-item" key={c.id}>
                  <div className="settings-item-info">
                    <label className="settings-item-label" htmlFor={c.id}>
                      {c.label}
                    </label>
                  </div>
                  <div className="settings-item-control">{renderInput(c)}</div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 16 }}>
              {/* eslint-disable-next-line react/jsx-no-bind */}
              <GeckoCodeList
                customCodes={customCodes}
                expandedGeckoIdx={expandedGeckoIdx}
                onExpandToggle={setExpandedGeckoIdx}
                onAdd={handleAddGeckoCode}
                onUpdate={handleUpdateGeckoCode}
                onRemove={handleRemoveGeckoCode}
              />
            </div>
          </>
        )
      }

      case 'paths':
      case 'video':
      case 'performance':
      case 'general': {
        const categoryKey = section
        const items = videoConfig.filter(
          (c: any) =>
            c.category === categoryKey && !hiddenFromSettings.has(c.id),
        )
        if (items.length === 0) {
          return (
            <div className="settings-empty">No settings in this section.</div>
          )
        }
        return (
          <div className="settings-list">
            {items.map((c: any) => {
              const isWide =
                c.type === 'openFile' ||
                c.type === 'openDirectory' ||
                c.type === 'textInput'
              return (
                <div
                  className={`settings-item${isWide ? ' settings-item--path' : ''}`}
                  key={c.id}
                  title={c.tooltip || ''}
                >
                  <div className="settings-item-info">
                    <label className="settings-item-label" htmlFor={c.id}>
                      {c.label}
                    </label>
                    {c.warning && config[c.id] && (
                      <span className="settings-item-warning">{c.warning}</span>
                    )}
                  </div>
                  <div className="settings-item-control">{renderInput(c)}</div>
                </div>
              )
            })}
          </div>
        )
      }

      case 'diagnostics':
        return (
          <div className="settings-list">
            <div className="settings-item">
              <div className="settings-item-info">
                <span className="settings-item-label">Test Dolphin</span>
                <span className="settings-item-desc">
                  Launch a test Dolphin instance to verify your setup
                </span>
              </div>
              <div className="settings-item-control">
                <button
                  type="button"
                  className="settings-action-btn"
                  onClick={() => ipcBridge.testDolphin()}
                >
                  Launch Test
                </button>
              </div>
            </div>
            <div className="settings-item">
              <div className="settings-item-info">
                <span className="settings-item-label">Logs Folder</span>
                <span className="settings-item-desc">
                  {logsPath || 'Loading...'}
                </span>
              </div>
              <div className="settings-item-control">
                <button
                  type="button"
                  className="settings-action-btn"
                  onClick={() => {
                    if (logsPath) {
                      window.electron.ipcRenderer.sendMessage(
                        'openFolder',
                        logsPath,
                      )
                    }
                  }}
                >
                  Open Logs
                </button>
              </div>
            </div>
            <div className="settings-item settings-item--danger">
              <div className="settings-item-info">
                <span className="settings-item-label">Reset Settings</span>
                <span className="settings-item-desc">
                  Reset all settings to defaults. Paths will be preserved.
                </span>
              </div>
              <div className="settings-item-control">
                <button
                  type="button"
                  className={`settings-action-btn settings-action-btn--danger${resetConfirm ? ' settings-action-btn--confirm' : ''}`}
                  onClick={handleResetConfig}
                >
                  {resetConfirm ? 'Are you sure?' : 'Reset'}
                </button>
              </div>
            </div>
          </div>
        )

      case 'about':
        return (
          <div className="settings-about">
            <div className="settings-about-title">LM Clipper</div>
            <div className="settings-about-version">
              Version {appVersion || '...'}
            </div>
            <div className="settings-about-desc">
              Automated clip generation from Slippi replays.
            </div>
            <div className="settings-about-links">
              <span
                className="settings-about-link settings-about-link--clickable"
                onClick={() =>
                  window.open('https://github.com/madenney/lm-clipper')
                }
              >
                GitHub
              </span>
              <span className="settings-about-sep">&middot;</span>
              <span
                className="settings-about-link settings-about-link--clickable"
                onClick={() => window.open('https://www.lunarmelee.com')}
              >
                Lunar Database
              </span>
            </div>
          </div>
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
        onClick={() => {
          setConfigModalOpen(false)
          setResetConfirm(false)
        }}
      >
        <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
          <div className="settings-header">
            <h2 className="settings-title">Settings</h2>
            <button
              type="button"
              className="settings-close"
              onClick={() => {
                setConfigModalOpen(false)
                setResetConfirm(false)
              }}
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
          <div className="settings-layout">
            <div className="settings-sidebar">
              {settingsSections.map((s) => (
                <div
                  key={s.key}
                  className={`settings-sidebar-item${activeSection === s.key ? ' settings-sidebar-item--active' : ''}`}
                  onClick={() => {
                    setActiveSection(s.key)
                    setResetConfirm(false)
                  }}
                >
                  {s.label}
                </div>
              ))}
            </div>
            <div className="settings-body">
              <div className="settings-section">
                <h3 className="settings-section-title">
                  {settingsSections.find((s) => s.key === activeSection)?.label}
                </h3>
                {renderSectionContent(activeSection)}
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  function handleAddGeckoCode() {
    const codes = [...(config.customGeckoCodes || [])]
    codes.push({ name: '', code: '', enabled: true })
    handleChange('customGeckoCodes', codes)
    setExpandedGeckoIdx(codes.length - 1)
  }

  function handleRemoveGeckoCode(idx: number) {
    const codes = [...(config.customGeckoCodes || [])]
    codes.splice(idx, 1)
    handleChange('customGeckoCodes', codes)
    if (expandedGeckoIdx === idx) setExpandedGeckoIdx(null)
    else if (expandedGeckoIdx !== null && expandedGeckoIdx > idx)
      setExpandedGeckoIdx(expandedGeckoIdx - 1)
  }

  function handleUpdateGeckoCode(
    idx: number,
    field: keyof CustomGeckoCode,
    value: string | boolean,
  ) {
    const codes = [...(config.customGeckoCodes || [])]
    codes[idx] = { ...codes[idx], [field]: value }
    handleChange('customGeckoCodes', codes)
  }

  function renderGeckoModal() {
    if (!geckoModalOpen) return null

    const geckoItems = videoConfig.filter(
      (c: any) => c.category === 'rendering',
    )
    const customCodes: CustomGeckoCode[] = config.customGeckoCodes || []

    return (
      <div
        className="settings-overlay"
        onClick={() => setGeckoModalOpen(false)}
      >
        <div
          className="settings-modal settings-modal--gecko"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="settings-header">
            <h2 className="settings-title">Gecko Codes</h2>
            <button
              type="button"
              className="settings-close"
              onClick={() => setGeckoModalOpen(false)}
              aria-label="Close gecko codes"
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
            <div className="settings-section">
              <h3 className="settings-section-title">Built-in Codes</h3>
              <div className="settings-list settings-list--grid">
                {geckoItems.map((c: any) => (
                  <div
                    className="settings-item"
                    key={c.id}
                    title={c.tooltip || ''}
                  >
                    <div className="settings-item-info">
                      <label className="settings-item-label" htmlFor={c.id}>
                        {c.label}
                      </label>
                    </div>
                    <div className="settings-item-control">
                      {renderInput(c)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="settings-section">
              {/* eslint-disable react/jsx-no-bind */}
              <GeckoCodeList
                customCodes={customCodes}
                expandedGeckoIdx={expandedGeckoIdx}
                onExpandToggle={setExpandedGeckoIdx}
                onAdd={handleAddGeckoCode}
                onUpdate={handleUpdateGeckoCode}
                onRemove={handleRemoveGeckoCode}
              />
              {/* eslint-enable react/jsx-no-bind */}
            </div>
          </div>
          <div className="settings-footer">
            <button
              type="button"
              className="settings-done-btn"
              onClick={() => setGeckoModalOpen(false)}
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
      {renderGeckoModal()}
      <div className="top-controls">
        <label
          className="top-control"
          title="Worker threads for filter processing"
        >
          <span className="top-control-label">Threads</span>
          <input
            type="number"
            className="top-control-input"
            value={config.numFilterThreads}
            min={1}
            onChange={(e) =>
              handleChange(
                'numFilterThreads',
                parseInt(e.target.value, 10) || 1,
              )
            }
          />
        </label>
      </div>
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
        {config.testMode && (
          <button
            type="button"
            className="top-gecko-btn"
            onClick={() => {
              handleChange('slpzMode', 'ask')
              handleChange('slpzOutputDir', '')
            }}
            title="Reset SLPZ settings to ask every time (dev helper)"
          >
            Reset SLPZ
          </button>
        )}
        <button
          type="button"
          className="top-gecko-btn"
          onClick={() => setGeckoModalOpen(true)}
          title="Configure Gecko Codes for recording"
        >
          Gecko Codes
        </button>
        <div className="gear-icon" onClick={() => setConfigModalOpen(true)}>
          <IoSettingsSharp />
        </div>
      </div>
    </div>
  )
}
