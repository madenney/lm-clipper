// Contract with the database API, reached through the website's /api/clipper,
// /api/getList and /api/download routes. scripts/test/clipper-database.test.mjs
// pins these lists to the database and website definitions.
// Type-only: this file stays import-free at runtime, so the cross-app contract tests
// (scripts/test/clipper-database.test.mjs) can load it in plain Node.
// Clip requests are parsed in clipSearch.ts (parseClipRequest).
import type {
  ClipSearchFilters,
  ClipSearchReply,
  LunarClip,
} from './clipSearch'

/** Job statuses the database reports (apps/database/src/models/jobStatus.ts). */
export const DB_JOB_STATUSES = [
  'pending',
  'processing',
  'bundling',
  'bundled',
  'uploading',
  'completed',
  'failed',
  'cancelled',
] as const
export type DbJobStatus = (typeof DB_JOB_STATUSES)[number]

/** Error codes meaning the server-side export can no longer be used; only a
 *  new export (an explicit user action) can continue. grant_invalid is the
 *  website's own code for an expired or invalid desktop grant. */
export const EXPORT_GONE_CODES = [
  'not_found',
  'forbidden',
  'bundle_missing',
  'grant_invalid',
] as const

/** Error codes meaning "try the same export again later". */
export const RETRY_LATER_CODES = [
  'rate_limited',
  'download_cap',
  'storage_busy',
  'queue_full',
  'too_many_active_jobs',
] as const

/** Error codes meaning the owner took the database down for maintenance: show
 *  the message instead of an error, pause transfers (keeping what's on disk) and
 *  resume them by themselves once /api/status says it's back. */
export const MAINTENANCE_CODES = ['maintenance'] as const

/** Database down for maintenance: the owner's message and when it started. */
export type DatabaseMaintenance = { message: string; since: string | null }

/** Manifest inside each export bundle (apps/database/src/services/bundleManifest.ts). */
export const BUNDLE_MANIFEST_NAME = 'lunar-manifest.json'

/** The website and database use at most this many values per list filter. */
export const MAX_FILTER_VALUES = 20

export type DatabaseFilters = {
  p1Characters: string[]
  p2Characters: string[]
  p1Codes: string[]
  p2Codes: string[]
  p1Tags: string[]
  p2Tags: string[]
  stageFilters: string[]
  startDate: string
  endDate: string
  sources: string[]
  /** Tournament keys (e.g. "kotj-7"), from the search box's tournament chips. */
  tournaments: string[]
  sort: 'replayNewest' | 'replayOldest'
  maxFiles: number
  /** Also games with a CPU player: the database leaves them out unless a
   *  request sends includeCpu=true. Optional: older saved filters have none. */
  includeCpu?: boolean
}

export const defaultDatabaseFilters: DatabaseFilters = {
  p1Characters: [],
  p2Characters: [],
  p1Codes: [],
  p2Codes: [],
  p1Tags: [],
  p2Tags: [],
  stageFilters: [],
  startDate: '',
  endDate: '',
  sources: ['netplay', 'ranked', 'tournament'],
  sort: 'replayNewest',
  maxFiles: 1000,
  tournaments: [],
  includeCpu: false,
}

export type DatabaseReplay = {
  _id: string
  fileHash?: string
  /** Already in your Replay Library (set by Clipper, not the server). */
  inLibrary?: boolean
  /** Where it came from, and its tournament page when there is one. */
  source?: 'netplay' | 'ranked' | 'tournament' | null
  tournamentKey?: string | null
  tournamentName?: string | null
  /** Compact extracted stats: stocks per player and the winner. */
  stats?: {
    winner: number | null
    players: {
      playerIndex: number
      startStocks?: number | null
      stocksLost?: number | null
    }[]
  } | null
  info: {
    players: {
      characterName?: string
      characterId: number
      characterColor?: number
      playerIndex?: number
      displayName?: string
      connectCode?: string
    }[]
    stageName?: string
    stage: number
    startedAt?: string
    /** Frames; null when the database has no duration for the replay. */
    lastFrame: number | null
  }
}

