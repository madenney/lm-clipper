import { useState, useEffect, useCallback } from 'react'
import type { CSSProperties, MouseEvent } from 'react'

import '../styles/Item.css'
import type {
  ClipInterface,
  FileInterface,
  PlayerInterface,
  LiteItem
} from '../../constants/types'
import { FiCircle, FiPlay, FiX } from 'react-icons/fi'

import { characters } from '../../constants/characters'
import { stages } from '../../constants/stages'
import { getVariantUrl } from '../stageVariantAssets'
import ipcBridge from 'renderer/ipcBridge'

type StageImageModule = string | { default: string }

const resolveModule = (value: StageImageModule) =>
  typeof value === 'string' ? value : value?.default

// Arrow images (only two, keep as direct imports)
import NextArrow from '../../images/next.png'
import WhiteNextArrow from '../../images/whitenext.png'

// Character icons via require.context
const charContext = (require as any).context(
  '../../images/character-icons',
  true,
  /\.(png|jpe?g)$/
)
const charImages = new Map<string, string>()
charContext.keys().forEach((key: string) => {
  // key looks like "./falcon/Default.png"
  const match = key.match(/^\.\/([^/]+)\/([^/]+)\.(png|jpe?g)$/)
  if (!match) return
  const folder = match[1]
  const colorName = match[2]
  const url = resolveModule(charContext(key))
  if (url) charImages.set(`${folder}/${colorName}`, url)
})

// Stage base images via require.context
const stageContext = (require as any).context(
  '../../images/stages',
  false,
  /\.(png|jpe?g|jpg)$/
)
const stageBaseImages = new Map<string, string>()
stageContext.keys().forEach((key: string) => {
  // key looks like "./battlefield.jpg"
  const match = key.match(/^\.\/(.+)\.(png|jpe?g|jpg)$/)
  if (!match) return
  const baseName = match[1]
  const url = resolveModule(stageContext(key))
  if (url) stageBaseImages.set(baseName, url)
})

// Build stage tag -> base image URL mapping from stages constant
const stageImageByTag = new Map<string, string>()
Object.values(stages).forEach((stage) => {
  const stageInfo = stage as { tag?: string; img?: string }
  if (!stageInfo.tag || !stageInfo.img) return
  const fileName = stageInfo.img.split('/').pop() || ''
  const baseName = fileName.replace(/\.[^.]+$/, '')
  if (!baseName) return
  const url = stageBaseImages.get(baseName)
  if (url) stageImageByTag.set(stageInfo.tag, url)
})

const resolveStageImage = (tag: string, tileSize: number) => {
  const variantUrl = getVariantUrl(tag, tileSize)
  if (variantUrl) return variantUrl
  return stageImageByTag.get(tag) || null
}

