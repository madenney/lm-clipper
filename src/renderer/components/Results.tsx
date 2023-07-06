/* eslint-disable react/no-array-index-key */
/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import { useState, Dispatch, SetStateAction, useEffect } from 'react'
import '../styles/Filters.css'
import ipcBridge from 'renderer/ipcBridge'
import {
  ShallowArchiveInterface,
  ShallowFilterInterface,
  ClipInterface,
} from '../../constants/types'

import { characters } from '../../constants/characters'
import { stages } from '../../constants/stages'
import images from '../../images'

type ResultsProps = {
  archive: ShallowArchiveInterface
  isResultsOpen: boolean
  setResultsOpen: Dispatch<SetStateAction<boolean>>
  selectedFilter: ShallowFilterInterface | null
}

export default function Results({
  archive,
  isResultsOpen,
  setResultsOpen,
  selectedFilter,
}: ResultsProps) {
  const [numPerPage] = useState(8)
  const [currentPage, setCurrentPage] = useState(0)
  const [results, setResults] = useState<ClipInterface[] | null>(null)

  useEffect(() => {
    async function getResults() {
      if (!selectedFilter) return
      const selectedFilterIndex = archive.filters.indexOf(selectedFilter)
      setResults(
        await ipcBridge.getResults({
          selectedFilterIndex,
          numPerPage,
          currentPage,
        })
      )
    }
    getResults()
  }, [archive.filters, selectedFilter, numPerPage, currentPage])

  function showClip(result: ClipInterface) {
    console.log('RESULT: ', result)
  }

  function renderStats() {
    if (!results) return <div>no results</div>
    const time = (
      results.reduce((n, c) => {
        const a = c.endFrame - c.startFrame
        return n + a
      }, 0) / 60
    ).toFixed(1)

    return (
      <div className="results-stats">
        <div className="results-stats-row">
          <div className="results-label">Total: </div>
          <div className="results-data">{results.length}</div>
        </div>
        <div className="results-stats-row">
          <div className="results-label">Time: </div>
          <div className="results-data">{time}</div>
        </div>
      </div>
    )
  }

  function renderList() {
    if (!results) return <div>no results</div>
    const darkStages = [2, 3, 31, 32]

    return results.map((result, index) => {
      const { stage, comboer, comboee } = result.recordingParams
      const stageImage = images[stages[stage].img].default
      const arrowImage =
        images[(darkStages.indexOf(stage) != -1 ? 'white' : '') + 'next.png']
          .default
      let p1Image, p2Image
      if (comboer) {
        const p1Char = comboer.characterId
        const p1Color = comboer.characterColor
        p1Image =
          images[
            characters[p1Char].img + characters[p1Char].colors[p1Color] + '.png'
          ].default
        const p2Char = comboee.characterId
        const p2Color = comboee.characterColor
        p2Image =
          images[
            characters[p2Char].img + characters[p2Char].colors[p2Color] + '.png'
          ].default
      } else {
        const p1Char = result.players[0].characterId
        const p1Color = result.players[0].characterColor
        p1Image =
          images[
            characters[p1Char].img + characters[p1Char].colors[p1Color] + '.png'
          ].default
        const p2Char = result.players[1].characterId
        const p2Color = result.players[1].characterColor
        p2Image =
          images[
            characters[p2Char].img + characters[p2Char].colors[p2Color] + '.png'
          ].default
      }

      return (
        <div className="result" onClick={() => showClip(result)} key={index}>
          <div className="result-image-container">
            <div className="characters-container">
              <img className="char1-image" src={p1Image} />
              <img className="arrow-image" src={arrowImage} />
              <img className="char2-image" src={p2Image} />
            </div>
            <img className="stage-image" src={stageImage} />
          </div>
          <div className="result-info-container">
            {result.recordingParams.moves ? (
              <div className="result-info-row">
                <div className="result-info-label">Moves:</div>
                <div className="result-info-data">
                  {result.recordingParams.moves.length}
                </div>
              </div>
            ) : (
              ''
            )}
            {result.startFrame && result.endFrame ? (
              <div className="result-info-row">
                <div className="result-info-label">Time:</div>
                <div className="result-info-data">
                  {((result.endFrame - result.startFrame) / 60).toFixed(1)}
                </div>
              </div>
            ) : (
              ''
            )}
          </div>
        </div>
      )
    })
  }

  function renderPagination() {
    if (!results) return <div>no results :</div>
    return (
      <div className="pagination">
        {currentPage === 0 ? (
          <div className="prev disabled">Prev</div>
        ) : (
          <div className="prev" onClick={() => setCurrentPage(currentPage - 1)}>
            Prev
          </div>
        )}
        <div className="current-page">{currentPage}</div>
        {numPerPage * (currentPage + 1) > results.length ? (
          <div className="next disabled">Next</div>
        ) : (
          <div className="next" onClick={() => setCurrentPage(currentPage + 1)}>
            Next
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="section">
      <div className="title" onClick={() => setResultsOpen(!isResultsOpen)}>
        Results<span>{isResultsOpen ? '▼' : '▲'}</span>
      </div>
      {isResultsOpen ? (
        <div className="section-content">
          {results ? (
            <div className="results-section">
              {renderStats()}
              {results.length > numPerPage ? renderPagination() : ''}
              <div className="results-list">{renderList()}</div>
            </div>
          ) : (
            <div>Select a filter to display results</div>
          )}
        </div>
      ) : (
        ''
      )}
    </div>
  )
}

// function showClip(result) {
//   if (!localStorage.ssbmIsoPath) throw 'Error: No ssbm iso path'
//   if (!localStorage.dolphinPath) throw 'Error: No dolphin path'

//   const { path: slpPath, startFrame, endFrame } = result
//   console.log(slpPath, startFrame, endFrame)
//   const dolphinConfig = {
//     mode: 'normal',
//     replay: slpPath,
//     startFrame,
//     endFrame,
//     isRealTimeMode: false,
//     commandId: `${crypto.randomBytes(12).toString('hex')}`,
//   }
//   const tmpDir = path.resolve(
//     os.tmpdir(),
//     `tmp-${crypto.randomBytes(12).toString('hex')}`
//   )
//   fs.mkdirSync(tmpDir)
//   const filePath = path.resolve(tmpDir, 'dolphinConfig.json')
//   fsPromises.writeFile(filePath, JSON.stringify(dolphinConfig))
//   const args = ['-i', filePath, '-b', '-e', localStorage.ssbmIsoPath]
//   const process = spawn(localStorage.dolphinPath, args)
//   // TODO: Kill process when clip finishes playing and delete JSON file from tmp
//   setTimeout(() => {
//     process.kill()
//   }, 3000)
// }
