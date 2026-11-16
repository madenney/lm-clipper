/**
 * FullCard Component
 *
 * The clip at full zoom (rethought 2026-10-10): the matchup over the stage art
 * with Play/Record, the numbers as tiles, then the combo itself: a map of where
 * it happened (positions read from the replay) and the damage hit by hit.
 * Raw details sit collapsed at the bottom.
 */

import React, { memo, useState, useCallback, useEffect, useMemo } from 'react'
import { FiPlay, FiCircle, FiCopy, FiCheck, FiFolder } from 'react-icons/fi'
import Tooltip from '../Tooltip'

import './FullCard.css'
import {
  resolveStageImage,
  resolveCharacterImage,
  getStageName,
  getPlayerLabel,
  getCharacterName,
} from '../../lib/clipAssets'
import ipcBridge from '../../ipcBridge'
import type { PlayerInterface } from '../../../constants/types'
import type { ClipTrack } from '../../../main/clipTrack'
import ComboMap from './ComboMap'
import DamageTimeline from './DamageTimeline'
import ReplayInfoPanel from './ReplayInfoPanel'
import GameFlow from './GameFlow'
import ClipWatch from './ClipWatch'
import { isWholeGame } from './cardSummary'
import { GAME_START_FRAME } from '../../../constants/frames'
import { comboHits, portColor } from './comboView'
import {
  getPlayers,
  getClipPayload,
  getDurationDisplay,
  type ClipData,
} from './clipUtils'

type FullCardProps = {
  data: ClipData
  /** Filter/table this clip came from — combined with the row id to form a
   *  fully-unique, copyable handle (row id alone repeats across tables). */
  filterId?: string
  isSelected?: boolean
  onMouseDown?: (_e: React.MouseEvent) => void
  onPlay?: (_payload: {
    path: string
    startFrame?: number
    endFrame?: number
    lastFrame?: number
  }) => void
  onRecord?: () => void
  onClose?: () => void
  /** Full zoom's place in the list: ‹ 3 / 1,957 › (also Z/X and ←/→). */
  nav?: { index: number; total: number; onPrev: () => void; onNext: () => void }
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
    <Tooltip
      text={copied ? 'Copied' : 'Copy this clip’s data (JSON) to the clipboard'}
    >
      <button
        type="button"
        className="fullcard-toolbar-btn"
        onClick={(e) => {
          e.stopPropagation()
          handleCopy()
        }}
      >
        {copied ? <FiCheck /> : <FiCopy />}
      </button>
    </Tooltip>
  )
}

/**
 * Clip ID row — shows the fully-unique `<filterId>#<rowId>` handle with a
 * one-click copy, so a clip can be referenced/looked up exactly.
 */
function ClipIdRow({ handle }: { handle: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(handle).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [handle])

  return (
    <div className="fullcard-row">
      <span className="fullcard-row-label">Clip ID</span>
      <span className="fullcard-row-value">
        <code className="fullcard-clipid">{handle}</code>
        <Tooltip
          text={
            copied
              ? 'Copied'
              : 'Copy the clip’s ID (filter#row), to look it up exactly later'
          }
        >
          <button
            type="button"
            className="fullcard-clipid-copy"
            onClick={(e) => {
              e.stopPropagation()
              handleCopy()
            }}
          >
            {copied ? <FiCheck /> : <FiCopy />}
          </button>
        </Tooltip>
      </span>
    </div>
  )
}

function StatTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  tone?: 'kill' | 'text'
}) {
  return (
    <div className={`fullcard-stat${tone ? ` fullcard-stat--${tone}` : ''}`}>
      <span className="fullcard-stat-label">{label}</span>
      <span className="fullcard-stat-value">{value}</span>
      {sub && <span className="fullcard-stat-sub">{sub}</span>}
    </div>
  )
}

