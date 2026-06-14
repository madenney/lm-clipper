/* eslint-disable jsx-a11y/no-noninteractive-element-interactions */
/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import {
  useState,
  useEffect,
  useContext,
  Dispatch,
  SetStateAction,
} from 'react'
import { videoConfig } from 'constants/config'

import {
  ConfigInterface,
  CustomGeckoCode,
  OverlaySourceRule,
  OverlayPosition,
} from '../../constants/types'
import { resolveSource } from '../../lib/overlayTokens'
import { hasActiveBranches, FILES_TABLE } from '../../lib/filterGraph'
import { ArchiveContext } from '../context/AppContext'
import ipcBridge from '../ipcBridge'
import GeckoCodeList from './GeckoCodeList'

// IDs that moved out of the settings modal
const hiddenFromSettings = new Set([
  'testMode',
  'testDolphin',
  'outputFilenamePattern', // rendered custom in Output section
])

// Sidebar sections for settings modal
const settingsSections = [
  { key: 'general', label: 'General' },
  { key: 'paths', label: 'Paths' },
  { key: 'output', label: 'Output' },
  { key: 'overlay', label: 'Overlay' },
  { key: 'video', label: 'Video' },
  { key: 'rendering', label: 'Gecko Codes' },
  { key: 'performance', label: 'Performance' },
  { key: 'diagnostics', label: 'Diagnostics' },
  { key: 'about', label: 'About' },
] as const

type SettingsSection = (typeof settingsSections)[number]['key']

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

// Tokens offered in the overlay pattern builder (superset of filename tokens:
// adds path-derived {source}, {filename}, {folder}, {parentfolder}).
const overlayVariables = [
  { key: 'source', label: 'Source', example: 'Mang0 netplay' },
  { key: 'date', label: 'Date', example: '2026-03-07' },
  { key: 'time', label: 'Time', example: '1430' },
  { key: 'player1', label: 'Player 1', example: 'Mang0' },
  { key: 'player2', label: 'Player 2', example: 'Zain' },
  { key: 'character1', label: 'Character 1', example: 'Fox' },
  { key: 'character2', label: 'Character 2', example: 'Marth' },
  { key: 'stage', label: 'Stage', example: 'FD' },
  { key: 'damage', label: 'Damage', example: '84' },
  { key: 'moves', label: 'Moves', example: '6' },
  { key: 'filename', label: 'Filename', example: 'Game_20230202T075353' },
  { key: 'folder', label: 'Folder', example: 'DaShizWiz' },
  { key: 'parentfolder', label: 'Parent Folder', example: 'netplay' },
]

const overlayPositions: { key: OverlayPosition; label: string }[] = [
  { key: 'bottom-left', label: 'Bottom Left' },
  { key: 'bottom-right', label: 'Bottom Right' },
  { key: 'top-left', label: 'Top Left' },
  { key: 'top-right', label: 'Top Right' },
]

const overlayExtractLabels: Record<OverlaySourceRule['extract'], string> = {
  nextSegment: 'Next folder after marker',
  fixed: 'Fixed text',
  regex: 'Regex capture',
}

type SettingsModalProps = {
  config: ConfigInterface
  setConfig: Dispatch<SetStateAction<ConfigInterface | null>>
  onClose: () => void
  onOpenGeckoModal: () => void
  onRunSetupWizard?: () => void
}