export type DatabaseSearch = { results: DatabaseReplay[]; total: number }
export type DatabaseEstimate = {
  replayCount: number
  rawSize: number
  estimatedSlpzSize: number
  /** Download size: the .slpz files plus ZIP overhead. */
  estimatedZipSize?: number
  /** What downloading this batch would mean right now (the server's queue forecast). */
  queue?: DownloadForecast
  /** How a direct download of it splits (website direct-locations count): games
   *  read straight from storage and their bytes, and games only the server has. */
  direct?: { located: number; locatedBytes: number; other: number }
}

/** The server's forecast for a download started now (website estimate `queue`). */
export type DownloadForecast = {
  /** Someone already asked for this exact batch: it's shared. */
  shared: 'building' | 'ready' | null
  /** Downloads that would start before this one. */
  ahead: number
  /** Seconds until it would be ready. */
  readySec: number
  /** Why downloads are paused, or null. */
  paused: string | null
}

/** Live site status (GET /api/status): the admin notice, database up/down, queue length. */
export type SiteStatus = {
  notice: { text: string; level: 'info' | 'warning' } | null
  database: 'up' | 'down'
  /** Set while the database is down for maintenance (database is 'down' then too). */
  maintenance: DatabaseMaintenance | null
  queue: {
    building: number
    waiting: number
    clearsInSec: number
    paused: string | null
  } | null
  /** What the website says about Clipper builds (all fields optional, from a
   *  newer website too): the newest version, the oldest it still serves, and a
   *  message to show. Absent from an older website. */
  clipper?: { latest?: string; minimum?: string; message?: string } | null
}

/** "about 35 min", like the website's queue (apps/website utils/formatters). */
export function formatWait(seconds: number): string {
  if (seconds < 60) return 'under a minute'
  const mins = Math.round(seconds / 60)
  if (mins < 60) return `about ${mins} min`
  const hrs = Math.floor(mins / 60)
  if (hrs >= 48) return `about ${Math.round(hrs / 24)} days`
  const rem = hrs < 6 ? Math.round((mins % 60) / 10) * 10 : 0
  return rem > 0 && rem < 60 ? `about ${hrs} h ${rem} min` : `about ${hrs} h`
}

/** The forecast in words, for the line under a batch's size. */
export function describeForecast(f: DownloadForecast): string {
  if (f.paused) return `Downloads are paused: ${f.paused}`
  if (f.shared === 'ready')
    return 'Someone already downloaded this exact batch: yours will be ready right away.'
  if (f.shared === 'building')
    return "Someone already asked for this exact batch: you'll share their download."
  if (f.readySec < 60 && f.ahead === 0)
    return 'If you download this now: ready in under a minute.'
  const ahead =
    f.ahead > 0
      ? ` · ${f.ahead.toLocaleString()} ${f.ahead === 1 ? 'download' : 'downloads'} ahead of you`
      : ''
  return `If you download this now: ready in ${formatWait(f.readySec)}${ahead}.`
}

/** The live queue in words: "14 waiting · clears in about 25 min". */
export function describeQueue(q: NonNullable<SiteStatus['queue']>): string {
  if (q.paused) return `Downloads paused: ${q.paused}`
  if (q.waiting === 0 && q.building === 0)
    return 'Server downloads: no wait right now'
  if (q.waiting === 0)
    return `Server downloads: ${q.building} being built · no line`
  return `Server downloads: ${q.waiting.toLocaleString()} waiting · clears in ${formatWait(q.clearsInSec)}`
}

const finite = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0