function PlayerCard({
  player,
  image,
  role,
  align,
}: {
  player?: PlayerInterface
  image?: string | null
  role?: string
  align: 'left' | 'right'
}) {
  if (!player) return <div className="fullcard-player" />
  const color = portColor(player.port)
  return (
    <div
      className={`fullcard-player fullcard-player--${align}`}
      style={{ '--port': color } as React.CSSProperties}
    >
      {image && <img className="fullcard-player-char" src={image} alt="" />}
      <div className="fullcard-player-text">
        {role && <span className="fullcard-player-role">{role}</span>}
        <span className="fullcard-player-name">
          {getPlayerLabel(player) || `Player ${player.port}`}
        </span>
        <span className="fullcard-player-meta">
          <span className="fullcard-port">P{player.port}</span>
          {getCharacterName(player.characterId) ?? 'Unknown'}
          {player.connectCode ? ` · ${player.connectCode}` : ''}
        </span>
      </div>
    </div>
  )
}

function FullCardComponent({
  data,
  filterId,
  isSelected,
  onMouseDown,
  onPlay,
  onRecord,
  onClose,
  nav,
}: FullCardProps) {
  const [player1, player2] = getPlayers(data)
  const stageId = data.stage
  const clipPayload = getClipPayload(data)
  const combo = 'combo' in data ? data.combo : undefined

  const stageImage = resolveStageImage(stageId)
  const char1Image = resolveCharacterImage(player1)
  const char2Image = resolveCharacterImage(player2)
  const stageName = getStageName(stageId)
  const duration = getDurationDisplay(data)

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
  // A clip of any kind (combo, edgeguard, highlight…) is shown as that clip:
  // the player on its frames, where it happened. A whole game gets its flow.
  const isClip = !isWholeGame(data) && startFrame != null && endFrame != null

  const hits = useMemo(() => comboHits(combo), [combo])
  const startPercent =
    combo && typeof combo.startPercent === 'number' ? combo.startPercent : null
  const endPercent =
    combo && typeof combo.endPercent === 'number'
      ? combo.endPercent
      : hits.length
        ? hits[hits.length - 1].percent
        : null
  const totalDamage =
    startPercent != null && endPercent != null
      ? endPercent - startPercent
      : null
  const perSecond =
    totalDamage != null && frameCount != null && frameCount > 0
      ? (totalDamage / frameCount) * 60
      : null

  // Where both players went, read from the replay in main: the clip, or for a
  // whole game everything from the start to its last frame.
  const path =
    'path' in data && typeof data.path === 'string' ? data.path : null
  const lastFrame =
    'lastFrame' in data && typeof data.lastFrame === 'number'
      ? data.lastFrame
      : null
  const spanStart = isClip ? startFrame : GAME_START_FRAME
  const spanEnd = isClip ? endFrame : (lastFrame ?? endFrame)
  const trackKey =
    path && spanStart != null && spanEnd != null && player1 && player2
      ? `${path}|${spanStart}|${spanEnd}|${player1.playerIndex}|${player2.playerIndex}`
      : null
  const [trackResult, setTrackResult] = useState<{
    key: string
    track?: ClipTrack
    error?: string
  } | null>(null)
  useEffect(() => {
    if (!trackKey || !path || spanStart == null || spanEnd == null) return
    let live = true
    ipcBridge.getClipTrack(
      {
        path,
        startFrame: spanStart,
        endFrame: spanEnd,
        playerIndexes: [player1!.playerIndex, player2!.playerIndex],
      },
      (res) => {
        if (live) setTrackResult({ key: trackKey, ...res })
      },
    )
    return () => {
      live = false
    }
    // trackKey carries every input that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackKey])
  const current =
    trackResult && trackResult.key === trackKey ? trackResult : null
  const mapStatus = !trackKey
    ? 'none'
    : !current
      ? 'loading'
      : current.track
        ? 'ready'
        : 'error'

  // A whole game's result, from the stocks at its end.
  const gameResult = useMemo(() => {
    if (isClip || !current?.track || !player1 || !player2) return null
    const left = (p: PlayerInterface) =>
      current
        .track!.players.find((t) => t.playerIndex === p.playerIndex)
        ?.points.at(-1)
    const a = left(player1)
    const b = left(player2)
    if (!a || !b || a.s === b.s) return null
    const [win, lose] = a.s > b.s ? [player1, b] : [player2, a]
    return {
      name: getPlayerLabel(win) || `P${win.port}`,
      stocks: Math.max(a.s, b.s),
      lostAll: lose.s === 0,
    }
  }, [isClip, current, player1, player2])

  const handlePlay =
    onPlay && clipPayload ? () => onPlay(clipPayload) : undefined
  const preventDrag = (e: React.DragEvent) => e.preventDefault()

  const clipId = 'id' in data && data.id != null ? String(data.id) : null
  const clipHandle = clipId != null ? `${filterId ?? 'files'}#${clipId}` : null

  const attackerColor = portColor(player1?.port)
  const victimColor = portColor(player2?.port)

  const classNames = ['fullcard']
  if (isSelected) classNames.push('fullcard--selected')

  return (
    <div
      className={classNames.join(' ')}
      onMouseDown={onMouseDown}
      onDragStart={preventDrag}
    >
      {/* ─── Header: stage art behind the matchup, actions on the right ─── */}
      <header
        className="fullcard-head"
        style={
          stageImage
            ? ({ '--stage': `url("${stageImage}")` } as React.CSSProperties)
            : undefined
        }
      >
        <div className="fullcard-toolbar">
          {nav && nav.total > 1 && (
            <div className="fullcard-nav">
              <Tooltip text="Previous clip (Z or ←)">
                <button
                  type="button"
                  className="fullcard-toolbar-btn"
                  disabled={nav.index <= 0}
                  onClick={(e) => {
                    e.stopPropagation()
                    nav.onPrev()
                  }}
                  aria-label="Previous"
                >
                  ‹
                </button>
              </Tooltip>
              <span>
                {(nav.index + 1).toLocaleString()} /{' '}
                {nav.total.toLocaleString()}
              </span>
              <Tooltip text="Next clip (X or →)">
                <button
                  type="button"
                  className="fullcard-toolbar-btn"
                  disabled={nav.index >= nav.total - 1}
                  onClick={(e) => {
                    e.stopPropagation()
                    nav.onNext()
                  }}
                  aria-label="Next"
                >
                  ›
                </button>
              </Tooltip>
            </div>
          )}
          {path && (
            <Tooltip text="Open the replay's folder">
              <button
                type="button"
                className="fullcard-toolbar-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  ipcBridge.openFolder(path.replace(/[\\/][^\\/]+$/, ''))
                }}
              >
                <FiFolder />
              </button>
            </Tooltip>
          )}
          <CopyButton data={data} />
          {onClose && (
            <Tooltip text="Back to the grid (Esc)">
              <button
                type="button"
                className="fullcard-close"
                aria-label="Back to the grid"
                onClick={(e) => {
                  e.stopPropagation()
                  onClose()
                }}
              >
                &times;
              </button>
            </Tooltip>
          )}
        </div>
        <div className="fullcard-matchup">
          <PlayerCard
            player={player1}
            image={char1Image}
            role={combo ? 'Combo by' : undefined}
            align="left"
          />
          <span className="fullcard-versus">{combo ? '→' : 'vs'}</span>
          <PlayerCard
            player={player2}
            image={char2Image}
            role={combo ? 'On' : undefined}
            align="right"
          />
        </div>
        <div className="fullcard-actions">
          {handlePlay && (
            <button
              type="button"
              className="fullcard-btn fullcard-btn--play"
              onClick={(e) => {
                e.stopPropagation()
                handlePlay()
              }}
            >
              <FiPlay /> Play
            </button>
          )}
          {onRecord && (
            <button
              type="button"
              className="fullcard-btn fullcard-btn--record"
              onClick={(e) => {
                e.stopPropagation()
                onRecord()
              }}
            >
              <FiCircle /> Record
            </button>
          )}
        </div>
      </header>

      {/* ─── Numbers ─── */}
      <div className="fullcard-stats">
        {totalDamage != null && (
          <StatTile
            label="Damage"
            value={`+${totalDamage.toFixed(0)}%`}
            sub={`${startPercent!.toFixed(0)}% → ${endPercent!.toFixed(0)}%`}
          />
        )}
        {hits.length > 0 && <StatTile label="Hits" value={hits.length} />}
        {duration && (
          <StatTile
            label="Length"
            value={duration}
            sub={frameCount != null ? `${frameCount} frames` : undefined}
          />
        )}
        {perSecond != null && (
          <StatTile label="Pace" value={`${perSecond.toFixed(1)}%/s`} />
        )}
        <StatTile label="Stage" value={stageName || '—'} tone="text" />
        {gameResult && (
          <StatTile
            label={gameResult.lostAll ? 'Winner' : 'Ahead at the end'}
            value={gameResult.name}
            sub={`${gameResult.stocks} ${gameResult.stocks === 1 ? 'stock' : 'stocks'} left`}
          />
        )}
        {combo?.didKill && (
          <StatTile
            label="Ending"
            value={combo.earlyQuit ? 'Quit out' : 'KO'}
            sub={combo.earlyQuit ? 'would have killed' : undefined}
            tone="kill"
          />
        )}
      </div>

      {/* ─── The combo ─── */}
      <div
        className={`fullcard-main${isClip && path ? ' fullcard-main--watch' : ''}`}
      >
        {isClip && startFrame != null && endFrame != null ? (
          path ? (
            <>
              {/* Left: the clip, its damage on the same timeline underneath. */}
              <div className="fullcard-col">
                <section className="fullcard-panel fullcard-panel--watch">
                  <h3>Watch</h3>
                  <ClipWatch
                    key={`${path}|${startFrame}|${endFrame}`}
                    path={path}
                    startFrame={startFrame}
                    endFrame={endFrame}
                  />
                  {hits.length > 0 && (
                    <DamageTimeline
                      part="chart"
                      hits={hits}
                      startFrame={startFrame}
                      endFrame={endFrame}
                      startPercent={startPercent ?? 0}
                      color={victimColor}
                      didKill={combo?.didKill ?? false}
                    />
                  )}
                </section>
              </div>
              {/* Right: where it happened, then every hit (scrolls). */}
              <div className="fullcard-col">
                <section className="fullcard-panel fullcard-panel--map">
                  <h3>Where it happened</h3>
                  <ComboMap
                    stageId={stageId}
                    track={current?.track ?? null}
                    status={mapStatus}
                    message={current?.error}
                    attacker={
                      player1
                        ? {
                            playerIndex: player1.playerIndex,
                            color: attackerColor,
                            image: char1Image,
                          }
                        : undefined
                    }
                    victim={
                      player2
                        ? {
                            playerIndex: player2.playerIndex,
                            color: victimColor,
                            image: char2Image,
                          }
                        : undefined
                    }
                    hits={hits}
                    startFrame={startFrame}
                    endFrame={endFrame}
                    didKill={combo?.didKill ?? false}
                  />
                </section>
                {combo && (
                  <section className="fullcard-panel fullcard-panel--hits">
                    <h3>
                      Hits
                      {hits.length ? ` (${hits.length})` : ''}
                    </h3>
                    {hits.length ? (
                      <DamageTimeline
                        part="list"
                        hits={hits}
                        startFrame={startFrame}
                        endFrame={endFrame}
                        startPercent={startPercent ?? 0}
                        color={victimColor}
                        didKill={combo?.didKill ?? false}
                      />
                    ) : (
                      <p className="fullcard-muted">No hits recorded.</p>
                    )}
                  </section>
                )}
              </div>
            </>
          ) : (
            <>
              <section className="fullcard-panel fullcard-panel--map">
                <h3>Where it happened</h3>
                <ComboMap
                  stageId={stageId}
                  track={current?.track ?? null}
                  status={mapStatus}
                  message={current?.error}
                  attacker={
                    player1
                      ? {
                          playerIndex: player1.playerIndex,
                          color: attackerColor,
                          image: char1Image,
                        }
                      : undefined
                  }
                  victim={
                    player2
                      ? {
                          playerIndex: player2.playerIndex,
                          color: victimColor,
                          image: char2Image,
                        }
                      : undefined
                  }
                  hits={hits}
                  startFrame={startFrame}
                  endFrame={endFrame}
                  didKill={combo?.didKill ?? false}
                />
              </section>
              {combo && (
                <section className="fullcard-panel fullcard-panel--damage">
                  <h3>Damage</h3>
                  {hits.length ? (
                    <DamageTimeline
                      hits={hits}
                      startFrame={startFrame}
                      endFrame={endFrame}
                      startPercent={startPercent ?? 0}
                      color={victimColor}
                      didKill={combo?.didKill ?? false}
                    />
                  ) : (
                    <p className="fullcard-muted">
                      No hits recorded for this clip.
                    </p>
                  )}
                </section>
              )}
            </>
          )
        ) : (
          <>
            <section className="fullcard-panel fullcard-panel--flow">
              <h3>Game flow</h3>
              {current?.track && spanStart != null && spanEnd != null ? (
                <GameFlow
                  track={current.track}
                  startFrame={Math.max(spanStart, 0)}
                  endFrame={spanEnd}
                  sides={[player1, player2]
                    .filter((p): p is PlayerInterface => !!p)
                    .map((p) => ({
                      playerIndex: p.playerIndex,
                      color: portColor(p.port),
                      name: getPlayerLabel(p) || `P${p.port}`,
                    }))}
                />
              ) : (
                <p className="fullcard-muted">
                  {mapStatus === 'loading'
                    ? 'Reading the replay…'
                    : current?.error || 'No game data for this replay.'}
                </p>
              )}
            </section>
            <section className="fullcard-panel fullcard-panel--map">
              <h3>Where they played</h3>
              <ComboMap
                mode="game"
                stageId={stageId}
                track={current?.track ?? null}
                status={mapStatus}
                message={current?.error}
                attacker={
                  player1
                    ? { playerIndex: player1.playerIndex, color: attackerColor }
                    : undefined
                }
                victim={
                  player2
                    ? { playerIndex: player2.playerIndex, color: victimColor }
                    : undefined
                }
                hits={[]}
                startFrame={null}
                endFrame={null}
              />
            </section>
          </>
        )}
      </div>

      {/* ─── What the Lunar Database knows (or the upload pitch) ─── */}
      <div className="fullcard-extra">
        <ReplayInfoPanel
          replayId={
            'lunarClip' in data && data.lunarClip?.replayId
              ? data.lunarClip.replayId
              : undefined
          }
          path={path}
          left={player1}
          right={player2}
        />
      </div>

      {/* ─── Details, out of the way ─── */}
      <div className="fullcard-body">
        <ExpandableSection title="Details">
          {clipHandle && <ClipIdRow handle={clipHandle} />}
          {startFrame != null && (
            <div className="fullcard-row">
              <span className="fullcard-row-label">Frames</span>
              <span className="fullcard-row-value">
                {startFrame} → {endFrame}
              </span>
            </div>
          )}
          {[player1, player2].map(
            (p, i) =>
              p && (
                <div className="fullcard-row" key={i}>
                  <span className="fullcard-row-label">Player {i + 1}</span>
                  <span className="fullcard-row-value">
                    {getPlayerLabel(p)} · port {p.port} · colour{' '}
                    {p.characterColor}
                    {p.nametag ? ` · tag ${p.nametag}` : ''}
                  </span>
                </div>
              ),
          )}
          {path && (
            <div className="fullcard-row">
              <span className="fullcard-row-label">File</span>
              <span className="fullcard-row-value fullcard-filepath">
                {path}
              </span>
            </div>
          )}
        </ExpandableSection>
        <ExpandableSection title="Raw data">
          <pre className="fullcard-raw">{JSON.stringify(data, null, 2)}</pre>
        </ExpandableSection>
      </div>
    </div>
  )
}

export const FullCard = memo(FullCardComponent)
export default FullCard
