/**
 * Clip search from Clipper (root docs/clip-search.md, Phase 4): searching the
 * Lunar Database's clips index and turning chosen clips into ordinary Clipper
 * clip rows. Shared by the renderer (Find clips tab) and main (TransferManager).
 */
import type { ClipInterface, PlayerInterface } from './types'

export const CLIP_TYPES = ['combo', 'edgeguard', 'quitout'] as const
export type ClipType = (typeof CLIP_TYPES)[number]

export type ClipSearchFilters = {
  type: ClipType
  attackerCharacterId: string[]
  victimCharacterId: string[]
  attackerConnectCode: string
  /** The opponent (combo victim / edgeguarded player), comma-separated codes. */
  victimConnectCode: string
  /** Tournament keys: only clips from those events' games. */
  tournaments: string[]
  stageId: string[]
  minDamage: string
  /** Combos with at least this many hits (the database's minMoves). */
  minHits: string
  killOnly: boolean
  zeroToDeath: boolean
  includeInfinites: boolean
  /** Also clips from games with a CPU player (the database hides them unless asked). */
  includeCpu: boolean
  sort: 'newest' | 'best' | 'oldest'
}

export const defaultClipSearch: ClipSearchFilters = {
  type: 'combo',
  attackerCharacterId: [],
  victimCharacterId: [],
  attackerConnectCode: '',
  victimConnectCode: '',
  tournaments: [],
  stageId: [],
  minDamage: '',
  minHits: '',
  killOnly: false,
  zeroToDeath: false,
  includeInfinites: false,
  includeCpu: false,
  sort: 'newest',
}

export const CLIP_PAGE_SIZE = 25
/** Most clips one "Add to project" takes (one page is 25; select-all pages add up). */
export const MAX_CLIPS_PER_ADD = 500

/** A player as the clips index stores them: `port` is the playerIndex. */
export type LunarClipPlayer = {
  port: number
  characterId: number | null
  connectCode: string | null
  displayName: string | null
}

/** One row of POST /api/clips (with `withMoves`). */
export type LunarClip = {
  id: string
  replayId: string
  type: ClipType
  startFrame: number
  endFrame: number | null
  gameFrames?: number | null
  stageId: number | null
  startAt: string | null
  attacker: LunarClipPlayer
  victim: LunarClipPlayer
  startPercent: number | null
  endPercent: number | null
  damage: number | null
  moves: number
  didKill: boolean
  score: number | null
  metrics: Record<string, unknown> | null
  infinite?: boolean
  /** [moveId, frame, damage, hitCount] per move. */
  moveList?: [number, number, number, number][]
  /** Its game is already in your Replay Library (set by Clipper). */
  inLibrary?: boolean
}

export type ClipSearchReply = {
  results: LunarClip[]
  total: number | null
  capped: boolean
  /** How many different games the matching clips are in (exact; only for searches small enough to count). */
  games?: { count: number; exact: boolean } | null
}

const HEX24 = /^[a-f0-9]{24}$/
const isInt = (v: unknown) => Number.isInteger(v)
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
const numOrNull = (v: unknown) => v === null || v === undefined || isNum(v)

/** Validate and normalise filters from the renderer. */
export function validateClipSearch(raw: unknown): ClipSearchFilters {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >
  if (!CLIP_TYPES.includes(r.type as ClipType))
    throw new Error('Choose combos, edgeguards or quit-outs.')
  const ids = (v: unknown, name: string) => {
    if (!Array.isArray(v) || v.length > 20) throw new Error(`Invalid ${name}.`)
    const out = v.map(String).filter((s) => /^\d{1,3}$/.test(s))
    return [...new Set(out)]
  }
  // One or more codes, comma-separated (the search box's chips; up to 20).
  const codes = (v: unknown) => {
    const out = String(v ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean)
      .join(',')
    if (out.length > 400 || out.split(',').length > 20)
      throw new Error('Invalid player code.')
    return out
  }
  // Older saved searches have no tournaments.
  const tournaments = r.tournaments ?? []
  if (
    !Array.isArray(tournaments) ||
    tournaments.length > 20 ||
    !tournaments.every(
      (t) => typeof t === 'string' && /^[a-z0-9-]{1,80}$/.test(t),
    )
  )
    throw new Error('Invalid tournament.')
  const minDamage = String(r.minDamage ?? '').trim()
  if (minDamage && !/^\d{1,3}(\.\d+)?$/.test(minDamage))
    throw new Error('Minimum damage must be a number.')
  const minHits = String(r.minHits ?? '').trim()
  if (minHits && !/^\d{1,3}$/.test(minHits))
    throw new Error('Minimum hits must be a whole number.')
  const sort = ['newest', 'best', 'oldest'].includes(r.sort as string)
    ? (r.sort as ClipSearchFilters['sort'])
    : 'newest'
  return {
    type: r.type as ClipType,
    attackerCharacterId: ids(r.attackerCharacterId ?? [], 'character'),
    victimCharacterId: ids(r.victimCharacterId ?? [], 'opponent'),
    attackerConnectCode: codes(r.attackerConnectCode),
    victimConnectCode: codes(r.victimConnectCode),
    tournaments: [...new Set(tournaments as string[])],
    stageId: ids(r.stageId ?? [], 'stage'),
    minDamage,
    minHits,
    killOnly: r.killOnly === true,
    zeroToDeath: r.zeroToDeath === true,
    includeInfinites: r.includeInfinites === true,
    // Older saved searches have none: off.
    includeCpu: r.includeCpu === true,
    sort,
  }
}