function parseForecast(raw: unknown): DownloadForecast | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const q = raw as Record<string, unknown>
  const reusable = q.reusable as { status?: unknown } | null | undefined
  return {
    shared:
      reusable && typeof reusable === 'object'
        ? reusable.status === 'completed'
          ? 'ready'
          : 'building'
        : null,
    ahead: finite(q.ahead) ? Math.round(q.ahead) : 0,
    readySec: finite(q.readySec) ? q.readySec : 0,
    paused: typeof q.paused === 'string' && q.paused ? q.paused : null,
  }
}

/** Validate GET /api/status; null when it's not the expected shape. */
export function parseSiteStatus(raw: unknown): SiteStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const c = r.clipper as Record<string, unknown> | null | undefined
  const version = (v: unknown) =>
    typeof v === 'string' && /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(v)
      ? v
      : undefined
  const n = r.notice as Record<string, unknown> | null
  const q = r.queue as Record<string, unknown> | null
  const m = r.maintenance as Record<string, unknown> | null
  return {
    // Unknown or future fields inside `clipper` are ignored, never an error.
    clipper:
      c && typeof c === 'object'
        ? {
            latest: version(c.latest),
            minimum: version(c.minimum),
            message:
              typeof c.message === 'string' && c.message.trim()
                ? c.message.trim().slice(0, 300)
                : undefined,
          }
        : undefined,
    notice:
      n && typeof n.text === 'string' && n.text.trim()
        ? {
            text: n.text.trim().slice(0, 400),
            level: n.level === 'warning' ? 'warning' : 'info',
          }
        : null,
    database: r.database === 'down' ? 'down' : 'up',
    maintenance:
      m && typeof m === 'object'
        ? {
            message:
              typeof m.message === 'string' && m.message.trim()
                ? m.message.trim().slice(0, 300)
                : 'Down for maintenance',
            since: typeof m.since === 'string' ? m.since : null,
          }
        : null,
    queue:
      q && typeof q === 'object'
        ? {
            building: finite(q.building) ? q.building : 0,
            waiting: finite(q.waiting) ? q.waiting : 0,
            clearsInSec: finite(q.clearsInSec) ? q.clearsInSec : 0,
            paused: typeof q.paused === 'string' && q.paused ? q.paused : null,
          }
        : null,
  }
}
export type TransferStage =
  | 'queued'
  | 'preparing'
  | 'downloading'
  | 'extracting'
  | 'waiting-project'
  | 'importing'
  | 'paused'
  | 'failed'
  | 'canceled'
  | 'completed'
/** Most games one "Add selected" takes (select-all pages add up). */
export const MAX_REPLAYS_PER_ADD = 2000
/* Find replays and Find clips offer only games stored in a zip on storage (the
 * full-DB snapshot or a newer delta; owner's decision 2026-10-19): every download
 * they make comes straight from R2, never from the Lunar server at home. Requests
 * carry storedOnly (databaseExportFilter, databaseSearchBody, findClipsBody).
 *
 * Up to ONE_BY_ONE_MAX_GAMES, a list of games is fetched one by one through the
 * website, which reads each from storage (storedOnly=1: never from home); from 25 on
 * it's a direct download by range (main/directDownload.ts). Measured / modelled
 * (docs/direct-downloads.md, "Small downloads"): one by one ~5 games a second
 * (40 in 7.8 s), direct ~1.5 s to plan and sign, then ~70 a second, so direct is
 * quicker from ~10 games. Small adds stay one by one so they don't use up the daily
 * direct-download allowance (DIRECT_MAX_PER_CLIENT, 30 a day). */
export const ONE_BY_ONE_MAX_GAMES = 24
export const ONE_BY_ONE_GAMES_PER_SEC = 5

/* A direct download: as fast as the line and the decoder allow. Assume a 200 Mbit/s
 * line, as the whole-database file does. Measured end to end from home (2026-10-17:
 * 2,000 Fox games, 900 MB, 16 requests in flight, a line that reads ~70 MB/s of raw
 * ranges): 35 MB/s, ~75 games a second, with decoding the limit on a busy machine,
 * so never more than 70 a second. */
