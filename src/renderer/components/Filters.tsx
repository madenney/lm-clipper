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
import {
  filtersConfig,
  REQUIRED_PRODUCER,
  PRODUCER_LABEL,
} from 'constants/config'
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
import {
  FilterErrorModal,
  FilterLogsModal,
  ParserWarningModal,
  ConfirmResetModal,
  ParserRunModal,
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
    // counts as needing a run once those partial results are dismissed.
    if (inputFilter.isProcessed || inputFilter.resumable) break
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

// Native (frame-data) filters that can't be expressed as JS templates but are
// surfaced in the Browse Templates modal. `nativeType` tells addFilter to add
// the native filter type instead of a custom JS template.
const nativeCatalogFilters: SavedCustomFilter[] = [
  {
    name: 'Stage Center Distance',
    code: '',
    nativeType: 'stageCenter',
    builtIn: true,
    category: 'Advanced',
    requiresParser: true,
    description:
      "Keep combos that started within X pixels of the stage's center vertical line.",
  },
  {
    name: 'Edgeguards (experimental)',
    code: '',
    nativeType: 'edgeguard',
    builtIn: true,
    category: 'Advanced',
    description:
      'Parse replays for edgeguard sequences. Experimental — loads full frame data.',
  },
  {
    name: 'Edgeguards Parser',
    code: '',
    nativeType: 'edgeguard2',
    builtIn: true,
    category: 'Advanced',
    description:
      'Smarter edgeguards: clips the full offstage sequence, scores it by hits/duration/depth, and catches no-contact ledge-steals. Tags each clip with metrics the Edgeguards Filter can refine.',
  },
]

type FiltersProps = {
  archive: ShallowArchiveInterface | null
  setArchive: Dispatch<SetStateAction<ShallowArchiveInterface | null>>
  activeFilterId: string
  setActiveFilterId: Dispatch<SetStateAction<string>>
  config: ConfigInterface
  setConfig: Dispatch<SetStateAction<ConfigInterface | null>>
}

export default function Filters({
  archive,
  setArchive,
  activeFilterId,
  setActiveFilterId,
  config,
  setConfig,
}: FiltersProps) {
  const dismissParserNote = () => {
    setConfig((prev) => (prev ? { ...prev, hideParserNote: true } : prev))
    ipcBridge.updateConfig({ key: 'hideParserNote', value: true })
  }
  const dismissRunHint = () => {
    setConfig((prev) => (prev ? { ...prev, hideRunHint: true } : prev))
    ipcBridge.updateConfig({ key: 'hideRunHint', value: true })
  }
  const [runningFilters, setRunningFilters] = useState<Set<number>>(new Set())
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
  const cardMidYs = useRef<{ index: number; midY: number }[]>([])
  const dropdownRef = useRef<HTMLDivElement>(null)
  const dragAllowedRef = useRef(true)

  useEffect(() => {
    return () => {
      if (dragWarningTimer.current) clearTimeout(dragWarningTimer.current)
    }
  }, [])

  useIpcListener('currentlyRunningFilter', (event: { running: number[] }) => {
    const next = new Set(event.running)
    setRunningFilters((prev) => {
      const stopped: number[] = []
      prev.forEach((idx) => {
        if (!next.has(idx)) stopped.push(idx)
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
  })

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
      setNamesList(names || [])
      setNamesLoading(false)
    })
    ipcBridge.getConnectCodes((codes) => {
      setConnectCodesList(codes || [])
      setCodesLoading(false)
    })
    // Re-fetch when the file count changes too (not just on project switch) so
    // names/codes populate after an import into a freshly-created project —
    // otherwise they'd stay stuck at the empty-project result.
  }, [archive?.path, archive?.files])

  function stopFilter(filterId: string, filterIndex: number) {
    setRunningFilters((prev) => {
      const next = new Set(prev)
      next.delete(filterIndex)
      return next
    })
    ipcBridge.stopFilter(filterId)
  }

  // Running a filter means "produce its results": run any UNPROCESSED upstream
  // filters first (cheap ones silently; an expensive parser asks first), then
  // run the filter itself. Clean (already-run) upstream is reused untouched.
  function runFilter(filter: ShallowFilterInterface) {
    if (!archive) return
    const branchingOn = config.branchingEnabled === true
    const targetIndex = archive.filters.findIndex((f) => f.id === filter.id)
    const prereqs =
      targetIndex >= 0
        ? getUnprocessedPrereqs(archive.filters, targetIndex, branchingOn)
        : []
    // Confirm before auto-running an EXPENSIVE parser prerequisite only: a big
    // parse, or re-running a parser that previously took a while. A small first
    // run just goes (nothing to lose).
    const bigInput =
      typeof archive.files === 'number' && archive.files >= PARSER_CONFIRM_COUNT
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
        count: archive.files ?? null,
      })
      return
    }
    continueRun(filter, prereqs)
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

  async function runSequence(filters: ShallowFilterInterface[]) {
    for (const f of filters) {
      // Sequential by design: each filter feeds the next.
      // eslint-disable-next-line no-await-in-loop
      const res = await doRunFilter(f)
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
        const fIdx = response?.filters?.findIndex(
          (f: ShallowFilterInterface) => f.id === filter.id,
        )
        if (fIdx != null && fIdx >= 0) {
          setRunningFilters((prev) => {
            const next = new Set(prev)
            next.delete(fIdx)
            return next
          })
        }
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

  function resumeFilterRun(filter: ShallowFilterInterface) {
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
      const fIdx = response?.filters?.findIndex(
        (f: ShallowFilterInterface) => f.id === filter.id,
      )
      if (fIdx != null && fIdx >= 0) {
        setRunningFilters((prev) => {
          const next = new Set(prev)
          next.delete(fIdx)
          return next
        })
      }
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

  function dismissResume(filter: ShallowFilterInterface) {
    console.log('[dismissResume] sending for filter:', filter.id)
    ipcBridge.dismissFilterResume(filter.id, (response) => {
      console.log('[dismissResume] response:', response)
      if (!response || response?.error) {
        console.error('dismissFilterResume error:', response?.error)
        return
      }
      const stillResumable = response?.filters?.filter((f: any) => f.resumable)
      console.log(
        '[dismissResume] still resumable:',
        stillResumable?.map((f: any) => ({
          id: f.id,
          label: f.label,
          resumable: f.resumable,
        })),
      )
      setArchive(response)
    })
  }

  function toggleFilterCollapse(
    event: MouseEvent<HTMLButtonElement>,
    filterId: string,
  ) {
    event.stopPropagation()
    setExpandedFilters((prev) => ({
      ...prev,
      [filterId]: !prev[filterId],
    }))
  }

  function addFilter(e: any) {
    if (!setArchive) return
    const nextType = e.target.value
    ipcBridge.addFilter(nextType, (response) => {
      if (!response || response?.error) {
        console.error('addFilter response error:', response.error)
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
    const save = () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        ipcBridge.updateFilter({ filterIndex, newFilter }, (response) => {
          if (!response || response?.error) {
            console.error('updateFilter response error:', response?.error)
            return
          }
          setArchive(response)
        })
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

  function deleteFilter(filter: FilterInterface) {
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
          // eslint-disable-next-line no-alert
          !window.confirm(
            `This combo parser was run on ${inputCount.toLocaleString()} files. Are you sure you want to delete it?`,
          )
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

    // One-time first-run nudge: the very first time a user has imported files
    // but never run anything, point at the Combo Filter's Run button. Gated on
    // a persistent flag so it only ever appears once, then never again.
    const hasFiles = typeof archive.files === 'number' && archive.files > 0
    const nothingRun = archive.filters
      .filter((f) => f.type !== 'files')
      .every((f) => !f.isProcessed && !f.resumable)
    const comboFilter = archive.filters.find((f) => f.type === 'comboFilter')
    const runHintFilterId =
      config.hideRunHint !== true &&
      hasFiles &&
      nothingRun &&
      comboFilter &&
      !comboFilter.isProcessed
        ? comboFilter.id
        : null

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
          const isRunning = runningFilters.has(index)
          const isCollapsed = !expandedFilters[filter.id]
          const filterMsg = filterMsgs[filter.id] || ''
          const resultsCount =
            filter.type === 'files' && !filter.isProcessed && archive
              ? archive.files
              : filter.results
          const isDragging = dragIndex === index

          const hasParser = archive.filters
            .slice(0, index)
            .some((f) => f.type === 'slpParser')

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
              isCollapsed={isCollapsed}
              isGameFilter={!!isGameFilter}
              isDragging={isDragging}
              dragTransform={dragTransform}
              filterMsg={filterMsg}
              liveResults={liveResults[filter.id]}
              resultsCount={resultsCount}
              namesList={namesList}
              connectCodesList={connectCodesList}
              namesLoading={namesLoading}
              codesLoading={codesLoading}
              hasParser={hasParser}
              inputOptions={inputOptions}
              defaultInputId={defaultInputId}
              indentLevel={indentLevel}
              isBranchPoint={isBranchPoint}
              onToggleCollapse={toggleFilterCollapse}
              onClick={() => setActiveFilterId(filter.id)}
              onDoubleClick={() => {
                if (!expandedFilters[filter.id]) {
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
              onRun={runFilter}
              onStop={stopFilter}
              onResume={resumeFilterRun}
              onDismissResume={dismissResume}
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

  return (
    <div className="filters">
      <div className="filters-header">
        <div className="filters-title">Filters</div>
        {archive && (
          <div className="filters-file-count">
            {archive.files == null ? (
              <span className="filter-results-spinner" title="Counting…" />
            ) : (
              archive.files.toLocaleString()
            )}{' '}
            SLP files
          </div>
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
            + Add Filter
          </button>
          {dropdownOpen && (
            <div className="add-filter-menu">
              {(() => {
                // These native filters are surfaced in the Browse Templates
                // modal instead of the main dropdown.
                const hiddenFilters = new Set([
                  'zeroToDeaths',
                  'edgeguard',
                  'stageCenter',
                ])
                const visible = filtersConfig.filter(
                  (p) => p.id !== 'files' && !hiddenFilters.has(p.id),
                )
                // Lift the Edgeguards Parser + Filter so they sit directly
                // beneath the Combo Parser + Combo Filter on the list.
                const edgeIds = ['edgeguard2', 'edgeguardFilter']
                const edge = visible.filter((p) => edgeIds.includes(p.id))
                const rest = visible.filter((p) => !edgeIds.includes(p.id))
                const comboIdx = rest.findIndex((p) => p.id === 'comboFilter')
                const ordered =
                  comboIdx >= 0
                    ? [
                        ...rest.slice(0, comboIdx + 1),
                        ...edge,
                        ...rest.slice(comboIdx + 1),
                      ]
                    : [...rest, ...edge]
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
                  if (p.id === 'sort') {
                    items.push(
                      <div key="divider" className="add-filter-divider" />,
                    )
                  }
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
                Browse Templates...
              </div>
            </div>
          )}
        </div>
      </div>
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
          hasParser={
            archive?.filters.some((f) => f.type === 'slpParser') ?? false
          }
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
