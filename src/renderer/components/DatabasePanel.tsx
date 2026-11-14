import { useEffect, useRef, useState } from 'react'
import {
  DatabaseFilters,
  DatabaseEstimate,
  DatabaseSearch,
  DatabaseReply,
  DatabaseRequest,
  MAX_FILTER_VALUES,
  Transfer,
  defaultDatabaseFilters,
  validateDatabaseFilters,
  formatWait,
  describeQueue,
  storageDownloadText,
  storageSeconds,
  storedThroughNote,
  type SiteStatus,
  type FullDbInfo,
  type DatabaseMaintenance,
} from '../../constants/database'
import { sortedCharacters } from '../../constants/characters'
import { legalStages } from '../../constants/stages'
import StageSelect from './StageSelect'
import ClipSearchTab from './ClipSearchTab'
import CharacterSelect from './CharacterSelect'
import {
  defaultClipSearch,
  type ClipSearchFilters,
} from '../../constants/clipSearch'
import { clipsToGames, gamesToClips, picksFor } from '../lib/databaseCarry'
import { resolveCharacterImage } from '../lib/clipAssets'
import type { PlayerInterface } from '../../constants/types'
import { shownProjectName } from '../../constants/defaultProject'
import SearchBox, { TournamentPick, playerLabel } from './SearchBox'
import AnimatedCount from './AnimatedCount'
import { useArchive, useConfig } from '../context/AppContext'
import { useModal } from '../hooks/useModal'
import useWorkRunning, { describeWork } from '../hooks/useWorkRunning'
import { statusPollDelay } from '../lib/statusPoll'
import { freeSpaceNote } from '../lib/freeSpace'
import { ConfirmModal } from './FilterModals'
import { showNotice } from '../importNotice'
import { openFailureNotice } from '../lib/openNotice'
import ipcBridge from '../ipcBridge'
import '../styles/DatabasePanel.css'
import { formatBytes } from '../../lib/format'

export type DatabaseTab = 'search' | 'clips' | 'transfers'

export { formatBytes }

const labels: Record<Transfer['stage'], string> = {
  queued: 'Queued',
  preparing: 'Preparing',
  downloading: 'Downloading',
  extracting: 'Extracting',
  'waiting-project': 'Waiting for project',
  importing: 'Importing',
  paused: 'Paused',
  failed: 'Needs attention',
  canceled: 'Canceled',
  completed: 'Complete',
}

/** "48:12" / "1:05:09" until `at`, ticking every second (between status polls). */
const ACTIVE_STAGES = [
  'queued',
  'preparing',
  'downloading',
  'extracting',
  'importing',
]
/** A download started this recently is marked "Just added". */
const NEW_FOR_MS = 90_000

/** How fast a running transfer moves: samples of its progress over the last
 *  ~8 seconds, by transfer id (kept between renders). */
type Sample = { t: number; current: number; stage: string }
function measure(samples: Map<string, Sample[]>, transfers: Transfer[]) {
  const now = Date.now()
  for (const job of transfers) {
    if (!ACTIVE_STAGES.includes(job.stage)) {
      samples.delete(job.id)
      continue
    }
    const list = (samples.get(job.id) ?? []).filter(
      (x) => x.stage === job.stage && now - x.t < 8000,
    )
    const last = list[list.length - 1]
    if (!last || last.current !== job.current)
      list.push({ t: now, current: job.current, stage: job.stage })
    samples.set(job.id, list)
  }
}
/** Units per second, or null until there's enough to say. */
function rateOf(samples: Sample[] | undefined) {
  if (!samples || samples.length < 2) return null
  const a = samples[0]
  const b = samples[samples.length - 1]
  const secs = (Date.now() - a.t) / 1000
  if (secs < 1.5 || b.current <= a.current) return null
  return (b.current - a.current) / secs
}

/** "42 / 200 games · 4.8 a second · about 30 s left" for a running download. */
function liveLine(job: Transfer, rate: number | null) {
  const games = job.unit === 'games'
  const amount = (n: number) => (games ? n.toLocaleString() : formatBytes(n))
  const parts = [
    `${amount(job.current)}${job.total ? ` / ${amount(job.total)}` : ''}${games ? ' games' : ''}`,
  ]
  if (rate)
    parts.push(
      games
        ? `${rate >= 10 ? Math.round(rate) : rate.toFixed(1)} a second`
        : `${formatBytes(rate)}/s`,
    )
  // Games straight from storage also say how fast the bytes come.
  if (games && job.speed && job.speed > 0)
    parts.push(`${formatBytes(job.speed)}/s`)
  if (rate && job.total && job.total > job.current) {
    const left = (job.total - job.current) / rate
    parts.push(
      left < 60
        ? `about ${Math.max(1, Math.round(left))} s left`
        : `${formatWait(left)} left`,
    )
  }
  return parts.join(' · ')
}

function Countdown({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const left = Math.max(0, Math.round((at - now) / 1000))
  const h = Math.floor(left / 3600)
  const m = Math.floor((left % 3600) / 60)
  const sec = String(left % 60).padStart(2, '0')
  const text = h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
  return (
    <span
      className="database-countdown"
      title="Estimated; the server updates it every few seconds"
    >
      {left > 0 ? `ready in ${text}` : 'almost ready'}
    </span>
  )
}

/** What a waiting/stopped job has on disk so far. */
/** What a finished download brought: "141 games added · 3 skipped". */
function historyResult(job: Transfer): string {
  if (job.stage === 'canceled') return 'Canceled'
  const r = job.result
  if (!r) return job.detail
  const parts = [
    `${r.inserted.toLocaleString()} ${r.inserted === 1 ? 'game' : 'games'} added`,
  ]
  if (r.duplicates) parts.push(`${r.duplicates.toLocaleString()} already there`)
  if (r.skipped) parts.push(`${r.skipped.toLocaleString()} skipped`)
  if (r.failed) parts.push(`${r.failed.toLocaleString()} failed`)
  return parts.join(' · ')
}

/** "just now", "12 min ago", "today 7:27 PM", "yesterday 9:02 AM", "Oct 3". */
function whenText(at: number): string {
  const d = new Date(at)
  const now = new Date()
  const mins = Math.round((now.getTime() - at) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const day = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((day(now) - day(d)) / 86400000)
  if (days === 0) return `today ${time}`
  if (days === 1) return `yesterday ${time}`
  return d.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  })
}

function savedText(job: Transfer): string | null {
  const saved = job.saved
  if (!saved) return null
  const parts: string[] = []
  if (saved.games)
    parts.push(
      `${saved.games.toLocaleString()} ${saved.games === 1 ? 'game' : 'games'} in your library`,
    )
  if (saved.bytes) parts.push(`${formatBytes(saved.bytes)} of the download`)
  return parts.length ? `Downloaded so far: ${parts.join(', ')}` : null
}

