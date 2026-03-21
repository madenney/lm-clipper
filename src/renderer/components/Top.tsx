import { useEffect, useState, Dispatch, SetStateAction } from 'react'
import { IoSettingsSharp } from 'react-icons/io5'
import { HiGlobeAlt } from 'react-icons/hi'

import '../styles/Top.css'
import { ConfigInterface } from '../../constants/types'
import ipcBridge from '../ipcBridge'
import SettingsModal from './SettingsModal'
import GeckoModal from './GeckoModal'

type TopProps = {
  config: ConfigInterface
  setConfig: Dispatch<SetStateAction<ConfigInterface | null>>
}

export default function Top({ config, setConfig }: TopProps) {
  const [configModalOpen, setConfigModalOpen] = useState(false)
  const [geckoModalOpen, setGeckoModalOpen] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [importCurrent, setImportCurrent] = useState(0)
  const [importTotal, setImportTotal] = useState<number | null>(null)

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

  function handleChange(key: string, value: any) {
    setConfig({
      ...config,
      [key]: value,
    })
    ipcBridge.updateConfig({ key, value })
  }

  return (
    <div className="top">
      {configModalOpen && (
        <SettingsModal
          config={config}
          setConfig={setConfig}
          onClose={() => setConfigModalOpen(false)}
          onOpenGeckoModal={() => {
            setConfigModalOpen(false)
            setGeckoModalOpen(true)
          }}
        />
      )}
      {geckoModalOpen && (
        <GeckoModal
          config={config}
          setConfig={setConfig}
          onClose={() => setGeckoModalOpen(false)}
        />
      )}
      <div className="top-controls">
        <label
          className="top-control"
          title="Worker threads for filter processing"
        >
          <span className="top-control-label">CPU Threads</span>
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
          className="top-lunar-btn"
          onClick={() => window.open('https://www.lunarmelee.com')}
          title="Browse and download Slippi replays"
        >
          <HiGlobeAlt className="top-lunar-icon" />
          <span>Lunar Database</span>
        </button>
        <button
          type="button"
          className="top-gecko-btn"
          onClick={() => setGeckoModalOpen(true)}
          title="Configure Gecko Codes for recording"
        >
          Gecko Codes
        </button>
        <div
          className="gear-icon"
          role="button"
          tabIndex={0}
          onClick={() => setConfigModalOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setConfigModalOpen(true)
            }
          }}
          aria-label="Settings"
        >
          <IoSettingsSharp />
        </div>
      </div>
    </div>
  )
}