export default function SettingsModal({
  config,
  setConfig,
  onClose,
  onOpenGeckoModal: _onOpenGeckoModal,
  onRunSetupWizard,
}: SettingsModalProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>('general')
  const [overlaySamplePath, setOverlaySamplePath] = useState(
    '/replays/netplay/DaShizWiz/2023/Game_20230202T075353.slp',
  )
  const [resetConfirm, setResetConfirm] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const [logsPath, setLogsPath] = useState('')
  const [exportingLogs, setExportingLogs] = useState(false)
  const [exportedPath, setExportedPath] = useState<string | null>(null)
  const [expandedGeckoIdx, setExpandedGeckoIdx] = useState<number | null>(null)
  const [updateCheckStatus, setUpdateCheckStatus] = useState<
    'idle' | 'checking' | 'up-to-date' | 'available' | 'error'
  >('idle')
  // Confirm before disabling branching while the open project still has branches.
  const [branchDisableConfirm, setBranchDisableConfirm] = useState(false)

  const archiveCtx = useContext(ArchiveContext)
  const archiveFilters = archiveCtx?.archive?.filters ?? []
  const branchCount = archiveFilters.filter((f, i) => {
    if (!f.inputId) return false
    const positional = i === 0 ? FILES_TABLE : archiveFilters[i - 1].id
    return f.inputId !== positional
  }).length
  const projectHasBranches = hasActiveBranches(archiveFilters)

  useEffect(() => {
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

    const removeUpdateChecking = window.electron.ipcRenderer.on(
      'update-checking',
      () => setUpdateCheckStatus('checking'),
    )
    const removeUpdateAvailable = window.electron.ipcRenderer.on(
      'update-available',
      () => setUpdateCheckStatus('available'),
    )
    const removeUpdateNotAvailable = window.electron.ipcRenderer.on(
      'update-not-available',
      () => setUpdateCheckStatus('up-to-date'),
    )
    const removeUpdateError = window.electron.ipcRenderer.on(
      'update-error',
      () => setUpdateCheckStatus('error'),
    )

    window.electron.ipcRenderer.sendMessage('getAppVersion', null)
    window.electron.ipcRenderer.sendMessage('getLogsPath', null)

    return () => {
      removeVersionListener()
      removeLogsListener()
      removeUpdateChecking()
      removeUpdateAvailable()
      removeUpdateNotAvailable()
      removeUpdateError()
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

  function renderInput(c: any) {
    switch (c.type) {
      case 'checkbox':
        return (
          <label className="settings-toggle">
            <input
              type="checkbox"
              id={c.id}
              checked={config[c.id]}
              onChange={(e) => {
                // Disabling branching while branches exist needs a heads-up.
                if (
                  c.id === 'branchingEnabled' &&
                  !e.target.checked &&
                  projectHasBranches
                ) {
                  setBranchDisableConfirm(true)
                  return
                }
                handleChange(c.id, e.target.checked)
              }}
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

  function insertOverlayToken(key: string) {
    const input = document.getElementById(
      'overlay-pattern-input',
    ) as HTMLInputElement | null
    if (!input) return
    const start = input.selectionStart ?? input.value.length
    const end = input.selectionEnd ?? start
    const val = input.value
    const token = `{${key}}`
    const newVal = val.slice(0, start) + token + val.slice(end)
    handleChange('overlayPattern', newVal)
    requestAnimationFrame(() => {
      input.focus()
      const pos = start + token.length
      input.setSelectionRange(pos, pos)
    })
  }

  function updateSourceRules(rules: OverlaySourceRule[]) {
    handleChange('overlaySourceRules', rules)
  }

  function patchRule(index: number, patch: Partial<OverlaySourceRule>) {
    const rules = (config.overlaySourceRules || []).map((r, i) =>
      i === index ? { ...r, ...patch } : r,
    )
    updateSourceRules(rules)
  }

  function addRule() {
    const rules = [...(config.overlaySourceRules || [])]
    rules.push({
      id: `rule_${Date.now()}`,
      marker: '',
      extract: 'nextSegment',
      value: '',
      prefix: '',
      suffix: '',
    })
    updateSourceRules(rules)
  }

  function removeRule(index: number) {
    updateSourceRules(
      (config.overlaySourceRules || []).filter((_, i) => i !== index),
    )
  }

  function moveRule(index: number, dir: -1 | 1) {
    const rules = [...(config.overlaySourceRules || [])]
    const target = index + dir
    if (target < 0 || target >= rules.length) return
    ;[rules[index], rules[target]] = [rules[target], rules[index]]
    updateSourceRules(rules)
  }

  function getOverlayPreview(pattern: string): string {
    const vars: Record<string, string> = {}
    for (const v of overlayVariables) vars[v.key] = v.example
    // {source} is computed live from the sample path + configured rules
    vars.source = resolveSource(
      overlaySamplePath,
      config.overlaySourceRules || [],
    )
    return pattern.replace(/\{(\w+)\}/g, (match, key) => vars[key] ?? match)
  }

  function renderOverlaySection() {
    const enabled = config.overlayEnabled
    const pattern = config.overlayPattern || ''
    const rules = config.overlaySourceRules || []
    const preview = getOverlayPreview(pattern)
    const sourcePreview = resolveSource(overlaySamplePath, rules)

    return (
      <div className="pattern-editor">
        <div className="settings-item overlay-toggle-row">
          <div className="settings-item-info">
            <label className="settings-item-label" htmlFor="overlay-enabled">
              Add overlay
            </label>
            <div className="settings-item-desc">
              Draws a text label onto every exported clip.
            </div>
          </div>
          <div className="settings-item-control">
            <label className="settings-toggle">
              <input
                type="checkbox"
                id="overlay-enabled"
                checked={enabled}
                onChange={(e) =>
                  handleChange('overlayEnabled', e.target.checked)
                }
              />
              <span className="settings-toggle-slider" />
            </label>
          </div>
        </div>

        {enabled && (
          <>
            <div className="pattern-editor-row">
              <label
                className="settings-item-label"
                htmlFor="overlay-pattern-input"
              >
                Overlay text
              </label>
              <input
                type="text"
                id="overlay-pattern-input"
                className="settings-path-input"
                value={pattern}
                onChange={(e) => handleChange('overlayPattern', e.target.value)}
                placeholder="{date} {time} - {source}"
              />
            </div>

            <div className="pattern-variables">
              <span className="pattern-variables-label">Click to insert:</span>
              {overlayVariables.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  className="pattern-var-btn"
                  onClick={() => insertOverlayToken(v.key)}
                  title={`${v.label} — e.g. "${v.example}"`}
                >
                  {`{${v.key}}`}
                </button>
              ))}
            </div>

            <div className="pattern-preview overlay-preview">
              <span className="pattern-preview-label">Preview:</span>
              <div className="overlay-preview-box">{preview || ' '}</div>
            </div>

            <div className="pattern-editor-row">
              <label className="settings-item-label" htmlFor="overlay-position">
                Position
              </label>
              <select
                id="overlay-position"
                className="settings-select"
                value={config.overlayPosition || 'bottom-left'}
                onChange={(e) =>
                  handleChange(
                    'overlayPosition',
                    e.target.value as OverlayPosition,
                  )
                }
              >
                {overlayPositions.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="overlay-rules">
              <div className="overlay-rules-header">
                <span className="settings-item-label">
                  Source rules — define what <code>{'{source}'}</code> resolves
                  to
                </span>
                <div className="overlay-rules-desc">
                  Each clip&apos;s file path is checked against these rules
                  top-to-bottom; the first whose marker is found wins.
                </div>
              </div>

              <div className="overlay-rules-sample">
                <label className="settings-item-label" htmlFor="overlay-sample">
                  Test path
                </label>
                <input
                  type="text"
                  id="overlay-sample"
                  className="settings-path-input"
                  value={overlaySamplePath}
                  onChange={(e) => setOverlaySamplePath(e.target.value)}
                />
                <span className="overlay-sample-result">
                  → <strong>{sourcePreview || '(no match)'}</strong>
                </span>
              </div>

              {rules.map((rule, i) => (
                <div className="overlay-rule" key={rule.id}>
                  <input
                    type="text"
                    className="overlay-rule-marker"
                    placeholder="marker (e.g. netplay)"
                    value={rule.marker}
                    onChange={(e) => patchRule(i, { marker: e.target.value })}
                    title="Path must contain this folder segment to match. Empty = always match (fallback)."
                  />
                  <select
                    className="overlay-rule-extract"
                    value={rule.extract}
                    onChange={(e) =>
                      patchRule(i, {
                        extract: e.target.value as OverlaySourceRule['extract'],
                      })
                    }
                  >
                    {(['nextSegment', 'fixed', 'regex'] as const).map((ex) => (
                      <option key={ex} value={ex}>
                        {overlayExtractLabels[ex]}
                      </option>
                    ))}
                  </select>
                  {rule.extract !== 'nextSegment' && (
                    <input
                      type="text"
                      className="overlay-rule-value"
                      placeholder={
                        rule.extract === 'fixed' ? 'text' : 'regex (1st group)'
                      }
                      value={rule.value}
                      onChange={(e) => patchRule(i, { value: e.target.value })}
                    />
                  )}
                  <input
                    type="text"
                    className="overlay-rule-prefix"
                    placeholder="prefix"
                    value={rule.prefix}
                    onChange={(e) => patchRule(i, { prefix: e.target.value })}
                    title="Text before the value"
                  />
                  <input
                    type="text"
                    className="overlay-rule-suffix"
                    placeholder="suffix"
                    value={rule.suffix}
                    onChange={(e) => patchRule(i, { suffix: e.target.value })}
                    title='Text after the value, e.g. " netplay"'
                  />
                  <div className="overlay-rule-actions">
                    <button
                      type="button"
                      className="overlay-rule-btn"
                      onClick={() => moveRule(i, -1)}
                      disabled={i === 0}
                      title="Move up"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="overlay-rule-btn"
                      onClick={() => moveRule(i, 1)}
                      disabled={i === rules.length - 1}
                      title="Move down"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="overlay-rule-btn overlay-rule-del"
                      onClick={() => removeRule(i)}
                      title="Delete rule"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}

              <button
                type="button"
                className="overlay-add-rule"
                onClick={addRule}
              >
                + Add rule
              </button>
            </div>
          </>
        )}
      </div>
    )
  }

  function renderSectionContent(section: SettingsSection) {
    switch (section) {
      case 'output':
        return renderOutputSection()

      case 'overlay':
        return renderOverlaySection()

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
                    {c.description && (
                      <span className="settings-item-desc">
                        {c.description}
                      </span>
                    )}
                    {c.warning && config[c.id] && (
                      <span className="settings-item-warning">{c.warning}</span>
                    )}
                  </div>
                  <div className="settings-item-control">{renderInput(c)}</div>
                </div>
              )
            })}
            {categoryKey === 'paths' && onRunSetupWizard && (
              <div className="settings-item">
                <div className="settings-item-info">
                  <span className="settings-item-label">Setup Wizard</span>
                  <span className="settings-item-desc">
                    Guided setup for Dolphin and ISO paths
                  </span>
                </div>
                <div
                  className="settings-item-control"
                  style={{ display: 'flex', gap: 8 }}
                >
                  <button
                    type="button"
                    className="settings-action-btn"
                    onClick={() => {
                      const cleared = {
                        dolphinPath: '',
                        ssbmIsoPath: '',
                        outputPath: '',
                        ffmpegPath: '',
                      }
                      setConfig({ ...config, ...cleared })
                      Object.entries(cleared).forEach(([key, value]) =>
                        ipcBridge.updateConfig({ key, value }),
                      )
                    }}
                  >
                    Clear Paths
                  </button>
                  <button
                    type="button"
                    className="settings-action-btn"
                    onClick={() => {
                      onClose()
                      onRunSetupWizard()
                    }}
                  >
                    Run Wizard
                  </button>
                </div>
              </div>
            )}
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
              <div
                className="settings-item-control"
                style={{ display: 'flex', gap: 8 }}
              >
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
                <button
                  type="button"
                  className="settings-action-btn"
                  disabled={exportingLogs}
                  onClick={() => {
                    setExportingLogs(true)
                    setExportedPath(null)
                    const reqId = `${Date.now()}`
                    const remove = window.electron.ipcRenderer.on(
                      'exportLogs',
                      (resp: any) => {
                        if (resp?.requestId !== reqId) return
                        remove()
                        setExportingLogs(false)
                        if (resp.payload?.path) {
                          setExportedPath(resp.payload.path)
                          setTimeout(() => setExportedPath(null), 4000)
                        }
                      },
                    )
                    window.electron.ipcRenderer.sendMessage('exportLogs', {
                      requestId: reqId,
                      payload: null,
                    })
                  }}
                >
                  {exportingLogs
                    ? 'Exporting...'
                    : exportedPath
                      ? 'Exported!'
                      : 'Export Logs'}
                </button>
              </div>
            </div>
            <div className="settings-item">
              <div className="settings-item-info">
                <span className="settings-item-label">Check for Updates</span>
                <span className="settings-item-desc">
                  {updateCheckStatus === 'checking'
                    ? 'Checking...'
                    : updateCheckStatus === 'up-to-date'
                      ? 'You\u2019re on the latest version.'
                      : updateCheckStatus === 'available'
                        ? 'Update available! Close settings to download.'
                        : updateCheckStatus === 'error'
                          ? 'Could not check for updates.'
                          : 'Check GitHub for a newer version.'}
                </span>
              </div>
              <div className="settings-item-control">
                <button
                  type="button"
                  className="settings-action-btn"
                  disabled={updateCheckStatus === 'checking'}
                  onClick={() => {
                    setUpdateCheckStatus('checking')
                    window.electron.ipcRenderer.sendMessage(
                      'check-for-updates',
                      null,
                    )
                  }}
                >
                  Check Now
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
              <span className="settings-about-sep">&middot;</span>
              <span
                className="settings-about-link settings-about-link--clickable"
                onClick={() => window.open('https://discord.gg/ThjMCW3F4R')}
              >
                Discord
              </span>
            </div>
          </div>
        )

      default:
        return null
    }
  }

  return (
    <div
      className="settings-overlay"
      onClick={() => {
        onClose()
        setResetConfirm(false)
      }}
    >
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        {branchDisableConfirm && (
          <div
            className="filter-warn-overlay"
            role="presentation"
            onClick={() => setBranchDisableConfirm(false)}
          >
            <div
              className="filter-warn-modal filter-warn-medium"
              role="presentation"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="filter-warn-title">Disable filter branching?</div>
              <div className="filter-warn-body">
                This project has{' '}
                <strong>
                  {branchCount} branched filter{branchCount === 1 ? '' : 's'}
                </strong>
                . Disabling branching runs the chain linearly — each filter
                reads from the one directly above it — until you turn branching
                back on. Your branch settings are kept and will be restored when
                you re-enable it.
              </div>
              <div className="filter-warn-actions">
                <button
                  type="button"
                  className="filter-warn-btn filter-warn-btn-secondary"
                  onClick={() => setBranchDisableConfirm(false)}
                >
                  Keep branching on
                </button>
                <button
                  type="button"
                  className="filter-warn-btn filter-warn-btn-danger"
                  onClick={() => {
                    handleChange('branchingEnabled', false)
                    setBranchDisableConfirm(false)
                  }}
                >
                  Disable branching
                </button>
              </div>
            </div>
          </div>
        )}
        <div className="settings-header">
          <h2 className="settings-title">Settings</h2>
          <button
            type="button"
            className="settings-close"
            onClick={() => {
              onClose()
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
