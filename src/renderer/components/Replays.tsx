/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */

import { useState, Dispatch, SetStateAction } from 'react'
import '../styles/Replays.css'
import ipcBridge from 'renderer/ipcBridge'
import { ShallowArchiveInterface } from '../../constants/types'

type ReplaysProps = {
  archive: ShallowArchiveInterface
  setArchive: Dispatch<SetStateAction<ShallowArchiveInterface>>
}

export default function Replays({ archive, setArchive }: ReplaysProps) {
  const [isReplaysOpen, setReplaysOpen] = useState(false)
  const [showConfigEdit, setShowConfigEditModal] = useState(false)
  const [showNamesOpen, setNamesModalOpen] = useState(false)
  const [names, setNames] = useState<{ name: string; total: number }[]>([])

  async function importReplays() {
    const newArchive = await ipcBridge.importSlpFiles()
    if (newArchive && !newArchive.error) {
      console.log(newArchive)
      return setArchive(newArchive)
    }
    return console.log('Error', newArchive.error)
  }

  async function showNames() {
    setNamesModalOpen(true)
    setNames(await ipcBridge.getNames())
  }

  function renderShowNamesModal() {
    return (
      <div
        className="replayModal-container"
        onClick={() => setNamesModalOpen(false)}
      >
        <div className="replayModal" onClick={(e) => e.stopPropagation()}>
          <div className="replayNamesList">
            <div className="nameRowTitle">
              <div className="nameKey">Name</div>
              <span className="nameValue"># Occurences</span>
            </div>
            {names.map((name) => {
              return (
                <div key={name.name} className="nameRow">
                  <div className="nameKey">{name.name ? name.name : '" "'}</div>
                  <span className="nameValue">{name.total}</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  function renderConfigEditModal() {
    return (
      <div
        className="replayModal-container"
        onClick={() => setShowConfigEditModal(false)}
      >
        <div className="replayModal" onClick={(e) => e.stopPropagation()}>
          Config edit will go here soon
        </div>
      </div>
    )
  }

  return (
    <div className="section">
      <div className="title" onClick={() => setReplaysOpen(!isReplaysOpen)}>
        Replays<span>{isReplaysOpen ? '▼' : '▲'}</span>
      </div>
      {isReplaysOpen ? (
        <div className="section-content">
          {archive.totalFiles === 0 ? (
            <div className="importInfoSection">
              <div className="importInfoLine">
                Add Slippi replays by dropping them on this window
              </div>
              <div className="importInfoLine">
                or by clicking File &gt; Import Replays
              </div>
              <div className="importInfoLine">
                or by clicking &quot;Import Replays&quot; below
              </div>
            </div>
          ) : (
            <div>
              <div className="replaysInfo">
                <div className="replaysInfoRow">
                  Total:
                  <span className="replayInfoData">{archive.totalFiles}</span>
                </div>
              </div>
              <div className="replaysInfo">
                <div className="replaysInfoRow">
                  Valid:
                  <span className="replayInfoData">{archive.validFiles}</span>
                </div>
              </div>
            </div>
          )}
          <div className="replayButtonsSection">
            <div
              onClick={() => importReplays()}
              className="replaySectionButton"
            >
              Import Replays
            </div>
            <div
              onClick={() => setShowConfigEditModal(true)}
              className="replaySectionButton"
            >
              Edit Config
            </div>
            {archive.totalFiles > 0 ? (
              <div onClick={showNames} className="replaySectionButton">
                Show Names
              </div>
            ) : (
              ''
            )}
          </div>
          {showConfigEdit ? renderConfigEditModal() : ''}
          {showNamesOpen ? renderShowNamesModal() : ''}
        </div>
      ) : (
        ''
      )}
    </div>
  )
}
