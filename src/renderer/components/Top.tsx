import { useEffect, useState, Dispatch, SetStateAction, ReactNode } from 'react'
import { FiDownload, FiHelpCircle, FiPlus, FiSettings } from 'react-icons/fi'
import { HiGlobeAlt } from 'react-icons/hi'

import '../styles/Top.css'
import '../styles/TopBar.css'
import { ConfigInterface } from '../../constants/types'
import ipcBridge from '../ipcBridge'
import useIpcListener from '../hooks/useIpcListener'
import SettingsModal from './SettingsModal'
import GeckoModal from './GeckoModal'
import Tooltip from './Tooltip'
import { openLunarDatabase } from '../lib/openDatabase'
import { AddReplaysDialog } from './AddReplays'
import { Transfer } from '../../constants/database'
import {
  OPEN_SETTINGS_EVENT,
  type OpenSettingsDetail,
} from '../lib/openSettings'
import { SHOW_WELCOME_EVENT } from '../lib/welcome'
import { downloadsBadgeCount } from '../lib/transferBadge'
import { OwnerTopButtons } from '../../owner/renderer'

type TopProps = {
  config: ConfigInterface
  setConfig: Dispatch<SetStateAction<ConfigInterface | null>>
  onRunSetupWizard?: () => void
  /** Play / Record / Video Tools and their options: the bar's left side. */
  actions?: ReactNode
  /** Small buttons just before Settings (the console). */
  trailing?: ReactNode
}

