import { filtersConfig } from '../constants/config'
import { FILES_TABLE, resolveInputId } from './filterGraph'

/** The bits of a filter this needs (ShallowFilterInterface fits). */
export interface TrayFilter {
  id: string
  type: string
  label: string
  isProcessed: boolean
  params: Record<string, any>
  results: number | null
  inputId?: string
}

/** What is running right now, so the sentence moves with it. */
export interface TrayLive {
  /** Steps that are running (ids). */
  running: Set<string>
  /** Results found so far by a running step (id to count). */
  counts: Record<string, number>
}

/** The sentence under the filters, in three parts so the count can be set in bold. */
export interface TrayDescription {
  /** "Showing", or the whole message when there is nothing to show. */
  lead: string
  /** "371 combos" (empty when there is nothing to show). */
  focus: string
  /** ", 5 hits min, sorted by DPS" (empty when there is none). */
  tail: string
}

type Opt = {
  id: string
  options?: { id: string | number; name: string }[]
}

/** The most clauses a sentence gets; the rest are counted ("+2 more steps"). */
const MAX_CLAUSES = 5

const SORT_NAMES: Record<string, string> = {
  chronological: 'date',
  dps: 'DPS',
  totalDamage: 'total damage',
  moves: 'number of hits',
  length: 'clip length',
  startPercent: 'start percent',
  endPercent: 'end percent',
  stage: 'stage',
  matchup: 'matchup',
  random: 'random order',
  edgeguardClutch: 'edgeguard clutch',
  edgeguardScore: 'edgeguard score',
  highlightScore: 'highlight score',
}

const isEmpty = (v: unknown) =>
  v == null || v === '' || (Array.isArray(v) && v.length === 0)

const list = (items: string[]) =>
  items.length <= 2
    ? items.join(' and ')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

/** The steps from the project's replays to `activeId`, first to last (follows each step's input). */
export function chainTo(filters: TrayFilter[], activeId: string): TrayFilter[] {
  const out: TrayFilter[] = []
  let at = filters.findIndex((f) => f.id === activeId)
  const seen = new Set<string>()
  while (at >= 0 && !seen.has(filters[at].id)) {
    seen.add(filters[at].id)
    out.unshift(filters[at])
    const from = resolveInputId(filters, at)
    at = from === FILES_TABLE ? -1 : filters.findIndex((f) => f.id === from)
  }
  return out
}

/** A setting's value as words: option names for ids ("Fox"), the text as typed otherwise. */
function words(type: string, id: string, value: unknown): string[] {
  const cfg = filtersConfig.find((c) => c.id === type) as
    | { options?: Opt[] }
    | undefined
  const opt = cfg?.options?.find((o) => o.id === id)
  const one = (x: unknown) =>
    opt?.options?.find((o) => String(o.id) === String(x))?.name ?? String(x)
  return (Array.isArray(value) ? value : [value])
    .filter((x) => !isEmpty(x))
    .map(one)
}

/** The setting as set, or the filter's own default when it was never touched. */
function setting(f: TrayFilter, id: string): unknown {
  if (f.params && f.params[id] !== undefined) return f.params[id]
  const cfg = filtersConfig.find((c) => c.id === f.type) as
    | { options?: { id: string; default?: unknown }[] }
    | undefined
  return cfg?.options?.find((o) => o.id === id)?.default
}

/** What the steps produce, as a plural noun ("combos"). */
function nounFor(steps: TrayFilter[]): string {
  const types = new Set(steps.map((s) => s.type))
  if (types.has('highlight')) return 'highlights'
  if (types.has('earlyQuitOut')) return 'early quit-outs'
  if (types.has('zeroToDeaths')) return 'zero-to-death combos'
  if (types.has('edgeguard') || types.has('edgeguardFilter'))
    return 'edgeguards'
  if (types.has('phantom') || types.has('phantomFilter')) return 'phantom hits'
  if (types.has('koDirection')) return 'KOs'
  if (types.has('slpParser') || types.has('comboFilter')) return 'combos'
  return 'clips'
}

