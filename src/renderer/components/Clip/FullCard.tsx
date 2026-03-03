/**
 * FullCard Component
 *
 * Rich, detailed game card rendered in full mode (max zoom).
 * Fills the entire tray and displays all available clip/game data
 * across a hero section, expandable body sections, and footer actions.
 */

import React, { memo, useState, useCallback, type MouseEvent } from 'react'
import { FiPlay, FiCircle, FiCopy, FiCheck } from 'react-icons/fi'

import './FullCard.css'
import type {
  ClipInterface,
  FileInterface,
  PlayerInterface,
  LiteItem,
} from '../../../constants/types'
import {
  resolveStageImage,
  resolveCharacterImage,
  getArrowImage,
  getStageName,
  getPlayerLabel,
  getCharacterName,
} from '../../lib/clipAssets'
import ipcBridge from '../../ipcBridge'
import { moves } from '../../../constants/moves'

type ClipData = ClipInterface | FileInterface | LiteItem

type FullCardProps = {
  data: ClipData
  isSelected?: boolean
  onMouseDown?: (_e: React.MouseEvent) => void
  onRecord?: () => void
  onClose?: () => void
}

/**
 * Extract player info from various data shapes
 */
const getPlayers = (
  data: ClipData,
): [PlayerInterface | undefined, PlayerInterface | undefined] => {
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
  if (
    'lastFrame' in data &&
    typeof (data as FileInterface).lastFrame === 'number'
  ) {
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
    if (
      typeof clip.endFrame === 'number' &&
      typeof clip.startFrame === 'number'
    ) {
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

/**
 * Lookup move name by moveId
 */
const getMoveName = (moveId: number): string => {
  const move = moves.find((m: { id: number; name: string }) => m.id === moveId)
  return move?.name ?? `Move ${moveId}`
}

/**
 * Aggregate moves into summary pills: "Uair x2 (24%)"
 */
const aggregateMoves = (
  moveList: { moveId: number; damage: number; hitCount: number }[],
): { name: string; count: number; damage: number }[] => {
  const map = new Map<string, { count: number; damage: number }>()
  for (const m of moveList) {
    const name = getMoveName(m.moveId)
    const existing = map.get(name)
    if (existing) {
      existing.count += m.hitCount || 1
      existing.damage += m.damage
    } else {
      map.set(name, { count: m.hitCount || 1, damage: m.damage })
    }
  }
  return Array.from(map.entries()).map(([name, v]) => ({
    name,
    count: v.count,
    damage: v.damage,
  }))
}

/**
 * Expandable section wrapper
 */
function ExpandableSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="fullcard-section">
      <div
        className="fullcard-section-header"
        onClick={() => setOpen((o) => !o)}
      >
        <span
          className={`fullcard-section-chevron ${open ? 'fullcard-section-chevron--open' : ''}`}
        >
          &#9654;
        </span>
        {title}
      </div>
      {open && <div className="fullcard-section-content">{children}</div>}
    </div>
  )
}

function CopyButton({ data }: { data: ClipData }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    const json = JSON.stringify(data, null, 2)
    navigator.clipboard.writeText(json).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [data])

  return (
    <button
      type="button"
      className="fullcard-toolbar-btn"
      onClick={(e) => {
        e.stopPropagation()
        handleCopy()
      }}
      title="Copy JSON to clipboard"
    >
      {copied ? <FiCheck /> : <FiCopy />}
    </button>
  )
}