export default function Top({
  config,
  setConfig,
  onRunSetupWizard,
  actions,
  trailing,
}: TopProps) {
  const [configModalOpen, setConfigModalOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<string | undefined>()
  const [geckoModalOpen, setGeckoModalOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [transfers, setTransfers] = useState<Transfer[]>([])
  useIpcListener('databaseTransfers', (jobs: Transfer[]) => {
    if (Array.isArray(jobs)) setTransfers(jobs)
  })
  const [isImporting, setIsImporting] = useState(false)
  const [importCurrent, setImportCurrent] = useState(0)
  const [importTotal, setImportTotal] = useState<number | null>(null)
  // The ZIP being unpacked before its import, or null while importing.
  const [extracting, setExtracting] = useState<string | null>(null)

  const applyStatus = (status: any) => {
    if (!status || typeof status !== 'object') return
    const isImportingNext = !!status.isImporting
    const current = typeof status.current === 'number' ? status.current : 0
    const total = typeof status.total === 'number' ? status.total : null
    setIsImporting(isImportingNext)
    setImportCurrent(isImportingNext ? current : 0)
    setImportTotal(isImportingNext ? total : null)
    setExtracting(
      isImportingNext && status.phase === 'extracting'
        ? String(status.label || 'ZIP')
        : null,
    )
  }

  useIpcListener('importStatus', applyStatus)

  // Other parts of the app open Settings on a section (the recording options' "Video settings").
  useEffect(() => {
    const open = (event: Event) => {
      setSettingsSection(
        (event as CustomEvent<OpenSettingsDetail>).detail?.section,
      )
      setConfigModalOpen(true)
    }
    window.addEventListener(OPEN_SETTINGS_EVENT, open)
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, open)
  }, [])

  useEffect(() => {
    ipcBridge.getImportStatus(applyStatus)
    ipcBridge.database({ action: 'list' }, (response) => {
      if (response.transfers) setTransfers(response.transfers)
    })
  }, [])

  function handleChange(key: string, value: any) {
    setConfig({
      ...config,
      [key]: value,
    })
    ipcBridge.updateConfig({ key, value })
  }

  // The test helpers (Reset SLPZ / Onboarding / App) exist in development builds only: a packaged
  // build never shows them, whatever config.testMode says in lm-clipper.json.
  const devTools = process.env.NODE_ENV === 'development' && !!config.testMode

  return (
    <div className="top">
      {addOpen && <AddReplaysDialog onClose={() => setAddOpen(false)} />}
      {configModalOpen && (
        <SettingsModal
          config={config}
          setConfig={setConfig}
          onClose={() => setConfigModalOpen(false)}
          onOpenGeckoModal={() => {
            setConfigModalOpen(false)
            setGeckoModalOpen(true)
          }}
          onRunSetupWizard={onRunSetupWizard}
          initialSection={settingsSection}
        />
      )}
      {geckoModalOpen && (
        <GeckoModal
          config={config}
          setConfig={setConfig}
          onClose={() => setGeckoModalOpen(false)}
        />
      )}
      <div className="top-controls">{actions}</div>
      <div className="top-actions">
        {isImporting ? (
          <div className="import-msg">
            <span className="import-spinner" />
            <span
              className="import-msg-text"
              title={
                extracting
                  ? 'Unpacking the ZIP; its replays are imported next'
                  : undefined
              }
            >
              {extracting ? `Extracting ${extracting}` : 'Importing'}
            </span>
            <span className="import-count">{importCurrent}</span>
            <span className="import-count-divider">/</span>
            {importTotal !== null ? (
              <span className="import-count">{importTotal}</span>
            ) : (
              <span className="import-total-spinner" />
            )}
          </div>
        ) : null}
        {/* One button: Stop and Cancel did the same thing (end the import;
            games already added stay, nothing from a ZIP being extracted is
            imported). */}
        {isImporting ? (
          <button
            type="button"
            className="import-stop"
            title={
              extracting
                ? 'Stop extracting: nothing from this ZIP is imported'
                : 'Stop importing: the games added so far stay in the project'
            }
            onClick={() => ipcBridge.stopImport()}
          >
            Stop
          </button>
        ) : null}
        {devTools && (
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
        {/* Dev helper — replays first-run onboarding on the CURRENT project
            without a full app reset: clears the consent + welcome "seen" flags
            and any forced dev screen, then reloads the renderer. If the open
            project has files, the "What to make?" modal fires again right away
            (after dismissing consent). testMode-gated. */}
        {devTools && (
          <button
            type="button"
            className="top-gecko-btn"
            onClick={() => {
              ipcBridge.updateConfig({ key: 'consentNoticeSeen', value: false })
              ipcBridge.updateConfig({ key: 'projectIdeasSeen', value: false })
              ipcBridge.updateConfig({ key: 'devForceScreen', value: '' })
              setTimeout(() => window.location.reload(), 100)
            }}
            title="Replay first-run onboarding (consent + welcome) on the current project and reload (dev helper)"
          >
            Reset Onboarding
          </button>
        )}
        {/* Dev helper — wipes config to first-run and restarts, with NO confirm.
            testMode-gated like the Reset SLPZ button beside it: a one-click,
            unconfirmed "delete everything" is a footgun in a shipped build. */}
        {devTools && (
          <button
            type="button"
            className="top-lunar-btn"
            onClick={() => {
              // Wipes settings and Clipper's library data: ask first.
              if (
                // eslint-disable-next-line no-alert
                window.confirm(
                  'Reset the app to first run and restart? This wipes settings and the Replay Library.',
                )
              )
                window.electron.ipcRenderer.sendMessage('resetApp', null)
            }}
            title="Reset app to first-run and restart (dev helper)"
          >
            <span>Reset App</span>
          </button>
        )}
        <div className="tb-group">
          <Tooltip text="Add replays from this PC or the Lunar Database">
            <button
              type="button"
              className="tb tb--icon"
              onClick={() => setAddOpen(true)}
              aria-label="Add replays"
            >
              <FiPlus />
            </button>
          </Tooltip>
          <Tooltip text="Lunar Database: browse and download Slippi replays">
            <button
              type="button"
              className="tb tb--icon tb--icon-accent"
              onClick={() => openLunarDatabase('search')}
              aria-label="Lunar Database"
            >
              <HiGlobeAlt />
            </button>
          </Tooltip>
          <Tooltip text="Your downloads">
            <button
              type="button"
              className="tb tb--icon"
              onClick={() => openLunarDatabase('transfers')}
              aria-label="Downloads"
            >
              <FiDownload />
              {downloadsBadgeCount(transfers) > 0 && (
                <span className="tb-count">
                  {downloadsBadgeCount(transfers)}
                </span>
              )}
            </button>
          </Tooltip>
          <OwnerTopButtons />
          <Tooltip text="Getting started">
            <button
              type="button"
              className="tb tb--icon top-help-btn"
              onClick={() =>
                window.dispatchEvent(new Event(SHOW_WELCOME_EVENT))
              }
              aria-label="Getting started"
            >
              <FiHelpCircle />
            </button>
          </Tooltip>
          {trailing}
          <Tooltip text="Settings">
            <button
              type="button"
              className="tb tb--icon"
              onClick={() => {
                setSettingsSection(undefined)
                setConfigModalOpen(true)
              }}
              aria-label="Settings"
            >
              <FiSettings />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}
