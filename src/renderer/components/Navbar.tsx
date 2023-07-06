/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import { useEffect, useState } from 'react'
import '../styles/Navbar.css'
import ipcBridge from 'renderer/ipcBridge'
import { ShallowArchiveInterface } from '../../constants/types'

type NavbarProps = {
  archive: ShallowArchiveInterface
}

export default function Navbar({ archive }: NavbarProps) {
  const [importMsg, setImportMsg] = useState('')
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

  return (
    <div className="navbar">
      <div className="projectTitleContainer">
        Project: <span className="projectTitle">{`${archive.name}`}</span>
      </div>
      <div className="files">{`Replays: ${archive.files}`}</div>
      <div className="importMsg">{importMsg}</div>
      <div
        onClick={saveArchive}
        className={`saveButton ${saveButtonText === 'Saved' ? 'green' : ''}`}
      >
        {saveButtonText}
      </div>
    </div>
  )
}