/** The short phrases the steps add, in the order they were applied. */
function clausesFor(steps: TrayFilter[], noun: string): string[] {
  const out: string[] = []
  const stages: string[] = []
  const players: string[] = []
  let minHits: string | null = null
  let maxHits: string | null = null
  let sortClause: string | null = null
  let killOnly = false
  const comboer = new Set<string>()
  const comboee = new Set<string>()
  const comboerTags = new Set<string>()
  const comboeeTags = new Set<string>()
  const extras: string[] = []
  const gameChars: string[] = []

  for (const s of steps) {
    const p = (id: string) => words(s.type, id, setting(s, id))
    switch (s.type) {
      case 'files': {
        const chars = [...p('char1'), ...p('char2')]
        if (chars.length) gameChars.push(...chars)
        const names = [
          ...p('player1'),
          ...p('player2'),
          ...p('player1CC'),
          ...p('player2CC'),
        ]
        if (names.length) players.push(...names)
        stages.push(...p('stage'))
        if (setting(s, 'includeCpu') === true) out.push('CPU games included')
        break
      }
      case 'slpParser':
      case 'comboFilter':
      case 'earlyQuitOut':
      case 'edgeguard':
      case 'edgeguardFilter':
      case 'highlight': {
        for (const c of p('comboerChar')) comboer.add(c)
        for (const c of p('comboeeChar')) comboee.add(c)
        for (const t of [...p('comboerTag'), ...p('comboerCC')])
          comboerTags.add(t)
        for (const t of [...p('comboeeTag'), ...p('comboeeCC')])
          comboeeTags.add(t)
        stages.push(...p('comboStage'), ...p('stageFilter'))
        if (
          s.type === 'slpParser' ||
          s.type === 'comboFilter' ||
          s.type === 'edgeguardFilter'
        ) {
          const lo = setting(s, 'minHits')
          if (!isEmpty(lo)) minHits = String(lo)
          const hi = setting(s, 'maxHits')
          if (!isEmpty(hi)) maxHits = String(hi)
        }
        if (setting(s, 'didKill') === true) killOnly = true
        const dmg = setting(s, 'minDamage')
        if (s.type === 'comboFilter' && !isEmpty(dmg))
          extras.push(`${dmg}% min damage`)
        break
      }
      case 'sort': {
        const how = String(setting(s, 'sortFunction') ?? '')
        const name = SORT_NAMES[how] ?? how
        if (name)
          sortClause = `sorted by ${name}${setting(s, 'reverse') === true ? ', reversed' : ''}`
        break
      }
      case 'trim': {
        const a = Number(setting(s, 'addStartFrames') || 0)
        const b = Number(setting(s, 'addEndFrames') || 0)
        if (a || b) extras.push('trimmed')
        break
      }
      case 'deduplicate':
        extras.push('duplicates removed')
        break
      case 'randomSample':
        extras.push(`random sample of ${setting(s, 'count') ?? ''}`.trim())
        break
      case 'range': {
        const from = setting(s, 'from')
        const to = setting(s, 'to')
        if (!isEmpty(from) || !isEmpty(to))
          extras.push(`positions ${from || 1} to ${to || 'end'}`)
        break
      }
      case 'afkDetection':
        if (setting(s, 'exclude') !== false) extras.push('AFK players skipped')
        break
      case 'removeStarKOFrames':
        extras.push('star KO animation cut')
        break
      case 'aiFilter':
        extras.push('narrowed by your AI Filter')
        break
      case 'custom':
        extras.push('narrowed by custom code')
        break
      case 'lunarClips':
        break
      default:
        extras.push(`after ${s.label}`)
    }
  }

  const front: string[] = []
  if (gameChars.length)
    front.push(
      `${noun === 'games' ? 'with' : 'in games with'} ${list([...new Set(gameChars)])}`,
    )
  if (comboer.size) front.push(`by ${list([...comboer])}`)
  if (comboerTags.size) front.push(`by ${list([...comboerTags])}`)
  if (comboee.size) front.push(`against ${list([...comboee])}`)
  if (comboeeTags.size) front.push(`against ${list([...comboeeTags])}`)
  if (players.length) front.push(`from ${list([...new Set(players)])}'s games`)
  if (stages.length) front.push(`on ${list([...new Set(stages)])}`)
  if (killOnly) front.push('ending in a kill')
  const mid: string[] = []
  if (minHits) mid.push(`${minHits} hits min`)
  if (maxHits) mid.push(`${maxHits} hits max`)

  const all = [
    ...front,
    ...out,
    ...mid,
    ...extras,
    ...(sortClause ? [sortClause] : []),
  ]
  if (all.length <= MAX_CLAUSES) return all
  const keep = all.slice(0, MAX_CLAUSES - 1)
  const more = all.length - keep.length
  return [...keep, `+${more} more settings`]
}

/**
 * "What are you looking at": one plain sentence about the tray's contents, from the steps
 * between the project's replays and the step the tray is on. The nearer the top of the chain,
 * the shorter it is.
 */
export function describeTray(
  filters: TrayFilter[],
  activeId: string,
  replayCount: number | null,
  live: TrayLive = { running: new Set(), counts: {} },
): TrayDescription {
  const active = filters.find((f) => f.id === activeId)
  const steps = active ? chainTo(filters, activeId) : []
  const isGames = !active || active.type === 'files'
  const noun = isGames ? 'games' : nounFor(steps)

  const phrase = (n: number) =>
    `${n.toLocaleString()} ${n === 1 ? noun.replace(/s$/, '') : noun}`

  // The step on show is running: the count so far, ticking up.
  if (active && live.running.has(active.id)) {
    const n = live.counts[active.id]
    if (n == null) {
      return { lead: `${active.label} is running…`, focus: '', tail: '' }
    }
    const so = clausesFor(steps, noun)
    return {
      lead: `${active.label} is running:`,
      focus: phrase(n),
      tail: ` so far${so.length ? `, ${so.join(', ')}` : ''}`,
    }
  }
  if (active && !isGames && !active.isProcessed) {
    // A step above is working towards it, or nothing has started.
    const upstream = steps.find(
      (s) => s.id !== active.id && live.running.has(s.id),
    )
    return {
      lead: upstream
        ? `Waiting for ${upstream.label} to finish…`
        : `${active.label} hasn't run yet, so the tray is empty.`,
      focus: '',
      tail: '',
    }
  }
  const count = isGames && !active ? replayCount : (active?.results ?? null)
  if (count == null) {
    return { lead: `Counting ${noun}…`, focus: '', tail: '' }
  }
  const unit = count === 1 ? noun.replace(/s$/, '') : noun
  const clauses = clausesFor(steps, noun)
  // "10 games with Fox" reads as one phrase, not "10 games, with Fox".
  const joined = clauses[0]?.startsWith('with ') ? ` ${clauses.shift()}` : ''
  return {
    lead: 'Showing',
    focus: `${count.toLocaleString()} ${unit}${joined}`,
    tail: clauses.length ? `, ${clauses.join(', ')}` : '',
  }
}
