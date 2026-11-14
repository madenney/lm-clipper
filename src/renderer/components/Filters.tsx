/* eslint-disable react/jsx-no-bind */
/* eslint-disable react/no-array-index-key */
import {
  MouseEvent,
  DragEvent,
  useState,
  useRef,
  Dispatch,
  SetStateAction,
  useEffect,
} from 'react'
import '../styles/Filters.css'
import '../styles/FiltersCompact.css'
import {
  filtersConfig,
  REQUIRED_PRODUCER,
  PRODUCER_LABEL,
  FILTER_LAYOUT,
} from 'constants/config'
import { useFiltersStyle } from '../lib/filtersStyle'
import { START_OPTION_EVENT, StartOption } from '../lib/startOptions'
import { showNotice } from '../importNotice'
import AiFilterGuide, { AI_GUIDE_EVENT } from './AiFilterGuide'
import ipcBridge from '../ipcBridge'
import useIpcListener from '../hooks/useIpcListener'
import {
  ConfigInterface,
  FilterInterface,
  SavedCustomFilter,
  ShallowArchiveInterface,
  ShallowFilterInterface,
} from '../../constants/types'
import TemplateCatalog from './TemplateCatalog'
import FilterCard from './FilterCard'
import TrayNote from './TrayNote'
import { STEP_FILTER_EVENT } from '../lib/filterNav'
import {
  FilterErrorModal,
  FilterLogsModal,
  ParserWarningModal,
  ConfirmResetModal,
  ParserRunModal,
  CustomCodeConsentModal,
  ConfirmModal,
  ResetWarnSeverity,
} from './FilterModals'
import {
  validInputsFor,
  FILES_TABLE,
  resolveInputId,
  getDescendantIds,
} from '../../lib/filterGraph'

// A parser prerequisite only warrants a confirmation when it's genuinely
// expensive — a large first parse, or re-running a parser that previously took
// a while. A small first run (fresh import, parser never touched) just goes;
// there's nothing to lose and the heads-up would only be friction.
const PARSER_CONFIRM_COUNT = 50000
const PARSER_CONFIRM_MS = 60000

// Walk up a filter's input path collecting the UNPROCESSED upstream filters
// that must run before it can produce results. Stops at the first processed
// (clean) upstream — its results are still valid and get reused — or at the
// raw files table. Returns them top-to-bottom (run order).
function getUnprocessedPrereqs(
  filters: ShallowFilterInterface[],
  targetIndex: number,
  branchingOn: boolean,
  // Ids of filters currently running. A running upstream is already
  // producing output, so it isn't a prerequisite to kick off — the target just
  // runs on its partial results (FilterExecutor handles the live table). Treat
  // it like a processed input and stop the walk, so we don't pop a "run the
  // parser first" warning for a parser the user already has running.
  runningIds: Set<string>,
): ShallowFilterInterface[] {
  const chain: ShallowFilterInterface[] = []
  const seen = new Set<number>()
  let idx = targetIndex
  while (idx >= 0 && !seen.has(idx)) {
    seen.add(idx)
    const inputId = resolveInputId(filters, idx, branchingOn)
    if (inputId === FILES_TABLE) break
    const inputIdx = filters.findIndex((f) => f.id === inputId)
    if (inputIdx < 0) break
    const inputFilter = filters[inputIdx]
    // A filter with partial results (stopped mid-run, resume banner still
    // showing) has usable output — reuse it rather than re-running. It only
    // counts as needing a run once those partial results are dismissed. A
    // filter that's actively running is likewise already producing output.
    if (
      inputFilter.isProcessed ||
      inputFilter.resumable ||
      runningIds.has(inputFilter.id)
    )
      break
    chain.unshift(inputFilter)
    idx = inputIdx
  }
  return chain
}

// Re-running a processed filter discards its results. We warn first, in three
// independent severity tiers by last-run duration. Ordered low→high: for a given
// run we surface the LOWEST tier the duration qualifies for that the user hasn't
// silenced — so a brand-new user re-running a 1-hour filter sees only the 60s
// warning, then (next time) the 10m one, then the 1h one. Each tier's checkbox
// silences only that tier.
const RESET_WARN_TIERS: {
  key: 'warnOnReset60s' | 'warnOnReset10m' | 'warnOnReset1h'
  thresholdMs: number
  label: string
  severity: ResetWarnSeverity
}[] = [
  {
    key: 'warnOnReset60s',
    thresholdMs: 60 * 1000,
    label: '1 minute',
    severity: 'low',
  },
  {
    key: 'warnOnReset10m',
    thresholdMs: 10 * 60 * 1000,
    label: '10 minutes',
    severity: 'medium',
  },
  {
    key: 'warnOnReset1h',
    thresholdMs: 60 * 60 * 1000,
    label: '1 hour',
    severity: 'high',
  },
]

// Native filters surfaced in the "Browse more" modal, DERIVED from FILTER_LAYOUT
// so their tab and order live in one place (config.ts) next to the dropdown —
// no separate hand-maintained list to drift out of sync. `nativeType` tells
// addFilter to add the native filter instead of a JS template; `requiredProducer`
// lets the modal grey the entries whose upstream parser isn't present yet.
const nativeCatalogFilters: SavedCustomFilter[] =
  FILTER_LAYOUT.modalTabs.flatMap((tab) =>
    (FILTER_LAYOUT.modalNatives[tab] || []).map((id) => {
      const cfg = filtersConfig.find((f) => f.id === id) as
        | { label?: string; tooltip?: string }
        | undefined
      return {
        name: cfg?.label || id,
        code: '',
        nativeType: id,
        builtIn: true,
        category: tab,
        description: cfg?.tooltip || '',
        requiredProducer: REQUIRED_PRODUCER[id],
      }
    }),
  )

type FiltersProps = {
  archive: ShallowArchiveInterface | null
  setArchive: Dispatch<SetStateAction<ShallowArchiveInterface | null>>
  activeFilterId: string
  setActiveFilterId: Dispatch<SetStateAction<string>>
  config: ConfigInterface
  setConfig: Dispatch<SetStateAction<ConfigInterface | null>>
}

