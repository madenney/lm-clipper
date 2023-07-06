/* eslint-disable react/no-array-index-key */
/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import { ReactElement, useState, Dispatch, SetStateAction } from 'react'
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
  const [filterToEdit, setFilterToEdit] =
    useState<ShallowFilterInterface | null>(null)

  function runFilter(filter: ShallowFilterInterface) {
    console.log('RUN FILTER: ', filter)
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
                filterToEdit.params[option.id] = e.target.value
              }}
              value={filterToEdit.params[option.id]}
            />
          )
          break
        case 'dropdown':
          input = (
            <select
              value={filterToEdit.params[option.id]}
              className="modal-row-input"
              onChange={(e) => {
                filterToEdit.params[option.id] = e.target.value
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
              className="modal-row-input modal-row-checkbox"
              type="checkbox"
              checked={filterToEdit.params[option.id]}
              onChange={(e) => {
                filterToEdit.params[option.id] = e.target.checked
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
                  filterToEdit.params[option.id].push({
                    moveId: '',
                    n: '',
                    d: '',
                    t: '',
                  })
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
                          move.n = e.target.value
                        }}
                      />
                      <div className="nth-move-label">T:</div>
                      <input
                        className="nth-move-int-input"
                        value={move.t}
                        onChange={(e) => {
                          move.t = e.target.value
                        }}
                      />
                      <div className="nth-move-label">D:</div>
                      <input
                        className="nth-move-int-input"
                        value={move.d}
                        onChange={(e) => {
                          move.d = e.target.value
                        }}
                      />
                      <div className="nth-move-label-move">Move:</div>
                      <select
                        className="nth-move-input"
                        value={move.moveId}
                        onChange={(e) => {
                          move.moveId = e.target.value
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
                          filterToEdit.params[option.id].splice(index, 1)
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
          <button
            type="button"
            className="filter-button"
            onClick={() => runFilter(filter)}
          >
            Run
          </button>
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
          <div className="filter-results">{filter.results}</div>
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