const resolveCharacterImage = (player?: PlayerInterface) => {
  if (!player) return undefined
  const character = characters[player.characterId]
  if (!character) return undefined
  const color = character.colors[player.characterColor]
  if (!color) return undefined
  // character.img is like "character-icons/falcon/"
  const folder = character.img?.replace(/^character-icons\//, '').replace(/\/$/, '')
  if (!folder) return undefined
  return charImages.get(`${folder}/${color}`)
}

type ClipPayload = {
  path: string
  startFrame?: number
  endFrame?: number
  lastFrame?: number
}

const getClipPayload = (
  item: ClipInterface | FileInterface | LiteItem | null
): ClipPayload | null => {
  if (!item || typeof (item as ClipInterface).path !== 'string') return null
  const payload: ClipPayload = { path: (item as ClipInterface).path }
  if (typeof (item as ClipInterface).startFrame === 'number') {
    payload.startFrame = (item as ClipInterface).startFrame
  }
  if (typeof (item as ClipInterface).endFrame === 'number') {
    payload.endFrame = (item as ClipInterface).endFrame
  }
  if (typeof (item as FileInterface).lastFrame === 'number') {
    payload.lastFrame = (item as FileInterface).lastFrame
  }
  return payload
}

type CardState = 'full' | 'square' | 'gpu'

type ItemProps = {
  item: ClipInterface | FileInterface | LiteItem
  index: number
  renderMode: 'lowRes' | 'full'
  tileSize: number
  showStageLabel: boolean
  showPlayers: boolean
  showLength: boolean
  showFileName: boolean
  showCardActions?: boolean
  style?: CSSProperties
  disableInteraction?: boolean
  cardState?: CardState
}

export default function Item({
  item,
  index,
  renderMode,
  tileSize,
  showStageLabel,
  showPlayers,
  showLength,
  showFileName,
  showCardActions,
  style,
  disableInteraction = false,
  cardState,
}: ItemProps) {

    const darkStages = [2, 3, 31, 32]
    let comboer
    let comboee
    const { stage, players } = item
    const itemStyle = disableInteraction
      ? { ...style, pointerEvents: 'none', cursor: 'default' }
      : style
    const cardClass = cardState ? ` card-${cardState}` : ''
    const baseClassName = `item${cardClass}`
    const lowResClassName = `item${cardClass} low-res`

    const clipPayload = getClipPayload(item)
    const handlePlay = clipPayload
      ? () => ipcBridge.playClip(clipPayload)
      : undefined
    const handleRecord = clipPayload
      ? () => ipcBridge.recordClip(clipPayload)
      : undefined

    const allowActions =
      typeof showCardActions === 'boolean'
        ? showCardActions
        : cardState === 'full'
    const showCardActionsResolved = allowActions && (handlePlay || handleRecord)
    const handlePlayClick = (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      if (handlePlay) handlePlay()
    }
    const handleRecordClick = (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      if (handleRecord) handleRecord()
    }
    const isFull = cardState === 'full'
    const [modalOpen, setModalOpen] = useState(false)
    const handleClick = disableInteraction || isFull ? undefined : () => setModalOpen(true)
    const closeModal = useCallback(() => setModalOpen(false), [])

    useEffect(() => {
      if (!modalOpen) return undefined
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') closeModal()
      }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }, [modalOpen, closeModal])

    if (isClipInterface(item)) {
      comboer = item.comboer
      comboee = item.comboee
    }

    const stageEntry = stages[stage as keyof typeof stages]
    const stageTag = stageEntry ? stageEntry.tag : 'unknown'
    const fallbackPlayers = players || []

    const stageImage =
      (renderMode === 'lowRes' ? resolveStageImage(stageTag, tileSize) : null) ||
      stageImageByTag.get(stageTag) ||
      stageImageByTag.get('pc') ||
      stageImageByTag.get('bf')
    const arrowImage =
      typeof stage === 'number' && darkStages.indexOf(stage) !== -1
        ? WhiteNextArrow
        : NextArrow

    if (renderMode === 'lowRes') {
      return (
        <div
          className={lowResClassName}
          onClick={handleClick}
          key={index}
          style={itemStyle}
        >
          <div className="result-image-container">
            {stageImage ? (
              <img alt="stage" className="stage-image" src={stageImage} />
            ) : null}
          </div>
        </div>
      )
    }

    const p1Image = resolveCharacterImage(comboer || fallbackPlayers[0])
    const p2Image = resolveCharacterImage(comboee || fallbackPlayers[1])

    if (!stageImage && !p1Image && !p2Image) {
      return null
    }

    const resolvePlayerLabel = (player?: PlayerInterface) => {
      if (!player) return ''
      const character = characters[player.characterId]
      const fallback = character ? character.shortName : ''
      return player.displayName || player.nametag || fallback || ''
    }

    const p1Label = resolvePlayerLabel(comboer || fallbackPlayers[0])
    const p2Label = resolvePlayerLabel(comboee || fallbackPlayers[1])

    const stageLabel = stageEntry
      ? stageEntry.shortName || stageEntry.name
      : 'Unknown'

    const fileName = item.path
      ? item.path.split(/[/\\]/).pop() || ''
      : ''

    const file = item as FileInterface
    const clip = item as ClipInterface
    const durationFrames =
      typeof clip.endFrame === 'number' && typeof clip.startFrame === 'number' && (clip.endFrame || clip.startFrame)
        ? clip.endFrame - clip.startFrame
        : typeof file.lastFrame === 'number' && file.lastFrame > 0
        ? file.lastFrame
        : 0
    const durationDisplay = (() => {
      if (!durationFrames) return null
      const seconds = durationFrames / 60
      return seconds >= 60
        ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
        : `${seconds.toFixed(1)}s`
    })()

    const resolveCharName = (player?: PlayerInterface) => {
      if (!player) return null
      const character = characters[player.characterId]
      return character ? character.name : null
    }

    const resolveCharColor = (player?: PlayerInterface) => {
      if (!player) return null
      const character = characters[player.characterId]
      if (!character) return null
      return character.colors[player.characterColor] || null
    }

    return (
      <>
        <div
          className={baseClassName}
          onClick={handleClick}
          key={index}
          style={itemStyle}
        >
            <div className="result-image-container">
            <div className="characters-container">
                {p1Image ? (
                  <img alt="char1" className="char1-image" src={p1Image} />
                ) : null}
                <img alt="arrow" className="arrow-image" src={arrowImage} />
                {p2Image ? (
                  <img alt="char2" className="char2-image" src={p2Image} />
                ) : null}
            </div>
            {stageImage ? (
              <img alt="stage" className="stage-image" src={stageImage} />
            ) : null}
            </div>
            {showCardActionsResolved ? (
                <div className="result-actions">
                <button
                    type="button"
                    className="card-action-button play"
                    onClick={handlePlayClick}
                    disabled={!handlePlay}
                    aria-label="Play clip"
                    title="Play clip"
                >
                    <FiPlay />
                </button>
                <button
                    type="button"
                    className="card-action-button record"
                    onClick={handleRecordClick}
                    disabled={!handleRecord}
                    aria-label="Record clip"
                    title="Record clip"
                >
                    <FiCircle />
                </button>
                </div>
            ) : null}
            {isFull ? (
              <div className="result-info-container">
                <div className="full-info-header">
                  <div className="full-info-matchup">
                    {p1Label || 'P1'} vs {p2Label || 'P2'}
                  </div>
                  <div className="full-info-meta">
                    <span>{stageEntry ? stageEntry.name : 'Unknown'}</span>
                    {durationDisplay ? <span>{durationDisplay}</span> : null}
                    {typeof file.startedAt === 'number' && file.startedAt > 0 ? (
                      <span>{new Date(file.startedAt * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</span>
                    ) : null}
                  </div>
                </div>
                <div className="full-info-players">
                  {(comboer ? [comboer, comboee] : fallbackPlayers).filter(Boolean).map((player, i) => {
                    const pImg = resolveCharacterImage(player)
                    const charName = resolveCharName(player)
                    const colorName = resolveCharColor(player)
                    return (
                      <div className="full-info-player" key={i}>
                        {pImg ? <img alt="char" className="full-info-player-icon" src={pImg} /> : null}
                        <div className="full-info-player-details">
                          <span className="full-info-player-tag">{player!.displayName || player!.nametag || `P${i + 1}`}</span>
                          <span className="full-info-player-char">{charName}{colorName && colorName !== 'Default' ? ` (${colorName})` : ''}</span>
                          <span className="full-info-player-port">Port {player!.port}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
                {clip.combo ? (
                  <div className="full-info-combo">
                    <span className="full-info-combo-label">Combo</span>
                    {clip.combo.moves ? <span>{clip.combo.moves.length} hits</span> : null}
                    {typeof clip.combo.startPercent === 'number' ? (
                      <span>{clip.combo.startPercent.toFixed(0)}% &rarr; {clip.combo.endPercent != null ? `${clip.combo.endPercent.toFixed(0)}%` : '?'}</span>
                    ) : null}
                    {clip.combo.didKill ? <span className="full-info-kill">Kill</span> : null}
                  </div>
                ) : null}
                {item.path ? (
                  <div className="full-info-file">{item.path}</div>
                ) : null}
                <div className="full-info-actions">
                  {handlePlay ? (
                    <button type="button" className="card-action-button play" onClick={handlePlay} aria-label="Play clip" title="Play">
                      <FiPlay /> <span>Play</span>
                    </button>
                  ) : null}
                  {handleRecord ? (
                    <button type="button" className="card-action-button record" onClick={handleRecord} aria-label="Record clip" title="Record">
                      <FiCircle /> <span>Record</span>
                    </button>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="result-info-container">
              {showPlayers && (p1Label || p2Label) ? (
                  <div className="result-info-row">
                  <div className="result-info-data">
                      {p1Label || 'P1'} vs {p2Label || 'P2'}
                  </div>
                  </div>
              ) : null}
              {durationDisplay ? (
                  <div className="result-info-row">
                    <div className="result-info-data">{durationDisplay}</div>
                  </div>
              ) : null}
              </div>
            )}
        </div>
        {!isFull && modalOpen ? (
          <div className="item-modal-backdrop" onClick={closeModal}>
            <div className="item-modal" onClick={(e) => e.stopPropagation()}>
              <button type="button" className="item-modal-close" onClick={closeModal} aria-label="Close">
                <FiX />
              </button>
              <div className="item-modal-stage">
                {stageImage ? <img alt="stage" className="item-modal-stage-img" src={stageImage} /> : null}
                <div className="item-modal-characters">
                  {p1Image ? <img alt="char1" className="item-modal-char" src={p1Image} /> : null}
                  <img alt="arrow" className="item-modal-arrow" src={arrowImage} />
                  {p2Image ? <img alt="char2" className="item-modal-char" src={p2Image} /> : null}
                </div>
              </div>
              <div className="item-modal-body">
                <div className="item-modal-matchup">
                  {p1Label || 'P1'} vs {p2Label || 'P2'}
                </div>
                <div className="item-modal-details">
                  <div className="item-modal-section">
                    <div className="item-modal-heading">Stage</div>
                    <div className="item-modal-value">{stageEntry ? stageEntry.name : 'Unknown'}</div>
                  </div>
                  {durationDisplay ? (
                    <div className="item-modal-section">
                      <div className="item-modal-heading">Duration</div>
                      <div className="item-modal-value">{durationDisplay}</div>
                    </div>
                  ) : null}
                  {typeof file.startedAt === 'number' && file.startedAt > 0 ? (
                    <div className="item-modal-section">
                      <div className="item-modal-heading">Date</div>
                      <div className="item-modal-value">{new Date(file.startedAt * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</div>
                    </div>
                  ) : null}
                </div>
                <div className="item-modal-players">
                  {(comboer ? [comboer, comboee] : fallbackPlayers).filter(Boolean).map((player, i) => {
                    const pImg = resolveCharacterImage(player)
                    const charName = resolveCharName(player)
                    const colorName = resolveCharColor(player)
                    return (
                      <div className="item-modal-player" key={i}>
                        {pImg ? <img alt="char" className="item-modal-player-icon" src={pImg} /> : null}
                        <div className="item-modal-player-info">
                          <div className="item-modal-player-tag">{player!.displayName || player!.nametag || `P${i + 1}`}</div>
                          <div className="item-modal-player-char">{charName}{colorName && colorName !== 'Default' ? ` (${colorName})` : ''}</div>
                          <div className="item-modal-player-port">Port {player!.port}</div>
                        </div>
                      </div>
                    )
                  })}
                </div>
                {clip.combo ? (
                  <div className="item-modal-combo">
                    <div className="item-modal-heading">Combo</div>
                    <div className="item-modal-combo-stats">
                      {clip.combo.moves ? <span>{clip.combo.moves.length} hits</span> : null}
                      {typeof clip.combo.startPercent === 'number' ? <span>{clip.combo.startPercent.toFixed(0)}% &rarr; {clip.combo.endPercent != null ? `${clip.combo.endPercent.toFixed(0)}%` : '?'}</span> : null}
                      {clip.combo.didKill ? <span className="item-modal-kill">Kill</span> : null}
                    </div>
                  </div>
                ) : null}
                {item.path ? (
                  <div className="item-modal-file">
                    <div className="item-modal-heading">File</div>
                    <div className="item-modal-value item-modal-path">{item.path}</div>
                  </div>
                ) : null}
                <div className="item-modal-actions">
                  {handlePlay ? (
                    <button type="button" className="card-action-button play" onClick={handlePlay} aria-label="Play clip" title="Play">
                      <FiPlay /> <span>Play</span>
                    </button>
                  ) : null}
                  {handleRecord ? (
                    <button type="button" className="card-action-button record" onClick={handleRecord} aria-label="Record clip" title="Record">
                      <FiCircle /> <span>Record</span>
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </>
    )

}

type MyType = ClipInterface | FileInterface | LiteItem;

function isClipInterface(obj: MyType): obj is ClipInterface {
    return (obj as ClipInterface).comboer !== undefined;
}
