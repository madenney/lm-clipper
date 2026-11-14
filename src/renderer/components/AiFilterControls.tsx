import { useEffect, useState } from 'react'
import { cloneDeep } from 'lodash'
import { ShallowFilterInterface } from '../../constants/types'
import {
  aiFilterInput,
  buildAiFilterPrompt,
  extractCode,
} from '../../constants/aiFilterPrompt'
import { openAiFilterGuide } from './AiFilterGuide'

/**
 * The AI Filter's card body (user, 2026-10-03): Copy prompt (to the
 * clipboard), a box that takes the AI's response as-is, and ? for the
 * how-it-works guide. The code is taken out of the response (first code
 * block, else all of it) and runs like Custom Code.
 */
export default function AiFilterControls({
  filter,
  previousType,
  onEditCode,
  onUpdate,
}: {
  filter: ShallowFilterInterface
  /** The step before (decides what the prompt says the input rows are). */
  previousType?: string
  /** Opens the code in the editor. */
  onEditCode?: () => void
  onUpdate: (
    _newFilter: ShallowFilterInterface,
    _previousFilter: ShallowFilterInterface,
  ) => void
}) {
  const saved: string = filter.params?.response ?? ''
  const code: string = filter.params?.code ?? ''
  // Typed / pasted text, saved on blur (Run blurs it first).
  const [response, setResponse] = useState(saved)
  useEffect(() => setResponse(saved), [saved])
  const [copied, setCopied] = useState(false)

  const save = () => {
    if (response === saved) return
    const extracted = extractCode(response)
    const found = /\breturn\b/.test(extracted) ? extracted : ''
    const next = cloneDeep(filter)
    next.params = { ...next.params, response, code: found }
    onUpdate(next, filter)
  }

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(
        buildAiFilterPrompt(aiFilterInput(previousType)),
      )
    } catch {
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
    window.electron.ipcRenderer.sendMessage('code-editor-ai-prompt-copied', {
      mode: 'aiFilter',
    })
  }

  const lines = code ? code.split('\n').length : 0
  const status = !saved.trim()
    ? null
    : code
      ? {
          ok: true,
          text: `✓ ${lines} ${lines === 1 ? 'line' : 'lines'} of code`,
        }
      : { ok: false, text: 'No code found in this response' }

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div className="ai-filter" onClick={(e) => e.stopPropagation()}>
      <div className="ai-filter-row">
        <button
          type="button"
          className="filter-button ai-filter-btn ai-filter-btn--primary"
          onClick={copyPrompt}
          title="Copy the prompt, paste it into ChatGPT, Claude or any AI"
        >
          {copied ? 'Copied ✓' : 'Copy prompt'}
        </button>
        <button
          type="button"
          className="ai-filter-help"
          onClick={() => openAiFilterGuide(filter.id)}
          title="How the AI Filter works"
          aria-label="How the AI Filter works"
        >
          ?
        </button>
      </div>
      <textarea
        className="ai-filter-request"
        value={response}
        rows={3}
        placeholder="Input response here"
        spellCheck={false}
        onChange={(e) => setResponse(e.target.value)}
        onBlur={save}
      />
      <div className="ai-filter-status">
        {status ? (
          <span className={status.ok ? 'ai-filter-ready' : 'ai-filter-bad'}>
            {status.text}
          </span>
        ) : (
          <span />
        )}
        <span className="ai-filter-status-actions">
          <button
            type="button"
            className="filter-button ai-filter-btn ai-filter-btn--quiet"
            disabled={!response.trim() && !code}
            onClick={() => {
              setResponse('')
              const next = cloneDeep(filter)
              next.params = { ...next.params, response: '', code: '' }
              onUpdate(next, filter)
            }}
            title="Empty the response box and remove the code"
          >
            Clear
          </button>
          {onEditCode && (
            <button
              type="button"
              className="filter-button ai-filter-btn ai-filter-btn--quiet"
              onClick={onEditCode}
              title="Open the code in the editor"
            >
              Edit code
            </button>
          )}
        </span>
      </div>
    </div>
  )
}
