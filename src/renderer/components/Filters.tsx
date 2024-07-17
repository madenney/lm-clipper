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
import {
  ShallowArchiveInterface,
  ShallowFilterInterface,
} from '../../constants/types'

type FiltersProps = {
  archive: ShallowArchiveInterface
  setArchive: Dispatch<
    SetStateAction<ShallowArchiveInterface | null | undefined>
  >
  setResultsOpen: Dispatch<SetStateAction<boolean>>
  setSelectedFilter: Dispatch<SetStateAction<ShallowFilterInterface | null>>
}

export default function Filters({
  archive,
  setResultsOpen,
  setSelectedFilter,
  setArchive,
}: FiltersProps) {
  const [resultsData, setResultsData] = useState([])
  const [isFiltersOpen, setFiltersOpen] = useState(false)
  const [showEditFilterModal, setShowEditFilterModal] = useState(false)
  const [currentlyRunningFilter, setCurrentlyRunningFilter] = useState(-1)
  const [filterMsg, setFilterMsg] = useState('')
  const [filterIndex, setFilterIndex] = useState(0)
  const [filterToEdit, setFilterToEdit] =
    useState<ShallowFilterInterface | null>(null)


  // useEffect(() => {
  //   async function getResults() {
  //     setResultsData( await ipcBridge.getResults({selectedFilterIndex: archive.filters.length-1 }) )
  //   }
  //   getResults()
  // }, [archive, setResultsData])

  useEffect(() => {
    setFilterToEdit(archive.filters[filterIndex])
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

  function run() {
    ipcBridge
      .runFilters()
      .then(async () => {
        setCurrentlyRunningFilter(-1)
        setFilterMsg('')
        setArchive(await ipcBridge.getArchive())
      })
      .catch((error) => {
        console.log('Error? ', error)
      })
  }

  function cancel(){
    ipcBridge.cancelRunningFilters()
  }

  async function runFilter(filter: ShallowFilterInterface) {
    console.log('RUN FILTER: ', filter.id)

    const response = await ipcBridge.runFilter(filter.id)

    if(response.error){
      console.log("Error: ", response.error)
      return
    }

    // const filterIndex = archive.filters.indexOf(filter)
    // if (filterIndex === 0) {
    //   filter.run({ results: archive.files }, (e) => {
    //     console.log(e.msg)
    //   })
    // } else {
    //   filter.run(archive.filters[filterIndex - 1], (e) => {
    //     console.log(e.msg)
    //   })
    // }
  }

  async function addFilter(e: any) {
    if (!setArchive) return
    setArchive(await ipcBridge.addFilter(e.target.value))
  }

  async function updateFilter(newFilter: ShallowFilterInterface) {
    if (!filterToEdit) throw Error('No selected filter?')
    const prevFilterIndex = archive.filters.indexOf(filterToEdit)
    setFilterIndex(prevFilterIndex)
    await ipcBridge.updateFilter({
      filterIndex: prevFilterIndex,
      newFilter,
    })
    setArchive(await ipcBridge.getArchive())
  }

  // function handleMultiChange(e, array) {
  //   console.log(e, array)
  //   const val = e.target.value
  //   if (array.indexOf(val) > -1) {
  //     array.splice(array.indexOf(val), 1)
  //   } else {
  //     array.push(val)
  //   }
  // }

  function renderEditOptions() {
    if (!filterToEdit)
      return <div className="filterTypeError">error: no filter?</div>
    const config = filtersConfig.find((p) => p.id === filterToEdit.type)
    if (!config)
      return <div className="filterTypeError">error: no filter type</div>
    return config.options.map((option) => {
      let input: ReactElement | null = null
      switch (option.type) {
        case 'textInput':
        case 'int':
          input = (
            <input
              className="modal-row-input"
              onChange={(e) => {
                const filterClone = cloneDeep(filterToEdit)
                filterClone.params[option.id] = e.target.value
                updateFilter(filterClone)
              }}
              value={filterToEdit.params[option.id]}
            />
          )
          break
        case 'dropdown':
          input = (
            <select
              value={filterToEdit.params[option.id]}
              className="modal-row-input-select"
              onChange={(e) => {
                const filterClone = cloneDeep(filterToEdit)
                filterClone.params[option.id] = e.target.value
                updateFilter(filterClone)
              }}
            >
              { filterToEdit.type == "sort" ? "" : <option value="">Any</option> }
              {option.options?.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.shortName}
                </option>
              ))}
            </select>
          )
          break
        case 'checkbox':
          input = (
            <input
              className="modal-row-checkbox"
              type="checkbox"
              checked={filterToEdit.params[option.id]}
              onChange={(e) => {
                const filterClone = cloneDeep(filterToEdit)
                filterClone.params[option.id] = e.target.checked
                updateFilter(filterClone)
              }}
            />
          )
          break
        case 'checkbox-disabled':
          input = (
            <input
              className="modal-row-checkbox"
              type="checkbox"
              checked={filterToEdit.params[option.id]}
              disabled={true}
            />
          )
          break
        case 'nthMoves':
          input = (
            <div className="nth-moves">
              <button
                type="button"
                className="add-nth-move-button"
                onClick={() => {
                  const filterClone = cloneDeep(filterToEdit)
                  filterClone.params[option.id].push({
                    moveId: '',
                    n: '',
                    d: '',
                    t: '',
                  })
                  updateFilter(filterClone)
                }}
              >
                Add Move
              </button>
              {filterToEdit.params[option.id].map(
                (
                  move: { moveId: string; n: string; d: string; t: string },
                  index: number
                ) => {
                  return (
                    <div key={index} className="nth-move">
                      <div className="nth-move-label">N:</div>
                      <input
                        className="nth-move-int-input"
                        value={move.n}
                        onChange={(e) => {
                          const filterClone = cloneDeep(filterToEdit)
                          filterClone.params[option.id][index].n =
                            e.target.value
                          updateFilter(filterClone)
                        }}
                      />
                      <div className="nth-move-label">T:</div>
                      <input
                        className="nth-move-int-input"
                        value={move.t}
                        onChange={(e) => {
                          const filterClone = cloneDeep(filterToEdit)
                          filterClone.params[option.id][index].t =
                            e.target.value
                          updateFilter(filterClone)
                        }}
                      />
                      <div className="nth-move-label">D:</div>
                      <input
                        className="nth-move-int-input"
                        value={move.d}
                        onChange={(e) => {
                          const filterClone = cloneDeep(filterToEdit)
                          filterClone.params[option.id][index].d =
                            e.target.value
                          updateFilter(filterClone)
                        }}
                      />
                      <div className="nth-move-label-move">Move:</div>
                      <select
                        className="nth-move-input"
                        value={move.moveId}
                        onChange={(e) => {
                          const filterClone = cloneDeep(filterToEdit)
                          filterClone.params[option.id][index].moveId =
                            e.target.value
                          updateFilter(filterClone)
                        }}
                      >
                        {option.options?.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.shortName}
                          </option>
                        ))}
                      </select>
                      <div
                        className="nth-move-delete"
                        onClick={() => {
                          const filterClone = cloneDeep(filterToEdit)
                          filterClone.params[option.id].splice(index, 1)
                          updateFilter(filterClone)
                        }}
                      >
                        ✕
                      </div>
                    </div>
                  )
                }
              )}
            </div>
          )
          break
        default:
          return <div className="filterTypeError">error: default?</div>
      }
      return (
        <div className="modal-row" key={option.id}>
          <div className="modal-row-label">{option.name}</div>
          {input}
        </div>
      )
    })
  }

  function renderEditFilterModal() {
    if (!filterToEdit) return ''
    return (
      <div
        className="modal-container"
        onClick={() => setShowEditFilterModal(false)}
      >
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          {renderEditOptions()}
          <div 
              className="modal-close"
              onClick={() => setShowEditFilterModal(stubFalse)}
          >✕</div>
        </div>
      </div>
    )
  }

  function renderFilters() {
    return archive.filters.map((filter, index) => {
      return (
        <div key={`${index}`} className="filter-row">
          {/* TODO: something interesting here */}
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
            index == 0 ? ("") : (
            <div
              className="filter-delete"
              onClick={async () => {
                await ipcBridge.removeFilter(archive.filters.indexOf(filter))
                setArchive( await ipcBridge.getArchive())
              }}
            >
              ✕
            </div>
            )
          }

        </div>
      )
    })
  }

  function renderResultsData(){
    const lastFilter = archive.filters[archive.filters.length-1]
    const isFiles = lastFilter.type == 'files'

    let totalFrames = 0

    if( resultsData[0] && resultsData[0].startFrame ){
      totalFrames = resultsData.reduce((acc,current) => {
        return acc + current.endFrame - current.startFrame
      }, 0)
    } else {
      totalFrames = resultsData.reduce((acc,current) => {
        return acc + current.lastFrame + 123
      }, 0)

    }
    
    const totalSeconds = totalFrames/60
    const totalTime = convertSecondsToFullString(totalSeconds)
    const averageLength = lastFilter.results == 0 ? "N/A" : convertSecondsToFullString(totalSeconds/lastFilter.results)

    return <div>
      <div className={'results-row'}>
        <div className={'last-results-label'}>Current results: </div>
        <div className={'last-results-data'}>{lastFilter.results} </div>
        <div className={'last-results-data-2'}>{isFiles ? " replays" : " clips"}</div>
      </div>
      <div className={'results-row'}>
        <div className={'last-results-label'}>Total length: </div>
        <div className={'last-results-data'}>{totalTime} </div>
      </div>
      <div className={'results-row'}>
        <div className={'last-results-label'}>Average length: </div>
        <div className={'last-results-data'}>{averageLength} </div>
      </div>
    </div>
  }

  function renderSection() {
    return (
      <div className="section-content">
        <div className="add-filter-label">Add - </div>
        <select
          value="default"
          className="add-filter-dropdown"
          onChange={addFilter}
        >
          <option key="default" value="default" disabled>
            Select Filter
          </option>
          {filtersConfig.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        { currentlyRunningFilter == -1 ?
          <button type="button" className="runButton" onClick={run}>
            Run &#9658;
          </button>
          :
          <button type="button" className="cancelButton" onClick={cancel}>
            Cancel
          </button>
        }
        <div id="filters-list">{renderFilters()}</div>
        {/*<div id="results">{ renderResultsData()  }</div>*/}
      </div>
    )
  }

  return (
    <div>
      <div className="section">
        <div className="title" onClick={() => setFiltersOpen(!isFiltersOpen)}>
          Filters
          <span>{isFiltersOpen ? '▼' : '▲'}</span>
        </div>
        {isFiltersOpen ? renderSection() : ''}
        {showEditFilterModal ? renderEditFilterModal() : ''}
      </div>
    </div>
  )
}


function convertSecondsToFullString(seconds: number) {
  const days = Math.floor(seconds / (3600 * 24));
  const hours = Math.floor((seconds % (3600 * 24)) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);  // Ensure no decimals

  let result = "";
  if (days > 0) result += `${days} day${days > 1 ? 's' : ''}, `;
  if (hours > 0) result += `${hours} hour${hours > 1 ? 's' : ''}, `;
  if (minutes > 0) result += `${minutes} minute${minutes > 1 ? 's' : ''}, `;
  result += `${remainingSeconds} second${remainingSeconds !== 1 ? 's' : ''}`;

  return result;
}