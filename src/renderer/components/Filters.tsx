/* eslint-disable react/no-array-index-key */
/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import {
    ReactElement,
    useState,
    Dispatch,
    SetStateAction,
    useEffect,
  } from 'react'
  import { cloneDeep, stubFalse } from 'lodash'
  import '../styles/Filters.css'
  import { filtersConfig } from 'constants/config'
  import ipcBridge from '../ipcBridge'
  import EditFilterModal from './EditFilterModal'
  import {
    FilterInterface,
    ShallowArchiveInterface,
    ShallowFilterInterface,
  } from '../../constants/types'
  
  type FiltersProps = {
    archive: ShallowArchiveInterface | null
    setArchive: Dispatch<
      SetStateAction<ShallowArchiveInterface | null >
    >
  }
  
  export default function Filters({
    archive,
    setArchive,
  }: FiltersProps) {
    const [showEditFilterModal, setShowEditFilterModal] = useState(false)
    const [selectedFilter, setSelectedFilter] = useState<ShallowFilterInterface | null>(null)
    const [currentlyRunningFilter, setCurrentlyRunningFilter] = useState(-1)
    const [filterMsg, setFilterMsg] = useState('')
    const [filterIndex, setFilterIndex] = useState(0)
    const [filterToEdit, setFilterToEdit] =
      useState<ShallowFilterInterface | null>(null)
  
    useEffect(() => {
      //setFilterToEdit(archive.filters[filterIndex])
    }, [archive, filterIndex])
  
    useEffect(() => {
      window.electron.ipcRenderer.on(
        'currentlyRunningFilter',
        async (event: { current: number }) => {
          setFilterMsg(``)
          setCurrentlyRunningFilter(event.current)
          setArchive(await ipcBridge.getArchive())
        }
      )
      window.electron.ipcRenderer.on(
        'filterUpdate',
        (event: { total: number; current: number }) => {
          setFilterMsg(`${event.current}/${event.total}`)
        }
      )
    }, [])

    async function runFilter(filter: ShallowFilterInterface) {
      console.log('RUN FILTER: ', filter.id)
      
      setSelectedFilter(filter)
      const response = await ipcBridge.runFilter(filter.id)
  
      if(response.error){
        console.log("Error: ", response.error)
        return
      }
    }
  
    async function addFilter(e: any) {
      if (!setArchive) return
      const response = await ipcBridge.addFilter(e.target.value)
      if(!response){ return console.log("Error adding filter") }
      const archive = await ipcBridge.getArchive()
      if(!archive){ return console.log("Error getting archive")}
      setArchive(archive)
    }
  

    async function deleteFilter(filter: FilterInterface){
        await ipcBridge.removeFilter(filter.id)
        setArchive( await ipcBridge.getArchive())
    }
  
    function renderFilters() {
        if(!archive) return ""
        if(!archive.filters){
          console.log("No filters? ", archive)
          return ""
        }
        return archive.filters.map((filter, index) => {
            return (
            <div key={`${index}`} className="filter">
                <div onClick={() => console.log(filter)} className="filter-title">
                {filter.label}
                </div>
                <button
                type="button"
                className="filter-button"
                onClick={() => {
                    setShowEditFilterModal(true)
                    setFilterToEdit(filter)
                }}
                >
                Edit
                </button>
                <button
                type="button"
                className="filter-button"
                onClick={() => runFilter(filter)}
                >
                Run
                </button>
                {/* <button
                type="button"
                className="filter-button"
                onClick={() => {
                    setSelectedFilter(filter)
                    setResultsOpen(true)
                }}
                >
                Show
                </button> */}
                <div className="filter-results">Results: {index === currentlyRunningFilter ? "---/---" : filter.results}</div>
                {index === currentlyRunningFilter ? (
                <div className="filterMsg">{filterMsg}</div>
                ) : (
                ''
                )}
                <div
                className={`filterIsProcessed ${
                    filter.isProcessed || currentlyRunningFilter > index
                    ? 'greenCheck'
                    : ''
                }`}
                >
                &#10004;
                </div>
                {
                <div
                    className="filter-delete"
                    onClick={() => deleteFilter(filter)} 
                >
                    ✕
                </div>
                }
    
            </div>
            )
      })
    }

    return (
      <div className="filters">
        <select
            value="default"
            className="add-filter-dropdown"
            onChange={addFilter}
        >
        <option key="default" value="default" disabled>
            + Add Filter
        </option>
        {filtersConfig.map((p) => (
            <option key={p.id} value={p.id}>
            {p.label}
            </option>
        ))}
        </select>
        { renderFilters()}
        {showEditFilterModal ? <EditFilterModal filter={filterToEdit}/> : ''}
      </div>
    )
  }