export const DIRECT_BYTES_PER_SEC = 25_000_000
export const DIRECT_MAX_GAMES_PER_SEC = 70

/** Seconds to download n stored games of ~bytesPerGame each, at 200 Mbit/s. */
export function storageSeconds(n: number, bytesPerGame: number): number {
  if (n <= 0) return 0
  if (n <= ONE_BY_ONE_MAX_GAMES) return n / ONE_BY_ONE_GAMES_PER_SEC
  return (
    2 + // the plan's first page and the signed link
    n / 50_000 + // the listing: ~0.1 s a page of 5,000
    Math.max(
      (n * bytesPerGame) / DIRECT_BYTES_PER_SEC,
      n / DIRECT_MAX_GAMES_PER_SEC,
    )
  )
}

/** The line under the Add button: "Ready in about 3 min at 200 Mbit/s, straight from storage." */
export function storageDownloadText(n: number, bytesPerGame: number): string {
  const seconds = storageSeconds(n, bytesPerGame)
  const at = n > ONE_BY_ONE_MAX_GAMES && seconds >= 60 ? ' at 200 Mbit/s' : ''
  return `Ready in ${formatWait(seconds)}${at}, straight from storage.`
}

/** "Oct 19, 2026" for an ISO time (UTC day), or null. */
export function storedDayLabel(iso: string | null | undefined): string | null {
  const ms = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/** Find replays' quiet note on what's offered, or null when the date isn't known. */
export function storedThroughNote(
  info: Pick<FullDbInfo, 'storedThrough'> | null | undefined,
): string | null {
  const day = storedDayLabel(info?.storedThrough)
  return day
    ? `Games up to ${day} are available. Newer ones appear after the next update.`
    : null
}

export type Transfer = {
  id: string
  kind: 'database' | 'extract'
  title: string
  createdAt: number
  /** When it completed or was canceled (epoch ms), for History. */
  finishedAt?: number
  stage: TransferStage
  detail: string
  outputDir: string
  projectPath?: string
  projectName?: string
  current: number
  total: number | null
  /** The whole-database download: saved as this one file, not unpacked. */
  fullDb?: boolean
  /** Where a single-file download is saved (the whole database). */
  file?: string
  /** What current/total count while downloading: bytes of an archive (the
   *  default) or games fetched one by one. */
  unit?: 'bytes' | 'games'
  /** Bytes a second lately, when it's counting games (a direct download from storage). */
  speed?: number
  error?: string
  /** Paused because the database is down for maintenance: resumes by itself
   *  when it's back (a manual pause, resume or cancel clears it). */
  waitingForDatabase?: boolean
  /** The server export is gone; Resume starts a new one with the same filters. */
  exportGone?: boolean
  /** Finished, replays on disk: "Add to project" can import them again. */
  canImport?: boolean
  /** Not running and not finished: what's on disk so far (partial bundle bytes,
   *  and for a list of games how many are in the library already). */
  saved?: { bytes: number; games: number | null }
  /** While the server prepares it: when it should be ready (epoch ms), for a
   *  live countdown between status polls. */
  readyAt?: number | null
  result?: {
    inserted: number
    failed: number
    /** Games Clipper doesn't import (teams, not 1v1, under 20 seconds). */
    skipped?: number
    /** Replays already in the project. */
    duplicates?: number
  }
}

/** The whole database as one ZIP of .slpz files (the site's "Download Full DB"):
 *  a snapshot on storage, downloaded at storage speed, no export queue. */
export const FULL_DB_JOB_ID = 'a11db000a11db000a11db000'
export const FULL_DB_FILE_NAME = 'lunar-melee-full-database.zip'
export type FullDbInfo = {
  bytes: number
  replays: number | null
  /** When the snapshot was taken (ISO), if known. */
  takenAt: string | null
  /** Up to when games are stored on storage, counting newer delta zips (ISO), if known. */
  storedThrough: string | null
}

/** The full-DB entry of the website's bundle list (`fullDb: true`). */
export function parseFullDbInfo(raw: unknown): FullDbInfo | null {
  const list = (raw as { bundles?: unknown })?.bundles
  if (!Array.isArray(list)) return null
  const b = list.find((x) => x && typeof x === 'object' && x.fullDb === true)
  if (!b || !Number.isFinite(b.bundleSize) || b.bundleSize <= 0) return null
  const takenAt = b.snapshotAt ?? b.completedAt
  const iso = (v: unknown) =>
    typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null
  return {
    bytes: b.bundleSize,
    replays: Number.isFinite(b.replayCount) ? b.replayCount : null,
    takenAt: typeof takenAt === 'string' ? takenAt : null,
    storedThrough: iso(b.storedThrough),
  }
}

/** Validate an estimate response before the UI formats its numbers. */
export function parseDatabaseEstimate(raw: unknown): DatabaseEstimate {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >
  const count = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0
  if (!count(r.replayCount) || !count(r.rawSize) || !count(r.estimatedSlpzSize))
    throw new Error('The database returned an invalid estimate.')
  return {
    replayCount: r.replayCount as number,
    rawSize: r.rawSize as number,
    estimatedSlpzSize: r.estimatedSlpzSize as number,
    ...(count(r.estimatedZipSize)
      ? { estimatedZipSize: r.estimatedZipSize as number }
      : {}),
    ...(parseForecast(r.queue) ? { queue: parseForecast(r.queue) } : {}),
    ...(parseDirectCounts(r.direct)
      ? { direct: parseDirectCounts(r.direct)! }
      : {}),
  }
}

/** Find replays' estimate from the direct-locations count of a storedOnly search:
 *  every game is read from storage, so its bytes are the download's size. */
export function estimateFromStored(
  direct: NonNullable<DatabaseEstimate['direct']>,
): DatabaseEstimate {
  return {
    replayCount: direct.located,
    rawSize: direct.locatedBytes,
    estimatedSlpzSize: direct.locatedBytes,
    estimatedZipSize: direct.locatedBytes,
    direct,
  }
}

/** The direct-locations count, or null when it isn't one. */
export function parseDirectCounts(
  raw: unknown,
): DatabaseEstimate['direct'] | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >
  const count = (v: unknown) =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
  if (!count(r.located) || !count(r.locatedBytes) || !count(r.other))
    return null
  return {
    located: r.located as number,
    locatedBytes: r.locatedBytes as number,
    other: r.other as number,
  }
}