function FullCardComponent({
  data,
  isSelected,
  onMouseDown,
  onRecord,
  onClose,
}: FullCardProps) {
  const [player1, player2] = getPlayers(data)
  const stageId = data.stage
  const clipPayload = getClipPayload(data)
  const combo = 'combo' in data ? data.combo : undefined

  // Images
  const stageImage = resolveStageImage(stageId)
  const char1Image = resolveCharacterImage(player1)
  const char2Image = resolveCharacterImage(player2)
  const arrowImage = getArrowImage(stageId)

  // Labels
  const player1Label = getPlayerLabel(player1)
  const player2Label = getPlayerLabel(player2)
  const stageName = getStageName(stageId)
  const duration = getDurationDisplay(data)

  // Move aggregation
  const movePills =
    combo?.moves && combo.moves.length > 0 ? aggregateMoves(combo.moves) : null

  // Frame data
  const startFrame =
    'startFrame' in data && typeof data.startFrame === 'number'
      ? data.startFrame
      : null
  const endFrame =
    'endFrame' in data && typeof data.endFrame === 'number'
      ? data.endFrame
      : null
  const frameCount =
    startFrame != null && endFrame != null ? endFrame - startFrame : null

  // Damage
  const startPercent =
    combo && typeof combo.startPercent === 'number' ? combo.startPercent : null
  const endPercent =
    combo && typeof combo.endPercent === 'number' ? combo.endPercent : null
  const totalDamage =
    startPercent != null && endPercent != null
      ? endPercent - startPercent
      : null
  const dps =
    totalDamage != null && frameCount != null && frameCount > 0
      ? ((totalDamage / frameCount) * 60).toFixed(1)
      : null

  // Handlers
  const handlePlay = clipPayload
    ? () => ipcBridge.playClip(clipPayload)
    : undefined
  const handleRecord = onRecord || undefined

  const handlePlayClick = (e: MouseEvent) => {
    e.stopPropagation()
    handlePlay?.()
  }

  const handleRecordClick = (e: MouseEvent) => {
    e.stopPropagation()
    handleRecord?.()
  }

  const preventDrag = (e: React.DragEvent) => e.preventDefault()

  const classNames = ['fullcard']
  if (isSelected) classNames.push('fullcard--selected')

  return (
    <div
      className={classNames.join(' ')}
      onMouseDown={onMouseDown}
      onDragStart={preventDrag}
    >
      {/* Top-right toolbar */}
      <div className="fullcard-toolbar">
        <CopyButton data={data} />
        {onClose && (
          <button
            type="button"
            className="fullcard-close"
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            title="Close (Escape)"
          >
            &times;
          </button>
        )}
      </div>

      {/* ─── Hero ─── */}
      <div className="fullcard-hero">
        <div className="fullcard-stage">
          {stageImage && <img src={stageImage} alt={stageName} />}
        </div>
        <div className="fullcard-summary">
          {/* Matchup */}
          <div className="fullcard-matchup">
            <div className="fullcard-matchup-icons">
              {char1Image && (
                <img
                  className="fullcard-char-icon"
                  src={char1Image}
                  alt={player1Label}
                />
              )}
              {arrowImage && (
                <img className="fullcard-arrow-icon" src={arrowImage} alt="" />
              )}
              {char2Image && (
                <img
                  className="fullcard-char-icon"
                  src={char2Image}
                  alt={player2Label}
                />
              )}
            </div>
            <span className="fullcard-matchup-names">
              {player1Label || 'P1'} vs {player2Label || 'P2'}
            </span>
          </div>

          {/* Meta */}
          <div className="fullcard-meta">
            <span>{stageName}</span>
            {duration && (
              <span className="fullcard-meta-duration">{duration}</span>
            )}
          </div>

          {/* Combo summary */}
          {combo && (
            <div className="fullcard-combo-summary">
              <span className="fullcard-combo-label">Combo</span>
              {combo.moves && <span>{combo.moves.length} hits</span>}
              {typeof combo.startPercent === 'number' && (
                <span>
                  {combo.startPercent.toFixed(0)}% &rarr;{' '}
                  {combo.endPercent?.toFixed(0) ?? '?'}%
                </span>
              )}
              {combo.didKill && (
                <span className="fullcard-kill-badge">Kill</span>
              )}
            </div>
          )}

          {/* Move pills */}
          {movePills && (
            <div className="fullcard-moves">
              {movePills.map((mp, i) => (
                <span key={`${mp.name}-${i}`} className="fullcard-move-pill">
                  {mp.name}
                  {mp.count > 1 ? ` x${mp.count}` : ''} ({mp.damage.toFixed(0)}
                  %)
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ─── Body ─── */}
      <div className="fullcard-body">
        {/* Player Details */}
        {(player1 || player2) && (
          <ExpandableSection title="Player Details" defaultOpen>
            {[player1, player2].map(
              (p, i) =>
                p && (
                  <div key={i} style={{ marginBottom: i === 0 ? 8 : 0 }}>
                    <div className="fullcard-row">
                      <span className="fullcard-row-label">Player {i + 1}</span>
                      <span className="fullcard-row-value">
                        {getPlayerLabel(p)}
                      </span>
                    </div>
                    {p.connectCode && (
                      <div className="fullcard-row">
                        <span className="fullcard-row-label">Connect Code</span>
                        <span className="fullcard-row-value">
                          {p.connectCode}
                        </span>
                      </div>
                    )}
                    {p.nametag && (
                      <div className="fullcard-row">
                        <span className="fullcard-row-label">Nametag</span>
                        <span className="fullcard-row-value">{p.nametag}</span>
                      </div>
                    )}
                    <div className="fullcard-row">
                      <span className="fullcard-row-label">Port</span>
                      <span className="fullcard-row-value">{p.port}</span>
                    </div>
                    <div className="fullcard-row">
                      <span className="fullcard-row-label">Character</span>
                      <span className="fullcard-row-value">
                        {getCharacterName(p.characterId) ?? 'Unknown'}
                      </span>
                    </div>
                    <div className="fullcard-row">
                      <span className="fullcard-row-label">Color</span>
                      <span className="fullcard-row-value">
                        {p.characterColor}
                      </span>
                    </div>
                  </div>
                ),
            )}
          </ExpandableSection>
        )}

        {/* Frame Data */}
        {(startFrame != null || endFrame != null) && (
          <ExpandableSection title="Frame Data">
            {startFrame != null && (
              <div className="fullcard-row">
                <span className="fullcard-row-label">Start Frame</span>
                <span className="fullcard-row-value">{startFrame}</span>
              </div>
            )}
            {endFrame != null && (
              <div className="fullcard-row">
                <span className="fullcard-row-label">End Frame</span>
                <span className="fullcard-row-value">{endFrame}</span>
              </div>
            )}
            {frameCount != null && (
              <div className="fullcard-row">
                <span className="fullcard-row-label">Duration</span>
                <span className="fullcard-row-value">
                  {frameCount} frames ({(frameCount / 60).toFixed(1)}s)
                </span>
              </div>
            )}
            {startPercent != null && (
              <div className="fullcard-row">
                <span className="fullcard-row-label">Start %</span>
                <span className="fullcard-row-value">
                  {startPercent.toFixed(1)}%
                </span>
              </div>
            )}
            {endPercent != null && (
              <div className="fullcard-row">
                <span className="fullcard-row-label">End %</span>
                <span className="fullcard-row-value">
                  {endPercent.toFixed(1)}%
                </span>
              </div>
            )}
            {totalDamage != null && (
              <div className="fullcard-row">
                <span className="fullcard-row-label">Total Damage</span>
                <span className="fullcard-row-value">
                  {totalDamage.toFixed(1)}%
                </span>
              </div>
            )}
            {dps != null && (
              <div className="fullcard-row">
                <span className="fullcard-row-label">DPS</span>
                <span className="fullcard-row-value">{dps}%/s</span>
              </div>
            )}
          </ExpandableSection>
        )}

        {/* File */}
        {'path' in data && data.path && (
          <ExpandableSection title="File">
            <div className="fullcard-filepath">{data.path}</div>
          </ExpandableSection>
        )}

        {/* Raw Data */}
        <ExpandableSection title="Raw Data">
          <pre className="fullcard-raw">{JSON.stringify(data, null, 2)}</pre>
        </ExpandableSection>
      </div>

      {/* ─── Footer ─── */}
      {(handlePlay || handleRecord) && (
        <div className="fullcard-footer">
          {handlePlay && (
            <button
              type="button"
              className="fullcard-btn fullcard-btn--play"
              onClick={handlePlayClick}
            >
              <FiPlay /> Play
            </button>
          )}
          {handleRecord && (
            <button
              type="button"
              className="fullcard-btn fullcard-btn--record"
              onClick={handleRecordClick}
            >
              <FiCircle /> Record
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export const FullCard = memo(FullCardComponent)
export default FullCard
