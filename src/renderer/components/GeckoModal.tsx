import { useState, Dispatch, SetStateAction } from 'react'
import { videoConfig } from 'constants/config'

import { ConfigInterface, CustomGeckoCode } from '../../constants/types'
import ipcBridge from '../ipcBridge'
import GeckoCodeList from './GeckoCodeList'

type GeckoModalProps = {
  config: ConfigInterface
  setConfig: Dispatch<SetStateAction<ConfigInterface | null>>
  onClose: () => void
}

export default function GeckoModal({
  config,
  setConfig,
  onClose,
}: GeckoModalProps) {
  const [expandedGeckoIdx, setExpandedGeckoIdx] = useState<number | null>(null)

  function handleChange(key: string, value: any) {
    setConfig({
      ...config,
      [key]: value,
    })
    ipcBridge.updateConfig({ key, value })
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
              onChange={(e) => handleChange(c.id, e.target.checked)}
            />
            <span className="settings-toggle-slider" />
          </label>
        )
      default:
        return null
    }
  }

  const geckoItems = videoConfig.filter((c: any) => c.category === 'rendering')
  const customCodes: CustomGeckoCode[] = config.customGeckoCodes || []

  return (
    <div className="settings-overlay" role="presentation" onClick={onClose}>
      <div
        className="settings-modal settings-modal--gecko"
        role="presentation"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-header">
          <h2 className="settings-title">Gecko Codes</h2>
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
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
                  <div className="settings-item-control">{renderInput(c)}</div>
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
          <button type="button" className="settings-done-btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
