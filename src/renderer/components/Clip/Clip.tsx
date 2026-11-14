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
import { FiPlay, FiCircle, FiCheck } from 'react-icons/fi'
import { GiDeathSkull } from 'react-icons/gi'

import './Clip.css'
import type { ClipMode } from '../../config/clipDisplay'
import { isFeatureVisible } from '../../config/clipDisplay'
import {
  resolveStageImage,
  resolveCharacterImage,
  getArrowImage,
  getStageName,
  getPlayerLabel,
  arrowImages,
} from '../../lib/clipAssets'
import {
  CARD_LAYOUTS,
  VS_FONT,
  VS_STROKE,
  VS_WEIGHT,
  type CardLayout,
  type Rect,
} from '../../lib/tileArt'
import {
  getPlayers,
  getClipPayload,
  getDurationDisplay,
  type ClipData,
} from './clipUtils'
import { summarizeClip, type CardKind } from './cardSummary'

/** A rect of the card (tile fractions) as absolute-position percentages. */
const place = (r: Rect): CSSProperties => ({
  left: `${r[0] * 100}%`,
  top: `${r[1] * 100}%`,
  width: `${(r[2] - r[0]) * 100}%`,
  height: `${(r[3] - r[1]) * 100}%`,
})

/** Per layout, the icons' places (CARD_LAYOUTS, shared with the GPU tiles). */
const PLACES = Object.fromEntries(
  (Object.keys(CARD_LAYOUTS) as CardLayout[]).map((k) => {
    const L = CARD_LAYOUTS[k]
    return [
      k,
      {
        chip: place(L.chip),
        char1: place(L.char1),
        char2: place(L.char2),
        mid: { ...place(L.mid), opacity: L.midAlpha },
      },
    ]
  }),
) as Record<
  CardLayout,
  {
    chip: CSSProperties
    char1: CSSProperties
    char2: CSSProperties
    mid: CSSProperties
  }
>

/** The card's icon layout for a row: who hit whom, or a game's two players. */
export const cardLayoutFor = (kind: CardKind, data: ClipData): CardLayout => {
  if (kind === 'game') return 'versus'
  if (kind !== 'clip') return 'arrow'
  return 'comboer' in data && data.comboer ? 'arrow' : 'versus'
}

type ClipProps = {
  data: ClipData
  size: number
  mode: ClipMode
  style?: CSSProperties
  isSelected?: boolean
  /** The grid's keyboard highlight is on this card (Tray/DomLayer.tsx). */
  kbdActive?: boolean
  /** An id for aria-activedescendant (the grid is a listbox of these). */
  domId?: string
  onMouseDown?: (_e: React.MouseEvent) => void
  onDoubleClick?: (_e: React.MouseEvent) => void
  onMouseEnter?: () => void
  onPlay?: (_payload: {
    path: string
    startFrame?: number
    endFrame?: number
    lastFrame?: number
  }) => void
  onRecord?: () => void
}