// SHA-256 of custom-filter code, used as the trust key for the consent gate.
// SHA-256 (not a cheap string hash) so an attacker can't craft malicious code
// that collides with a hash the user already approved.
async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export default function Filters({
  archive,
  setArchive,
  activeFilterId,
  setActiveFilterId,
  config,
  setConfig,
}: FiltersProps) {
  const filtersStyle = useFiltersStyle()
  const dismissParserNote = () => {
    setConfig((prev) => (prev ? { ...prev, hideParserNote: true } : prev))
    ipcBridge.updateConfig({ key: 'hideParserNote', value: true })
  }
  const dismissRunHint = () => {
    setConfig((prev) => (prev ? { ...prev, hideRunHint: true } : prev))
    ipcBridge.updateConfig({ key: 'hideRunHint', value: true })
  }
  // Running filters by id (positions shift when steps are deleted or moved
  // mid-run), and the ones told to stop that are still winding down.
  const [runningFilters, setRunningFilters] = useState<Set<string>>(new Set())
  const [stoppingFilters, setStoppingFilters] = useState<Set<string>>(new Set())
  const [filterMsgs, setFilterMsgs] = useState<Record<string, string>>({})
  const [liveResults, setLiveResults] = useState<Record<string, number>>({})
  const [expandedFilters, setExpandedFilters] = useState<
    Record<string, boolean>
  >({})
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [namesList, setNamesList] = useState<{ name: string; total: number }[]>(
    [],
  )
  const [namesLoading, setNamesLoading] = useState(true)
  const [connectCodesList, setConnectCodesList] = useState<
    { name: string; total: number }[]
  >([])
  const [codesLoading, setCodesLoading] = useState(true)
  const [parserWarning, setParserWarning] = useState<{
    producer: string
    dependents: string[]
  } | null>(null)
  const [resetConfirm, setResetConfirm] = useState<{
    filter: ShallowFilterInterface
    tier: (typeof RESET_WARN_TIERS)[number]
    prereqs: ShallowFilterInterface[]
  } | null>(null)
  // Editing a filter discards its (and downstream) results — same protection as
  // a re-run. `editConfirmedRef` remembers which filters the user already OK'd
  // this session; `pendingEditRef` holds the deferred save until they confirm.
  const [editConfirm, setEditConfirm] = useState<{
    filter: ShallowFilterInterface
    tier: (typeof RESET_WARN_TIERS)[number]
  } | null>(null)
  const editConfirmedRef = useRef<Set<string>>(new Set())
  // Once the user OKs running a given parser, don't re-prompt for it this
  // session (covers brief archive sync hiccups and just-ran-it annoyance).
  const parserConfirmedRef = useRef<Set<string>>(new Set())
  const pendingEditRef = useRef<{
    save: () => void
    previousFilter: ShallowFilterInterface
  } | null>(null)
  // Set when running a filter needs an expensive upstream parser run first.
  const [parserConfirm, setParserConfirm] = useState<{
    target: ShallowFilterInterface
    prereqs: ShallowFilterInterface[]
    parserLabel: string
    count: number | null
  } | null>(null)
  // Set when a run includes custom-code filters the user hasn't approved. Holds
  // the labels (for display), their code hashes (to persist on "always trust"),
  // and the action to take once consent is given.
  // An in-app yes / no question (ConfirmModal); askConfirm resolves with it.
  const [confirmAsk, setConfirmAsk] = useState<{
    title: string
    body: string
    confirmLabel: string
    resolve: (_ok: boolean) => void
  } | null>(null)
  function askConfirm(title: string, body: string, confirmLabel: string) {
    return new Promise<boolean>((resolve) => {
      setConfirmAsk({ title, body, confirmLabel, resolve })
    })
  }
  const [customConsent, setCustomConsent] = useState<{
    labels: string[]
    hashes: string[]
    onApprove: () => void
  } | null>(null)
  // Session-local mirror of each tier's "don't warn me again" choice so it takes
  // effect immediately (the config prop only refreshes on reload).
  const [suppressedTiers, setSuppressedTiers] = useState<Set<string>>(new Set())
  const [filterError, setFilterError] = useState<{
    filterLabel: string
    errors: string[]
  } | null>(null)
  const [filterLogs, setFilterLogs] = useState<{
    filterLabel: string
    logs: string[]
  } | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [dragWarning, setDragWarning] = useState<string | null>(null)
  const dragIndexRef = useRef<number | null>(null)
  const dropIndexRef = useRef<number | null>(null)
  const dragHeightRef = useRef(0)
  const dragWarningTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const filtersListRef = useRef<HTMLDivElement>(null)
  // Z/X and the arrow keys (from the tray's grid) move the highlighted step, in the order the
  // list shows: the Game Filter first, then the rest.
  const stepRef = useRef<(_delta: number) => void>(() => {})
  stepRef.current = (delta: number) => {
    const all = archive?.filters ?? []
    const game = all.find((f) => f.type === 'files')
    const ids = [
      ...(game ? [game.id] : []),
      ...all.filter((f) => f !== game).map((f) => f.id),
    ]
    if (!ids.length) return
    const at = Math.max(0, ids.indexOf(activeFilterId))
    const next = Math.min(ids.length - 1, Math.max(0, at + delta))
    if (next === at && ids.includes(activeFilterId)) return
    setActiveFilterId(ids[next])
    // Once it has rendered as the active card, bring it into view.
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        filtersListRef.current
          ?.querySelector('.filter-active')
          ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
      ),
    )
  }
  useEffect(() => {
    const on = (e: Event) => stepRef.current((e as CustomEvent<number>).detail)
    window.addEventListener(STEP_FILTER_EVENT, on)
    return () => window.removeEventListener(STEP_FILTER_EVENT, on)
  }, [])
  const cardMidYs = useRef<{ index: number; midY: number }[]>([])
  const dropdownRef = useRef<HTMLDivElement>(null)
  const dragAllowedRef = useRef(true)

  useEffect(() => {
    return () => {
      if (dragWarningTimer.current) clearTimeout(dragWarningTimer.current)
    }
  }, [])

  useIpcListener(
    'currentlyRunningFilter',
    (event: {
      running: number[]
      runningIds?: string[]
      stoppingIds?: string[]
    }) => {
      const next = new Set(event.runningIds ?? [])
      setStoppingFilters(new Set(event.stoppingIds ?? []))
      setRunningFilters((prev) => {
        const stopped: string[] = []
        prev.forEach((id) => {
          if (!next.has(id)) stopped.push(id)
        })
        if (stopped.length > 0) {
          setFilterMsgs((msgs) => {
            const updated = { ...msgs }
            for (const key of Object.keys(updated)) {
              if (/^\d+\/\d+$/.test(updated[key])) {
                delete updated[key]
              }
            }
            return updated
          })
        }
        return next
      })
    },
  )

  useIpcListener(
    'filterUpdate',
    (event: {
      filterId?: string
      filterIndex?: number
      total: number
      current: number
      results?: number
    }) => {
      const key = event.filterId || String(event.filterIndex ?? '')
      if (key) {
        setFilterMsgs((prev) => ({
          ...prev,
          [key]: `${event.current}/${event.total}`,
        }))
        if (event.results !== undefined) {
          setLiveResults((prev) => ({
            ...prev,
            [key]: event.results as number,
          }))
        }
      }
    },
  )

  useIpcListener(
    'filterError',
    (event: { filterId: string; filterLabel: string; errors: string[] }) => {
      setFilterError({
        filterLabel: event.filterLabel,
        errors: event.errors,
      })
    },
  )

  useIpcListener(
    'filterLogs',
    (event: { filterId: string; filterLabel: string; logs: string[] }) => {
      setFilterLogs({
        filterLabel: event.filterLabel,
        logs: event.logs,
      })
    },
  )

  useIpcListener('code-editor-saved', (shallowArchive: any) => {
    if (shallowArchive) setArchive(shallowArchive)
  })

  useEffect(() => {
    const handleClickOutside = (event: Event) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [])

  useEffect(() => {
    if (!archive) return
    setNamesLoading(true)
    setCodesLoading(true)
    // Queries run in a worker thread so the main process stays responsive.
    ipcBridge.getNames((names) => {
      // Never trust the payload's type — an error/stale-reaper reply is a
      // truthy non-array, which `|| []` wouldn't catch and would later blow up
      // `filteredNames.filter(...)` when a name-select renders.
      setNamesList(Array.isArray(names) ? names : [])
      setNamesLoading(false)
    })
    ipcBridge.getConnectCodes((codes) => {
      setConnectCodesList(Array.isArray(codes) ? codes : [])
      setCodesLoading(false)
    })
    // Re-fetch when the file count changes too (not just on project switch) so
    // names/codes populate after an import into a freshly-created project —
    // otherwise they'd stay stuck at the empty-project result.
  }, [archive?.path, archive?.files])

  // Set by a Stop: the run sequence stops before starting its next step, so
  // steps queued behind a stopped one don't run.
  const stopRequestedRef = useRef(false)
  // The step stays "running" (shown as Stopping…) until the main process says
  // its workers have exited and its partial results are saved.
  function stopFilter(filterId: string, _filterIndex?: number) {
    stopRequestedRef.current = true
    setStoppingFilters((prev) => new Set(prev).add(filterId))
    ipcBridge.stopFilter(filterId)
  }

  // Filters whose Run was clicked but that aren't finished yet: shown as
  // running at once (the main process's broadcast arrives a beat later) and
  // protected from a second click, which would abort and restart the run.
  const [pendingRunIds, setPendingRunIds] = useState<Set<string>>(new Set())
  const pendingRunIdsRef = useRef<Set<string>>(new Set())
  const startingRunIdsRef = useRef<Set<string>>(new Set())
  function markRunPending(filters: ShallowFilterInterface[], on: boolean) {
    const next = new Set(pendingRunIdsRef.current)
    for (const f of filters) {
      if (on) next.add(f.id)
      else next.delete(f.id)
    }
    pendingRunIdsRef.current = next
    setPendingRunIds(next)
  }

  // Parameter edits not yet sent to the main process, per filter (updateFilter
  // debounces them). Keyed by id so edits to two filters in quick succession
  // are both saved.
  const pendingSavesRef = useRef<
    Map<string, { filterIndex: number; newFilter: ShallowFilterInterface }>
  >(new Map())

  // Send every pending edit now, in order. Resolves with the archive from the
  // last save (null if there was nothing to save or it failed).
  async function flushPendingSaves(): Promise<ShallowArchiveInterface | null> {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const saves = Array.from(pendingSavesRef.current.values())
    pendingSavesRef.current.clear()
    let latest: ShallowArchiveInterface | null = null
    for (const save of saves) {
      // eslint-disable-next-line no-await-in-loop
      const response = await new Promise<any>((resolve) => {
        ipcBridge.updateFilter(save, resolve)
      })
      if (!response || response?.error) {
        console.error('updateFilter response error:', response?.error)
      } else {
        latest = response
        setArchive(response)
      }
    }
    return latest
  }

  // Running a filter means "produce its results": run any UNPROCESSED upstream
  // filters first (cheap ones silently; an expensive parser asks first), then
  // run the filter itself. Clean (already-run) upstream is reused untouched.
  function runFilter(
    requested: ShallowFilterInterface,
    // The archive just returned by a flushed save (see requestRun); the
    // render-time `archive` would still hold the pre-save filters.
    current: ShallowArchiveInterface | null = archive,
  ) {
    if (!current) return
    const branchingOn = config.branchingEnabled === true
    const targetIndex = current.filters.findIndex((f) => f.id === requested.id)
    const filter = targetIndex >= 0 ? current.filters[targetIndex] : requested
    const prereqs =
      targetIndex >= 0
        ? getUnprocessedPrereqs(
            current.filters,
            targetIndex,
            branchingOn,
            runningFilters,
          )
        : []
    // Confirm before auto-running an EXPENSIVE parser prerequisite only: a big
    // parse, or re-running a parser that previously took a while. A small first
    // run just goes (nothing to lose).
    const bigInput =
      typeof current.files === 'number' && current.files >= PARSER_CONFIRM_COUNT
    const parserPrereq = prereqs.find(
      (f) =>
        PRODUCER_LABEL[f.type] &&
        !parserConfirmedRef.current.has(f.id) &&
        (bigInput ||
          (typeof f.lastRunMs === 'number' &&
            f.lastRunMs >= PARSER_CONFIRM_MS)),
    )
    if (parserPrereq) {
      setParserConfirm({
        target: filter,
        prereqs,
        parserLabel: PRODUCER_LABEL[parserPrereq.type],
        count: current.files ?? null,
      })
      return
    }
    continueRun(filter, prereqs)
  }

  // Run button entry point. Saves any parameter edit still waiting in the
  // debounce first — clicking Run blurs the field, which commits the edit at
  // the same moment — so the run always uses what's on screen. (Without this
  // the run used the old params and the late save then reset the filter:
  // "you have to click Run twice".) Also ignores repeat clicks while this
  // filter is starting or running.
  // `current`: an archive newer than this render's (e.g. just after the steps
  // were replaced), so the run sees the new steps.
  async function requestRun(
    filter: ShallowFilterInterface,
    current: ShallowArchiveInterface | null = null,
  ) {
    const { id } = filter
    if (startingRunIdsRef.current.has(id) || pendingRunIdsRef.current.has(id))
      return
    startingRunIdsRef.current.add(id)
    try {
      const saved = await flushPendingSaves()
      runFilter(filter, saved ?? current ?? archive)
    } finally {
      startingRunIdsRef.current.delete(id)
    }
  }

  // Guard an expensive RE-RUN of the target itself (the long-run tiers), then
  // run the cheap prerequisites and the target, in order.
  function continueRun(
    filter: ShallowFilterInterface,
    prereqs: ShallowFilterInterface[],
  ) {
    if (filter.isProcessed && typeof filter.lastRunMs === 'number') {
      const ms = filter.lastRunMs
      const tier = RESET_WARN_TIERS.find(
        (t) =>
          ms >= t.thresholdMs &&
          config[t.key] !== false &&
          !suppressedTiers.has(t.key),
      )
      if (tier) {
        setResetConfirm({ filter, tier, prereqs })
        return
      }
    }
    runSequence([...prereqs, filter])
  }

  // Custom filters whose code the user hasn't already approved to run. Custom
  // code executes with full machine access, so running it is gated behind an
  // explicit confirm (see CustomCodeConsentModal).
  async function unapprovedCustomFilters(filters: ShallowFilterInterface[]) {
    const approved = new Set(config.approvedCustomCodeHashes || [])
    // Built-in templates ship with the app, so their (unmodified) code is
    // trusted and must NOT trip the consent gate — only code the user wrote or
    // edited should. Pre-approve every built-in template's code hash; the moment
    // a user edits a template the code diverges, its hash no longer matches, and
    // it prompts again (as it should).
    for (const t of config.savedCustomFilters || []) {
      if (t.builtIn && typeof t.code === 'string' && t.code.trim()) {
        // eslint-disable-next-line no-await-in-loop
        approved.add(await sha256Hex(t.code))
      }
    }
    const out: { filter: ShallowFilterInterface; hash: string }[] = []
    for (const f of filters) {
      const code =
        f.type === 'custom' || f.type === 'aiFilter'
          ? f.params?.code
          : undefined
      if (typeof code === 'string' && code.trim()) {
        // eslint-disable-next-line no-await-in-loop
        const hash = await sha256Hex(code)
        if (!approved.has(hash)) out.push({ filter: f, hash })
      }
    }
    return out
  }

  // Code pasted into an AI Filter is NOT approved by pasting it: it came from
  // an AI or a stranger (a chat post, a prompt injection), and runs with full
  // access to the computer. It asks like any other custom code (launch review
  // SEC-1), and main refuses it until the user has said yes.

  function approveCustomHashes(hashes: string[]) {
    const merged = Array.from(
      new Set([...(config.approvedCustomCodeHashes || []), ...hashes]),
    )
    setConfig((prev) =>
      prev ? { ...prev, approvedCustomCodeHashes: merged } : prev,
    )
    ipcBridge.updateConfig({ key: 'approvedCustomCodeHashes', value: merged })
  }

  async function runSequence(
    filters: ShallowFilterInterface[],
    customApproved = false,
  ) {
    markRunPending(filters, true)
    try {
      await runSequenceInner(filters, customApproved)
    } finally {
      markRunPending(filters, false)
    }
  }

  async function runSequenceInner(
    filters: ShallowFilterInterface[],
    customApproved: boolean,
  ) {
    if (!customApproved) {
      const unapproved = await unapprovedCustomFilters(filters)
      if (unapproved.length > 0) {
        setCustomConsent({
          labels: unapproved.map((u) => u.filter.label),
          hashes: unapproved.map((u) => u.hash),
          onApprove: () => runSequence(filters, true),
        })
        return
      }
    }
    stopRequestedRef.current = false
    for (const f of filters) {
      if (stopRequestedRef.current) break
      // Sequential by design: each filter feeds the next.
      // eslint-disable-next-line no-await-in-loop
      const res = await doRunFilter(f)
      // Done: no longer queued (the rest of the run still is).
      markRunPending([f], false)
      if (!res || res.error) break
    }
  }

  function doRunFilter(filter: ShallowFilterInterface): Promise<any> {
    return new Promise((resolve) => {
      if (!archive) {
        resolve(null)
        return
      }
      setActiveFilterId(filter.id)
      setFilterMsgs((prev) => {
        const updated = { ...prev }
        delete updated[filter.id]
        return updated
      })

      ipcBridge.runFilter(filter.id, (response) => {
        if (!response || response?.error) {
          console.error('Error: ', response.error)
          setFilterMsgs((prev) => ({
            ...prev,
            [filter.id]: response?.error || 'Error running filter',
          }))
          resolve(response)
          return
        }

        setArchive(response)
        // Clear running state immediately so results display switches to final count
        // Use response.filters (fresh) instead of archive.filters (stale closure)
        setRunningFilters((prev) => {
          const next = new Set(prev)
          next.delete(filter.id)
          return next
        })
        // Clear live results for this filter
        setLiveResults((prev) => {
          const updated = { ...prev }
          delete updated[filter.id]
          return updated
        })
        // Show message from response, or clear
        setFilterMsgs((prev) => {
          const updated = { ...prev }
          const msg = response.filterMessage?.[filter.id]
          if (msg) {
            updated[filter.id] = msg
          } else {
            delete updated[filter.id]
          }
          return updated
        })
        resolve(response)
      })
    })
  }

  // Gate a resume the same way as a run: resuming a custom filter still
  // executes its code, so unapproved custom code must clear the consent prompt.
  async function resumeFilterRun(filter: ShallowFilterInterface) {
    if (!archive) return
    const unapproved = await unapprovedCustomFilters([filter])
    if (unapproved.length > 0) {
      setCustomConsent({
        labels: unapproved.map((u) => u.filter.label),
        hashes: unapproved.map((u) => u.hash),
        onApprove: () => doResume(filter),
      })
      return
    }
    doResume(filter)
  }

  function doResume(filter: ShallowFilterInterface) {
    if (!archive) return
    setFilterMsgs((prev) => {
      const updated = { ...prev }
      delete updated[filter.id]
      return updated
    })

    ipcBridge.resumeFilter(filter.id, (response) => {
      if (!response || response?.error) {
        console.error('Error: ', response.error)
        setFilterMsgs((prev) => ({
          ...prev,
          [filter.id]: response?.error || 'Error resuming filter',
        }))
        return
      }

      setArchive(response)
      // Use response.filters (fresh) instead of archive.filters (stale closure)
      setRunningFilters((prev) => {
        const next = new Set(prev)
        next.delete(filter.id)
        return next
      })
      setLiveResults((prev) => {
        const updated = { ...prev }
        delete updated[filter.id]
        return updated
      })
      setFilterMsgs((prev) => {
        const updated = { ...prev }
        const msg = response.filterMessage?.[filter.id]
        if (msg) {
          updated[filter.id] = msg
        } else {
          delete updated[filter.id]
        }
        return updated
      })
    })
  }

  // A stopped or failed run whose results are good: keep them as they are.
  function keepFilterResults(filter: ShallowFilterInterface) {
    if (!archive) return
    ipcBridge.keepFilterResults(filter.id, (response) => {
      if (!response || response?.error) {
        showNotice(
          `Couldn’t keep those results${response?.error ? `: ${response.error}` : '.'}`,
        )
        return
      }
      setArchive(response)
      setFilterMsgs((prev) => {
        const updated = { ...prev }
        delete updated[filter.id]
        return updated
      })
    })
  }

  // AI Filters start open (their Copy prompt + response box is the whole
  // point); everything else starts collapsed. A click overrides either.
  function isExpanded(filter: ShallowFilterInterface) {
    return expandedFilters[filter.id] ?? filter.type === 'aiFilter'
  }

  function toggleFilterCollapse(
    event: MouseEvent<HTMLButtonElement>,
    filterId: string,
  ) {
    event.stopPropagation()
    const filter = archive?.filters.find((f) => f.id === filterId)
    const open = filter ? isExpanded(filter) : !!expandedFilters[filterId]
    setExpandedFilters((prev) => ({ ...prev, [filterId]: !open }))
  }

  function addFilter(e: any) {
    if (!setArchive) return
    const nextType = e.target.value
    ipcBridge.addFilter(nextType, (response) => {
      if (!response || response?.error) {
        console.error('addFilter response error:', response?.error)
        showNotice(
          `Couldn’t add that filter${response?.error ? `: ${response.error}` : '.'}`,
        )
        return
      }
      // Auto-expand the newly added filter
      const newFilter = response.filters?.[response.filters.length - 1]
      if (newFilter) {
        setExpandedFilters((prev) => ({ ...prev, [newFilter.id]: true }))
      }
      setArchive(response)
    })
  }

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Would editing this filter discard expensive results? Editing resets the
  // filter AND its descendants, so check the longest last-run among them and
  // return the lowest un-silenced warning tier it qualifies for (or null).
  function editResetTier(filter: ShallowFilterInterface) {
    if (!archive) return null
    const branchingOn = config.branchingEnabled === true
    const descendants = getDescendantIds(
      archive.filters,
      filter.id,
      branchingOn,
    )
    const affected = archive.filters.filter(
      (f) => f.id === filter.id || descendants.has(f.id),
    )
    const maxMs = affected.reduce(
      (m, f) =>
        f.isProcessed && typeof f.lastRunMs === 'number' && f.lastRunMs > m
          ? f.lastRunMs
          : m,
      0,
    )
    if (maxMs <= 0) return null
    return (
      RESET_WARN_TIERS.find(
        (t) =>
          maxMs >= t.thresholdMs &&
          config[t.key] !== false &&
          !suppressedTiers.has(t.key),
      ) ?? null
    )
  }

  function updateFilter(
    newFilter: ShallowFilterInterface,
    previousFilter: ShallowFilterInterface,
  ) {
    if (!archive) return
    const filterIndex = archive.filters.indexOf(previousFilter)

    // Optimistic local update -- instant UI, preserve results display
    const nextFilters = [...archive.filters]
    nextFilters[filterIndex] = newFilter
    setArchive({ ...archive, filters: nextFilters })

    // The destructive part is the save (it resets results). Debounce it...
    // (Run flushes it immediately; see requestRun.)
    const save = () => {
      pendingSavesRef.current.set(newFilter.id, { filterIndex, newFilter })
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null
        flushPendingSaves()
      }, 300)
    }

    // ...but hold it behind a confirm if it would throw away expensive results.
    const tier = editConfirmedRef.current.has(previousFilter.id)
      ? null
      : editResetTier(previousFilter)
    if (tier) {
      pendingEditRef.current = { save, previousFilter }
      setEditConfirm({ filter: previousFilter, tier })
      return
    }
    save()
  }

  async function deleteFilter(filter: FilterInterface) {
    if (archive) {
      // Block deletion if any filter still depends on this one as its producer
      // (e.g. deleting a combo parser with a combo filter below, or an
      // Edgeguards Parser with an Edgeguards Filter below).
      const dependentTypes = Object.entries(REQUIRED_PRODUCER)
        .filter(([, parent]) => parent === filter.type)
        .map(([dep]) => dep)
      if (dependentTypes.length > 0) {
        const dependents = archive.filters.filter((f) =>
          dependentTypes.includes(f.type),
        )
        if (dependents.length > 0) {
          setParserWarning({
            producer: PRODUCER_LABEL[filter.type] || filter.label,
            dependents: dependents.map((f) => f.label),
          })
          return
        }
      }
      // Combo parser only: extra confirm when it was run on a lot of files.
      if (filter.type === 'slpParser') {
        const idx = archive.filters.findIndex((f) => f.id === filter.id)
        const inputCount =
          (filter.isProcessed
            ? idx > 0
              ? archive.filters[idx - 1].results
              : archive.files
            : 0) ?? 0
        if (
          config.warnOnParserDelete !== false &&
          inputCount >= 10000 &&
          !(await askConfirm(
            'Delete the Combo Parser?',
            `It was run on ${inputCount.toLocaleString()} replays; running it again takes a while.`,
            'Delete',
          ))
        ) {
          return
        }
      }
    }
    ipcBridge.removeFilter(filter.id, (response) => {
      if (!response || response?.error) {
        console.error('removeFilter response error:', response.error)
        return
      }
      setArchive(response)
    })
  }

  function canDropAt(
    filters: ShallowFilterInterface[],
    from: number,
    to: number,
  ): string | true | false {
    // Can't drop at pinned game filter position
    if (to === 0) return false
    // No-op: dropping in same position
    if (from === to || to === from + 1) return false

    // Simulate the final order
    const types = filters.map((f) => f.type)
    const [moved] = types.splice(from, 1)
    const insertAt = to > from ? to - 1 : to
    types.splice(insertAt, 0, moved)

    // Validate every producer dependency: a filter that requires a producer
    // type must have one of that type somewhere above it.
    for (let i = 0; i < types.length; i += 1) {
      const parent = REQUIRED_PRODUCER[types[i]]
      if (parent && !types.slice(0, i).includes(parent)) {
        return `This filter requires the ${PRODUCER_LABEL[parent] || parent} above it`
      }
    }

    return true
  }

  function handleDrop(from: number, to: number) {
    if (!archive || from === to) {
      setDragIndex(null)
      setDropIndex(null)
      return
    }
    ipcBridge.reorderFilter({ fromIndex: from, toIndex: to }, (response) => {
      if (!response || response?.error) {
        console.error('reorderFilter error:', response?.error)
      } else {
        setArchive(response)
      }
      // Clear drag state in same batch as archive update -- no flash
      setDragIndex(null)
      setDropIndex(null)
    })
  }

  function measureCardPositions() {
    if (!filtersListRef.current) return
    const positions: { index: number; midY: number }[] = []
    const children = filtersListRef.current.children
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i] as HTMLElement
      const idx = parseInt(child.dataset.filterIndex || '', 10)
      if (Number.isNaN(idx)) continue
      const r = child.getBoundingClientRect()
      positions.push({ index: idx, midY: r.top + r.height / 2 })
    }
    cardMidYs.current = positions
  }

  function handleContainerDragOver(e: DragEvent<HTMLDivElement>) {
    if (dragIndexRef.current === null || !archive) return
    const mouseY = e.clientY
    const positions = cardMidYs.current

    // Find insertion index based on stored original midpoints
    let targetIndex =
      positions.length > 0 ? positions[positions.length - 1].index + 1 : 0
    for (const pos of positions) {
      if (mouseY < pos.midY) {
        targetIndex = pos.index
        break
      }
    }

    const result = canDropAt(archive.filters, dragIndexRef.current, targetIndex)
    if (result === true) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      dropIndexRef.current = targetIndex
      setDropIndex(targetIndex)
    } else {
      dropIndexRef.current = null
      setDropIndex(null)
      // Show warning toast for constraint violations (string reasons)
      if (typeof result === 'string') {
        setDragWarning(result)
        if (dragWarningTimer.current) clearTimeout(dragWarningTimer.current)
        dragWarningTimer.current = setTimeout(() => {
          setDragWarning(null)
          dragWarningTimer.current = null
        }, 1500)
      }
    }
  }

  function dismissFilterMsg(filterId: string) {
    setFilterMsgs((prev) => {
      const updated = { ...prev }
      delete updated[filterId]
      return updated
    })
  }

  // Whether an import is running: a welcome option picked mid-import waits
  // for it to finish before running its steps (startOption).
  const [isImporting, setIsImporting] = useState<boolean | null>(null)
  const applyImportStatus = (status: any) => {
    if (status && typeof status === 'object') {
      setIsImporting(!!status.isImporting)
    }
  }
  useIpcListener('importStatus', applyImportStatus)
  useEffect(() => {
    ipcBridge.getImportStatus(applyImportStatus)
  }, [])
  // No first-run auto-run (user, 2026-10-03): steps run when the user picks
  // a welcome option or presses Run.

  // The welcome modal's start options (lib/startOptions.ts), acting on this
  // project's steps. A ref keeps the listener on the latest archive.
  async function startOption(option: StartOption) {
    if (!archive) return
    // A new choice replaces any run still waiting for an import.
    pendingStartRunRef.current = null
    setWaitingForImport(null)
    const pool = archive.filters.find((f) => f.type === 'files')
    if (option === 'games') {
      // Just the Replays pool (other steps removed, user 2026-10-03): its
      // results are whole games, and Record makes full-game videos.
      const next = await new Promise<ShallowArchiveInterface | null>(
        (resolve) => {
          ipcBridge.applyStarterChain('games', (response) => {
            if (!response || response.error) {
              showNotice(
                `Couldn’t set up the steps${response?.error ? `: ${response.error}` : '.'}`,
              )
              return resolve(null)
            }
            setArchive(response)
            return resolve(response)
          })
        },
      )
      const onlyPool = next?.filters.find((f) => f.type === 'files') ?? pool
      if (onlyPool) setActiveFilterId(onlyPool.id)
      showNotice(
        'Showing whole games. Pick the ones you want, then press Record.',
      )
      return
    }
    if (option === 'combos' || option === 'edgeguards') {
      // Fill in the steps (parser, filter, sort: applyStarterChain), then run
      // them if there are replays. A project that already has this filter
      // just runs it; other steps are only replaced after asking.
      const filterType = option === 'combos' ? 'comboFilter' : 'edgeguardFilter'
      let current: ShallowArchiveInterface | null = archive
      const steps = current.filters.filter((f) => f.type !== 'files')
      if (!steps.some((f) => f.type === filterType)) {
        if (
          steps.length > 0 &&
          !(await askConfirm(
            `Switch to ${option}?`,
            `This replaces your ${steps.length === 1 ? 'current step' : `${steps.length} current steps`} with the ${option} steps. ${steps.length === 1 ? 'Its results are' : 'Their results are'} discarded.`,
            'Replace',
          ))
        )
          return
        current = await new Promise<ShallowArchiveInterface | null>(
          (resolve) => {
            ipcBridge.applyStarterChain(option, (response) => {
              if (!response || response.error) {
                showNotice(
                  `Couldn’t set up the steps${response?.error ? `: ${response.error}` : '.'}`,
                )
                return resolve(null)
              }
              setArchive(response)
              return resolve(response)
            })
          },
        )
        if (!current) return
      }
      // Just added: run the whole new chain (its last step, the sort).
      // Already there: run that filter.
      const existing = archive.filters.find((f) => f.type === filterType)
      const target = existing
        ? current.filters.find((f) => f.id === existing.id)
        : current.filters[current.filters.length - 1]
      if (!target) return
      // Picking the option is the go-ahead: no "parse may take a while" ask.
      for (const f of current.filters)
        if (PRODUCER_LABEL[f.type]) parserConfirmedRef.current.add(f.id)
      const hasReplays = typeof current.files === 'number' && current.files > 0
      if (!hasReplays && !isImporting) {
        // Nothing to look through yet (e.g. Start empty project, then Look for
        // combos): show the Replays step, whose empty tray offers the imports,
        // and run the steps as soon as replays are in (user, 2026-10-08).
        const replaysPool = current.filters.find((f) => f.type === 'files')
        setActiveFilterId(replaysPool?.id ?? target.id)
        pendingStartRunRef.current = target.id
        setWaitingForImport(target.id)
        showNotice(
          `Import some replays and the ${option} steps run by themselves.`,
        )
        return
      }
      setActiveFilterId(target.id)
      if (isImporting) {
        pendingStartRunRef.current = target.id
        setWaitingForImport(target.id)
      } else requestRun(target, current)
      return
    }
    // AI: the Replays pool plus one AI Filter step (other steps removed,
    // user 2026-10-03), opened so its three steps show.
    const next = await new Promise<ShallowArchiveInterface | null>(
      (resolve) => {
        ipcBridge.applyStarterChain('ai', (response) => {
          if (!response || response.error) {
            showNotice(
              `Couldn’t set up the steps${response?.error ? `: ${response.error}` : '.'}`,
            )
            return resolve(null)
          }
          setArchive(response)
          return resolve(response)
        })
      },
    )
    const step = next?.filters.find((f) => f.type === 'aiFilter')
    if (!step) return
    const { id } = step
    setActiveFilterId(id)
    setExpandedFilters((prev) => ({ ...prev, [id]: true }))
    setAiGuideFor(id)
    setAiGuideOpen(true)
  }
  // A welcome option picked during an import runs once the import is done.
  // Kept in state too, so the steps can say they're waiting for it.
  const pendingStartRunRef = useRef<string | null>(null)
  const [waitingForImport, setWaitingForImport] = useState<string | null>(null)
  useEffect(() => {
    const id = pendingStartRunRef.current
    if (!id || isImporting !== false || !archive) return
    // Still no replays (none imported yet, or an import that added none):
    // keep waiting for them.
    if (!(typeof archive.files === 'number' && archive.files > 0)) return
    pendingStartRunRef.current = null
    setWaitingForImport(null)
    const target = archive.filters.find((f) => f.id === id)
    if (target) {
      setActiveFilterId(target.id)
      requestRun(target)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isImporting, archive])
  // The AI Filter's how-it-works guide (AiFilterGuide): the card's ?, and
  // by itself right after the welcome's Use AI.
  // Open, and for which AI Filter (null: the first one in the project).
  const [aiGuideOpen, setAiGuideOpen] = useState(false)
  const [aiGuideFor, setAiGuideFor] = useState<string | null>(null)
  useEffect(() => {
    const on = (e: Event) => {
      setAiGuideFor((e as CustomEvent<string | undefined>).detail ?? null)
      setAiGuideOpen(true)
    }
    window.addEventListener(AI_GUIDE_EVENT, on)
    return () => window.removeEventListener(AI_GUIDE_EVENT, on)
  }, [])
  const startOptionRef = useRef(startOption)
  startOptionRef.current = startOption
  useEffect(() => {
    const on = (e: Event) =>
      startOptionRef.current((e as CustomEvent<StartOption>).detail)
    window.addEventListener(START_OPTION_EVENT, on)
    return () => window.removeEventListener(START_OPTION_EVENT, on)
  }, [])

  function renderFilters() {
    if (!archive) return ''
    const branchingOn = config.branchingEnabled === true

    // Indent depth per filter (its position in the input tree). A linear
    // continuation inherits its predecessor's depth so a whole branch subtree
    // stays nested together; an explicit branch sits one level under its source.
    const depthByIndex: number[] = []
    archive.filters.forEach((f, i) => {
      if (i === 0) {
        depthByIndex[i] = 0
        return
      }
      const positionalPrevId = archive.filters[i - 1].id
      const effectiveInput =
        branchingOn && f.inputId ? f.inputId : positionalPrevId
      if (effectiveInput === positionalPrevId) {
        depthByIndex[i] = depthByIndex[i - 1]
      } else if (effectiveInput === FILES_TABLE) {
        depthByIndex[i] = 0
      } else {
        const srcIdx = archive.filters.findIndex(
          (ff) => ff.id === effectiveInput,
        )
        depthByIndex[i] =
          srcIdx >= 0 ? (depthByIndex[srcIdx] ?? 0) + 1 : depthByIndex[i - 1]
      }
    })

    // The old first-run "Click Run to find your combos" nudge is gone (user,
    // 2026-10-06): the welcome's options run the steps.
    const runHintFilterId: string | null = null

    const entries = archive.filters.map((filter, index) => ({
      filter,
      index,
    }))
    const gameEntry = entries.find((entry) => entry.filter.type === 'files')
    const orderedEntries = gameEntry
      ? [gameEntry, ...entries.filter((entry) => entry !== gameEntry)]
      : entries
    return (
      <div
        className="filters-list"
        ref={filtersListRef}
        onDragOver={handleContainerDragOver}
      >
        {orderedEntries.map((entry) => {
          const { filter, index } = entry
          const isGameFilter = entry === gameEntry
          const isActive = activeFilterId === filter.id
          // Only the step actually working shows Stop; ones waiting their turn
          // in a run show as queued.
          const isRunning = runningFilters.has(filter.id)
          const isStopping = isRunning && stoppingFilters.has(filter.id)
          // Steps of a welcome option picked mid-import: up to its target.
          const waitIndex = waitingForImport
            ? archive.filters.findIndex((f) => f.id === waitingForImport)
            : -1
          const afterImport =
            !isRunning && waitIndex >= 0 && index > 0 && index <= waitIndex
          const isQueued =
            afterImport || (!isRunning && pendingRunIds.has(filter.id))
          const isCollapsed = !isExpanded(filter)
          const filterMsg = filterMsgs[filter.id] || ''
          const resultsCount =
            filter.type === 'files' && !filter.isProcessed && archive
              ? archive.files
              : filter.results
          const isDragging = dragIndex === index

          const hasParser = archive.filters
            .slice(0, index)
            .some((f) => f.type === 'slpParser')
          // The Edgeguards Parser also tags comboer/comboee onto its clips, so
          // sorts that only need that (character matchup) work off an edgeguard
          // branch too — not just a combo parser.
          const hasEdgeguardParser = archive.filters
            .slice(0, index)
            .some((f) => f.type === 'edgeguard')

          // Branching: this filter may read from Files (raw) or any filter above
          // it. Default = the filter directly above (or Files for index 0).
          // Only surfaced when branching is enabled; when off, the dropdown and
          // indent are hidden (but saved inputIds stay in the data).
          const defaultInputId =
            index === 0 ? FILES_TABLE : archive.filters[index - 1].id
          const inputOptions = branchingOn
            ? validInputsFor(archive.filters, index).map((id) => ({
                id,
                label:
                  id === FILES_TABLE
                    ? 'Files (raw)'
                    : (archive.filters.find((f) => f.id === id)?.label ?? id),
              }))
            : []
          // The whole branch subtree is indented (depth); only the card that
          // actually changes its source shows the "⑂ reads from" emphasis.
          const indentLevel = branchingOn ? (depthByIndex[index] ?? 0) : 0
          const isBranchPoint =
            branchingOn && !!filter.inputId && filter.inputId !== defaultInputId

          // Compute translateY shift for live reorder preview
          let dragTransform = ''
          if (dragIndex !== null && dropIndex !== null && !isDragging) {
            const shift = dragHeightRef.current + 10 // 10 = gap
            if (
              dropIndex > dragIndex + 1 &&
              index > dragIndex &&
              index < dropIndex
            ) {
              dragTransform = `translateY(${-shift}px)`
            } else if (
              dropIndex < dragIndex &&
              index >= dropIndex &&
              index < dragIndex
            ) {
              dragTransform = `translateY(${shift}px)`
            }
          }

          return (
            <FilterCard
              key={filter.id}
              filter={filter}
              filterIndex={index}
              isActive={isActive}
              isRunning={isRunning}
              isQueued={isQueued}
              isStopping={isStopping}
              queuedLabel={afterImport ? 'After import' : undefined}
              isCollapsed={isCollapsed}
              isGameFilter={!!isGameFilter}
              isDragging={isDragging}
              dragTransform={dragTransform}
              filterMsg={filterMsg}
              liveResults={liveResults[filter.id]}
              resultsCount={resultsCount}
              poolTotal={archive?.files ?? null}
              namesList={namesList}
              connectCodesList={connectCodesList}
              namesLoading={namesLoading}
              codesLoading={codesLoading}
              hasParser={hasParser}
              hasEdgeguardParser={hasEdgeguardParser}
              previousType={archive.filters[index - 1]?.type}
              inputOptions={inputOptions}
              defaultInputId={defaultInputId}
              indentLevel={indentLevel}
              isBranchPoint={isBranchPoint}
              onToggleCollapse={toggleFilterCollapse}
              onClick={() => setActiveFilterId(filter.id)}
              onDoubleClick={() => {
                if (!isExpanded(filter)) {
                  setExpandedFilters((prev) => ({
                    ...prev,
                    [filter.id]: true,
                  }))
                }
              }}
              showRunHint={filter.id === runHintFilterId}
              onDismissRunHint={dismissRunHint}
              parserNoteDisabled={config.hideParserNote === true}
              onDismissParserNote={dismissParserNote}
              onRun={requestRun}
              onStop={stopFilter}
              onResume={resumeFilterRun}
              onKeepResults={keepFilterResults}
              onDelete={deleteFilter}
              onUpdate={updateFilter}
              onDismissMsg={dismissFilterMsg}
              draggable={!isGameFilter}
              onMouseDown={(e) => {
                const tag = (e.target as HTMLElement).tagName
                dragAllowedRef.current =
                  tag !== 'INPUT' &&
                  tag !== 'SELECT' &&
                  tag !== 'TEXTAREA' &&
                  tag !== 'BUTTON'
              }}
              onDragStart={(e: DragEvent<HTMLDivElement>) => {
                if (isGameFilter || !dragAllowedRef.current) {
                  e.preventDefault()
                  return
                }
                dragIndexRef.current = index
                dragHeightRef.current =
                  e.currentTarget.getBoundingClientRect().height
                measureCardPositions()
                setDragIndex(index)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={() => {
                const dIdx = dragIndexRef.current
                const drIdx = dropIndexRef.current
                dragIndexRef.current = null
                dropIndexRef.current = null
                if (dragWarningTimer.current) {
                  clearTimeout(dragWarningTimer.current)
                  dragWarningTimer.current = null
                }
                setDragWarning(null)
                if (dIdx !== null && drIdx !== null && dIdx !== drIdx) {
                  const to = drIdx > dIdx ? drIdx - 1 : drIdx
                  // handleDrop clears drag state after IPC response
                  handleDrop(dIdx, to)
                } else {
                  // No valid drop -- clear state immediately
                  setDragIndex(null)
                  setDropIndex(null)
                }
              }}
            />
          )
        })}
      </div>
    )
  }

  const busy = runningFilters.size > 0 || pendingRunIds.size > 0

  return (
    <div
      className={`filters${filtersStyle === 'compact' ? ' filters--compact' : ''}`}
    >
      {aiGuideOpen && (
        <AiFilterGuide
          previousType={(() => {
            const fs = archive?.filters ?? []
            const at = fs.findIndex((f) =>
              aiGuideFor ? f.id === aiGuideFor : f.type === 'aiFilter',
            )
            return at > 0 ? fs[at - 1].type : undefined
          })()}
          onClose={() => setAiGuideOpen(false)}
        />
      )}
      <div className="filters-header">
        <div className="filters-title">Filters</div>
        {archive && (
          <div className="filters-file-count">
            {archive.files == null ? (
              <span className="filter-results-spinner" title="Counting…" />
            ) : (
              archive.files.toLocaleString()
            )}{' '}
            {filtersStyle === 'compact'
              ? archive.files === 1
                ? 'replay'
                : 'replays'
              : 'SLP files'}
          </div>
        )}
        {filtersStyle === 'compact' &&
          archive &&
          archive.filters.length > 1 && (
            // Running the last step runs every step above it that needs it
            // (runFilter), so this is "run the whole chain".
            <button
              type="button"
              className={`filters-run-all${busy ? ' filters-run-all--stop' : ''}`}
              disabled={!busy && !!waitingForImport}
              title={
                busy
                  ? 'Stop the step that is running and the ones queued after it'
                  : 'Run every step that needs it, top to bottom'
              }
              onClick={() => {
                if (!busy) {
                  requestRun(archive.filters[archive.filters.length - 1])
                  return
                }
                stopRequestedRef.current = true
                for (const id of runningFilters) stopFilter(id)
              }}
            >
              {busy
                ? '■ Stop'
                : waitingForImport
                  ? 'Starts after import…'
                  : '▶ Run all'}
            </button>
          )}
      </div>
      {archive ? (
        renderFilters()
      ) : (
        <div className="no-archive">Import replays to start.</div>
      )}
      <div className="filters-footer">
        <div className="add-filter-dropdown-wrap" ref={dropdownRef}>
          <button
            type="button"
            className="add-filter-dropdown"
            onClick={() => setDropdownOpen((prev) => !prev)}
          >
            {filtersStyle === 'compact' ? '+ Add filter' : '+ Add Filter'}
          </button>
          {dropdownOpen && (
            <div className="add-filter-menu">
              {(() => {
                // The dropdown is the everyday chain only; its contents and
                // order come straight from FILTER_LAYOUT.main (single source of
                // truth). Everything else lives in the "Browse more" modal.
                const ordered = FILTER_LAYOUT.main
                  .map((id) => filtersConfig.find((p) => p.id === id))
                  .filter((p): p is (typeof filtersConfig)[number] =>
                    Boolean(p),
                  )
                return ordered.flatMap((p) => {
                  // Grey out a filter that needs an upstream producer until one
                  // exists (combo filter → combo parser, edgeguard filter →
                  // Edgeguards Parser).
                  const parent = REQUIRED_PRODUCER[p.id]
                  const needsParser =
                    !!parent && !archive?.filters.some((f) => f.type === parent)
                  const items = [
                    <div
                      key={p.id}
                      className={`add-filter-item${needsParser ? ' add-filter-item-disabled' : ''}`}
                      title={(p as any).tooltip || ''}
                      role="menuitem"
                      tabIndex={0}
                      onClick={() => {
                        if (needsParser) return
                        addFilter({ target: { value: p.id } })
                        setDropdownOpen(false)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          if (needsParser) return
                          addFilter({ target: { value: p.id } })
                          setDropdownOpen(false)
                        }
                      }}
                    >
                      {p.label}
                      {needsParser && (
                        <span className="add-filter-hint">
                          {' '}
                          - requires {PRODUCER_LABEL[parent] || parent} first
                        </span>
                      )}
                    </div>,
                  ]
                  return items
                })
              })()}
              <div
                className="add-filter-item add-filter-item-browse"
                role="menuitem"
                tabIndex={0}
                onClick={() => {
                  setDropdownOpen(false)
                  setCatalogOpen(true)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setDropdownOpen(false)
                    setCatalogOpen(true)
                  }
                }}
              >
                Browse more...
              </div>
            </div>
          )}
        </div>
      </div>
      {archive && (
        <TrayNote
          filters={archive.filters}
          activeFilterId={activeFilterId}
          replayCount={archive.files}
          live={{ running: runningFilters, counts: liveResults }}
        />
      )}
      {dragWarning && <div className="drag-warning-toast">{dragWarning}</div>}
      {resetConfirm && (
        <ConfirmResetModal
          filterLabel={resetConfirm.filter.label}
          durationMs={resetConfirm.filter.lastRunMs ?? 0}
          severity={resetConfirm.tier.severity}
          thresholdLabel={resetConfirm.tier.label}
          onCancel={() => setResetConfirm(null)}
          onConfirm={(dontAskAgain) => {
            const { filter, tier, prereqs } = resetConfirm
            if (dontAskAgain) {
              setSuppressedTiers((prev) => new Set(prev).add(tier.key))
              ipcBridge.updateConfig({ key: tier.key, value: false })
            }
            setResetConfirm(null)
            runSequence([...prereqs, filter])
          }}
        />
      )}
      {editConfirm && (
        <ConfirmResetModal
          mode="edit"
          filterLabel={editConfirm.filter.label}
          durationMs={editConfirm.filter.lastRunMs ?? 0}
          severity={editConfirm.tier.severity}
          thresholdLabel={editConfirm.tier.label}
          onCancel={() => {
            // Revert the optimistic param change — the edit was declined.
            const pending = pendingEditRef.current
            pendingEditRef.current = null
            setEditConfirm(null)
            if (pending) {
              setArchive((prev) => {
                if (!prev) return prev
                const idx = prev.filters.findIndex(
                  (f) => f.id === pending.previousFilter.id,
                )
                if (idx < 0) return prev
                const filters = [...prev.filters]
                filters[idx] = pending.previousFilter
                return { ...prev, filters }
              })
            }
          }}
          onConfirm={(dontAskAgain) => {
            const { filter, tier } = editConfirm
            if (dontAskAgain) {
              setSuppressedTiers((prev) => new Set(prev).add(tier.key))
              ipcBridge.updateConfig({ key: tier.key, value: false })
            }
            editConfirmedRef.current.add(filter.id)
            const pending = pendingEditRef.current
            pendingEditRef.current = null
            setEditConfirm(null)
            pending?.save()
          }}
        />
      )}
      {parserConfirm && (
        <ParserRunModal
          targetLabel={parserConfirm.target.label}
          parserLabel={parserConfirm.parserLabel}
          count={parserConfirm.count}
          onCancel={() => setParserConfirm(null)}
          onConfirm={() => {
            const { target, prereqs } = parserConfirm
            // Remember the OK'd parsers so we don't re-prompt for them.
            prereqs.forEach((p) => {
              if (PRODUCER_LABEL[p.type]) parserConfirmedRef.current.add(p.id)
            })
            setParserConfirm(null)
            continueRun(target, prereqs)
          }}
        />
      )}
      {confirmAsk && (
        <ConfirmModal
          title={confirmAsk.title}
          body={confirmAsk.body}
          confirmLabel={confirmAsk.confirmLabel}
          onConfirm={() => {
            confirmAsk.resolve(true)
            setConfirmAsk(null)
          }}
          onCancel={() => {
            confirmAsk.resolve(false)
            setConfirmAsk(null)
          }}
        />
      )}
      {customConsent && (
        <CustomCodeConsentModal
          filterLabels={customConsent.labels}
          onCancel={() => setCustomConsent(null)}
          onRunOnce={() => {
            const { onApprove, hashes } = customConsent
            // Main enforces the same gate: tell it this once, for this session.
            window.electron.ipcRenderer.sendMessage(
              'approveCustomCodeOnce',
              hashes,
            )
            setCustomConsent(null)
            onApprove()
          }}
          onAlwaysTrust={() => {
            const { onApprove, hashes } = customConsent
            approveCustomHashes(hashes)
            setCustomConsent(null)
            onApprove()
          }}
        />
      )}
      {parserWarning && (
        <ParserWarningModal
          producer={parserWarning.producer}
          dependents={parserWarning.dependents}
          onDismiss={() => setParserWarning(null)}
        />
      )}
      {catalogOpen && (
        <TemplateCatalog
          templates={[
            ...nativeCatalogFilters,
            ...(config.savedCustomFilters || []),
          ]}
          presentTypes={archive?.filters.map((f) => f.type) ?? []}
          onClose={() => setCatalogOpen(false)}
          onSelect={(tmpl: SavedCustomFilter) => {
            setCatalogOpen(false)
            // Native filters add their real filter type directly.
            if (tmpl.nativeType) {
              addFilter({ target: { value: tmpl.nativeType } })
              return
            }
            // Find the index of this template in savedCustomFilters
            const allTemplates = config.savedCustomFilters || []
            const idx = allTemplates.findIndex(
              (t) => t.name === tmpl.name && t.code === tmpl.code,
            )
            if (idx >= 0) {
              addFilter({ target: { value: `customTemplate:${idx}` } })
            } else {
              // User template or unknown -- add as plain custom with code
              addFilter({ target: { value: `customTemplate:${idx}` } })
            }
          }}
        />
      )}
      {filterError && (
        <FilterErrorModal
          filterError={filterError}
          onDismiss={() => setFilterError(null)}
        />
      )}
      {filterLogs && (
        <FilterLogsModal
          filterLogs={filterLogs}
          onDismiss={() => setFilterLogs(null)}
        />
      )}
    </div>
  )
}
