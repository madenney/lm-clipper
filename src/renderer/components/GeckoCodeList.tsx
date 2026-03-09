/* eslint-disable jsx-a11y/no-noninteractive-element-interactions */
/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import { FiPlus, FiTrash2, FiChevronDown, FiChevronRight } from 'react-icons/fi'
import type { CustomGeckoCode } from '../../constants/types'

type GeckoCodeListProps = {
  customCodes: CustomGeckoCode[]
  expandedGeckoIdx: number | null
  onExpandToggle: (_idx: number | null) => void
  onAdd: () => void
  onUpdate: (
    _idx: number,
    _field: keyof CustomGeckoCode,
    _value: string | boolean,
  ) => void
  onRemove: (_idx: number) => void
}

export default function GeckoCodeList({
  customCodes,
  expandedGeckoIdx,
  onExpandToggle,
  onAdd,
  onUpdate,
  onRemove,
}: GeckoCodeListProps) {
  return (
    <>
      <div className="gecko-custom-header">
        <h3 className="settings-section-title">Custom Codes</h3>
        <button
          type="button"
          className="gecko-add-btn"
          onClick={onAdd}
          title="Add a custom gecko code"
        >
          <FiPlus /> Add Code
        </button>
      </div>
      {customCodes.length === 0 ? (
        <div className="gecko-empty">
          No custom codes added. Click &ldquo;Add Code&rdquo; to add your own
          gecko codes.
        </div>
      ) : (
        <div className="gecko-custom-list">
          {customCodes.map((gc, idx) => {
            const isExpanded = expandedGeckoIdx === idx
            return (
              <div className="gecko-code-item" key={idx}>
                <div
                  className="gecko-code-row"
                  onClick={() => onExpandToggle(isExpanded ? null : idx)}
                >
                  <span className="gecko-code-chevron">
                    {isExpanded ? <FiChevronDown /> : <FiChevronRight />}
                  </span>
                  <span className="gecko-code-name">
                    {gc.name || 'Untitled Code'}
                  </span>
                  <div className="gecko-code-actions">
                    <label
                      className="settings-toggle"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={gc.enabled}
                        onChange={(e) =>
                          onUpdate(idx, 'enabled', e.target.checked)
                        }
                      />
                      <span className="settings-toggle-slider" />
                    </label>
                    <button
                      type="button"
                      className="gecko-delete-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        onRemove(idx)
                      }}
                      title="Remove this code"
                    >
                      <FiTrash2 />
                    </button>
                  </div>
                </div>
                {isExpanded && (
                  <div className="gecko-code-editor">
                    <div className="gecko-code-field">
                      <label className="gecko-code-field-label">Name</label>
                      <input
                        type="text"
                        className="settings-path-input"
                        value={gc.name}
                        onChange={(e) => onUpdate(idx, 'name', e.target.value)}
                        placeholder="My Custom Code"
                      />
                    </div>
                    <div className="gecko-code-field">
                      <label className="gecko-code-field-label">Hex Code</label>
                      <textarea
                        className="gecko-code-textarea"
                        value={gc.code}
                        onChange={(e) => onUpdate(idx, 'code', e.target.value)}
                        placeholder={'04462984 38600001\n044629A8 38600001'}
                        rows={5}
                        spellCheck={false}
                      />
                      <span className="gecko-code-hint">
                        Paste gecko code hex lines here. One instruction per
                        line.
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
