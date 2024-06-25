/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import { useEffect, useState, Dispatch, SetStateAction  } from 'react'
import { IoSettingsSharp } from "react-icons/io5";
import { FaRegSave } from "react-icons/fa";
import { videoConfig } from 'constants/config'

import '../styles/Navbar.css'
import ipcBridge from 'renderer/ipcBridge'
import { ConfigInterface, ShallowArchiveInterface } from '../../constants/types'

type NavbarProps = {
  archive: ShallowArchiveInterface,
  config: ConfigInterface,
  setConfig: Dispatch<SetStateAction<ConfigInterface>>
}

export default function Navbar({ archive, config, setConfig }: NavbarProps) {
  const [importMsg, setImportMsg] = useState('')
  const [configModalOpen, setConfigModalOpen] = useState(false)
  const [saveButtonText, setSaveButtonText] = useState('Save')
  useEffect(() => {
    window.electron.ipcRenderer.on(
      'importingFileUpdate',
      ({ total, current, finished }) => {
        if (finished) {
          setImportMsg('')
        } else {
          setImportMsg(`Importing ${current}/${total}`)
        }
      }
    )
  }, [])



  async function saveArchive() {
    setSaveButtonText('Saving...')
    await ipcBridge.saveArchive()
    setSaveButtonText('Saved')
    setTimeout(() => setSaveButtonText('Save'), 2000)
  }

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

    console.log(modalOptions)

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
    <div className="navbar">
      {renderConfigModal()}
      <div className="projectTitleContainer">
        Project: <span className="projectTitle">{`${archive.name}`}</span>
      </div>
      <div className="importMsg">{importMsg}</div>
      <div
        onClick={saveArchive}
        className={`saveButton ${saveButtonText === 'Saved' ? 'green' : ''}`}
      >
        {saveButtonText == 'Saved' ? saveButtonText : <FaRegSave/>}
      </div>
      <div className="gear-icon" onClick={() => setConfigModalOpen(true)}><IoSettingsSharp /></div>
    </div>
  )
}
