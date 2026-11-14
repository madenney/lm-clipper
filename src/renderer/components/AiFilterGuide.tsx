import { useState } from 'react'
import { FaRobot, FaCopy, FaComments, FaPlay } from 'react-icons/fa'
import { useModal } from '../hooks/useModal'
import {
  aiFilterInput,
  buildAiFilterPrompt,
} from '../../constants/aiFilterPrompt'
import '../styles/AiFilterGuide.css'

/** Window event asking Filters.tsx to open the guide. */
export const AI_GUIDE_EVENT = 'lunar:aiFilterGuide'
/** `filterId`: the AI Filter it's about (its input decides the prompt). */
export const openAiFilterGuide = (filterId?: string) =>
  window.dispatchEvent(new CustomEvent(AI_GUIDE_EVENT, { detail: filterId }))

/**
 * How the AI Filter works, step by step (user, 2026-10-03). Opened by the ?
 * on the AI Filter card, and by itself right after the welcome's Use AI.
 * Explanation only: the card has the Copy prompt button and response box.
 */
export default function AiFilterGuide({
  previousType,
  onClose,
}: {
  /** The step before the AI Filter (what the prompt says its input is). */
  previousType?: string
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  // The real thing: same prompt as the card's Copy prompt.
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
  const box = useModal({ onEscape: onClose })

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div className="aig-overlay" onClick={onClose}>
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={box}
        className="aig-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="aig-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="aig-header">
          <span className="aig-icon">
            <FaRobot />
          </span>
          <h2 id="aig-title">How the AI Filter works</h2>
          <button
            type="button"
            className="aig-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Three steps side by side, each with a small mock of what you'll
            click or see (user, 2026-10-06: less boring). */}
        <ol className="aig-flow">
          <li className="aig-card aig-card--copy">
            <span className="aig-card-icon">
              <FaCopy />
            </span>
            <span className="aig-card-step">Step 1</span>
            <div className="aig-card-title">Copy the prompt</div>
            <div className="aig-mock">
              <button
                type="button"
                className={`aig-mock-btn aig-mock-btn--live${copied ? ' aig-mock-btn--done' : ''}`}
                onClick={copyPrompt}
                title="Copy the prompt to paste into your AI"
              >
                {copied ? 'Copied ✓' : 'Copy prompt'}
              </button>
            </div>
            <div className="aig-card-text">
              Paste it into ChatGPT, Claude or any other AI. It explains the
              task to the AI.
            </div>
          </li>
          <li className="aig-arrow" aria-hidden>
            →
          </li>
          <li className="aig-card aig-card--paste">
            <span className="aig-card-icon">
              <FaComments />
            </span>
            <span className="aig-card-step">Step 2</span>
            <div className="aig-card-title">Describe what you want</div>
            <div className="aig-mock">
              <span className="aig-mock-chat">
                every time Fox shines out of shield and gets a kill
              </span>
            </div>
            <div className="aig-card-text">
              At the end of the prompt, tell the AI in your own words the kind
              of clips you&apos;d like to find, then send it.
            </div>
          </li>
          <li className="aig-arrow" aria-hidden>
            →
          </li>
          <li className="aig-card aig-card--run">
            <span className="aig-card-icon">
              <FaPlay />
            </span>
            <span className="aig-card-step">Step 3</span>
            <div className="aig-card-title">Paste it in and hit Run</div>
            <div className="aig-mock aig-mock--pair">
              <span className="aig-mock-code">return clips.filter(…</span>
              <span className="aig-mock-run">Run</span>
            </div>
            <div className="aig-card-text">
              Copy the AI&apos;s reply into <strong>Input response here</strong>{' '}
              on the AI Filter and hit Run. Not quite right? Ask for changes and
              paste again.
            </div>
            <div className="aig-card-text">
              Clipper asks before it runs the code: it can do anything on your
              computer, so only run code you trust (a reply from an AI is not
              always safe).
            </div>
          </li>
        </ol>

        <div className="aig-footer">
          <button
            type="button"
            className="aig-btn aig-btn--primary"
            onClick={onClose}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}
