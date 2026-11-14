/**
 * @jest-environment jsdom
 */
import React from 'react'
import { render } from '@testing-library/react'
import '@testing-library/jest-dom'
import type {
  ClipInterface,
  FileInterface,
  PlayerInterface,
} from '../constants/types'
import {
  summarizeClip,
  shortMoveName,
  formatGameDate,
} from '../renderer/components/Clip/cardSummary'
import { Clip } from '../renderer/components/Clip'

const player = (
  playerIndex: number,
  characterId: number,
  displayName: string,
): PlayerInterface => ({
  playerIndex,
  port: playerIndex + 1,
  characterId,
  characterColor: 0,
  nametag: '',
  displayName,
  connectCode: '',
})
const mayo = player(0, 19, 'mayo') // Sheik
const snoo = player(1, 2, 'Snoo') // Fox

const combo = (over: Partial<NonNullable<ClipInterface['combo']>> = {}) =>
  ({
    path: '/r/a.slp',
    stage: 31,
    startFrame: 100,
    endFrame: 346, // 4.1 s
    comboer: mayo,
    comboee: snoo,
    combo: {
      startPercent: 85,
      endPercent: 117.4,
      didKill: false,
      moves: [
        { playerIndex: 0, frame: 100, moveId: 17, hitCount: 1, damage: 11 },
        { playerIndex: 0, frame: 160, moveId: 15, hitCount: 1, damage: 8 },
        // Out of order on purpose: the finisher is the latest hit.
        { playerIndex: 0, frame: 300, moveId: 16, hitCount: 1, damage: 7 },
        { playerIndex: 0, frame: 220, moveId: 13, hitCount: 1, damage: 6 },
      ],
      ...over,
    },
  }) as ClipInterface

const edgeguard = (score: number, over: Record<string, unknown> = {}) =>
  ({
    path: '/r/b.slp',
    stage: 8,
    startFrame: 0,
    endFrame: 609,
    comboer: mayo,
    comboee: snoo,
    edgeguardScore: score,
    edgeguardMetrics: {
      offstageFrames: 300,
      hits: 8,
      recoveryFrame: 10,
      minLedgeDist: 1,
      blockedByHit: true,
      ledgeSteal: true,
      maxDepthX: 100,
      minY: -50,
      recoveryAttempts: 3,
      edgeguarderDepth: 10,
      edgeguarderReturned: true,
      lastHitToDeath: 11,
      stageTouches: 1,
      diedOffstage: true,
      score,
      ...over,
    },
  }) as ClipInterface

const game = {
  id: '7',
  path: '/r/c.slp',
  players: [mayo, snoo],
  winner: 0,
  stage: 2,
  startedAt: 1775698982,
  lastFrame: 10077,
  isValid: true,
  isProcessed: true,
  info: '',
  startFrame: -123,
  endFrame: 10077,
} as FileInterface

