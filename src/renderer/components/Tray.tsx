
import { useState, Dispatch, SetStateAction, useEffect } from 'react'
import '../styles/Tray.css'
import ipcBridge from 'renderer/ipcBridge'
import Item from "./Item"
import {
  ShallowArchiveInterface,
  ClipInterface,
  FileInterface
} from '../../constants/types'


type TrayProps = {
  archive: ShallowArchiveInterface | null
  setArchive: Dispatch<
    SetStateAction<ShallowArchiveInterface | null >
  >
}

export default function Tray({
  archive,
  setArchive
}: TrayProps) {
  const [numPerPage] = useState(1000)
  const [currentPage, setCurrentPage] = useState(0)
  const [importMsg, setImportMsg] = useState("")
  const [currentResults, setCurrentResults] = useState([])
  const [newItem, setNewItem] = useState(null)
  const [isLoadingPage, setIsLoadingPage] = useState(false)


  useEffect(() => {
    if(!archive){
      setCurrentResults([])
    }
  }, [archive])

  useEffect(() => {
    if(currentResults.length < numPerPage){
      if(!currentResults || !newItem) return
      setCurrentResults([...currentResults, newItem])
    }
  }, [newItem])

  useEffect(() => {

    async function getResults() {
      console.log(`getting results -> page: ${currentPage} numPerPage -> ${numPerPage}`)
      //const selectedFilterIndex = archive.filters.indexOf(selectedFilter)

      setIsLoadingPage(true)
      const newResults = await ipcBridge.getResults({
        filterId: 'files', //selectedFilterIndex,
        numPerPage,
        currentPage,
      })
      setCurrentResults(newResults)
      setIsLoadingPage(false)
    }
    getResults()
  }, [archive, numPerPage, currentPage])

  useEffect(() => {
    window.electron.ipcRenderer.on(
      'importingFileUpdate',
      async ({ total, current, finished, newItem }) => {
        console.log("newitem:", newItem)
        if(newItem) setNewItem(newItem)
        if (finished) {
          setImportMsg('')
        } else {
          setImportMsg(`Importing ${current}/${total}`)
        }
        // if(newItem) setNewItem(newItem)
      }
    )
  }, [])




  useEffect(() => {
    //good spot to get clips
  }, [])

  function showClip(result: ClipInterface) {
    console.log('RESULT: ', result)
  }


  function renderPagination() {
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
        { currentResults.length < numPerPage ? ( // TODO, make this work
          <div className="next disabled">Next</div>
        ) : (
          <div className="next" onClick={() => setCurrentPage(currentPage + 1)}>
            Next
          </div>
        )}
      </div>
    )
  }

  function renderResults(){
    return currentResults.map((item: ClipInterface | FileInterface, index) => {
      
      const tag = item.path.slice(-8)

      return <Item item={item} key={index} index={index}/>
    });
  }
  

  return (
    <div className="tray">
    { ((archive && archive.files > 0) || currentResults.length > 0) ? (
      <div>
        <div className='import-message'>{importMsg}</div>
        {renderPagination()}
        { isLoadingPage ? <div className="loading-page-message">LOADING...</div> : <div className="results">{renderResults()}</div> }
      </div>
    ) : (
        <div className="noFilesMsg">
            <div className="firstLine">Add Slippi replays by dropping them on this window </div>
            <div className="secondLine"> or by clicking File &gt; Import Replays</div>
        </div> 
    )}
    </div>
  )
}