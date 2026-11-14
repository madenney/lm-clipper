/**
 * What a grid card says about its clip (Clip.tsx, mode2): the most useful line
 * for the step's kind of result, a detail line, the players, and a 0..1 meter.
 * Only fields the row really has are shown: combo rows carry `combo`,
 * edgeguard rows `edgeguardMetrics`, games (the Replays step) `players` +
 * `lastFrame` + `startedAt` (no winner or stocks are stored at import).
 */
import type { ClipInterface, PlayerInterface } from '../../../constants/types'
import { moves } from '../../../constants/moves'
import {
  getCharacterName,
  getPlayerLabel,
  getStageName,
} from '../../lib/clipAssets'
import { getDurationDisplay, getPlayers, type ClipData } from './clipUtils'
import { clamp01 } from '../../../lib/format'

export type CardKind =
  | 'combo'
  | 'edgeguard'
  | 'highlight'
  | 'pressure'
  | 'phantom'
  | 'game'
  | 'clip'

/** Colour of the meter and the accent edge. */
export type CardTone = 'kill' | 'hot' | 'normal'

export type CardSummary = {
  kind: CardKind
  /** Leads the card: hits + damage, the edgeguard score, the players of a game. */
  primary: string
  /** Second line: percents + finisher, edgeguard facts, the game's date. */
  detail: string
  /** "P1 vs P2" (empty when neither player is known). */
  names: string
  duration: string | null
  /** A kill (combo / highlight / pressure that ended in one). */
  kill: boolean
  /** Corner badge text: KILL, or QUIT when the victim quit out first. */
  badge: 'KILL' | 'QUIT' | null
  /** 0..1 strength bar along the bottom; null = no bar. */
  meter: number | null
  tone: CardTone
  /** Everything, for the hover tooltip and screen readers. */
  label: string
}

const SHORT_MOVES: Record<string, string> = {
  'Up Air': 'Up-air',
  'Forward Air': 'Fair',
  'Back Air': 'Bair',
  'Down Air': 'Dair',
  'Neutral Air': 'Nair',
  'Forward Smash': 'F-smash',
  'Up Smash': 'Up-smash',
  'Down Smash': 'D-smash',
  'Forward Tilt': 'F-tilt',
  'Up Tilt': 'Up-tilt',
  'Down Tilt': 'D-tilt',
  'Forward Throw': 'F-throw',
  'Back Throw': 'B-throw',
  'Up Throw': 'Up-throw',
  'Down Throw': 'D-throw',
  'Grab Pummel': 'Pummel',
  'Dash Attack': 'Dash attack',
  'Getup Attack (Slow)': 'Getup attack',
  'Getup Attack': 'Getup attack',
  'Ledge Attack (Slow)': 'Ledge attack',
  'Ledge Attack': 'Ledge attack',
}

const moveNames = new Map<number, string>(
  (moves as { id: number; name: string }[]).map((m) => [
    m.id,
    SHORT_MOVES[m.name] ?? m.name,
  ]),
)

/** A move's short name ("Up-air"), or null for an unknown or misc move. */
export const shortMoveName = (moveId: number): string | null => {
  const name = moveNames.get(moveId)
  return name && name !== 'Miscellaneous' ? name : null
}