/** The request body for the website's POST /api/clips. */
export function clipSearchBody(
  f: ClipSearchFilters,
  page: number,
  limit: number = CLIP_PAGE_SIZE,
) {
  return {
    type: f.type,
    attackerCharacterId: f.attackerCharacterId,
    victimCharacterId: f.victimCharacterId,
    attackerConnectCode: f.attackerConnectCode || undefined,
    victimConnectCode: f.victimConnectCode || undefined,
    tournament: f.tournaments.length ? f.tournaments : undefined,
    stageId: f.stageId,
    minDamage: f.type === 'edgeguard' ? undefined : f.minDamage || undefined,
    minMoves: f.type === 'combo' ? f.minHits || undefined : undefined,
    killOnly: f.type === 'combo' ? f.killOnly : undefined,
    zeroToDeath: f.type === 'combo' ? f.zeroToDeath : undefined,
    includeInfinites: f.includeInfinites,
    // Only sent when on: the database leaves CPU games' clips out unless asked.
    includeCpu: f.includeCpu ? true : undefined,
    sort: f.sort,
    page: Math.max(1, Math.min(1000, Math.floor(page) || 1)),
    limit: Math.max(1, Math.min(100, Math.floor(limit) || CLIP_PAGE_SIZE)),
    withMoves: true,
  }
}

/** Find clips' request: clipSearchBody, and only clips whose game is stored on
 *  storage (Clipper downloads every game straight from R2). Searches saved for a
 *  home-recorded run use clipSearchBody as it is: that run records at home. */
export function findClipsBody(
  f: ClipSearchFilters,
  page: number,
  limit: number = CLIP_PAGE_SIZE,
) {
  return { ...clipSearchBody(f, page, limit), storedOnly: true as const }
}

function validPlayer(v: unknown): v is LunarClipPlayer {
  const p = v as LunarClipPlayer
  return (
    !!p &&
    isInt(p.port) &&
    p.port >= 0 &&
    p.port <= 3 &&
    (p.characterId === null || isInt(p.characterId)) &&
    (p.connectCode === null || typeof p.connectCode === 'string') &&
    (p.displayName === null || typeof p.displayName === 'string')
  )
}

/**
 * Clips the renderer asks to add. They came from the website, but pass through
 * the renderer, so each is checked; any bad clip rejects the request.
 */
export function parseLunarClips(raw: unknown): LunarClip[] {
  if (!Array.isArray(raw) || raw.length === 0)
    throw new Error('Choose some clips first.')
  if (raw.length > MAX_CLIPS_PER_ADD)
    throw new Error(`Add at most ${MAX_CLIPS_PER_ADD} clips at a time.`)
  return raw.map((v) => {
    const c = v as LunarClip
    const ok =
      !!c &&
      typeof c.id === 'string' &&
      c.id.length <= 64 &&
      HEX24.test(c.replayId) &&
      CLIP_TYPES.includes(c.type) &&
      isInt(c.startFrame) &&
      (c.endFrame === null || isInt(c.endFrame)) &&
      numOrNull(c.gameFrames) &&
      (c.stageId === null || isInt(c.stageId)) &&
      (c.startAt === null || typeof c.startAt === 'string') &&
      validPlayer(c.attacker) &&
      validPlayer(c.victim) &&
      numOrNull(c.startPercent) &&
      numOrNull(c.endPercent) &&
      typeof c.didKill === 'boolean' &&
      numOrNull(c.score) &&
      (c.moveList === undefined ||
        (Array.isArray(c.moveList) &&
          c.moveList.length <= 1000 &&
          c.moveList.every(
            (m) => Array.isArray(m) && m.length === 4 && m.every(isNum),
          )))
    if (!ok) throw new Error('Invalid clip data.')
    return c
  })
}