export type DatabaseRequest =
  | { action: 'search'; filters: DatabaseFilters; page: number }
  | { action: 'estimate'; filters: DatabaseFilters }
  | { action: 'status' }
  | { action: 'start'; filters: DatabaseFilters }
  | { action: 'list' }
  | {
      action: 'extract'
      outputDir: string
      importAfter: boolean
      sourceKind: 'files' | 'folder'
    }
  | {
      action: 'pause' | 'resume' | 'open' | 'remove' | 'cancel' | 'addToProject'
      id: string
    }
  | { action: 'addReplays'; replayIds: string[] }
  | { action: 'clearFinished' }
  /** The whole-database file: its size and date, then download it, unpack it. */
  | { action: 'fullDbInfo' }
  | { action: 'downloadFullDb' }
  | { action: 'unpackFile'; id: string }
  | { action: 'library' }
  | { action: 'openLibrary' }
  | {
      action: 'clipSearch'
      search: ClipSearchFilters
      page: number
      limit?: number
    }
  | { action: 'addClips'; clips: LunarClip[] }
  | {
      action: 'autocomplete'
      q: string
      tournaments: boolean
      /** Only players of these characters, most games on them first. */
      characters?: string[]
    }
  /** What the database knows about a replay: by id, or a local path in the library. */
  | { action: 'replayInfo'; replayId?: string; path?: string }

