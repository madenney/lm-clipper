/**
 * Clip Component
 *
 * Displays a single clip (segment of Melee gameplay) as a square card.
 * Used in DOM rendering modes (full and mode2).
 *
 * CRITICAL: The container is ALWAYS square. Width and height are set
 * via inline style to the same value. All children are absolute
 * positioned and cannot affect container dimensions.
 */

import React, { memo, type CSSProperties, type MouseEvent } from 'react'
import { FiPlay, FiCircle } from 'react-icons/fi'

import './Clip.css'
import type { ClipInterface, FileInterface, PlayerInterface, LiteItem } from '../../../constants/types'
import { clipDisplayConfig, isFeatureVisible, type ClipMode } from '../../config/clipDisplay'
import {
  resolveStageImage,
  resolveCharacterImage,
  getArrowImage,
  getStageName,
  getPlayerLabel,
  getCharacterName,
} from '../../lib/clipAssets'
import ipcBridge from '../../ipcBridge'

export type ClipData = ClipInterface | FileInterface | LiteItem

type ClipProps = {
  data: ClipData
  size: number
  mode: ClipMode
  style?: CSSProperties
  isSelected?: boolean
  onMouseDown?: (e: React.MouseEvent) => void
  onMouseEnter?: () => void
}

/**
 * Extract player info from various data shapes
 */
const getPlayers = (data: ClipData): [PlayerInterface | undefined, PlayerInterface | undefined] => {
  if ('comboer' in data && data.comboer) {
    return [data.comboer, data.comboee]
  }
  if ('players' in data && data.players) {
    return [data.players[0], data.players[1]]
  }
  return [undefined, undefined]
}

/**
 * Get clip payload for play/record actions
 */
const getClipPayload = (data: ClipData) => {
  if (!('path' in data) || typeof data.path !== 'string') return null

  const payload: {
    path: string
    startFrame?: number
    endFrame?: number
    lastFrame?: number
  } = { path: data.path }

  if ('startFrame' in data && typeof data.startFrame === 'number') {
    payload.startFrame = data.startFrame
  }
  if ('endFrame' in data && typeof data.endFrame === 'number') {
    payload.endFrame = data.endFrame
  }
  if ('lastFrame' in data && typeof (data as FileInterface).lastFrame === 'number') {
    payload.lastFrame = (data as FileInterface).lastFrame
  }

  return payload
}

/**
 * Calculate duration display string
 */
const getDurationDisplay = (data: ClipData): string | null => {
  let frames = 0

  if ('endFrame' in data && 'startFrame' in data) {
    const clip = data as ClipInterface
    if (typeof clip.endFrame === 'number' && typeof clip.startFrame === 'number') {
      frames = clip.endFrame - clip.startFrame
    }
  } else if ('lastFrame' in data) {
    const file = data as FileInterface
    if (typeof file.lastFrame === 'number' && file.lastFrame > 0) {
      frames = file.lastFrame
    }
  }

  if (!frames) return null

  const seconds = frames / 60
  if (seconds >= 60) {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }
  return `${seconds.toFixed(1)}s`
}

