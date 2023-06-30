/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import '../styles/OpenScreen.css'
import { useState, Dispatch, SetStateAction } from 'react'
import ipcBridge from '../ipcBridge'
import { ArchiveInterface } from '../../constants/types'

type OpenScreenProps = {
  setArchive: Dispatch<SetStateAction<ArchiveInterface | null | undefined>>
}

export default function OpenScreen({ setArchive }: OpenScreenProps) {
  const [createNew, setCreateNew] = useState(false)
  const [location, setLocation] = useState('')
  const [name, setName] = useState<string>('')
  const [errorMessage, setErrorMessage] = useState<string>('')

  async function handleSubmit() {
    setErrorMessage('')
    try {
      const newArchive = await ipcBridge.createNewArchive({
        name: name || 'my first project',
        location: location || '',
      })
      if (newArchive.error) throw newArchive.info
      setArchive(newArchive)
    } catch (error) {
      console.log(error)
      setErrorMessage('An error occurred :(')
    }
  }

  if (createNew) {
    return (
      <div className="main">
        <div className="title">New Project:</div>
        <form>
          <div className="label">Name</div>
          <input
            className="input"
            placeholder="my first project"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="label">Save Location:</div>
          <input
            onClick={async () => {
              setLocation(await ipcBridge.getDirectory())
            }}
            value={location}
            className="locationInput"
            placeholder="~/Documents"
            readOnly
          />
          <div className="button" onClick={handleSubmit}>
            Create
          </div>
          <div className="errorMessage">{errorMessage}</div>
        </form>
      </div>
    )
  }

  return (
    <div className="main">
      <div onClick={() => setCreateNew(true)} className="button">
        Create New Project
      </div>
      <div
        onClick={async () => {
          const archive = await ipcBridge.openExistingArchive()
          if (!archive) return
          if (archive.error) {
            setErrorMessage(archive.error)
          } else {
            setArchive(archive)
          }
        }}
        className="button"
      >
        Open Saved Project
      </div>
    </div>
  )
}