describe('grid card summary', () => {
  it('leads a combo with hits and damage, then percents and the finisher', () => {
    const s = summarizeClip(combo())
    expect(s.kind).toBe('combo')
    expect(s.primary).toBe('4 hits · 32%')
    expect(s.detail).toBe('85% → 117% · Up-air')
    expect(s.duration).toBe('4.1s')
    expect(s.names).toBe('mayo vs Snoo')
    expect(s.kill).toBe(false)
    expect(s.badge).toBeNull()
    expect(s.meter).toBeCloseTo(0.324, 2)
    expect(s.tone).toBe('normal')
  })

  it('marks a kill, and a quit-out as its own badge', () => {
    const kill = summarizeClip(combo({ didKill: true }))
    expect(kill.badge).toBe('KILL')
    expect(kill.tone).toBe('kill')
    expect(kill.label).toMatch(/killed with Up-air/)
    const quit = summarizeClip(combo({ didKill: true, earlyQuit: true }))
    expect(quit.badge).toBe('QUIT')
    expect(quit.tone).toBe('normal')
  })

  it('works out the damage when the end percent is missing', () => {
    const s = summarizeClip(combo({ endPercent: null }))
    expect(s.primary).toBe('4 hits · 32%')
    expect(s.detail).toBe('85% → 117% · Up-air')
  })

  it('leads an edgeguard with its score, rarest facts first', () => {
    const s = summarizeClip(edgeguard(48.4))
    expect(s.kind).toBe('edgeguard')
    expect(s.primary).toBe('Score 48 · 8 hits')
    expect(s.detail).toBe('forced landing · 3 recoveries · ledge steal')
    expect(s.tone).toBe('hot')
    expect(s.badge).toBeNull()
    expect(summarizeClip(edgeguard(20)).tone).toBe('normal')
    expect(summarizeClip(edgeguard(120)).meter).toBe(1)
  })

  it('leads a game with its players, then the date and stage', () => {
    const s = summarizeClip(game)
    expect(s.kind).toBe('game')
    expect(s.primary).toBe('mayo vs Snoo')
    // The stage name joins it (Jest's clipAssets mock has no stage names).
    expect(s.detail).toBe(formatGameDate(game.startedAt))
    expect(s.detail).toMatch(/2026/)
    expect(s.duration).toBe('2:50') // startFrame -123 to lastFrame, as before
    expect(s.meter).toBeNull()
    expect(s.names).toBe('')
  })

  it('degrades when a row has almost nothing', () => {
    const s = summarizeClip({ id: '1', stage: 0 })
    expect(s.kind).toBe('clip')
    expect(s.primary).toBe('')
    expect(s.duration).toBeNull()
    expect(s.meter).toBeNull()
    expect(formatGameDate(0)).toBe('')
    expect(shortMoveName(-1)).toBeNull()
  })
})

describe('grid card', () => {
  it('shows more lines as it grows and keeps the buttons labelled', () => {
    const data = combo({ didKill: true })
    const small = render(
      <Clip
        data={data}
        size={130}
        mode="mode2"
        onPlay={() => {}}
        onRecord={() => {}}
      />,
    )
    const card = small.container.querySelector('.clip')!
    expect(card).toHaveClass('clip--sm', 'clip--tone-kill')
    expect(card.querySelector('.clip-info-primary')).toHaveTextContent(
      '4 hits · 32%',
    )
    expect(card.querySelector('.clip-duration')).toHaveTextContent('4.1s')
    expect(card.querySelector('.clip-info-detail')).toBeNull()
    // Small: the skull alone; the words are in the card's label.
    expect(card.querySelector('.clip-badge svg')).not.toBeNull()
    expect(card.getAttribute('aria-label')).toMatch(/killed with Up-air/)
    expect(small.getByLabelText('Play clip')).toBeInTheDocument()
    expect(small.getByLabelText('Record clip')).toBeInTheDocument()
    small.unmount()

    const large = render(
      <Clip data={data} size={260} mode="mode2" isSelected />,
    )
    const big = large.container.querySelector('.clip')!
    expect(big).toHaveClass('clip--lg', 'clip--selected')
    expect(big.querySelector('.clip-check')).not.toBeNull()
    expect(big.querySelector('.clip-badge')).toHaveTextContent('KILL')
    expect(big.querySelector('.clip-info-detail')).toHaveTextContent(
      '85% → 117% · Up-air',
    )
    expect(big.querySelector('.clip-info-names')).toHaveTextContent(
      'mayo vs Snoo',
    )
  })

  it('plays from the button without opening Single', () => {
    const onPlay = jest.fn()
    const onDoubleClick = jest.fn()
    const { getByLabelText } = render(
      <Clip
        data={combo()}
        size={180}
        mode="mode2"
        onPlay={onPlay}
        onDoubleClick={onDoubleClick}
      />,
    )
    const play = getByLabelText('Play clip')
    play.click()
    play.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(onPlay).toHaveBeenCalledWith({
      path: '/r/a.slp',
      startFrame: 100,
      endFrame: 346,
    })
    expect(onDoubleClick).not.toHaveBeenCalled()
  })
})
