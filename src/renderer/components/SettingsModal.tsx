/* eslint-disable jsx-a11y/no-noninteractive-element-interactions */
/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import {
  useState,
  useEffect,
  useContext,
  useRef,
  Dispatch,
  SetStateAction,
} from 'react'
import { videoConfig, settingForPlatform } from 'constants/config'
import { keyboardClick } from '../lib/keyboardClick'
import { DISCORD_URL, GITHUB_URL } from '../../constants/links'
import Modal from './Modal'
import { IntField, PathField } from './SettingsFields'
import { openChangelog } from './WhatsNew'

import {
  ConfigInterface,
  CustomGeckoCode,
  OverlaySourceRule,
  OverlayPosition,
} from '../../constants/types'
import { resolveSource } from '../../lib/overlayTokens'
import { OverlayFontRow, OverlayPreviewImage } from './OverlayFont'
import {
  OVERLAY_FONT_SIZE_DEFAULT,
  OVERLAY_FONT_SIZE_MAX,
  OVERLAY_FONT_SIZE_MIN,
  clampOverlayFontSize,
} from '../../lib/overlayStyle'
import { hasActiveBranches, FILES_TABLE } from '../../lib/filterGraph'
import { ArchiveContext } from '../context/AppContext'
import ipcBridge from '../ipcBridge'
import GeckoCodeList from './GeckoCodeList'
import useGeckoCodes from './useGeckoCodes'
import { openLunarDatabase } from '../lib/openDatabase'
import {
  performanceWarning,
  recordingWarning,
  freeDiskNote,
  hardwareSummary,
} from '../lib/performanceWarnings'
import { ownerSettingsSections, useOwnerAdminView } from '../../owner/renderer'

// IDs that moved out of the settings modal
const hiddenFromSettings = new Set([
  'testMode',
  'testDolphin',
  'outputFilenamePattern', // rendered custom in Output section
  // The three reset-warning tiers are collapsed into one dropdown in the
  // Filters section, so hide their raw checkboxes.
  'warnOnReset60s',
  'warnOnReset10m',
  'warnOnReset1h',
])

// Sidebar sections for settings modal
const settingsSections = [
  { key: 'paths', label: 'Paths' },
  { key: 'project', label: 'Project' },
  { key: 'recording', label: 'Recording' },
  { key: 'encoding', label: 'Encoding' },
  { key: 'rendering', label: 'Gecko Codes' },
  { key: 'textures', label: 'Textures' },
  { key: 'overlay', label: 'Overlay' },
  { key: 'performance', label: 'Performance' },
  { key: 'diagnostics', label: 'Diagnostics' },
  { key: 'about', label: 'About' },
] as const

// One-click quality bundles applied over the individual Video controls. Each
// applies its `settings` to the config; tweaking any of those controls after
// makes the preset selector read "Custom". Resolution values are EFBScale codes
// (2=1x … 7=4x … 11=8x). All presets use CRF (constant quality).
const VIDEO_QUALITY_PRESETS: {
  id: string
  label: string
  hint: string
  settings: Record<string, number | string | boolean>
}[] = [
  {
    id: 'test',
    label: 'Test — 1x, fast',
    hint: 'Low resolution, Fast draft recording, fast encode. For quickly checking a filter or output, not for publishing.',
    settings: {
      resolution: 2,
      recordingFormat: 'draft',
      videoCodec: 'h264',
      videoQualityMode: 'crf',
      crf: 23,
      videoPreset: 'veryfast',
      keepLosslessMaster: false,
    },
  },
  {
    id: 'medium',
    label: 'Medium — 2x, balanced',
    hint: 'Good quality at a sensible size and speed. Great for sharing.',
    settings: {
      resolution: 4,
      videoCodec: 'h264',
      videoQualityMode: 'crf',
      crf: 21,
      videoPreset: 'medium',
      keepLosslessMaster: false,
      recordingFormat: 'auto',
    },
  },
  {
    id: 'high',
    label: 'High — 4x, great quality',
    hint: '4K-class internal resolution, slower encode. Excellent quality.',
    settings: {
      resolution: 7,
      videoCodec: 'h264',
      videoQualityMode: 'crf',
      crf: 18,
      videoPreset: 'slow',
      keepLosslessMaster: false,
      recordingFormat: 'auto',
    },
  },
  {
    id: 'max',
    label: 'Maximum — 8x, everything cranked',
    hint: 'Highest practical quality: 8x internal res, near-transparent CRF, slowest encode. Very large files, very slow. Switch codec to H.265 to roughly halve size, or enable Keep Lossless Master for a pristine editing source.',
    settings: {
      resolution: 11,
      videoCodec: 'h264',
      videoQualityMode: 'crf',
      crf: 16,
      videoPreset: 'veryslow',
      keepLosslessMaster: false,
      recordingFormat: 'auto',
    },
  },
]