function ClipComponent({ data, size, mode, style, isSelected, onMouseDown, onMouseEnter }: ClipProps) {
  const [player1, player2] = getPlayers(data)
  const stageId = data.stage
  const clipPayload = getClipPayload(data)

  // Feature visibility based on size
  const showButtons = isFeatureVisible('buttons', size)
  const showText = isFeatureVisible('text', size)
  const showCharIcons = isFeatureVisible('charIcons', size)
  const showBorders = isFeatureVisible('borders', size)

  // Resolve images
  const stageImage = resolveStageImage(stageId, size)
  const char1Image = showCharIcons ? resolveCharacterImage(player1) : undefined
  const char2Image = showCharIcons ? resolveCharacterImage(player2) : undefined
  const arrowImage = showCharIcons ? getArrowImage(stageId) : undefined

  // Labels
  const player1Label = getPlayerLabel(player1)
  const player2Label = getPlayerLabel(player2)
  const stageName = getStageName(stageId)
  const duration = getDurationDisplay(data)

  // Combo info
  const combo = 'combo' in data ? data.combo : undefined

  // Prevent native drag so it doesn't trigger the file-drop overlay
  const preventDrag = (e: React.DragEvent) => e.preventDefault()

  // Handlers
  const handlePlay = clipPayload ? () => ipcBridge.playClip(clipPayload) : undefined
  const handleRecord = clipPayload ? () => ipcBridge.recordClip(clipPayload) : undefined

  const handlePlayClick = (e: MouseEvent) => {
    e.stopPropagation()
    handlePlay?.()
  }

  const handleRecordClick = (e: MouseEvent) => {
    e.stopPropagation()
    handleRecord?.()
  }

  // Build class names
  const classNames = ['clip']
  if (mode === 'full') classNames.push('clip--full')
  if (mode === 'mode2') classNames.push('clip--mode2')
  if (showBorders) classNames.push('clip--with-border')
  if (size < 50) classNames.push('clip--low-res')
  if (isSelected) classNames.push('clip--selected')

  // Full mode: horizontal rectangle. Other modes: square
  const containerStyle: CSSProperties = mode === 'full'
    ? { ...style, width: '100%', height: size }
    : { ...style, width: size, height: size }

  // Full mode: horizontal layout with stage on left, info on right
  if (mode === 'full') {
    return (
      <div
        className={classNames.join(' ')}
        style={containerStyle}
        onMouseDown={onMouseDown}
        onMouseEnter={onMouseEnter}
        onDragStart={preventDrag}
      >
        {/* Left: Stage thumbnail */}
        <div className="clip-thumbnail">
          <div className="clip-bg">
            {stageImage && (
              <img className="clip-stage" src={stageImage} alt="" />
            )}
          </div>
          {showCharIcons && (char1Image || char2Image) && (
            <div className="clip-characters">
              {char1Image && <img className="clip-char" src={char1Image} alt="" />}
              {arrowImage && <img className="clip-arrow" src={arrowImage} alt="" />}
              {char2Image && <img className="clip-char" src={char2Image} alt="" />}
            </div>
          )}
        </div>

        {/* Right: Info content */}
        <div className="clip-content">
          <div className="clip-header">
            <div className="clip-matchup">
              {player1Label || 'P1'} vs {player2Label || 'P2'}
            </div>
            <div className="clip-meta">
              <span>{stageName}</span>
              {duration && <span className="clip-duration">{duration}</span>}
            </div>
          </div>
          {combo && (
            <div className="clip-combo">
              <span className="clip-combo-label">Combo</span>
              {combo.moves && <span>{combo.moves.length} hits</span>}
              {typeof combo.startPercent === 'number' && (
                <span>
                  {combo.startPercent.toFixed(0)}% → {combo.endPercent?.toFixed(0) ?? '?'}%
                </span>
              )}
              {combo.didKill && <span className="clip-kill">Kill</span>}
            </div>
          )}
          {'path' in data && data.path && (
            <div className="clip-file">{data.path}</div>
          )}
          {(handlePlay || handleRecord) && (
            <div className="clip-actions-bar">
              {handlePlay && (
                <button
                  type="button"
                  className="clip-action-btn clip-action-btn--play"
                  onClick={handlePlayClick}
                >
                  <FiPlay /> Play
                </button>
              )}
              {handleRecord && (
                <button
                  type="button"
                  className="clip-action-btn clip-action-btn--record"
                  onClick={handleRecordClick}
                >
                  <FiCircle /> Record
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  // Other modes: square card layout
  return (
    <div
      className={classNames.join(' ')}
      style={containerStyle}
      onMouseDown={onMouseDown}
      onMouseEnter={onMouseEnter}
      onDragStart={preventDrag}
    >
      {/* Background: Stage Image */}
      <div className="clip-bg">
        {stageImage && (
          <img className="clip-stage" src={stageImage} alt="" />
        )}
      </div>

      {/* Characters Overlay */}
      {showCharIcons && (char1Image || char2Image) && (
        <div className="clip-characters">
          {char1Image && <img className="clip-char" src={char1Image} alt="" />}
          {arrowImage && <img className="clip-arrow" src={arrowImage} alt="" />}
          {char2Image && <img className="clip-char" src={char2Image} alt="" />}
        </div>
      )}

      {/* Info Overlay */}
      {showText && (
        <div className="clip-info">
          <div className="clip-info-row">
            <span className="clip-info-value">
              {player1Label || 'P1'} vs {player2Label || 'P2'}
            </span>
          </div>
          {duration && (
            <div className="clip-info-row">
              <span className="clip-info-value clip-duration">{duration}</span>
            </div>
          )}
        </div>
      )}

      {/* Action Buttons (hover) - mode2 only */}
      {showButtons && mode === 'mode2' && (handlePlay || handleRecord) && (
        <div className="clip-actions">
          {handlePlay && (
            <button
              type="button"
              className="clip-action-btn clip-action-btn--play"
              onClick={handlePlayClick}
              title="Play"
            >
              <FiPlay />
            </button>
          )}
          {handleRecord && (
            <button
              type="button"
              className="clip-action-btn clip-action-btn--record"
              onClick={handleRecordClick}
              title="Record"
            >
              <FiCircle />
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export const Clip = memo(ClipComponent)
export default Clip