const pct = (n: number) => `${Math.round(n)}%`
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`

/** Damage that reads as a full bar (kill combos run ~30-75%). */
export const COMBO_FULL_DAMAGE = 100
/** Edgeguard score that fills the bar (median ~28, top tenth 45+). */
export const EDGEGUARD_FULL_SCORE = 60
/** From here an edgeguard is marked as a standout (about the top tenth). */
export const EDGEGUARD_HOT_SCORE = 45

const dateFormat = (() => {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  } catch {
    return null
  }
})()

/** startedAt is Unix seconds (File.ts); 0 / missing = unknown. */
export const formatGameDate = (startedAt?: number): string => {
  if (!startedAt || !Number.isFinite(startedAt) || !dateFormat) return ''
  return dateFormat.format(new Date(startedAt * 1000))
}

const who = (p?: PlayerInterface) => {
  if (!p) return ''
  const name = getPlayerLabel(p)
  const char = getCharacterName(p.characterId)
  if (name && char) return `${name} (${char})`
  return name || char || ''
}

const namesOf = (a?: PlayerInterface, b?: PlayerInterface) => {
  const na = a ? getPlayerLabel(a) : ''
  const nb = b ? getPlayerLabel(b) : ''
  if (!na && !nb) return ''
  return `${na || 'P1'} vs ${nb || 'P2'}`
}

type Combo = NonNullable<ClipInterface['combo']>

function comboFacts(combo: Combo) {
  const list = Array.isArray(combo.moves) ? combo.moves : []
  const hits = list.length
  const start = typeof combo.startPercent === 'number' ? combo.startPercent : 0
  const sum = list.reduce((s, m) => s + (m.damage || 0), 0)
  const end =
    typeof combo.endPercent === 'number' && Number.isFinite(combo.endPercent)
      ? combo.endPercent
      : start + sum
  const damage = Math.max(0, end - start) || sum
  let last: (typeof list)[number] | undefined
  for (const m of list) if (!last || m.frame >= last.frame) last = m
  const finisher = last ? shortMoveName(last.moveId) : null
  return { hits, start, end, damage, finisher }
}

/** What the card shows for one result row. */
export function summarizeClip(data: ClipData): CardSummary {
  const [p1, p2] = getPlayers(data)
  const names = namesOf(p1, p2)
  const duration = getDurationDisplay(data)
  const clip = data as ClipInterface
  const stage =
    typeof data.stage === 'number' ? getStageName(data.stage) : 'Unknown'
  const base = {
    names,
    duration,
    kill: false,
    badge: null,
    meter: null,
    tone: 'normal',
  } as const
  const matchup = [who(p1), who(p2)].filter(Boolean).join(' vs ')
  const tail = [stage !== 'Unknown' ? stage : '', duration]
    .filter(Boolean)
    .join(' · ')

  if (clip.combo && Array.isArray(clip.combo.moves)) {
    const f = comboFacts(clip.combo)
    const kill = !!clip.combo.didKill
    const quit = kill && !!clip.combo.earlyQuit
    const primary = [
      f.hits ? plural(f.hits, 'hit') : '',
      f.damage ? pct(f.damage) : '',
    ]
      .filter(Boolean)
      .join(' · ')
    const detail = [`${pct(f.start)} → ${pct(f.end)}`, f.finisher]
      .filter(Boolean)
      .join(' · ')
    const verdict = quit
      ? 'would have killed (opponent quit out)'
      : kill
        ? `killed${f.finisher ? ` with ${f.finisher}` : ''}`
        : ''
    return {
      ...base,
      kind: 'combo',
      primary: primary || 'Combo',
      detail,
      kill,
      badge: quit ? 'QUIT' : kill ? 'KILL' : null,
      meter: f.damage ? clamp01(f.damage / COMBO_FULL_DAMAGE) : null,
      tone: kill && !quit ? 'kill' : 'normal',
      label: [
        matchup,
        `Combo: ${[primary, detail].filter(Boolean).join(', ')}`,
        verdict,
        tail,
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }

  if (clip.edgeguardMetrics) {
    const m = clip.edgeguardMetrics
    const score =
      typeof clip.edgeguardScore === 'number' ? clip.edgeguardScore : m.score
    // Rarest first, so a cut-off line still shows what's special (547 real
    // edgeguards: onstage kills <1%, deep dives 17%, forced landings 23%,
    // 2+ recoveries 63%, ledge steals 64%).
    const facts: string[] = []
    if (m.diedOffstage === false) facts.push('onstage kill')
    if (m.edgeguarderReturned && m.edgeguarderDepth > 30)
      facts.push('deep dive')
    if (m.stageTouches > 0)
      facts.push(
        m.stageTouches > 1
          ? `${m.stageTouches} forced landings`
          : 'forced landing',
      )
    if (m.recoveryAttempts > 1)
      facts.push(plural(m.recoveryAttempts, 'recovery', 'recoveries'))
    if (m.ledgeSteal) facts.push('ledge steal')
    const hits = typeof m.hits === 'number' && m.hits > 0 ? m.hits : 0
    const hasScore = typeof score === 'number' && Number.isFinite(score)
    const primary = [
      hasScore ? `Score ${Math.round(score)}` : 'Edgeguard',
      hits ? plural(hits, 'hit') : '',
    ]
      .filter(Boolean)
      .join(' · ')
    const hot = hasScore && score >= EDGEGUARD_HOT_SCORE
    return {
      ...base,
      kind: 'edgeguard',
      primary,
      detail: facts.join(' · '),
      kill: true,
      meter: hasScore ? clamp01(score / EDGEGUARD_FULL_SCORE) : null,
      tone: hot ? 'hot' : 'normal',
      label: [matchup, `Edgeguard: ${primary}`, facts.join(', '), tail]
        .filter(Boolean)
        .join('\n'),
    }
  }

  if (clip.highlightMetrics) {
    const m = clip.highlightMetrics
    const score =
      typeof clip.highlightScore === 'number' ? clip.highlightScore : m.score
    const primary = Number.isFinite(score)
      ? `Score ${Math.round(score)}`
      : 'Highlight'
    const detail = [m.killMove, ...(m.flavors || [])]
      .filter(Boolean)
      .slice(0, 3)
      .join(' · ')
    return {
      ...base,
      kind: 'highlight',
      primary,
      detail,
      kill: true,
      meter: Number.isFinite(score) ? clamp01(score / 100) : null,
      tone: 'normal',
      label: [matchup, `Highlight: ${primary}`, m.reason, tail]
        .filter(Boolean)
        .join('\n'),
    }
  }

  if (clip.pressureMetrics) {
    const m = clip.pressureMetrics
    const primary = [
      Number.isFinite(clip.pressureScore ?? m.score)
        ? `Score ${Math.round(clip.pressureScore ?? m.score)}`
        : 'Pressure',
      m.shieldHits ? plural(m.shieldHits, 'shield hit') : '',
    ]
      .filter(Boolean)
      .join(' · ')
    const detail = [
      m.hadOpening ? 'opening' : '',
      m.endedInKill ? 'ended in a kill' : '',
    ]
      .filter(Boolean)
      .join(' · ')
    return {
      ...base,
      kind: 'pressure',
      primary,
      detail,
      kill: !!m.endedInKill,
      badge: m.endedInKill ? 'KILL' : null,
      tone: m.endedInKill ? 'kill' : 'normal',
      label: [matchup, `Pressure: ${primary}`, detail, tail]
        .filter(Boolean)
        .join('\n'),
    }
  }

  if (clip.phantomMetrics) {
    const m = clip.phantomMetrics
    const primary = `Phantom · ${pct(m.damage)}`
    const detail = `at ${pct(m.victimPercent)}`
    return {
      ...base,
      kind: 'phantom',
      primary,
      detail,
      label: [matchup, `${primary} ${detail}`, tail].filter(Boolean).join('\n'),
    }
  }

  // A game (the Replays step, Full games) or any other clip: the players lead.
  const isGame = 'lastFrame' in data && !('comboer' in data && data.comboer)
  const date = isGame
    ? formatGameDate((data as { startedAt?: number }).startedAt)
    : ''
  const detail = [date, stage !== 'Unknown' ? stage : '']
    .filter(Boolean)
    .join(' · ')
  return {
    ...base,
    kind: isGame ? 'game' : 'clip',
    primary: names,
    detail,
    // Names are the lead line already.
    names: '',
    label: [matchup, date, tail].filter(Boolean).join('\n'),
  }
}
