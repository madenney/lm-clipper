import { ReactNode } from 'react'
import { FaPlay, FaCircle, FaLayerGroup, FaFolderOpen } from 'react-icons/fa'

import '../styles/ActionBar.css'
import '../styles/TopBar.css'
import Tooltip from './Tooltip'

type Props = {
  /** Clips (or games, in the games view) selected, and their length in frames, if known. */
  selectedCount: number
  selectionLabel: string
  selectionLength: string | null
  isGenerating: boolean
  isPlaying: boolean
  stopping: boolean
  /** The recording's progress line ("recording 2/3 · 40%", "Merging videos", ...). */
  progress: ReactNode
  showSpinner: boolean
  canStitch: boolean
  onPlay: () => void
  onRecord: () => void
  onStopPlayback: () => void
  onStopRecording: () => void
  onCancelRecording: () => void
  onStitch: () => void
  /** Open the folder recorded clips are written to. */
  onOpenOutput: () => void
  /** The recording options popover. */
  options: ReactNode
  /** Owner-only extras (empty in public builds). */
  extras?: ReactNode
}

/**
 * Play, Record and Stitch, with what is selected: the top bar's left side (these
 * used to be the bottom bar). Record is the filled one. While recording, the same
 * place shows the progress with Stop and Cancel.
 */
export default function ActionBar({
  selectedCount,
  selectionLabel,
  selectionLength,
  isGenerating,
  isPlaying,
  stopping,
  progress,
  showSpinner,
  canStitch,
  onPlay,
  onRecord,
  onStopPlayback,
  onStopRecording,
  onCancelRecording,
  onStitch,
  onOpenOutput,
  options,
  extras,
}: Props) {
  if (isGenerating) {
    return (
      <div className="action-bar">
        <div className="action-status">
          {showSpinner && <span className="footer-gen-spinner" />}
          <span className="footer-gen-msg">{progress}</span>
        </div>
        <Tooltip text="Stop after the current clip finishes — keeps all completed clips">
          <button
            type="button"
            className="tb tb--stop"
            onClick={onStopRecording}
            disabled={stopping}
          >
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        </Tooltip>
        <Tooltip text="Cancel immediately — kills active Dolphin processes and discards in-progress clips">
          <button
            type="button"
            className="tb tb--danger"
            onClick={onCancelRecording}
          >
            Cancel
          </button>
        </Tooltip>
      </div>
    )
  }
  return (
    <div className="action-bar">
      <div className="action-selection" aria-live="polite">
        {selectedCount > 0 ? (
          <>
            <span className="action-selection-count">
              {selectedCount.toLocaleString()} {selectionLabel}
              {selectedCount !== 1 ? 's' : ''}
            </span>
            {selectionLength && (
              <span className="action-selection-length">{selectionLength}</span>
            )}
          </>
        ) : (
          <span className="action-selection-none">No clips selected</span>
        )}
      </div>
      <div className="tb-group action-group">
        {isPlaying ? (
          <Tooltip text="Stop playback and close Dolphin">
            <button
              type="button"
              className="tb tb--stop"
              onClick={onStopPlayback}
            >
              Stop
            </button>
          </Tooltip>
        ) : (
          <>
            <Tooltip text="Play the selected clips in Dolphin">
              <button
                type="button"
                className="tb tb--icon action-icon--play"
                onClick={onPlay}
                disabled={selectedCount === 0}
                aria-label="Play"
              >
                <FaPlay />
              </button>
            </Tooltip>
            <Tooltip text="Record the selected clips to video">
              <button
                type="button"
                className="tb tb--icon tb--record"
                onClick={onRecord}
                disabled={selectedCount === 0}
                aria-label="Record"
              >
                <FaCircle />
              </button>
            </Tooltip>
          </>
        )}
        <Tooltip text="Open output folder">
          <button
            type="button"
            className="tb tb--icon"
            onClick={onOpenOutput}
            aria-label="Open output folder"
          >
            <FaFolderOpen />
          </button>
        </Tooltip>
        {options}
        {extras}
        {canStitch && (
          <Tooltip text="Stitch clips together">
            <button
              type="button"
              className="tb tb--icon"
              onClick={onStitch}
              aria-label="Stitch"
            >
              <FaLayerGroup />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