// Owner tools add their own sections (empty in release builds), before About.
const allSettingsSections: { key: string; label: string }[] = [
  ...settingsSections.filter((s) => s.key !== 'about'),
  ...ownerSettingsSections.map(({ key, label }) => ({ key, label })),
  ...settingsSections.filter((s) => s.key === 'about'),
]
type SettingsSection = (typeof settingsSections)[number]['key'] | (string & {})

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
  /** Open on this section instead of Paths (e.g. 'recording'). */
  initialSection?: string
}

export default function SettingsModal({
  config,
  setConfig,
  onClose,
  onOpenGeckoModal: _onOpenGeckoModal,
  onRunSetupWizard,
  initialSection,
}: SettingsModalProps) {
  // The owner's sections hide while looking at the regular user's Clipper.
  const adminView = useOwnerAdminView()
  const ownerKeys = new Set(ownerSettingsSections.map((o) => o.key))
  const visibleSections = adminView
    ? allSettingsSections
    : allSettingsSections.filter((s) => !ownerKeys.has(s.key))
  const [activeSection, setActiveSection] = useState<SettingsSection>(
    initialSection ?? 'paths',
  )
  const [overlaySamplePath, setOverlaySamplePath] = useState(
    '/replays/netplay/DaShizWiz/2023/Game_20230202T075353.slp',
  )
  const [resetConfirm, setResetConfirm] = useState(false)
  const [clearPathsConfirm, setClearPathsConfirm] = useState(false)
  const [detectorCache, setDetectorCache] = useState<{
    entries: number
    bytes: number
  } | null>(null)
  useEffect(() => {
    ipcBridge.detectorCache('stats', (r) => setDetectorCache(r?.stats ?? null))
  }, [config.replayLibraryPath])
  const [resetAppConfirm, setResetAppConfirm] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const [logsPath, setLogsPath] = useState('')
  const [exportingLogs, setExportingLogs] = useState(false)
  const [exportedPath, setExportedPath] = useState<string | null>(null)
  const [updateCheckStatus, setUpdateCheckStatus] = useState<
    'idle' | 'checking' | 'up-to-date' | 'available' | 'error'
  >('idle')
  // "Pick settings for this computer": waiting for main to detect and apply.
  const [picking, setPicking] = useState(false)
  const [pickedNote, setPickedNote] = useState('')
  // The last Test Dolphin result (main reports it as a videoMsg).
  const [testStatus, setTestStatus] = useState('')
  const [testRunning, setTestRunning] = useState(false)
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

    const removeVideoMsg = window.electron.ipcRenderer.on('videoMsg', (msg) => {
      if (typeof msg !== 'string') return
      if (
        /^(Launching Dolphin test|Dolphin test|Error: Dolphin|Error: Set Dolphin|Error: test\.slp|Error: dolphinPath|Error: isoPath)/.test(
          msg,
        )
      ) {
        setTestStatus(msg)
        setTestRunning(msg.startsWith('Launching'))
      }
    })

    window.electron.ipcRenderer.sendMessage('getAppVersion', null)
    window.electron.ipcRenderer.sendMessage('getLogsPath', null)

    return () => {
      removeVersionListener()
      removeLogsListener()
      removeUpdateChecking()
      removeUpdateAvailable()
      removeUpdateNotAvailable()
      removeUpdateError()
      removeVideoMsg()
    }
  }, [])

  function handleChange(key: string, value: any) {
    // From the latest config: two boxes committing together (Settings closing) must not undo each other.
    setConfig((prev) => (prev ? { ...prev, [key]: value } : prev))
    ipcBridge.updateConfig({ key, value })
  }

  const {
    expandedGeckoIdx,
    setExpandedGeckoIdx,
    handleAddGeckoCode,
    handleRemoveGeckoCode,
    handleUpdateGeckoCode,
  } = useGeckoCodes(config, handleChange)

  // Apply several config keys at once (one setConfig so none clobber each other,
  // plus a persist per key). Used by the Quality Preset selector.
  function handleChangeMany(patch: Record<string, number | string | boolean>) {
    setConfig({ ...config, ...patch })
    Object.entries(patch).forEach(([key, value]) =>
      ipcBridge.updateConfig({ key, value }),
    )
  }

  // The preset whose bundle currently matches every relevant setting, else
  // 'custom' — so tweaking any individual control below reads as Custom.
  // Picking "Custom" keeps the current values and sends you to the controls
  // below; it reads Custom until a preset is picked again.
  const [customPicked, setCustomPicked] = useState(false)
  const presetItemRef = useRef<HTMLDivElement>(null)
  const matchedPreset =
    VIDEO_QUALITY_PRESETS.find((p) =>
      Object.entries(p.settings).every(
        // An install from before Recording Format existed has no key: auto.
        ([k, v]) =>
          ((config as Record<string, unknown>)[k] ??
            (k === 'recordingFormat' ? 'auto' : undefined)) === v,
      ),
    )?.id || 'custom'
  const currentPreset = customPicked ? 'custom' : matchedPreset
  const applyPreset = (id: string) => {
    if (id === 'custom') {
      setCustomPicked(true)
      const next = presetItemRef.current
        ?.nextElementSibling as HTMLElement | null
      next?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      next
        ?.querySelector<HTMLElement>('select, input, button')
        ?.focus({ preventScroll: true })
      return
    }
    setCustomPicked(false)
    const preset = VIDEO_QUALITY_PRESETS.find((p) => p.id === id)
    if (preset) handleChangeMany(preset.settings)
  }

  // Single source of truth for toggling a checkbox setting — used by the
  // whole-row click. Replicates the branching-disable confirmation that the
  // checkbox's own onChange has (its input is click-inert in a clickable row).
  const toggleCheckbox = (c: { id: string }) => {
    const next = !config[c.id]
    if (c.id === 'branchingEnabled' && !next && projectHasBranches) {
      setBranchDisableConfirm(true)
      return
    }
    handleChange(c.id, next)
  }

  // The three reset-warning tiers (warnOnReset60s/10m/1h) presented as one
  // "warn if the last run took at least X" threshold. Setting it flips the
  // booleans monotonically; the value shown is the lowest still-enabled tier.
  const resetWarnValue =
    config.warnOnReset60s !== false
      ? '1min'
      : config.warnOnReset10m !== false
        ? '10min'
        : config.warnOnReset1h !== false
          ? '1hour'
          : 'never'
  const setResetWarn = (v: string) => {
    const flags: Record<string, Record<string, boolean>> = {
      never: {
        warnOnReset60s: false,
        warnOnReset10m: false,
        warnOnReset1h: false,
      },
      '1min': {
        warnOnReset60s: true,
        warnOnReset10m: true,
        warnOnReset1h: true,
      },
      '10min': {
        warnOnReset60s: false,
        warnOnReset10m: true,
        warnOnReset1h: true,
      },
      '1hour': {
        warnOnReset60s: false,
        warnOnReset10m: false,
        warnOnReset1h: true,
      },
    }
    handleChangeMany(flags[v])
  }

  // --- Custom/HD texture packs ---
  const texturePacks = config.texturePacks || []
  const importTexturePack = () => {
    ipcBridge.getPath('openDirectory', (p) => {
      if (!p) return
      const name = p.split(/[\\/]/).filter(Boolean).pop() || 'Texture pack'
      handleChange('texturePacks', [
        ...texturePacks,
        { id: `pack-${Date.now().toString(36)}`, name, path: p, enabled: true },
      ])
    })
  }
  const toggleTexturePack = (id: string, enabled: boolean) =>
    handleChange(
      'texturePacks',
      texturePacks.map((pk) => (pk.id === id ? { ...pk, enabled } : pk)),
    )
  const removeTexturePack = (id: string) =>
    handleChange(
      'texturePacks',
      texturePacks.filter((pk) => pk.id !== id),
    )

  function handleGetPath(key: string, type: string) {
    ipcBridge.getPath(type as 'openFile' | 'openDirectory', (p) => {
      if (!p) return
      // The library moves with its setting (main asks first and may decline),
      // so show whatever main ends up using.
      if (key === 'replayLibraryPath') {
        ipcBridge.moveReplayLibrary(p, (res) => {
          if (res?.config) setConfig(res.config)
        })
        return
      }
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

  // Detect this computer again and apply the recording settings picked for it
  // (main's resetConfig with only: 'hardware'; every other setting is kept).
  function handlePickForComputer() {
    setPicking(true)
    setPickedNote('')
    const removeListener = window.electron.ipcRenderer.on('config', (cfg) => {
      removeListener()
      setPicking(false)
      if (cfg && typeof cfg === 'object') {
        setConfig(cfg as ConfigInterface)
        setPickedNote('Applied.')
        setTimeout(() => setPickedNote(''), 4000)
      }
    })
    window.electron.ipcRenderer.sendMessage('resetConfig', { only: 'hardware' })
  }

  function handleResetApp() {
    if (!resetAppConfirm) {
      setResetAppConfirm(true)
      return
    }
    setResetAppConfirm(false)
    // Main wipes config + paths to defaults and relaunches; no reply expected.
    window.electron.ipcRenderer.sendMessage('resetApp', null)
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
            <PathField
              id={c.id}
              value={config[c.id] || ''}
              // The Replay Library moves its files when it changes: only Browse
              // (moveReplayLibrary, which asks first) may change it. Typing here
              // re-pointed the library at every half-typed path (launch review CR-3).
              readOnly={c.id === 'replayLibraryPath'}
              title={
                c.id === 'replayLibraryPath'
                  ? 'Use Browse to move the Replay Library'
                  : undefined
              }
              placeholder={
                c.id === 'scratchPath'
                  ? 'System temp folder'
                  : c.type === 'openDirectory'
                    ? '/path/to/directory'
                    : '/path/to/file'
              }
              // Saved when the user is done typing (blur, Enter), not per keystroke. The
              // Replay Library goes through the move (main asks first, and may decline).
              onCommit={(next, revert) => {
                if (c.id === 'replayLibraryPath') {
                  ipcBridge.moveReplayLibrary(next, (res) => {
                    if (res?.config) setConfig(res.config)
                    else revert()
                  })
                  return
                }
                handleChange(c.id, next)
              }}
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
          <IntField
            id={c.id}
            value={config[c.id]}
            onCommit={(n) => handleChange(c.id, n)}
          />
        )
      case 'dropdown':
        return (
          <select
            id={c.id}
            value={config[c.id]}
            className="settings-select"
            onChange={(e) => {
              // Options may carry numeric values (resolutions, etc.) or string
              // values (codec, preset). Coerce to a number only when the string
              // round-trips cleanly; otherwise keep it a string.
              const raw = e.target.value
              const asNum = Number(raw)
              handleChange(
                c.id,
                raw !== '' && String(asNum) === raw ? asNum : raw,
              )
            }}
          >
            {c.options?.map((o: { value: number | string; label: string }) => (
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
              <OverlayPreviewImage
                text={preview}
                font={config.overlayFont || ''}
                size={clampOverlayFontSize(config.overlayFontSize)}
                fallback={
                  <div className="overlay-preview-box">{preview || ' '}</div>
                }
              />
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

            <OverlayFontRow
              value={config.overlayFont || ''}
              onChange={(file) => handleChange('overlayFont', file)}
            />

            <div className="pattern-editor-row">
              <label className="settings-item-label" htmlFor="overlayFontSize">
                Size
              </label>
              <div className="overlay-size-controls">
                <IntField
                  id="overlayFontSize"
                  value={clampOverlayFontSize(config.overlayFontSize)}
                  onCommit={(n) => handleChange('overlayFontSize', n)}
                />
                <span className="settings-item-desc">
                  pixels on a 1080p video ({OVERLAY_FONT_SIZE_MIN} to{' '}
                  {OVERLAY_FONT_SIZE_MAX}; {OVERLAY_FONT_SIZE_DEFAULT} is the
                  default). Text too long for the video is made smaller to fit.
                </span>
              </div>
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
      case 'textures':
        return (
          <div className="settings-list">
            <div
              className="settings-item-desc"
              style={{ padding: '2px 2px 10px', lineHeight: 1.5 }}
            >
              HD/custom textures replace Melee’s built-in art with
              higher-resolution versions — real added detail, unlike resolution
              (which just supersamples). Enabled packs apply to every recording
              and clip preview. Heavy at high resolutions.
            </div>
            <div
              className="settings-item settings-item--clickable"
              onClick={() =>
                handleChange('hdTexturesEnabled', !config.hdTexturesEnabled)
              }
            >
              <div className="settings-item-info">
                <span className="settings-item-label">
                  Definitive Melee HD (bundled)
                </span>
                <span className="settings-item-desc">
                  The community “Definitive Melee HD” pack, shipped with the
                  app.
                </span>
              </div>
              <div className="settings-item-control">
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={!!config.hdTexturesEnabled}
                    readOnly
                  />
                  <span className="settings-toggle-slider" />
                </label>
              </div>
            </div>
            {texturePacks.map((pk) => (
              <div className="settings-item" key={pk.id}>
                <div className="settings-item-info">
                  <label className="settings-item-label">{pk.name}</label>
                  <span
                    className="settings-item-desc"
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: 360,
                    }}
                  >
                    {pk.path}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <label className="settings-toggle">
                    <input
                      type="checkbox"
                      checked={pk.enabled}
                      onChange={(e) =>
                        toggleTexturePack(pk.id, e.target.checked)
                      }
                    />
                    <span className="settings-toggle-slider" />
                  </label>
                  <button
                    type="button"
                    className="settings-action-btn"
                    onClick={() => removeTexturePack(pk.id)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
            <button
              type="button"
              className="settings-action-btn"
              onClick={importTexturePack}
              style={{ alignSelf: 'flex-start', marginTop: 4 }}
            >
              Import texture pack…
            </button>
          </div>
        )

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
                <div
                  className="settings-item settings-item--clickable"
                  key={c.id}
                  onClick={() => toggleCheckbox(c)}
                >
                  <div className="settings-item-info">
                    <span className="settings-item-label">{c.label}</span>
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
      case 'project':
      case 'recording':
      case 'encoding':
      case 'performance': {
        const categoryKey = section
        const items = videoConfig
          .filter(
            (c: any) =>
              c.category === categoryKey && !hiddenFromSettings.has(c.id),
          )
          .map((c) => settingForPlatform(c, window.electronPlatform))
        if (items.length === 0) {
          return (
            <div className="settings-empty">No settings in this section.</div>
          )
        }
        return (
          <div className="settings-list">
            {categoryKey === 'performance' && (
              <div
                className="settings-item"
                title="Worker threads for filter processing (importing, parsing, filtering)"
              >
                <div className="settings-item-info">
                  <label
                    className="settings-item-label"
                    htmlFor="numFilterThreads"
                  >
                    CPU threads for filters
                  </label>
                  <span className="settings-item-desc">
                    How many replays are read and filtered at once. More is
                    faster on a big library.
                  </span>
                </div>
                <div className="settings-item-control">
                  <input
                    type="number"
                    id="numFilterThreads"
                    className="settings-input settings-input--number"
                    min={1}
                    value={config.numFilterThreads}
                    onChange={(e) =>
                      handleChange(
                        'numFilterThreads',
                        Math.max(1, parseInt(e.target.value, 10) || 1),
                      )
                    }
                  />
                </div>
              </div>
            )}
            {categoryKey === 'performance' && (
              <div
                className="settings-item"
                title="Look at this computer's CPU, memory and graphics again and set Dolphin Instances, Recording and Player Resolution, Quality Mode, CRF and Encoder Preset to suit it. Other settings are kept."
              >
                <div className="settings-item-info">
                  <span className="settings-item-label">
                    Settings for this computer
                  </span>
                  <span className="settings-item-desc">
                    {hardwareSummary(config.hardwareProfile) ||
                      'Pick recording settings that suit this computer.'}
                  </span>
                </div>
                <div className="settings-item-control">
                  <button
                    type="button"
                    className="settings-action-btn"
                    disabled={picking}
                    onClick={handlePickForComputer}
                  >
                    {picking
                      ? 'Checking…'
                      : pickedNote || 'Pick settings for this computer'}
                  </button>
                </div>
              </div>
            )}
            {categoryKey === 'encoding' && (
              <div
                ref={presetItemRef}
                className="settings-item"
                title="Apply a bundle of quality settings, or pick Custom to set each option below yourself."
              >
                <div className="settings-item-info">
                  <label
                    className="settings-item-label"
                    htmlFor="qualityPreset"
                  >
                    Quality Preset
                  </label>
                  <span className="settings-item-desc">
                    {VIDEO_QUALITY_PRESETS.find((p) => p.id === currentPreset)
                      ?.hint || 'Custom: set each option below.'}
                  </span>
                </div>
                <select
                  id="qualityPreset"
                  className="settings-select"
                  value={currentPreset}
                  onChange={(e) => applyPreset(e.target.value)}
                >
                  {VIDEO_QUALITY_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                  <option value="custom">Custom</option>
                </select>
              </div>
            )}
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
                    className={`settings-action-btn${clearPathsConfirm ? ' settings-action-btn--danger settings-action-btn--confirm' : ''}`}
                    onClick={() => {
                      // Two clicks: this forgets Dolphin, the ISO, the output folder and ffmpeg.
                      if (!clearPathsConfirm) {
                        setClearPathsConfirm(true)
                        return
                      }
                      setClearPathsConfirm(false)
                      const cleared = {
                        dolphinPath: '',
                        ssbmIsoPath: '',
                        outputPath: '',
                        ffmpegPath: '',
                      }
                      setConfig((prev) =>
                        prev ? { ...prev, ...cleared } : prev,
                      )
                      Object.entries(cleared).forEach(([key, value]) =>
                        ipcBridge.updateConfig({ key, value }),
                      )
                    }}
                    title="Forget the Dolphin, Melee ISO, output folder and ffmpeg paths (you can set them again with the wizard)"
                  >
                    {clearPathsConfirm ? 'Forget these paths?' : 'Clear Paths'}
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
            {items.map((c: any) => {
              const isWide =
                c.type === 'openFile' ||
                c.type === 'openDirectory' ||
                c.type === 'textInput'
              const isCheck = c.type === 'checkbox'
              return (
                <div
                  className={`settings-item${isWide ? ' settings-item--path' : ''}${isCheck ? ' settings-item--clickable' : ''}`}
                  key={c.id}
                  title={c.tooltip || ''}
                  // The hover text, for a screen reader and the keyboard too.
                  aria-description={c.tooltip || undefined}
                  // The whole row toggles a checkbox setting. The toggle switch
                  // is click-inert (pointer-events:none in CSS) so every click in
                  // the row lands here — one handler, no double-fire.
                  onClick={isCheck ? () => toggleCheckbox(c) : undefined}
                >
                  <div className="settings-item-info">
                    {isCheck ? (
                      <span className="settings-item-label">{c.label}</span>
                    ) : (
                      <label className="settings-item-label" htmlFor={c.id}>
                        {c.label}
                      </label>
                    )}
                    {c.description && (
                      <span className="settings-item-desc">
                        {c.description}
                      </span>
                    )}
                    {/* Always shown (not gated on the toggle) so enabling the
                        setting doesn't change the row's height. */}
                    {c.type === 'int' &&
                      performanceWarning(
                        c.id,
                        config[c.id],
                        config.hardwareProfile?.threads,
                        config.hardwareProfile,
                      ) && (
                        <span className="settings-item-warning" role="alert">
                          ⚠{' '}
                          {performanceWarning(
                            c.id,
                            config[c.id],
                            config.hardwareProfile?.threads,
                            config.hardwareProfile,
                          )}
                        </span>
                      )}
                    {recordingWarning(c.id, config) && (
                      <span className="settings-item-warning" role="alert">
                        ⚠ {recordingWarning(c.id, config)}
                      </span>
                    )}
                    {c.id === 'recordingFormat' && freeDiskNote(config) && (
                      <span
                        className={
                          freeDiskNote(config)!.low
                            ? 'settings-item-warning'
                            : 'settings-item-desc'
                        }
                      >
                        {freeDiskNote(config)!.low ? '⚠ ' : ''}
                        {freeDiskNote(config)!.text}
                      </span>
                    )}
                    {c.warning && (
                      <span className="settings-item-warning">{c.warning}</span>
                    )}
                  </div>
                  <div className="settings-item-control">{renderInput(c)}</div>
                </div>
              )
            })}
            {categoryKey === 'project' && (
              <div
                className="settings-item"
                title="Re-running a filter that already processed a lot of files can take a long time; this asks you to confirm first, based on how long its last run took."
              >
                <div className="settings-item-info">
                  <label
                    className="settings-item-label"
                    htmlFor="resetWarnThreshold"
                  >
                    Warn before re-running a slow filter
                  </label>
                  <span className="settings-item-desc">
                    Confirm before re-running a filter whose last run took at
                    least this long.
                  </span>
                </div>
                <select
                  id="resetWarnThreshold"
                  className="settings-select"
                  value={resetWarnValue}
                  onChange={(e) => setResetWarn(e.target.value)}
                >
                  <option value="never">Never</option>
                  <option value="1min">If over 1 minute</option>
                  <option value="10min">If over 10 minutes</option>
                  <option value="1hour">If over 1 hour</option>
                </select>
              </div>
            )}
            {categoryKey === 'recording' && renderOutputSection()}
            {categoryKey === 'paths' && (
              <div
                className="settings-item"
                title="Combos and edgeguards Clipper already found, per game, so re-running a parser (or using the same games in another project) skips reading the replays."
              >
                <div className="settings-item-info">
                  <span className="settings-item-label">Detector cache</span>
                  <span className="settings-item-desc">
                    {detectorCache
                      ? `${detectorCache.entries.toLocaleString()} games · ${(detectorCache.bytes / 1e6).toFixed(1)} MB, in the Replay Library folder.`
                      : 'Results Clipper already found, kept in the Replay Library folder.'}
                  </span>
                </div>
                <div className="settings-item-control">
                  <button
                    type="button"
                    className="settings-action-btn"
                    disabled={!detectorCache?.entries}
                    onClick={() =>
                      ipcBridge.detectorCache('clear', (r) =>
                        setDetectorCache(r?.stats ?? null),
                      )
                    }
                  >
                    Clear
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
                <span className="settings-item-label">Check for Updates</span>
                <span className="settings-item-desc">
                  {updateCheckStatus === 'checking'
                    ? 'Checking...'
                    : updateCheckStatus === 'up-to-date'
                      ? 'You’re on the latest version.'
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
            <div className="settings-item">
              <div className="settings-item-info">
                <span className="settings-item-label">Test Dolphin</span>
                <span className="settings-item-desc">
                  Launch a test Dolphin instance to verify your setup
                </span>
                {testStatus && (
                  <span
                    className={
                      testStatus.startsWith('Error')
                        ? 'settings-item-warning'
                        : 'settings-item-desc'
                    }
                    role={testStatus.startsWith('Error') ? 'alert' : undefined}
                    style={{ userSelect: 'text', whiteSpace: 'pre-wrap' }}
                  >
                    {testStatus}
                  </span>
                )}
              </div>
              <div className="settings-item-control">
                <button
                  type="button"
                  className="settings-action-btn"
                  disabled={testRunning}
                  onClick={() => {
                    setTestStatus('')
                    ipcBridge.testDolphin()
                  }}
                >
                  {testRunning ? 'Testing…' : 'Launch Test'}
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
            {videoConfig
              .filter(
                (c: any) =>
                  c.category === 'diagnostics' && !hiddenFromSettings.has(c.id),
              )
              .map((c: any) => (
                <div
                  className="settings-item settings-item--clickable"
                  key={c.id}
                  title={c.tooltip || ''}
                  onClick={() => toggleCheckbox(c)}
                >
                  <div className="settings-item-info">
                    <span className="settings-item-label">{c.label}</span>
                    {c.description && (
                      <span className="settings-item-desc">
                        {c.description}
                      </span>
                    )}
                  </div>
                  <div className="settings-item-control">{renderInput(c)}</div>
                </div>
              ))}
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
            <div className="settings-item settings-item--danger">
              <div className="settings-item-info">
                <span className="settings-item-label">Reset App</span>
                <span className="settings-item-desc">
                  Put every setting, path and the recent-projects list back to
                  how a new install starts, and restart. Your projects, your
                  Replay Library and all replay files stay exactly where they
                  are; nothing is deleted.
                </span>
              </div>
              <div className="settings-item-control">
                <button
                  type="button"
                  className={`settings-action-btn settings-action-btn--danger${resetAppConfirm ? ' settings-action-btn--confirm' : ''}`}
                  onClick={handleResetApp}
                >
                  {resetAppConfirm ? 'Yes, wipe it and restart' : 'Reset App'}
                </button>
              </div>
            </div>
          </div>
        )

      case 'about':
        return (
          <div className="settings-about">
            <div className="settings-about-title">Lunar Clipper</div>
            <div className="settings-about-version">
              Version {appVersion || '...'}
              {' · '}
              <span
                className="settings-about-link settings-about-link--clickable"
                role="button"
                tabIndex={0}
                onKeyDown={keyboardClick}
                onClick={() => {
                  onClose()
                  openChangelog()
                }}
              >
                What&apos;s new
              </span>
            </div>
            <div className="settings-about-desc">
              Automated clip generation from Slippi replays.
            </div>
            <div className="settings-about-links">
              <span
                className="settings-about-link settings-about-link--clickable"
                role="button"
                tabIndex={0}
                onKeyDown={keyboardClick}
                onClick={() => window.open(GITHUB_URL)}
              >
                GitHub
              </span>
              <span className="settings-about-sep">&middot;</span>
              <span
                className="settings-about-link settings-about-link--clickable"
                role="button"
                tabIndex={0}
                onKeyDown={keyboardClick}
                onClick={() => openLunarDatabase()}
              >
                Lunar Database
              </span>
              <span className="settings-about-sep">&middot;</span>
              <span
                className="settings-about-link settings-about-link--clickable"
                role="button"
                tabIndex={0}
                onKeyDown={keyboardClick}
                onClick={() => window.open(DISCORD_URL)}
              >
                Discord
              </span>
            </div>
          </div>
        )

      default:
        return (
          ownerSettingsSections
            .find((o) => o.key === section)
            ?.render(onClose) ?? null
        )
    }
  }

  const closeSettings = () => {
    onClose()
    setResetConfirm(false)
    setResetAppConfirm(false)
    setClearPathsConfirm(false)
  }

  return (
    <Modal
      overlayClassName="settings-overlay"
      className="settings-modal"
      onClose={closeSettings}
      label="Settings"
    >
      {branchDisableConfirm && (
        <Modal
          overlayClassName="filter-warn-overlay"
          className="filter-warn-modal filter-warn-medium"
          onClose={() => setBranchDisableConfirm(false)}
          label="Disable filter branching?"
        >
          <div className="filter-warn-title">Disable filter branching?</div>
          <div className="filter-warn-body">
            This project has{' '}
            <strong>
              {branchCount} branched filter{branchCount === 1 ? '' : 's'}
            </strong>
            . Disabling branching runs the chain linearly — each filter reads
            from the one directly above it — until you turn branching back on.
            Your branch settings are kept and will be restored when you
            re-enable it.
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
        </Modal>
      )}
      <div className="settings-header">
        <h2 className="settings-title">Settings</h2>
        <button
          type="button"
          className="settings-close"
          onClick={closeSettings}
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
          {visibleSections.map((s) => (
            <button
              type="button"
              key={s.key}
              className={`settings-sidebar-item${activeSection === s.key ? ' settings-sidebar-item--active' : ''}`}
              aria-current={activeSection === s.key ? 'page' : undefined}
              onClick={() => {
                setActiveSection(s.key)
                setResetConfirm(false)
                setResetAppConfirm(false)
                setClearPathsConfirm(false)
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="settings-body">
          <div className="settings-section">
            <h3 className="settings-section-title">
              {visibleSections.find((s) => s.key === activeSection)?.label}
            </h3>
            {renderSectionContent(activeSection)}
          </div>
        </div>
      </div>
    </Modal>
  )
}