function ClipComponent({
  data,
  size,
  mode,
  style,
  isSelected,
  kbdActive,
  domId,
  onMouseDown,
  onDoubleClick,
  onMouseEnter,
  onPlay,
  onRecord,
}: ClipProps) {
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
  const handlePlay =
    onPlay && clipPayload ? () => onPlay(clipPayload) : undefined
  const handleRecord = onRecord || undefined

  const handlePlayClick = (e: MouseEvent) => {
    e.stopPropagation()
    handlePlay?.()
  }

  // Pressing a button twice quickly mustn't also open Single.
  const stopDoubleClick = (e: MouseEvent) => e.stopPropagation()

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
  if (kbdActive) classNames.push('clip--kbd-active')

  // Full mode: horizontal rectangle (width from left+right positioning). Other modes: square
  const containerStyle: CSSProperties =
    mode === 'full'
      ? { ...style, height: size }
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
              {char1Image && (
                <img className="clip-char" src={char1Image} alt="" />
              )}
              {arrowImage && (
                <img className="clip-arrow" src={arrowImage} alt="" />
              )}
              {char2Image && (
                <img className="clip-char" src={char2Image} alt="" />
              )}
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
                  {combo.startPercent.toFixed(0)}% →{' '}
                  {combo.endPercent?.toFixed(0) ?? '?'}%
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

  // Grid card (mode2): dimmed stage, both icons on one backing, a lead line
  // for what the step found, a strength meter and the actions in a corner.
  const summary = summarizeClip(data)
  // Lines keep their place when empty, so a row of cards lines up.
  const showDetail = isFeatureVisible('detail', size)
  const showNames = isFeatureVisible('names', size) && summary.kind !== 'game'
  let tier = 'sm'
  if (isFeatureVisible('names', size)) tier = 'lg'
  else if (isFeatureVisible('detail', size)) tier = 'md'
  classNames.push(`clip--${tier}`)
  if (summary.tone !== 'normal') classNames.push(`clip--tone-${summary.tone}`)
  const layout = cardLayoutFor(summary.kind, data)
  const icons = CARD_LAYOUTS[layout]
  const places = PLACES[layout]
  const vsFont = (icons.mid[2] - icons.mid[0]) * size * VS_FONT

  return (
    <div
      className={classNames.join(' ')}
      style={containerStyle}
      id={domId}
      role={domId ? 'option' : undefined}
      aria-selected={domId ? !!isSelected : undefined}
      title={summary.label}
      aria-label={summary.label}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      onMouseEnter={onMouseEnter}
      onDragStart={preventDrag}
    >
      {/* Background: the stage, dimmed so the icons and text read on it */}
      <div className="clip-bg">
        {stageImage && <img className="clip-stage" src={stageImage} alt="" />}
      </div>

      {/* Icons placed by CARD_LAYOUTS: both on one dark pill with the arrow
          between them (attacker -> victim); a game's players with a "vs". */}
      {showCharIcons && (char1Image || char2Image) && (
        <div className={`clip-characters clip-characters--${layout}`}>
          <span
            className="clip-matchup-chip"
            style={{
              ...places.chip,
              borderRadius: icons.chipRadius * size,
            }}
          />
          {char1Image && (
            <img
              className="clip-char clip-char--1"
              src={char1Image}
              alt=""
              style={places.char1}
            />
          )}
          {layout === 'versus' ? (
            <span
              className="clip-vs"
              style={{
                ...places.mid,
                fontSize: vsFont,
                fontWeight: VS_WEIGHT,
                WebkitTextStroke: `${vsFont * VS_STROKE * 2}px rgba(0, 0, 0, 0.75)`,
              }}
            >
              vs
            </span>
          ) : (
            arrowImages.light && (
              <img
                className="clip-arrow"
                src={arrowImages.light}
                alt=""
                style={places.mid}
              />
            )
          )}
          {char2Image && (
            <img
              className="clip-char clip-char--2"
              src={char2Image}
              alt=""
              style={places.char2}
            />
          )}
        </div>
      )}

      {summary.tone !== 'normal' && <span className="clip-accent" />}

      {summary.badge && (
        <span
          className={`clip-badge clip-badge--${summary.badge === 'KILL' ? 'kill' : 'quit'}`}
        >
          {summary.badge === 'KILL' && <GiDeathSkull aria-hidden="true" />}
          {/* Small cards: the skull alone (a step of kills shows one on each). */}
          {(tier !== 'sm' || summary.badge !== 'KILL') && summary.badge}
        </span>
      )}

      {isSelected && (
        <span className="clip-check" aria-hidden="true">
          <FiCheck />
        </span>
      )}

      <div className="clip-foot">
        {showButtons && (handlePlay || handleRecord) && (
          <div className="clip-actions">
            {handlePlay && (
              <button
                type="button"
                className="clip-action-btn clip-action-btn--play"
                onDoubleClick={stopDoubleClick}
                onClick={handlePlayClick}
                title="Play in Dolphin"
                aria-label="Play clip"
              >
                <FiPlay />
              </button>
            )}
            {handleRecord && (
              <button
                type="button"
                className="clip-action-btn clip-action-btn--record"
                onDoubleClick={stopDoubleClick}
                onClick={handleRecordClick}
                title="Record clip"
                aria-label="Record clip"
              >
                <FiCircle />
              </button>
            )}
          </div>
        )}

        {showText && (
          <div className="clip-info">
            <div className="clip-info-row clip-info-lead">
              <span className="clip-info-primary">
                {summary.primary || 'Clip'}
              </span>
              {summary.duration && (
                <span className="clip-duration">{summary.duration}</span>
              )}
            </div>
            {showDetail && (
              <div className="clip-info-row clip-info-detail">
                {summary.detail || '\u00a0'}
              </div>
            )}
            {showNames && (
              <div className="clip-info-row clip-info-names">
                {summary.names || '\u00a0'}
              </div>
            )}
          </div>
        )}
        {summary.meter !== null && (
          <span className="clip-meter">
            <span
              className="clip-meter-fill"
              style={{ transform: `scaleX(${summary.meter.toFixed(3)})` }}
            />
          </span>
        )}
      </div>
    </div>
  )
}

export const Clip = memo(ClipComponent)
export default Clip