/** A player suggestion for a connect-code box (website /api/playerAutocomplete). */
export type PlayerSuggestion = {
  connectCode: string
  displayName: string | null
  gameCount: number
  /** With a characters filter: this player's games on those characters. */
  characterGames?: number
}

/** A tournament suggestion (website /api/tournaments). */
export type TournamentSuggestion = {
  _id: string
  name: string
  games: number
  firstAt: string | null
  lastAt: string | null
}

export function parseTournamentSuggestions(
  raw: unknown,
): TournamentSuggestion[] {
  const list = (raw as { tournaments?: unknown })?.tournaments
  if (!Array.isArray(list)) return []
  return list
    .filter(
      (t) =>
        t &&
        typeof t._id === 'string' &&
        /^[a-z0-9-]{1,80}$/.test(t._id) &&
        typeof t.name === 'string' &&
        Number.isFinite(t.games),
    )
    .slice(0, 5)
    .map((t) => ({
      _id: t._id,
      name: t.name.slice(0, 200),
      games: t.games,
      firstAt: typeof t.firstAt === 'string' ? t.firstAt : null,
      lastAt: typeof t.lastAt === 'string' ? t.lastAt : null,
    }))
}

/** Keep only well-formed suggestions (the reply passes to the renderer). Only the connect code and
 *  one display name are kept: other names a player has used (`aliases`, if a server still sends
 *  them) are dropped here and never shown (owner decision: no identity links in public search). */
export function parsePlayerSuggestions(raw: unknown): PlayerSuggestion[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (p) =>
        p &&
        typeof p.connectCode === 'string' &&
        p.connectCode.length <= 40 &&
        Number.isFinite(p.gameCount),
    )
    .slice(0, 10)
    .map((p) => ({
      connectCode: p.connectCode,
      displayName: typeof p.displayName === 'string' ? p.displayName : null,
      gameCount: p.gameCount,
      ...(Number.isFinite(p.characterGames)
        ? { characterGames: p.characterGames }
        : {}),
    }))
}

const TRANSFER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Parse an IPC request from the renderer. The renderer is not trusted to send
 * well-formed data: unknown actions or wrongly typed fields are rejected here,
 * and filters are validated (and normalised) with validateDatabaseFilters.
 */
