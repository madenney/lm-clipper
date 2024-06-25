/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import { useEffect, useState, Dispatch, SetStateAction } from 'react'
import '../styles/Filters.css'
import '../styles/Video.css'
import { videoConfig } from 'constants/config'
import { ConfigInterface, ShallowArchiveInterface } from '../../constants/types'
import ipcBridge from '../ipcBridge'

type VideoProps = {
  archive: ShallowArchiveInterface
  config: ConfigInterface
  setConfig: Dispatch<SetStateAction<ConfigInterface>>
}

export default function Video({ archive, config, setConfig }: VideoProps) {
  const [isVideoOpen, setVideoOpen] = useState(false)
  const [videoMsg, setVideoMsg] = useState('')
  const [advancedOptionsOpen, setAdvancedOptionsOpen] = useState(false)

  useEffect(() => {
    window.electron.ipcRenderer.on('videoMsg', async (msg) => {
      console.log('videoMsg: ', msg)
      setVideoMsg(msg)
    })
  }, [setVideoMsg])

  async function generateVideo() {
    ipcBridge.generateVideo()
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
            className="video-row-checkbox"
            checked={config[c.id]}
            onChange={(e) => handleChange(c.id, e.target.checked)}
          />
        )
      case 'openFile':
      case 'openDirectory':
        return (
          <input
            className="video-row-input"
            value={config[c.id]}
            onChange={() => {}}
            onClick={() => handleGetPath(c.id, c.type)}
          />
        )
      case 'textInput':
        return (
          <input
            className="video-row-input"
            value={config[c.id]}
            onChange={(e) => handleChange(c.id, e.target.value)}
          />
        )
      case 'int':
        return (
          <input
            className="video-row-input"
            value={config[c.id]}
            onChange={(e) => handleChange(c.id, parseInt(e.target.value, 10))}
          />
        )
      case 'dropdown':
        return (
          <select
            value={config[c.id]}
            className="video-row-input-dropdown"
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


  // TODO: this seems pretty dumb
  const unwantedKeys = ['outputPath', 'dolphinPath', 'ssbmIsoPath', 'cpuThreads', 'resolution', 'numCPUs', 'slice', 'shuffle']
  const simpleVideoOptionKeys = ['slice', 'numCPUs', 'resolution', 'shuffle']
  const advancedVideoOptionKeys = ['hideHud', 'gameMusic', 'enableChants', 'disableScreenShake', 'hideTags', 'hideNames', 
    'fixedCamera', 'noElectricSFX', 'noCrowdNoise', 'disableMagnifyingGlass','addStartFrames', 'addEndFrames', 'lastClipOffset', 'bitrateKbps']

  const simpleVideoOptions: any[] = []
  simpleVideoOptionKeys.forEach(key => {
    const option = videoConfig.find(c => c.id == key)
    if(option) simpleVideoOptions.push(option)
  })

  const advancedVideoOptions: any[] = []
  advancedVideoOptionKeys.forEach(key => {
    const option = videoConfig.find(c => c.id == key)
    if(option) advancedVideoOptions.push(option)
  })

  return (
    <div className="section">
      <div className="title" onClick={() => setVideoOpen(!isVideoOpen)}>
        Video<span>{isVideoOpen ? '▼' : '▲'}</span>
      </div>
      {isVideoOpen ? (
        <div className="section-content">
          <div className="video-section">
            <div className="video-buttons-section">
              <button
                type="button"
                className="normal-button"
                onClick={() => generateVideo()}
              >
                Generate Video
              </button>
              {videoMsg ? <div className="videoMessage">{videoMsg}</div> : ''}
            </div>
            <div className="simple-video-config-options">
                {simpleVideoOptions.map((c: any) => {
                  return (
                    <div className="simple-video-row" key={c.id}>
                      <div className="simple-video-row-label">{c.label}</div>
                      {renderInput(c)}
                    </div>
                  )
              })}
            </div>
            <button 
              type="button"
              className="advanced-options-button"
              onClick={()=> setAdvancedOptionsOpen(!advancedOptionsOpen)}
            >{advancedOptionsOpen ? "Close More Options" : "Show More Options"}</button>
            { advancedOptionsOpen ?
            <div className="advanced-video-config-options">
              {advancedVideoOptions.map((c: any) => {
                return (
                  <div className="advanced-video-row" key={c.id}>
                    <div className="advanced-video-row-label">{c.label}</div>
                    {renderInput(c)}
                  </div>
                )
              })}
            </div>
            : "" }
          </div>
        </div>
      ) : (
        ''
      )}
    </div>
  )
}