/** The game's own player (colour, nametag…) when the file is in the project;
 *  otherwise what the clips index knows. */
function playerFor(
  p: LunarClipPlayer,
  players: PlayerInterface[] | undefined,
): PlayerInterface {
  const fromGame = players?.find((x) => x?.playerIndex === p.port)
  if (fromGame) return fromGame
  return {
    playerIndex: p.port,
    port: p.port + 1,
    characterId: p.characterId ?? 0,
    characterColor: 0,
    nametag: '',
    displayName: p.displayName ?? '',
    connectCode: p.connectCode ?? '',
  } as PlayerInterface
}

/**
 * A Lunar Database clip as a Clipper clip row: the same shape the Combo Parser,
 * Early Quit Out and Edgeguards parsers produce, so Combo Filter, Sort, Trim and
 * recording treat it like any other clip.
 */
export function clipToInterface(
  clip: LunarClip,
  path: string,
  players?: PlayerInterface[],
): ClipInterface {
  const comboer = playerFor(clip.attacker, players)
  const comboee = playerFor(clip.victim, players)
  const startedAt = clip.startAt ? Date.parse(clip.startAt) : NaN
  const base: ClipInterface = {
    path,
    stage: clip.stageId ?? 0,
    startFrame: clip.startFrame,
    endFrame: clip.endFrame ?? clip.gameFrames ?? 0,
    ...(Number.isFinite(startedAt)
      ? { startedAt: Math.floor(startedAt / 1000) }
      : {}),
    comboer,
    comboee,
    lunarClip: { id: clip.id, replayId: clip.replayId, type: clip.type },
  }
  if (clip.type === 'edgeguard') {
    const metrics = (clip.metrics ?? {}) as NonNullable<
      ClipInterface['edgeguardMetrics']
    >
    return {
      ...base,
      edgeguardScore: clip.score ?? metrics.score,
      edgeguardMetrics: metrics,
    }
  }
  return {
    ...base,
    combo: {
      startPercent: clip.startPercent ?? 0,
      endPercent: clip.endPercent,
      didKill: clip.didKill,
      ...(clip.type === 'quitout' ? { earlyQuit: true } : {}),
      moves: (clip.moveList ?? []).map(([moveId, frame, damage, hitCount]) => ({
        playerIndex: comboer.playerIndex,
        frame,
        moveId,
        hitCount,
        damage,
      })),
    },
  }
}

/** Same moment, same game: used so adding a clip twice doesn't duplicate it. */
export const lunarClipKey = (c: { lunarClip?: { id: string } | null }) =>
  c.lunarClip?.id ?? null

/** "Fox → Marth · 0% → 104% · 6 moves · kill" style summary for a result row. */
export function describeClip(c: LunarClip): string {
  if (c.type === 'edgeguard') {
    const m = (c.metrics ?? {}) as Record<string, unknown>
    return `score ${c.score ?? '–'} · ${m.hits ?? '?'} hits · ${m.recoveryAttempts ?? '?'} recovery attempts`
  }
  const pct = (v: number | null) => (v == null ? '?' : `${Math.round(v)}%`)
  return `${pct(c.startPercent)} → ${c.endPercent == null ? 'end' : pct(c.endPercent)} · ${c.moves} moves${c.didKill ? (c.type === 'quitout' ? ' · quit-out' : ' · kill') : ''}`
}

export const isReplayId = (id: string) => HEX24.test(id)

/** The renderer's clip requests (parseDatabaseRequest handles the rest), or
 *  null when `raw` isn't one. */
export function parseClipRequest(raw: unknown):
  | {
      action: 'clipSearch'
      search: ClipSearchFilters
      page: number
      limit?: number
    }
  | { action: 'addClips'; clips: LunarClip[] }
  | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >
  if (r.action === 'clipSearch')
    return {
      action: 'clipSearch',
      search: validateClipSearch(r.search),
      page: Number.isInteger(r.page) ? (r.page as number) : 1,
      ...(Number.isInteger(r.limit) ? { limit: r.limit as number } : {}),
    }
  if (r.action === 'addClips')
    return { action: 'addClips', clips: parseLunarClips(r.clips) }
  return null
}