export function parseDatabaseRequest(raw: unknown): DatabaseRequest {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >
  const outputDir = () => {
    if (typeof r.outputDir !== 'string' || r.outputDir.length > 4096)
      throw new Error('Invalid destination folder.')
    return r.outputDir
  }
  const filters = () => validateDatabaseFilters(r.filters as DatabaseFilters)
  switch (r.action) {
    case 'search':
      return {
        action: 'search',
        filters: filters(),
        page: Number.isInteger(r.page) ? (r.page as number) : 1,
      }
    case 'estimate':
      return { action: 'estimate', filters: filters() }
    case 'start':
      return { action: 'start', filters: filters() }
    case 'status':
      return { action: 'status' }
    case 'list':
    case 'clearFinished':
    case 'library':
    case 'openLibrary':
    case 'fullDbInfo':
    case 'downloadFullDb':
      return { action: r.action }
    case 'extract':
      if (r.sourceKind !== 'files' && r.sourceKind !== 'folder')
        throw new Error('Invalid extraction source.')
      return {
        action: 'extract',
        outputDir: outputDir(),
        importAfter: r.importAfter === true,
        sourceKind: r.sourceKind,
      }
    case 'addReplays': {
      const ids = r.replayIds
      if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        ids.length > MAX_REPLAYS_PER_ADD ||
        !ids.every((id) => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id))
      )
        throw new Error('Invalid replay selection.')
      return { action: 'addReplays', replayIds: ids as string[] }
    }
    case 'replayInfo': {
      const id = typeof r.replayId === 'string' ? r.replayId : undefined
      const p = typeof r.path === 'string' ? r.path : undefined
      if (id !== undefined && !/^[a-f0-9]{24}$/.test(id))
        throw new Error('Invalid replay id.')
      // Same rule as isReplayPath (lib/replayPath): this file is loaded by plain Node
      // in the cross-app tests, so it imports only types.
      if (p !== undefined && (p.length > 4096 || !/\.slpz?$/i.test(p)))
        throw new Error('Invalid replay path.')
      if (id === undefined && p === undefined)
        throw new Error('Invalid replay.')
      return { action: 'replayInfo', replayId: id, path: p }
    }
    case 'autocomplete': {
      const q = typeof r.q === 'string' ? r.q.trim().slice(0, 100) : ''
      const characters = Array.isArray(r.characters)
        ? r.characters.filter(
            (c: unknown) => typeof c === 'string' && /^\d{1,2}$/.test(c),
          )
        : []
      if (characters.length > 26) throw new Error('Too many characters.')
      return {
        action: 'autocomplete',
        q,
        tournaments: r.tournaments === true,
        ...(characters.length ? { characters } : {}),
      }
    }
    case 'pause':
    case 'resume':
    case 'open':
    case 'remove':
    case 'cancel':
    case 'addToProject':
    case 'unpackFile':
      if (typeof r.id !== 'string' || !TRANSFER_ID_RE.test(r.id))
        throw new Error('Download not found.')
      return { action: r.action, id: r.id }
    default:
      throw new Error('Invalid database request.')
  }
}

export type DatabaseReply = {
  error?: string
  /** Reply to `fullDbInfo`: the whole-database file (null if unavailable). */
  fullDb?: FullDbInfo | null
  /** Set (with error) when the site rate-limited the request: seconds to wait. */
  retryAfter?: number
  players?: PlayerSuggestion[]
  tournaments?: TournamentSuggestion[]
  clips?: ClipSearchReply
  search?: DatabaseSearch
  estimate?: DatabaseEstimate
  /** Set (with error) when the database is down for maintenance: show this
   *  message instead of the error. */
  maintenance?: DatabaseMaintenance
  /** Reply to `status`: null when the site couldn't be reached. */
  status?: SiteStatus | null
  transfers?: Transfer[]
  /** Your Replay Library: its folder, games on disk, and how many came from
   *  the Lunar Database. */
  library?: {
    folder: string
    games: number
    fromDatabase: number
    /** Free bytes on the library's drive, when main could tell (the panel warns before a download that will not fit). */
    freeBytes?: number
  }
  /** Reply to `replayInfo`: null when the replay isn't linked to the database. */
  replayInfo?: import('./replayInfo').ReplayInfo | null
}

/** Validate filters and return a normalised copy: list values trimmed, empty and
 *  repeated values dropped. Use the returned value, not the input. */