const characterName = (id: string) =>
  sortedCharacters.find((c) => String(c.id) === id)?.name ?? null

/** One side of the matchup in words: "XX#02 (Hax$) as Sheik", "anyone". */
function describeSide(codes: string[], tags: string[], characters: string[]) {
  const people = [...codes.map(playerLabel), ...tags.map((t) => `“${t}”`)]
  const who = people.length ? people.join(' or ') : 'anyone'
  const as = characters.map(characterName).filter(Boolean)
  return as.length ? `${who} as ${as.join(' or ')}` : who
}

/** The whole search as a sentence: "XX#02 (Hax$) as Sheik vs anyone ·
 *  Battlefield · KOTJ #7". */
/** A source as the person reads it. Ranked games carry no tag or connect code (Slippi's ranked data is anonymous). */
function sourceName(source: string): string {
  if (source === 'ranked') return 'Ranked (anonymous)'
  if (source === 'tournament') return 'Tournaments'
  if (source === 'netplay') return 'Netplay'
  return source
}

export function describeSearch(
  f: DatabaseFilters,
  tournaments: TournamentPick[],
): string {
  const p1 = describeSide(f.p1Codes, f.p1Tags, f.p1Characters)
  const p2 = describeSide(f.p2Codes, f.p2Tags, f.p2Characters)
  const parts = [
    `${p1.charAt(0).toUpperCase()}${p1.slice(1)} vs ${p2}`,
    f.stageFilters
      .map((id) => legalStages.find((s) => String(s.id) === id)?.name)
      .filter(Boolean)
      .join(' or '),
    tournaments.map((t) => t.name).join(' or '),
    f.startDate || f.endDate
      ? `${f.startDate || 'any time'} – ${f.endDate || 'now'}`
      : '',
    f.sources.length < 3 ? f.sources.map(sourceName).join(' + ') : '',
    f.includeCpu ? 'with CPU games' : '',
  ]
  return parts.filter(Boolean).join(' · ')
}

const ALL_SOURCES = ['netplay', 'ranked', 'tournament']

/** The first How many card (and the starting amount). */
const QUICK_GAMES = 100

/** For the rough times on How many: an average game's download size (until an
 *  estimate gives this search's own). */
const ROUGH_BYTES_PER_GAME = 400_000
/** The whole-database file comes from storage at the user's own speed: assume
 *  200 Mbit/s for its rough time. */
const FULL_DB_BYTES_PER_SEC = 25_000_000

/** Where the games come from, as one choice. */
const FROM = [
  { label: 'All games', sources: ALL_SOURCES },
  { label: 'Tournaments', sources: ['tournament'] },
  { label: 'Netplay', sources: ['netplay'] },
  { label: 'Ranked (anon)', sources: ['ranked'] },
]

/** What the batch is, for the button: "Fox vs Marth games", "Fox games". */
function gamesPhrase(f: DatabaseFilters) {
  const names = (ids: string[]) =>
    ids.map(characterName).filter(Boolean).join(' or ')
  const p1 = names(f.p1Characters)
  const p2 = names(f.p2Characters)
  if (p1 && p2) return `${p1} vs ${p2} games`
  if (p1) return `${p1} games`
  if (p2) return `games against ${p2}`
  return 'games'
}

/** A button label for work in progress, with dots that keep moving. */
function BusyLabel({ text }: { text: string }) {
  return (
    <span className="database-busy" aria-live="polite">
      {text}
      <span className="database-busy-dots" aria-hidden="true">
        <span>.</span>
        <span>.</span>
        <span>.</span>
      </span>
    </span>
  )
}

