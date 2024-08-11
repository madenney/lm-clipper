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
  import '../styles/EditFilterModal.css'
  import { cloneDeep, stubFalse } from 'lodash'
  import { filtersConfig } from 'constants/config'
  import {
    FilterInterface,
    ShallowArchiveInterface,
    ShallowFilterInterface,
  } from '../../constants/types'
  
  type EditFilterModalProps = {
    filter: ShallowFilterInterface | null
  }
  
  export default function EditFilterModal({
    filter
  }: EditFilterModalProps) {

    const [showEditFilterModal, setShowEditFilterModal] = useState(false)

  
    async function updateFilter(newFilter: ShallowFilterInterface) {
        if (!filter) throw Error('No selected filter?')
        console.log("Update Filter")
    }
  
    function renderEditOptions() {
      if (!filter)
        return <div className="filterTypeError">error: no filter?</div>
      const config = filtersConfig.find((p) => p.id === filter.type)
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
                  const filterClone = cloneDeep(filter)
                  filterClone.params[option.id] = e.target.value
                  updateFilter(filterClone)
                }}
                value={filter.params[option.id]}
              />
            )
            break
          case 'dropdown':
            input = (
              <select
                value={filter.params[option.id]}
                className="modal-row-input-select"
                onChange={(e) => {
                  const filterClone = cloneDeep(filter)
                  filterClone.params[option.id] = e.target.value
                  updateFilter(filterClone)
                }}
              >
                { filter.type == "sort" ? "" : <option value="">Any</option> }
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
                checked={filter.params[option.id]}
                onChange={(e) => {
                  const filterClone = cloneDeep(filter)
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
                checked={filter.params[option.id]}
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
                    const filterClone = cloneDeep(filter)
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
                {filter.params[option.id].map(
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
                            const filterClone = cloneDeep(filter)
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
                            const filterClone = cloneDeep(filter)
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
                            const filterClone = cloneDeep(filter)
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
                            const filterClone = cloneDeep(filter)
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
                            const filterClone = cloneDeep(filter)
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