export function validateDatabaseFilters(
  value: DatabaseFilters,
): DatabaseFilters {
  if (
    !value ||
    !Number.isInteger(value.maxFiles) ||
    value.maxFiles < 1 ||
    !Number.isSafeInteger(value.maxFiles)
  ) {
    throw new Error('Choose how many replays (1 or more).')
  }
  const arrays = [
    'p1Characters',
    'p2Characters',
    'p1Codes',
    'p2Codes',
    'p1Tags',
    'p2Tags',
    'stageFilters',
    'sources',
  ] as const
  // Saved before tournaments existed: none.
  const normalised: DatabaseFilters = {
    ...value,
    tournaments: value.tournaments ?? [],
    // Saved before the CPU toggle existed: off.
    includeCpu: value.includeCpu === true,
  }
  if (value.includeCpu !== undefined && typeof value.includeCpu !== 'boolean')
    throw new Error('Invalid database filters.')
  if (
    !Array.isArray(normalised.tournaments) ||
    normalised.tournaments.some(
      (k) => typeof k !== 'string' || !/^[a-z0-9-]{1,80}$/.test(k),
    )
  )
    throw new Error('Invalid database filters.')
  normalised.tournaments = Array.from(new Set(normalised.tournaments))
  if (normalised.tournaments.length > MAX_FILTER_VALUES)
    throw new Error(`Use at most ${MAX_FILTER_VALUES} values per filter.`)
  for (const key of arrays) {
    if (
      !Array.isArray(value[key]) ||
      value[key].some((v) => typeof v !== 'string' || v.length > 100)
    )
      throw new Error('Invalid database filters.')
    normalised[key] = Array.from(
      new Set(value[key].map((v) => v.trim()).filter(Boolean)),
    )
    if (normalised[key].length > MAX_FILTER_VALUES)
      throw new Error(`Use at most ${MAX_FILTER_VALUES} values per filter.`)
  }
  value = normalised
  if (
    !value.sources.length ||
    value.sources.some((v) => !['netplay', 'ranked', 'tournament'].includes(v))
  )
    throw new Error('Choose at least one replay source.')
  for (const date of [value.startDate, value.endDate]) {
    if (
      typeof date !== 'string' ||
      (date &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          !Number.isFinite(Date.parse(date))))
    )
      throw new Error('Invalid date.')
  }
  if (value.startDate && value.endDate && value.startDate > value.endDate)
    throw new Error('Start date must precede end date.')
  if (!['replayNewest', 'replayOldest'].includes(value.sort))
    throw new Error('Invalid sort order.')
  return value
}

export function databaseExportFilter(
  input: DatabaseFilters,
): Record<string, string | number | boolean> {
  const filters = validateDatabaseFilters(input)
  const body: Record<string, string | number | boolean> = {
    maxFiles: filters.maxFiles,
    sort: filters.sort === 'replayOldest' ? 'startAt:1' : 'startAt:-1',
    // Find replays offers only games stored on storage (they all come from R2).
    storedOnly: true,
  }
  const fields = {
    p1Characters: 'p1CharacterId',
    p2Characters: 'p2CharacterId',
    p1Codes: 'p1ConnectCode',
    p2Codes: 'p2ConnectCode',
    p1Tags: 'p1DisplayName',
    p2Tags: 'p2DisplayName',
    stageFilters: 'stageId',
  } as const
  for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
    if (filters[key].length) body[fields[key]] = filters[key].join(',')
  }
  if (filters.startDate) body.startDate = filters.startDate
  if (filters.endDate) body.endDate = filters.endDate
  if (filters.sources.length < 3) body.source = filters.sources.join(',')
  if (filters.tournaments.length)
    body.tournament = filters.tournaments.join(',')
  // Only sent when on: the database leaves CPU games out unless asked.
  if (filters.includeCpu) body.includeCpu = true
  return body
}

/**
 * The website's POST /api/getList body for a search: the filters as they are,
 * with includeCpu only when on (the website forwards only a real true), and
 * always storedOnly (Find replays shows only games it can fetch from storage).
 */
export function databaseSearchBody(
  input: DatabaseFilters,
  page: number,
  numPerPage: number,
): Record<string, unknown> {
  const { includeCpu, ...filters } = validateDatabaseFilters(input)
  return {
    ...filters,
    ...(includeCpu ? { includeCpu: true } : {}),
    // Only games stored on storage: what Find replays can download from R2.
    storedOnly: true,
    page,
    numPerPage,
  }
}

/**
 * The /api/clipper?action=create body for an explicit list of replays. Always
 * with includeCpu: the list names games someone already chose (in Find replays,
 * behind chosen clips, or missing from a project), and without it the database
 * reports any CPU game among them as "missing".
 */
export function replayListExportBody(replayIds: string[]) {
  return { replayIds, includeCpu: true }
}
