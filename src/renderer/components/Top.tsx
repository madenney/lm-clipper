/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import { useEffect, useState, Dispatch, SetStateAction  } from 'react'
import { IoSettingsSharp } from "react-icons/io5";
import { videoConfig } from 'constants/config'

import '../styles/Top.css'
import ipcBridge from 'renderer/ipcBridge'
import { ConfigInterface, ShallowArchiveInterface } from '../../constants/types'

type TopProps = {
  archive: ShallowArchiveInterface | null,
  config: ConfigInterface,
  setConfig: Dispatch<SetStateAction<ConfigInterface | null>>
}

export default function Top({ archive, config, setConfig }: TopProps) {
  const [configModalOpen, setConfigModalOpen] = useState(false)

  function handleChange(key: string, value: string | number | boolean) {
    setConfig({
      ...config,
      [key]: value,
    })
    ipcBridge.updateConfig({ key, value })
  }

  async function handleGetPath(key: string, type: string) {
    const path = await ipcBridge.getPath(type)
    if (!path) return
    setConfig({
      ...config,
      [key]: path,
    })
    ipcBridge.updateConfig({ key, value: path })
  }

  function renderInput(c: any) {
    switch (c.type) {
      case 'checkbox':
        return (
          <input
            type="checkbox"
            className="settings-row-checkbox"
            checked={config[c.id]}
            onChange={(e) => handleChange(c.id, e.target.checked)}
          />
        )
      case 'openFile':
      case 'openDirectory':
        return (
          <input
            className="settings-row-input"
            value={config[c.id]}
            onChange={() => {}}
            onClick={() => handleGetPath(c.id, c.type)}
          />
        )
      case 'textInput':
        return (
          <input
            className="settings-row-input"
            value={config[c.id]}
            onChange={(e) => handleChange(c.id, e.target.value)}
          />
        )
      case 'int':
        return (
          <input
            className="settings-row-input"
            value={config[c.id]}
            onChange={(e) => handleChange(c.id, parseInt(e.target.value, 10))}
          />
        )
      case 'dropdown':
        return (
          <select
            value={config[c.id]}
            className="settings-row-input-dropdown"
            onChange={(e) => handleChange(c.id, e.target.value)}
          >
            {c.options.map((o: { value: number; label: string }) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )
      default:
        return <div>default</div>
    }
  }

  function renderConfigModal(){
    if(!configModalOpen) return ""

    const configModalKeys = ['outputPath', 'dolphinPath', 'ssbmIsoPath', 'numFilterThreads']

    const modalOptions: any[] = []
    configModalKeys.forEach(key => {
      const option = videoConfig.find(c => c.id == key)
      if(option) modalOptions.push(option)
    })

    return (
      <div
        className="modal-container"
        onClick={() => setConfigModalOpen(false)}
      >
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="config-options">
            <div className="config-title">Settings</div>
            <div className="config-row">
              <div className="video-config-options">
                {modalOptions.map((c: any) => {
                  return (
                    <div className="settings-row" key={c.id}>
                      <div className="settings-row-label">{c.label}</div>
                      {renderInput(c)}
                    </div>
                  )
                })}
            </div>
            </div>
          </div>
          <div 
              className="modal-close"
              onClick={() => setConfigModalOpen(false)}
          >✕</div>
        </div>
      </div>
    )
  }

  return (
    <div className="top">
      {renderConfigModal()}
      <div className="gear-icon" onClick={() => setConfigModalOpen(true)}><IoSettingsSharp /></div>
    </div>
  )
}
