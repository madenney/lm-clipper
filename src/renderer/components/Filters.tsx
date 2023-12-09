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
import { cloneDeep } from 'lodash'
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
  const [isFiltersOpen, setFiltersOpen] = useState(false)
  const [showEditFilterModal, setShowEditFilterModal] = useState(false)
  const [currentlyRunningFilter, setCurrentlyRunningFilter] = useState(0)
  const [filterMsg, setFilterMsg] = useState('')
  const [filterIndex, setFilterIndex] = useState(0)
  const [filterToEdit, setFilterToEdit] =
    useState<ShallowFilterInterface | null>(null)

  useEffect(() => {
    setFilterToEdit(archive.filters[filterIndex])
  }, [archive, filterIndex])

  useEffect(() => {
    window.electron.ipcRenderer.on(
      'currentlyRunningFilter',
      (event: { current: number, numPrevResults: number }) => {
        setCurrentlyRunningFilter(event.current)
        if (event.current > 0) {
            const newArchive = { ...archive }
            newArchive.filters[event.current - 1].results = event.numPrevResults
            setArchive(newArchive)
        }
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
      .then((newArchive) => {
        setArchive(newArchive)
        setCurrentlyRunningFilter(0)
        return setFilterMsg('')
      })
      .catch((error) => {
        console.log('Error? ', error)
      })
  }

  // function runFilter(filter: ShallowFilterInterface) {
  //   console.log('RUN FILTER: ', filter)
  //   // const filterIndex = archive.filters.indexOf(filter)
  //   // if (filterIndex === 0) {
  //   //   filter.run({ results: archive.files }, (e) => {
  //   //     console.log(e.msg)
  //   //   })
  //   // } else {
  //   //   filter.run(archive.filters[filterIndex - 1], (e) => {
  //   //     console.log(e.msg)
  //   //   })
  //   // }
  // }

  async function addFilter(e: any) {
    if (!setArchive) return
    setArchive(await ipcBridge.addFilter(e.target.value))
  }

  async function updateFilter(newFilter: ShallowFilterInterface) {
    if (!filterToEdit) throw Error('No selected filter?')
    const prevFilterIndex = archive.filters.indexOf(filterToEdit)
    setFilterIndex(prevFilterIndex)
    setArchive(
      await ipcBridge.updateFilter({
        filterIndex: prevFilterIndex,
        newFilter,
      })
    )
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
              <option value="">Any</option>
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
          {/* <button
            type="button"
            className="filter-button"
            onClick={() => runFilter(filter)}
          >
            Run
          </button> */}
          <button
            type="button"
            className="filter-button"
            onClick={() => {
              setSelectedFilter(filter)
              setResultsOpen(true)
            }}
          >
            Show
          </button>
          <div className="filter-results">Results: {filter.results}</div>
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
          <div
            className="filter-delete"
            onClick={async () => {
              setArchive(
                await ipcBridge.removeFilter(archive.filters.indexOf(filter))
              )
            }}
          >
            ✕
          </div>
        </div>
      )
    })
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
        <button type="button" className="runButton" onClick={run}>
          Run &#9658;
        </button>
        <div id="filters-list">{renderFilters()}</div>
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