export default function DatabasePanel({
  tab,
  onTab,
  transfers,
  onTransfers,
  clipSearch,
}: {
  tab: DatabaseTab | null
  onTab: (_tab: DatabaseTab | null) => void
  transfers: Transfer[]
  onTransfers: (_transfers: Transfer[]) => void
  /** Open Find clips on this search (key changes start it fresh). */
  clipSearch?: { filters: ClipSearchFilters; key: number } | null
}) {
  const { archive, setArchive } = useArchive()
  const { config, setConfig } = useConfig()
  const hideMomentsNote = () => {
    setConfig((prev) => (prev ? { ...prev, showMomentsNote: false } : prev))
    ipcBridge.updateConfig({ key: 'showMomentsNote', value: false })
  }
  const [tournamentPicks, setTournamentPicks] = useState<TournamentPick[]>([])
  // The Find moments form lives in its own component; its latest search is kept
  // here so switching tabs can carry people, characters and tournaments across.
  const clipLive = useRef<{
    filters: ClipSearchFilters
    picks: TournamentPick[]
  } | null>(null)
  const [clipCarry, setClipCarry] = useState<{
    filters: ClipSearchFilters
    picks: TournamentPick[]
    key: number
  } | null>(null)
  // A new project starts small: 100 games download straight away.
  const [filters, setFilters] = useState<DatabaseFilters>({
    ...defaultDatabaseFilters,
    maxFiles: QUICK_GAMES,
  })
  const [showMore, setShowMore] = useState(false)
  // How many: one of the cards, all the matches, or a number typed in.
  const [amountMode, setAmountMode] = useState<'preset' | 'all' | 'custom'>(
    'preset',
  )
  const [customAmount, setCustomAmount] = useState('')
  const bytesPerGame = useRef(ROUGH_BYTES_PER_GAME)
  const [searched, setSearched] = useState<DatabaseFilters | null>(null)
  const [results, setResults] = useState<DatabaseSearch | null>(null)
  const [estimate, setEstimate] = useState<DatabaseEstimate | null>(null)
  // The site's live status while the panel is open: the admin notice, whether
  // the Lunar database is reachable, and how long the download queue is.
  const [siteStatus, setSiteStatus] = useState<SiteStatus | null>(null)
  // The whole database as one file, offered when no filter narrows the search;
  // its info also says up to when games are stored (the note under the search).
  const [fullDb, setFullDb] = useState<FullDbInfo | null>(null)
  const [statusReached, setStatusReached] = useState(true)
  // Down for maintenance, as a request's reply said (before the next status poll).
  const [replyMaintenance, setReplyMaintenance] =
    useState<DatabaseMaintenance | null>(null)
  // Asked only while the panel is open or a download is running (its maintenance notice
  // matters then): a Clipper left open all day does not poll the server for a panel nobody
  // sees. Failures back off (lib/statusPoll.ts).
  const pollWanted =
    tab !== null || transfers.some((j) => ACTIVE_STAGES.includes(j.stage))
  useEffect(() => {
    if (!pollWanted) return undefined
    let stopped = false
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = () => {
      ipcBridge.database({ action: 'status' }, (response) => {
        if (stopped) return
        if (response.status) {
          failures = 0
          setSiteStatus(response.status)
          setReplyMaintenance(null)
          setStatusReached(true)
        } else {
          failures += 1
          if (!response.error) setStatusReached(false)
        }
        // Look more often while it's down for maintenance, to come back quickly.
        timer = setTimeout(
          poll,
          statusPollDelay(failures, !!response.status?.maintenance),
        )
      })
    }
    poll()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [pollWanted])
  const [loading, setLoading] = useState(false)
  const [estimating, setEstimating] = useState(false)
  const [starting, setStarting] = useState(false)
  // A download being started can be canceled while it says "Starting…": the late reply (the job) is then canceled too.
  const startSeq = useRef(0)
  const startedAt = useRef(0)
  const canceledStarts = useRef(new Set<number>())
  const [error, setError] = useState('')
  // The database is down for maintenance: its message replaces errors and the
  // search forms; downloads wait in the Downloads tab and resume by themselves.
  const maintenance = siteStatus?.maintenance ?? replyMaintenance
  /** A reply that says "maintenance" is not an error: note it, true if so. */
  const noteMaintenance = (response: DatabaseReply) => {
    if (!response.maintenance) return false
    setReplyMaintenance(response.maintenance)
    return true
  }
  const [library, setLibrary] = useState<DatabaseReply['library'] | null>(null)
  const sequence = useRef(0)
  const pressedBackdrop = useRef(false)
  const samples = useRef(new Map<string, Sample[]>())
  measure(samples.current, transfers)
  const anyActive = transfers.some((j) => ACTIVE_STAGES.includes(j.stage))
  // Tick while something runs, so speeds, times and "Just added" stay current.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (tab !== 'transfers' || !anyActive) return undefined
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [tab, anyActive])
  // Opening Downloads right after adding one: bring it into view.
  const newest = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (tab === 'transfers')
      newest.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [tab])
  const retryTimer = useRef<ReturnType<typeof setTimeout>>()
  const estimateTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(
    () => () => {
      clearTimeout(retryTimer.current)
      clearTimeout(estimateTimer.current)
    },
    [],
  )
  // The last character clicked: a shift-click fills everything between it and the
  // new one (on, or off when the new one was on), like a file list.
  const characterAnchor = useRef<number | null>(null)
  const open = tab !== null

  // Focus in, Tab kept inside, Esc closes, focus back (hooks/useModal.ts).
  const dialogBox = useModal<HTMLDivElement>({
    active: open,
    initialFocus: 'box',
    onEscape: () => onTab(null),
  })

  // The form tab looked at last: switching to the other one carries the shared
  // search across (people, characters, tournaments), not the stage or dates.
  const lastForm = useRef<'search' | 'clips'>('search')
  useEffect(() => {
    if (tab === 'search' || tab === 'clips') lastForm.current = tab
  }, [tab])
  // A search handed in from outside (Surprise me) starts the form fresh.
  useEffect(() => {
    setClipCarry(null)
    clipLive.current = null
  }, [clipSearch?.key])

  function switchTab(value: DatabaseTab) {
    setError('')
    const from = lastForm.current
    if (value === 'clips') {
      if (from === 'search') {
        setClipCarry({
          filters: gamesToClips(
            filters,
            clipLive.current?.filters ?? defaultClipSearch,
          ),
          picks: picksFor(filters.tournaments, tournamentPicks),
          key: Date.now(),
        })
      } else if (clipLive.current && tab !== 'clips') {
        setClipCarry({ ...clipLive.current, key: Date.now() })
      }
    } else if (value === 'search' && from === 'clips' && clipLive.current) {
      const live = clipLive.current
      setFilters((f) => clipsToGames(live.filters, f))
      setTournamentPicks(live.picks)
    }
    onTab(value)
  }

  function update<K extends keyof DatabaseFilters>(
    key: K,
    value: DatabaseFilters[K],
  ) {
    setFilters((previous) => ({ ...previous, [key]: value }))
  }

  // Where the games come from decides what the search can name: ranked games are
  // anonymous (no tags or codes), and only tournament games belong to a tournament.
  // Picking a source drops the picks it can't match (they would only find nothing).
  const onlyRanked =
    filters.sources.length === 1 && filters.sources[0] === 'ranked'
  const canPickTournament = filters.sources.includes('tournament')
  function pickFrom(sources: string[]) {
    const ranked = sources.length === 1 && sources[0] === 'ranked'
    const tournaments = sources.includes('tournament')
    setFilters((previous) => ({
      ...previous,
      sources,
      ...(ranked ? { p1Codes: [], p1Tags: [], p2Codes: [], p2Tags: [] } : {}),
      ...(tournaments ? {} : { tournaments: [] }),
    }))
    if (!tournaments) setTournamentPicks([])
  }

  useEffect(() => {
    if (tab !== 'search' || fullDb) return
    ipcBridge.database({ action: 'fullDbInfo' }, (response) => {
      if (response.fullDb) setFullDb(response.fullDb)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  // Results like the website: the newest games as soon as the tab opens, and
  // again shortly after any filter changes (no need to press Search).
  useEffect(() => {
    if (tab !== 'search') return undefined
    try {
      validateDatabaseFilters(filters)
    } catch {
      return undefined // mid-edit (e.g. half a date): wait for a valid filter
    }
    if (searched && JSON.stringify(filters) === JSON.stringify(searched))
      return undefined
    const t = setTimeout(() => search(1, filters), searched ? 400 : 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, tab])

  function search(nextPage = 1, snapshot = filters) {
    try {
      validateDatabaseFilters(snapshot)
    } catch (e) {
      setError((e as Error).message)
      return
    }
    const ticket = ++sequence.current
    const sameFilters = snapshot === searched
    setLoading(true)
    setError('')
    if (!sameFilters) {
      setEstimating(true)
      setEstimate(null)
    }
    setSearched(snapshot)
    clearTimeout(retryTimer.current)
    clearTimeout(estimateTimer.current)
    // Rate limited: say nothing alarming, wait as long as the site asks, try again.
    const retryLater = (seconds: number | undefined, run: () => void) => {
      retryTimer.current = setTimeout(
        () => ticket === sequence.current && run(),
        Math.min(Math.max(seconds ?? 5, 1), 60) * 1000,
      )
    }
    const runSearch = () =>
      ipcBridge.database(
        { action: 'search', filters: snapshot, page: nextPage },
        (response) => {
          if (ticket !== sequence.current) return
          if (response.retryAfter !== undefined) {
            retryLater(response.retryAfter, runSearch)
            return
          }
          setLoading(false)
          if (response.error) {
            if (!noteMaintenance(response)) setError(response.error)
            setResults(null)
          } else if (response.search && Array.isArray(response.search.results))
            setResults(response.search)
          else setError('The database returned an invalid search response.')
        },
      )
    const runEstimate = () =>
      ipcBridge.database(
        { action: 'estimate', filters: snapshot },
        (response) => {
          if (ticket !== sequence.current) return
          if (response.retryAfter !== undefined) {
            retryLater(response.retryAfter, runEstimate)
            return
          }
          setEstimating(false)
          if (response.error) {
            if (!noteMaintenance(response)) setError(response.error)
          } else if (
            response.estimate &&
            Number.isFinite(response.estimate.replayCount)
          )
            setEstimate(response.estimate)
          else setError('Could not estimate this download.')
        },
      )
    runSearch()
    // The size only changes with the filters (not the page), and costs more:
    // wait until the clicking has settled before asking for it.
    if (!sameFilters)
      estimateTimer.current = setTimeout(
        () => ticket === sequence.current && runEstimate(),
        searched ? 1200 : 0,
      )
  }

  function cancelStarting() {
    canceledStarts.current.add(startSeq.current)
    setStarting(false)
  }

  function action(request: DatabaseRequest) {
    const token = ++startSeq.current
    const at = Date.now()
    startedAt.current = at
    setStarting(true)
    setError('')
    ipcBridge.database(request, (response) => {
      if (canceledStarts.current.delete(token)) {
        // Canceled while starting, but the request went through: stop what it started.
        if (response.transfers) {
          onTransfers(response.transfers)
          for (const job of response.transfers) {
            if (
              job.createdAt >= at - 2000 &&
              ACTIVE_STAGES.includes(job.stage)
            ) {
              ipcBridge.database({ action: 'cancel', id: job.id }, (r) => {
                if (r.transfers) onTransfers(r.transfers)
              })
            }
          }
        }
        return
      }
      setStarting(false)
      if (response.error) {
        if (!noteMaintenance(response)) setError(response.error)
        return
      }
      if (response.transfers) onTransfers(response.transfers)
      if (
        request.action === 'start' ||
        request.action === 'extract' ||
        request.action === 'addReplays' ||
        request.action === 'addToProject' ||
        request.action === 'downloadFullDb' ||
        request.action === 'unpackFile'
      ) {
        // Straight to Downloads, so you see it start (the user, 2026-10-10:
        // closing the panel looked like nothing happened).
        onTab('transfers')
        ipcBridge.getArchive((value) => {
          if (!value?.error) setArchive(value || null)
        })
      }
    })
  }

  // What's already downloaded: refreshed on opening Transfers and whenever a
  // transfer finishes.
  const finished = transfers.filter((t) => t.stage === 'completed').length
  useEffect(() => {
    if (tab !== 'transfers') return
    ipcBridge.database({ action: 'library' }, (response) => {
      if (response.library) setLibrary(response.library)
    })
  }, [tab, finished])

  const dirty = JSON.stringify(filters) !== JSON.stringify(searched)
  const total = results?.total ?? null

  // Every game offered here is stored on storage (searches ask for storedOnly),
  // so every download comes straight from storage: this says up to when.
  const storedNote = storedThroughNote(fullDb)
  // "Games up to Oct 24, 2026": the rest of that sentence is not needed beside the Create button.
  const storedShort = storedNote
    ? storedNote.replace(/ are available\..*$/, '')
    : ''
  const what = describeSearch(filters, tournamentPicks)

  // How many: three cards (those smaller than the matches), then under them
  // "or exactly N" and "or all of them", each with a rough time.
  const amounts = [QUICK_GAMES, 1000, 10000].filter(
    (value) => total === null || value < total,
  )
  // Remember the latest size per game (the estimate is cleared while it reloads).
  if (estimate?.direct && estimate.direct.located > 0)
    bytesPerGame.current =
      estimate.direct.locatedBytes / estimate.direct.located
  else if (estimate && estimate.replayCount > 0)
    bytesPerGame.current =
      (estimate.estimatedZipSize ?? estimate.estimatedSlpzSize) /
      estimate.replayCount
  /** Rough time for n games, all straight from storage (at 200 Mbit/s). */
  const roughTime = (n: number): string =>
    formatWait(storageSeconds(n, bytesPerGame.current))
  function pickCustom(text: string) {
    setCustomAmount(text)
    setAmountMode('custom')
    const n = parseInt(text.replace(/[^\d]/g, ''), 10)
    if (Number.isSafeInteger(n) && n > 0)
      update('maxFiles', Math.min(n, total || n))
  }
  // Keep the choice valid when the number of matches changes.
  useEffect(() => {
    if (total === null || total < 1) return
    if (amountMode === 'all') {
      update('maxFiles', total)
      return
    }
    if (amountMode === 'custom') {
      if (filters.maxFiles > total) update('maxFiles', total)
      return
    }
    if (amounts.includes(filters.maxFiles)) return
    const fit = [...amounts].reverse().find((v) => v <= filters.maxFiles)
    if (fit ?? amounts[0]) update('maxFiles', (fit ?? amounts[0])!)
    else {
      setAmountMode('all')
      update('maxFiles', total)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total])
  const batchCount = Math.min(filters.maxFiles, total ?? filters.maxFiles)
  // Nothing narrows the search: everything there is (the full database).
  const unfiltered =
    !filters.p1Characters.length &&
    !filters.p2Characters.length &&
    !filters.p1Codes.length &&
    !filters.p2Codes.length &&
    !filters.p1Tags.length &&
    !filters.p2Tags.length &&
    !filters.stageFilters.length &&
    !filters.tournaments.length &&
    !filters.startDate &&
    !filters.endDate &&
    filters.sources.length === 3
  // "All" of everything is the whole-database file: one ZIP straight from
  // storage, hours instead of days, kept zipped. Said quietly, not advertised.
  const wholeDbReady = unfiltered && !!fullDb
  const wholeDb = wholeDbReady && amountMode === 'all'
  const moreCount =
    (filters.p2Codes.length ? 1 : 0) +
    (filters.stageFilters.length ? 1 : 0) +
    (filters.startDate || filters.endDate ? 1 : 0) +
    (filters.p2Characters.length ? 1 : 0) +
    (filters.sort !== defaultDatabaseFilters.sort ? 1 : 0) +
    (filters.includeCpu ? 1 : 0)

  /** What clicking the button means, in plain steps and times. */
  function whatHappens() {
    if (dirty || estimating || !estimate) return 'Working out the size…'
    const size = formatBytes(
      estimate.estimatedZipSize ?? estimate.estimatedSlpzSize,
    )
    return `About ${size}. ${storageDownloadText(batchCount, bytesPerGame.current)}`
  }

  const characterSelect = (
    key: 'p1Characters' | 'p2Characters',
    any: string,
  ) => (
    <CharacterSelect
      value={filters[key]}
      onChange={(v) => update(key, v.slice(0, 1))}
      anyLabel={any}
      ariaLabel="Opponent character"
    />
  )

  const pickCharacter = (index: number, shift: boolean) => {
    const picked = filters.p1Characters
    const id = String(sortedCharacters[index].id)
    const turnOn = !picked.includes(id)
    const from = shift ? characterAnchor.current : null
    const range =
      from === null
        ? [id]
        : sortedCharacters
            .slice(Math.min(from, index), Math.max(from, index) + 1)
            .map((c) => String(c.id))
    characterAnchor.current = index
    if (!turnOn) {
      update(
        'p1Characters',
        picked.filter((x) => !range.includes(x)),
      )
      return
    }
    const added = range.filter((x) => !picked.includes(x))
    update('p1Characters', [...picked, ...added].slice(0, MAX_FILTER_VALUES))
  }

  // A download's way back to the app: close the panel on its project, opening it if
  // another one (or none) is open.
  // What runs in the open project: a download finishing must not swap the project under it.
  const work = useWorkRunning()
  const workNow = describeWork(work)
  const [goAsk, setGoAsk] = useState<Transfer | null>(null)
  const goToProject = (job: Transfer) => {
    if (!job.projectPath || job.projectPath === archive?.path) {
      onTab(null)
      return
    }
    ipcBridge.openRecentProject(job.projectPath, (result) => {
      if (!result || result.error) {
        showNotice(
          openFailureNotice('open', result) ?? "Couldn't open that project.",
        )
        return
      }
      setArchive(result)
      onTab(null)
    })
  }

  // With a single download going, finishing it takes you to its project a moment
  // later: that is where the games are, and what you came for. Not when several
  // are running, nor when you have moved on to another tab.
  const openedAt = useRef(0)
  const seenRunning = useRef(new Set<string>())
  const jumped = useRef(new Set<string>())
  useEffect(() => {
    if (tab) {
      if (!openedAt.current) openedAt.current = Date.now()
    } else {
      openedAt.current = 0
      seenRunning.current.clear()
    }
  }, [tab])
  useEffect(() => {
    if (tab !== 'transfers') return undefined
    const runningNow = transfers.filter((j) => ACTIVE_STAGES.includes(j.stage))
    if (runningNow.length === 1) seenRunning.current.add(runningNow[0].id)
    if (runningNow.length > 0) return undefined
    const done = transfers.find(
      (j) =>
        j.stage === 'completed' &&
        !!j.projectPath &&
        !jumped.current.has(j.id) &&
        (seenRunning.current.has(j.id) || j.createdAt >= openedAt.current),
    )
    if (!done) return undefined
    jumped.current.add(done.id)
    // Not while a filter, import or recording runs in the open project: switching would close
    // its database under it. The card's "Go to" button is still there.
    if (workNow) return undefined
    // Not cleared when transfers update again within the beat: it is marked done.
    setTimeout(() => goToProject(done), 600)
    return undefined
    // goToProject only reads the open project and closes the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, transfers])

  const renderCard = (job: Transfer) => {
    const active = ACTIVE_STAGES.includes(job.stage)
    const isNew = active && Date.now() - job.createdAt < NEW_FOR_MS
    const latest = transfers.reduce(
      (a, b) => (b.createdAt > a.createdAt ? b : a),
      transfers[0],
    )
    const rate = rateOf(samples.current.get(job.id))
    return (
      <article
        className={`database-transfer${active ? ' database-transfer--active' : ''}${isNew ? ' database-transfer--new' : ''}`}
        key={job.id}
        ref={
          job.id === latest.id
            ? (el) => {
                newest.current = el
              }
            : undefined
        }
      >
        <div className="database-transfer-heading">
          <h3>{job.title}</h3>
          {isNew && <span className="database-new">Just added</span>}
          <span className={`database-status database-status-${job.stage}`}>
            {active && (
              <span className="database-live-dot" aria-hidden="true" />
            )}
            {labels[job.stage]}
          </span>
          <button
            type="button"
            className="database-transfer-remove"
            disabled={starting}
            aria-label={`Remove ${job.title}`}
            title={
              job.stage === 'completed' || job.stage === 'canceled'
                ? 'Remove from the list (the replays stay)'
                : 'Remove from the list (stops it; replays already brought in stay)'
            }
            onClick={() => action({ action: 'remove', id: job.id })}
          >
            ✕
          </button>
        </div>
        <p>
          {job.stage === 'preparing' && job.readyAt
            ? job.detail.replace(/ · ready in [^·]*/, '')
            : job.detail}
          {job.stage === 'preparing' && job.readyAt ? (
            <>
              {' · '}
              <Countdown at={job.readyAt} />
            </>
          ) : null}
        </p>
        {shownProjectName(job.projectName) && (
          <small>Project: {job.projectName}</small>
        )}
        {['downloading', 'extracting', 'importing', 'preparing'].includes(
          job.stage,
        ) && (
          <>
            <div
              className={`database-bar${job.total ? '' : ' database-bar--waiting'}`}
              role="progressbar"
              aria-label={`${job.title} progress`}
              aria-valuemin={0}
              aria-valuemax={job.total || undefined}
              aria-valuenow={
                job.total ? Math.min(job.current, job.total) : undefined
              }
            >
              <div
                style={{
                  width: job.total
                    ? `${Math.min(100, (job.current / job.total) * 100)}%`
                    : undefined,
                }}
              />
            </div>
            {(job.total || job.current > 0) && (
              <small className="database-live">
                {job.stage === 'downloading'
                  ? liveLine(job, rate)
                  : `${job.current.toLocaleString()}${job.total ? ` / ${job.total.toLocaleString()}` : ''}${rate ? ` · ${rate >= 10 ? Math.round(rate) : rate.toFixed(1)} a second` : ''}`}
              </small>
            )}
          </>
        )}
        {job.error && <p className="database-error">{job.error}</p>}
        {job.saved && (
          <p
            className={`database-saved${savedText(job) ? '' : ' database-saved--none'}`}
          >
            {savedText(job) ?? 'Nothing downloaded yet'}
          </p>
        )}
        <div className="database-transfer-actions">
          {['paused', 'failed', 'waiting-project', 'canceled'].includes(
            job.stage,
          ) ? (
            <button
              type="button"
              disabled={starting}
              onClick={() => action({ action: 'resume', id: job.id })}
            >
              {job.exportGone
                ? 'Start new export'
                : job.stage === 'canceled'
                  ? 'Start again'
                  : job.stage === 'failed'
                    ? 'Retry'
                    : 'Resume'}
            </button>
          ) : (
            job.stage !== 'completed' && (
              <button
                type="button"
                disabled={starting}
                onClick={() => action({ action: 'pause', id: job.id })}
              >
                Pause
              </button>
            )
          )}
          {job.canImport && archive && job.projectPath !== archive.path && (
            <button
              type="button"
              disabled={starting}
              title="Import these replays into the project open now (nothing is downloaded again)"
              onClick={() => action({ action: 'addToProject', id: job.id })}
            >
              {shownProjectName(archive.name)
                ? `Add to “${archive.name}”`
                : 'Add to my project'}
            </button>
          )}
          {job.projectPath && shownProjectName(job.projectName) && (
            <button
              type="button"
              className="database-transfer-go"
              title={`Close this panel and go to “${job.projectName}” (games show up there as they arrive)`}
              onClick={() =>
                // Another project, with something running in this one: ask first.
                workNow && job.projectPath !== archive?.path
                  ? setGoAsk(job)
                  : goToProject(job)
              }
            >
              Go to “{job.projectName}” →
            </button>
          )}
          <button
            type="button"
            onClick={() => action({ action: 'open', id: job.id })}
          >
            Open folder
          </button>
          {job.stage !== 'completed' && job.stage !== 'canceled' && (
            <button
              type="button"
              className="database-transfer-cancel"
              disabled={starting}
              title="Stop this download for good and delete what's partly downloaded (games already in your library stay)"
              onClick={() => action({ action: 'cancel', id: job.id })}
            >
              Cancel
            </button>
          )}
        </div>
      </article>
    )
  }

  // Downloads, grouped: running or queued (in order), stopped ones that need
  // you, and the history of finished ones (newest first).
  const running = transfers.filter((j) => ACTIVE_STAGES.includes(j.stage))
  const attention = transfers.filter((j) =>
    ['paused', 'failed', 'waiting-project'].includes(j.stage),
  )
  const history = transfers
    .filter((j) => j.stage === 'completed' || j.stage === 'canceled')
    .sort(
      (a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt),
    )

  if (!tab) return null
  return (
    <div
      className="database-overlay"
      // A click outside the panel closes it (like Escape). Both press and release
      // must land on the backdrop, so a text selection dragged out doesn't close it.
      onMouseDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        if (pressedBackdrop.current && event.target === event.currentTarget)
          onTab(null)
        pressedBackdrop.current = false
      }}
    >
      <div
        className="database-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="database-title"
        tabIndex={-1}
        ref={dialogBox}
      >
        <header className="database-header">
          <div>
            <span className="database-eyebrow">REPLAY LIBRARY</span>
            <h2 id="database-title">Lunar Database</h2>
          </div>
          <button
            type="button"
            onClick={() => onTab(null)}
            aria-label="Close Lunar Database"
          >
            ✕
          </button>
        </header>
        {maintenance && (
          <div className="database-maintenance" role="status">
            <strong>{maintenance.message}</strong>
            <span>
              The Lunar Database is down for maintenance. Downloads are paused
              and pick up where they left off when it&apos;s back; nothing
              already downloaded is lost.
            </span>
          </div>
        )}
        {!maintenance &&
          (siteStatus?.database === 'down' || !statusReached) && (
            <div className="database-notice warning" role="status">
              The Lunar database is out of reach for a moment. Search, clips and
              downloads should be back within a few minutes.
            </div>
          )}
        {siteStatus?.notice && (
          <div
            className={`database-notice ${siteStatus.notice.level}`}
            role="status"
          >
            {siteStatus.notice.text}
          </div>
        )}
        <nav className="database-tabs" aria-label="Replay tools">
          {(['search', 'clips', 'transfers'] as DatabaseTab[]).map((value) => (
            <button
              type="button"
              key={value}
              aria-current={tab === value ? 'page' : undefined}
              className={tab === value ? 'selected' : ''}
              onClick={() => switchTab(value)}
            >
              {value === 'search' ? (
                'Download games'
              ) : value === 'clips' ? (
                'Pre-parsed moments'
              ) : (
                <>
                  Downloads
                  {running.length > 0 && (
                    <span
                      className="downloads-tab-count"
                      title={`${running.length} running`}
                    >
                      <span className="database-live-dot" aria-hidden="true" />
                      {running.length}
                    </span>
                  )}
                </>
              )}
            </button>
          ))}
        </nav>
        {!maintenance && tab === 'search' && (
          <p className="database-tab-caption">
            Whole replays, straight from storage into your library. Filter them
            for combos and clips yourself.
          </p>
        )}
        {!maintenance &&
          tab === 'clips' &&
          config.showMomentsNote !== false && (
            <div className="database-moments-note" role="note">
              <button
                type="button"
                className="database-moments-close"
                aria-label="Hide this note"
                title="Hide this note (turn it back on in Settings › General)"
                onClick={hideMomentsNote}
              >
                ✕
              </button>
              <strong>Search by what happened in the games.</strong>
              <span>
                Lunar has already parsed every game in the database, so you can
                filter replays by a particular interaction (combos by who, hits,
                damage and kills, or edgeguards) without parsing anything
                yourself.
              </span>
              <span>
                Pick the moments you want and Lunar downloads the games they
                came from to your computer, then opens just those moments as
                clips. You skip the slow part: parsing thousands of games to
                find them.
              </span>
            </div>
          )}
        {error && !maintenance && (
          <div className="database-error" role="alert">
            {error}
          </div>
        )}
        {tab === 'search' && !maintenance && (
          <div className="database-find">
            <div className="database-find-body">
              <section className="database-step" aria-labelledby="find-what">
                <h3 id="find-what">What games do you want?</h3>
                {/* Same box as the website's: players and tournaments, as chips. */}
                <div className="database-big-search">
                  <SearchBox
                    placeholder={
                      onlyRanked
                        ? 'Ranked games are anonymous: pick characters, a stage or dates'
                        : canPickTournament
                          ? 'Any player or tournament'
                          : 'Any player'
                    }
                    disabled={onlyRanked}
                    codes={filters.p1Codes}
                    characters={filters.p1Characters}
                    onCodes={(v) => update('p1Codes', v)}
                    tournaments={
                      canPickTournament ? tournamentPicks : undefined
                    }
                    onTournaments={
                      canPickTournament
                        ? (picks) => {
                            setTournamentPicks(picks)
                            update(
                              'tournaments',
                              picks.map((t) => t.key),
                            )
                          }
                        : undefined
                    }
                  />
                </div>
                <div
                  className="database-chars"
                  role="group"
                  aria-label="Character"
                >
                  {sortedCharacters.map((c, index) => {
                    const id = String(c.id)
                    const on = filters.p1Characters.includes(id)
                    const icon = resolveCharacterImage({
                      characterId: c.id,
                      characterColor: 0,
                    } as PlayerInterface)
                    return (
                      <button
                        type="button"
                        key={id}
                        className={on ? 'selected' : ''}
                        aria-pressed={on}
                        disabled={
                          !on &&
                          filters.p1Characters.length >= MAX_FILTER_VALUES
                        }
                        title={c.name}
                        // Shift keeps the browser from selecting text on a shift-click.
                        onMouseDown={(event) => {
                          if (event.shiftKey) event.preventDefault()
                        }}
                        onClick={(event) =>
                          pickCharacter(index, event.shiftKey)
                        }
                      >
                        {icon ? <img src={icon} alt={c.name} /> : c.name}
                      </button>
                    )
                  })}
                </div>
                <div className="database-from-row">
                  <div
                    className="database-from"
                    role="radiogroup"
                    aria-label="Where the games come from"
                  >
                    {FROM.map((from) => {
                      const on =
                        [...filters.sources].sort().join() ===
                        [...from.sources].sort().join()
                      return (
                        <button
                          type="button"
                          role="radio"
                          aria-checked={on}
                          key={from.label}
                          className={on ? 'selected' : ''}
                          onClick={() => pickFrom(from.sources)}
                        >
                          {from.label}
                        </button>
                      )
                    })}
                  </div>
                  <button
                    type="button"
                    className="database-more-toggle"
                    aria-expanded={showMore}
                    onClick={() => setShowMore((v) => !v)}
                  >
                    {showMore ? '▾' : '▸'} More filters
                    {!showMore && moreCount > 0 && ` (${moreCount} on)`}
                  </button>
                </div>
                {showMore && (
                  <div className="database-more">
                    {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
                    <label>
                      Opponent player
                      <SearchBox
                        placeholder={
                          onlyRanked
                            ? 'Anonymous in ranked games'
                            : 'Anyone (tag or code)'
                        }
                        disabled={onlyRanked}
                        codes={filters.p2Codes}
                        characters={filters.p2Characters}
                        onCodes={(v) => update('p2Codes', v)}
                      />
                    </label>
                    <label>
                      Opponent character
                      {characterSelect('p2Characters', 'Anyone')}
                    </label>
                    <label>
                      Stage
                      <StageSelect
                        value={filters.stageFilters}
                        ariaLabel="Stage"
                        onChange={(next) => update('stageFilters', next)}
                      />
                    </label>
                    <label>
                      From
                      <input
                        type="date"
                        value={filters.startDate}
                        onChange={(event) =>
                          update('startDate', event.target.value)
                        }
                      />
                    </label>
                    <label>
                      Through
                      <input
                        type="date"
                        value={filters.endDate}
                        onChange={(event) =>
                          update('endDate', event.target.value)
                        }
                      />
                    </label>
                    <label>
                      Order
                      <select
                        value={filters.sort}
                        onChange={(event) =>
                          update(
                            'sort',
                            event.target.value as DatabaseFilters['sort'],
                          )
                        }
                      >
                        <option value="replayNewest">Newest games first</option>
                        <option value="replayOldest">Oldest games first</option>
                      </select>
                    </label>
                    <label
                      className="database-check"
                      title="Games with a computer (CPU) player. Off: the Lunar Database leaves them out."
                    >
                      <input
                        type="checkbox"
                        checked={filters.includeCpu === true}
                        onChange={(event) =>
                          update('includeCpu', event.target.checked)
                        }
                      />
                      Include CPU games
                    </label>
                  </div>
                )}
                <div className="database-hero" aria-live="polite">
                  <div
                    className={`database-hero-number${loading ? ' is-updating' : ''}`}
                  >
                    {results ? (
                      <AnimatedCount value={results.total} />
                    ) : loading ? (
                      '…'
                    ) : (
                      '—'
                    )}
                  </div>
                  <div className="database-hero-unit">
                    {loading ? (
                      <span className="footer-dots-anim">counting</span>
                    ) : results?.total === 1 ? (
                      'game'
                    ) : (
                      'games'
                    )}
                    {what !== 'Anyone vs anyone' && (
                      <span className="database-hero-what"> · {what}</span>
                    )}
                  </div>
                </div>
              </section>

              <section className="database-step" aria-labelledby="find-many">
                <div className="database-many-head">
                  <h3 id="find-many">How many do you want to download?</h3>
                  {total !== null && total > 0 && (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={amountMode === 'all'}
                      className={`database-all${amountMode === 'all' ? ' selected' : ''}`}
                      onClick={() => {
                        setAmountMode('all')
                        update('maxFiles', total)
                      }}
                    >
                      All <strong>{total.toLocaleString()}</strong>
                      <span className="database-amount-time">
                        {wholeDbReady
                          ? formatWait(fullDb!.bytes / FULL_DB_BYTES_PER_SEC)
                          : roughTime(total)}
                      </span>
                    </button>
                  )}
                </div>
                <div
                  className="database-amounts"
                  role="radiogroup"
                  aria-label="How many games"
                >
                  {amounts.map((value) => {
                    const on =
                      amountMode === 'preset' && value === filters.maxFiles
                    return (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={on}
                        key={value}
                        className={on ? 'selected' : ''}
                        onClick={() => {
                          setAmountMode('preset')
                          update('maxFiles', value)
                        }}
                      >
                        <strong>{value.toLocaleString()}</strong>
                        <small>
                          {/* All straight from storage: a time at 200 Mbit/s. */}
                          {[
                            value === QUICK_GAMES ? 'Quick start' : '',
                            roughTime(value),
                          ]
                            .filter(Boolean)
                            .join(', ')}
                        </small>
                      </button>
                    )
                  })}
                  {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
                  <label
                    className={`database-amount-exact${amountMode === 'custom' ? ' selected' : ''}`}
                  >
                    <strong>Exactly</strong>
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="any number"
                      aria-label="How many games, any number"
                      value={amountMode === 'custom' ? customAmount : ''}
                      onFocus={() => {
                        if (amountMode !== 'custom' && customAmount)
                          pickCustom(customAmount)
                      }}
                      onChange={(e) => pickCustom(e.target.value)}
                    />
                  </label>
                </div>
                {amountMode === 'custom' &&
                  total !== null &&
                  parseInt(customAmount.replace(/[^\d]/g, ''), 10) > total && (
                    <small className="database-amount-note">
                      Only {total.toLocaleString()} match, so that’s all of
                      them.
                    </small>
                  )}
              </section>
            </div>

            <footer className="database-add">
              <div className="database-add-actions">
                <button
                  type="button"
                  className="database-primary"
                  disabled={
                    wholeDb
                      ? starting
                      : starting ||
                        dirty ||
                        loading ||
                        estimating ||
                        !results ||
                        !estimate?.replayCount
                  }
                  onClick={() =>
                    wholeDb
                      ? action({ action: 'downloadFullDb' })
                      : action({ action: 'start', filters: searched! })
                  }
                >
                  {starting ? (
                    <BusyLabel text="Starting" />
                  ) : wholeDb ? (
                    `Download the whole database · ${formatBytes(fullDb!.bytes)}`
                  ) : !dirty && (loading || estimating) ? (
                    // Still working out how many games match: say so, so a
                    // disabled button doesn't look broken.
                    <BusyLabel text="Counting games" />
                  ) : (
                    `${archive ? 'Add' : 'Create project with'} ${batchCount.toLocaleString()} ${gamesPhrase(filters)}`
                  )}
                </button>
                {starting && (
                  <button
                    type="button"
                    className="database-cancel-start"
                    onClick={cancelStarting}
                    title="Stop this from starting"
                  >
                    Cancel
                  </button>
                )}
              </div>
              {(() => {
                // Free space on the library's drive, when main says (library.freeBytes).
                const need =
                  estimate?.estimatedSlpzSize ??
                  batchCount * bytesPerGame.current
                const note = wholeDb
                  ? null
                  : freeSpaceNote(need, library?.freeBytes)
                return note && note.level !== 'ok' ? (
                  <p
                    className={`database-free-space database-free-space--${note.level}`}
                    role={note.level === 'short' ? 'alert' : 'status'}
                  >
                    {note.text}
                  </p>
                ) : null
              })()}
              <p className="database-what-happens">
                {wholeDb
                  ? `${fullDb!.replays ? `${fullDb!.replays.toLocaleString()} games` : 'Every game'}${fullDb!.takenAt ? ` as of ${new Date(fullDb!.takenAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}` : ''} · about ${formatWait(fullDb!.bytes / FULL_DB_BYTES_PER_SEC).replace(/^about /, '')} at 200 Mbit/s`
                  : `${whatHappens().replace(/\.$/, '')}${storedShort ? ` · ${storedShort}` : ''}`}
              </p>
            </footer>
          </div>
        )}
        {tab === 'clips' && !maintenance && (
          <ClipSearchTab
            key={clipCarry?.key ?? clipSearch?.key ?? 'clips'}
            initial={clipCarry?.filters ?? clipSearch?.filters}
            initialPicks={clipCarry?.picks}
            onLive={(f, picks) => {
              clipLive.current = { filters: f, picks }
            }}
            projectName={archive?.name ?? null}
            onTransfers={onTransfers}
            onAdded={() => onTab('transfers')}
          />
        )}
        {tab === 'transfers' && (
          <section className="database-transfers">
            {/* One slim bar: the server's line, your library, the folder. */}
            <div className="downloads-bar">
              <span
                className="downloads-chip"
                title="The Lunar database is free and runs on one server. Games come straight from storage into your library: big downloads can take a while when it's busy, and one that stops picks up where it left off. You can keep using Clipper meanwhile."
              >
                <span
                  className={`downloads-chip-dot${siteStatus?.database === 'down' ? ' is-down' : ''}`}
                  aria-hidden="true"
                />
                {siteStatus?.queue
                  ? describeQueue(siteStatus.queue)
                  : 'Lunar server'}
              </span>
              <span className="downloads-chip" title={library?.folder}>
                {library
                  ? `${library.games.toLocaleString()} ${library.games === 1 ? 'game' : 'games'} in your library · ${library.fromDatabase.toLocaleString()} from Lunar`
                  : 'Your library…'}
              </span>
              <button
                type="button"
                className="downloads-bar-button"
                onClick={() => action({ action: 'openLibrary' })}
              >
                Open library folder
              </button>
            </div>

            {!transfers.length && (
              <div className="database-empty">
                No downloads yet. Download games or search pre-parsed moments
                and they show up here, live, then stay in your history.
                Unpacking archives with File › Extract Replays shows up here
                too.
              </div>
            )}

            {running.length > 0 && (
              <div className="downloads-group">
                <h3 className="downloads-group-title">
                  Now
                  <span>
                    {running.length === 1
                      ? 'one download running'
                      : `${running.length} downloads, one at a time in order`}
                  </span>
                </h3>
                {running.map(renderCard)}
              </div>
            )}

            {attention.length > 0 && (
              <div className="downloads-group">
                <h3 className="downloads-group-title">
                  Needs you
                  <span>paused or stopped: resume, retry or remove</span>
                </h3>
                {attention.map(renderCard)}
              </div>
            )}

            {history.length > 0 && (
              <div className="downloads-group">
                <h3 className="downloads-group-title">
                  History
                  <span>
                    {history.length.toLocaleString()}{' '}
                    {history.length === 1 ? 'download' : 'downloads'} · removing
                    one keeps its replays
                  </span>
                  <button
                    type="button"
                    className="downloads-clear"
                    disabled={starting}
                    onClick={() => action({ action: 'clearFinished' })}
                  >
                    Clear history
                  </button>
                </h3>
                <ul className="downloads-history">
                  {history.map((job) => (
                    <li
                      key={job.id}
                      className={`downloads-row downloads-row--${job.stage}`}
                    >
                      <span
                        className="downloads-row-icon"
                        aria-label={labels[job.stage]}
                        title={labels[job.stage]}
                      >
                        {job.stage === 'completed' ? '✓' : '–'}
                      </span>
                      <div className="downloads-row-main">
                        <strong>{job.title}</strong>
                        <small>
                          {[
                            historyResult(job),
                            shownProjectName(job.projectName)
                              ? `in “${job.projectName}”`
                              : '',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </small>
                      </div>
                      <time
                        className="downloads-row-when"
                        dateTime={new Date(
                          job.finishedAt ?? job.createdAt,
                        ).toISOString()}
                        title={new Date(
                          job.finishedAt ?? job.createdAt,
                        ).toLocaleString()}
                      >
                        {whenText(job.finishedAt ?? job.createdAt)}
                      </time>
                      <div className="downloads-row-actions">
                        {job.canImport &&
                          archive &&
                          job.projectPath !== archive.path && (
                            <button
                              type="button"
                              disabled={starting}
                              title="Import these replays into the project open now (nothing is downloaded again)"
                              onClick={() =>
                                action({ action: 'addToProject', id: job.id })
                              }
                            >
                              {shownProjectName(archive.name)
                                ? `Add to “${archive.name}”`
                                : 'Add to my project'}
                            </button>
                          )}
                        {job.fullDb && job.stage === 'completed' && (
                          <button
                            type="button"
                            disabled={starting}
                            title="Unpack every game into playable .slp files (Extract Replays)"
                            onClick={() =>
                              action({ action: 'unpackFile', id: job.id })
                            }
                          >
                            Unpack…
                          </button>
                        )}
                        {job.stage === 'canceled' && (
                          <button
                            type="button"
                            disabled={starting}
                            onClick={() =>
                              action({ action: 'resume', id: job.id })
                            }
                          >
                            Start again
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => action({ action: 'open', id: job.id })}
                        >
                          Open folder
                        </button>
                        <button
                          type="button"
                          className="downloads-row-remove"
                          disabled={starting}
                          aria-label={`Remove ${job.title} from history`}
                          title="Remove from history (the replays stay)"
                          onClick={() =>
                            action({ action: 'remove', id: job.id })
                          }
                        >
                          ✕
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}
      </div>
      {goAsk && (
        <ConfirmModal
          title={`Go to “${goAsk.projectName}” now?`}
          body={`${workNow ? workNow.charAt(0).toUpperCase() + workNow.slice(1) : 'Something is running'} in the project that is open. Opening another project stops it. You can stay here and go when it has finished.`}
          confirmLabel="Stop it and go"
          onCancel={() => setGoAsk(null)}
          onConfirm={() => {
            const job = goAsk
            setGoAsk(null)
            goToProject(job)
          }}
        />
      )}
    </div>
  )
}
