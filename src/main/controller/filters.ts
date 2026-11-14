import { IpcMainEvent } from 'electron'
import type { ControllerCore } from './context'
import { getDescendantIds } from '../../lib/filterGraph'
import { filtersConfig } from '../../constants/config'
import {
  FilterInterface,
  ShallowFilterInterface,
  SavedCustomFilter,
} from '../../constants/types'
import Filter from '../../models/Filter'
import { deleteFilterRunAsync } from '../dbAsync'
import { RequestEnvelope, unpackRequest, reply } from '../ipcUtils'

export type Ctx = Pick<
  ControllerCore,
  | 'archive'
  | 'config'
  | 'createNewArchiveInternal'
  | 'filterExecutor'
  | 'saveConfig'
>

export async function addFilter(
  ctx: Ctx,
  event: IpcMainEvent,
  data: RequestEnvelope<string>,
) {
  const { requestId, payload } = unpackRequest<string>(data)
  if (!ctx.archive) {
    try {
      await ctx.createNewArchiveInternal({
        name: ctx.config.projectName || undefined,
      })
    } catch (error) {
      console.error('Error creating default DB:', error)
    }
  }
  if (!ctx.archive || !ctx.archive.shallowCopy || !ctx.archive.addFilter)
    return reply(event, 'addFilter', requestId, {
      error: 'archive undefined',
    })
  if (payload === 'default') {
    return reply(event, 'addFilter', requestId, {
      error: 'invalid filter type',
    })
  }

  // Handle saved custom templates: "customTemplate:INDEX"
  const isCustomTemplate = payload?.startsWith('customTemplate:')
  const filterType = isCustomTemplate ? 'custom' : payload
  const template = filtersConfig.find((p) => p.id === filterType)
  if (!template) {
    return reply(event, 'addFilter', requestId, {
      error: `Unknown filter type ${payload}. Restart Clipper if it was just added.`,
    })
  }

  const existingIds = new Set(ctx.archive.filters.map((f) => f.id))
  let newFilterId: string
  do {
    const randomNum = Math.floor(1000 + Math.random() * 90000)
    newFilterId = `filter_${randomNum}`
  } while (existingIds.has(newFilterId))

  const newFilterJSON: FilterInterface = {
    id: newFilterId,
    results: 0,
    type: template.id,
    isProcessed: false,
    label: template.label,
    params: {},
  }
  template.options.forEach((option) => {
    newFilterJSON.params[option.id] = option.default
  })
  if (template.id === 'sort') {
    const hasParser = ctx.archive.filters.some((f) => f.type === 'slpParser')
    if (!hasParser) {
      newFilterJSON.params.sortFunction = 'chronological'
    }
  }

  // Pre-fill from saved custom template
  if (isCustomTemplate) {
    const templateIndex = parseInt(payload!.split(':')[1], 10)
    const saved = ctx.config.savedCustomFilters?.[templateIndex]
    if (saved) {
      newFilterJSON.label = saved.name
      newFilterJSON.params.code = saved.code
      if (saved.customParams) {
        newFilterJSON.params.customParams = JSON.parse(
          JSON.stringify(saved.customParams),
        )
      }
      if (saved.outputFields) {
        newFilterJSON.params.outputFields = JSON.parse(
          JSON.stringify(saved.outputFields),
        )
      }
    }
  }

  try {
    await ctx.archive.addFilter(newFilterJSON)
    const metadata = await ctx.archive.shallowCopy()
    return reply(event, 'addFilter', requestId, metadata)
  } catch (error) {
    console.error('[addFilter] error:', error)
    return reply(event, 'addFilter', requestId, {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

// Build a fresh filter JSON of `type` with its config-default params (plus any
// overrides), assigning a unique id. Mirrors the defaulting in addFilter.
export function buildFilterJSON(
  type: string,
  existingIds: Set<string>,
  paramOverrides?: Record<string, any>,
): FilterInterface {
  const template = filtersConfig.find((p) => p.id === type)
  if (!template) throw new Error(`Invalid Filter Type ${type}`)
  let newFilterId: string
  do {
    const randomNum = Math.floor(1000 + Math.random() * 90000)
    newFilterId = `filter_${randomNum}`
  } while (existingIds.has(newFilterId))
  existingIds.add(newFilterId)
  const json: FilterInterface = {
    id: newFilterId,
    results: 0,
    type: template.id,
    isProcessed: false,
    label: template.label,
    params: {},
  }
  template.options.forEach((option) => {
    json.params[option.id] = option.default
  })
  if (paramOverrides) Object.assign(json.params, paramOverrides)
  return json
}

// Starter chain (kept for the planned Combos · Edgeguards · Custom switcher;
// the ProjectIdeas modal that used it is gone). Replaces the downstream chain
// with a purpose-built one for the chosen goal, keeping the base Game Filter.
export async function applyStarterChain(
  ctx: Ctx,
  event: IpcMainEvent,
  data: RequestEnvelope<string>,
) {
  const { requestId, payload } = unpackRequest<string>(data)
  if (!ctx.archive) {
    try {
      await ctx.createNewArchiveInternal({
        name: ctx.config.projectName || undefined,
      })
    } catch (error) {
      console.error('Error creating default DB:', error)
    }
  }
  if (
    !ctx.archive ||
    !ctx.archive.shallowCopy ||
    !ctx.archive.replaceDownstreamFilters
  )
    return reply(event, 'applyStarterChain', requestId, {
      error: 'archive undefined',
    })

  const CHAINS: Record<
    string,
    Array<{ type: string; params?: Record<string, any> }>
  > = {
    combos: [
      { type: 'slpParser' },
      { type: 'comboFilter' },
      { type: 'sort', params: { sortFunction: 'dps' } },
    ],
    edgeguards: [
      { type: 'edgeguard' },
      { type: 'edgeguardFilter' },
      { type: 'sort', params: { sortFunction: 'edgeguardScore' } },
    ],
    custom: [{ type: 'custom' }],
    ai: [{ type: 'aiFilter' }],
    // Full games: just the Replays pool.
    games: [],
  }
  const spec = payload ? CHAINS[payload] : undefined
  if (!spec)
    return reply(event, 'applyStarterChain', requestId, {
      error: `unknown starter chain: ${payload}`,
    })

  await ctx.filterExecutor.stopAndWait()
  if (!ctx.archive || !ctx.archive.replaceDownstreamFilters)
    return reply(event, 'applyStarterChain', requestId, {
      error: 'archive undefined',
    })
  const existingIds = new Set(ctx.archive.filters.map((f) => f.id))
  try {
    const downstream = spec.map((s) =>
      buildFilterJSON(s.type, existingIds, s.params),
    )
    await ctx.archive.replaceDownstreamFilters(downstream)
    const metadata = await ctx.archive.shallowCopy()
    return reply(event, 'applyStarterChain', requestId, metadata)
  } catch (error) {
    console.error('[applyStarterChain] error:', error)
    return reply(event, 'applyStarterChain', requestId, {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function removeFilter(
  ctx: Ctx,
  event: IpcMainEvent,
  data: RequestEnvelope<string>,
) {
  const { requestId, payload } = unpackRequest<string>(data)
  if (!ctx.archive || !ctx.archive.shallowCopy || !ctx.archive.deleteFilter) {
    return reply(event, 'removeFilter', requestId, {
      error: 'archive undefined',
    })
  }

  const target = ctx.archive.filters.find((filter) => filter.id === payload)
  if (target?.type === 'files') {
    return reply(event, 'removeFilter', requestId, {
      error: 'cannot remove game filter',
    })
  }

  try {
    if (payload) {
      // Removing a filter drops its table and changes what later filters
      // read from: stop those runs first and wait for them to finish.
      await ctx.filterExecutor.stopAndWait([
        payload,
        ...getDescendantIds(
          ctx.archive.filters,
          payload,
          ctx.config.branchingEnabled === true,
        ),
      ])
      if (!ctx.archive || !ctx.archive.deleteFilter) {
        return reply(event, 'removeFilter', requestId, {
          error: 'archive undefined',
        })
      }
      const _t0 = Date.now()
      await deleteFilterRunAsync(ctx.archive.path, payload)
      console.log(`[removeFilter] deleteFilterRun took ${Date.now() - _t0}ms`)
      const _t1 = Date.now()
      await ctx.archive.deleteFilter(payload)
      console.log(`[removeFilter] deleteFilter took ${Date.now() - _t1}ms`)
    }
    const _t2 = Date.now()
    const metadata = await ctx.archive.shallowCopy!()
    console.log(`[removeFilter] shallowCopy took ${Date.now() - _t2}ms`)
    ctx.filterExecutor.broadcastRunningFilters()
    return reply(event, 'removeFilter', requestId, metadata)
  } catch (error) {
    console.error('[removeFilter] error:', error)
    return reply(event, 'removeFilter', requestId, {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

// removeGame, removeResult, reorderClips → ClipManager

export async function saveCustomFilter(
  ctx: Ctx,
  event: IpcMainEvent,
  data: RequestEnvelope<{
    name: string
    code: string
    customParams?: { name: string; type: string; value: string }[]
    outputFields?: { name: string; type: string }[]
  }>,
) {
  const { requestId, payload } = unpackRequest<{
    name: string
    code: string
    customParams?: { name: string; type: string; value: string }[]
    outputFields?: { name: string; type: string }[]
  }>(data)
  if (!payload?.name || !payload?.code) {
    return reply(event, 'saveCustomFilter', requestId, {
      error: 'missing name or code',
    })
  }
  if (!ctx.config.savedCustomFilters) {
    ctx.config.savedCustomFilters = []
  }
  // Update existing template with same name, or add new
  const existing = ctx.config.savedCustomFilters.findIndex(
    (t) => t.name === payload.name,
  )
  // IPC-payload boundary: assert the renderer-sent param `type` strings back
  // to the SavedCustomFilter union.
  const entry = {
    name: payload.name,
    code: payload.code,
    customParams: payload.customParams,
    outputFields: payload.outputFields,
  } as SavedCustomFilter
  if (existing >= 0) {
    ctx.config.savedCustomFilters[existing] = entry
  } else {
    ctx.config.savedCustomFilters.push(entry)
  }
  ctx.saveConfig()
  return reply(event, 'saveCustomFilter', requestId, {
    savedCustomFilters: ctx.config.savedCustomFilters,
  })
}

export async function deleteCustomFilter(
  ctx: Ctx,
  event: IpcMainEvent,
  data: RequestEnvelope<number>,
) {
  const { requestId, payload } = unpackRequest<number>(data)
  if (
    !ctx.config.savedCustomFilters ||
    typeof payload !== 'number' ||
    payload < 0 ||
    payload >= ctx.config.savedCustomFilters.length
  ) {
    return reply(event, 'deleteCustomFilter', requestId, {
      error: 'invalid index',
    })
  }
  ctx.config.savedCustomFilters.splice(payload, 1)
  ctx.saveConfig()
  return reply(event, 'deleteCustomFilter', requestId, {
    savedCustomFilters: ctx.config.savedCustomFilters,
  })
}

export async function reorderFilter(
  ctx: Ctx,
  event: IpcMainEvent,
  data: RequestEnvelope<{ fromIndex: number; toIndex: number }>,
) {
  const { requestId, payload } = unpackRequest<{
    fromIndex: number
    toIndex: number
  }>(data)
  if (!payload) {
    return reply(event, 'reorderFilter', requestId, {
      error: 'missing payload',
    })
  }
  if (!ctx.archive || !ctx.archive.shallowCopy) {
    return reply(event, 'reorderFilter', requestId, {
      error: 'archive undefined',
    })
  }

  // Moving filters changes what they read from; stop running filters and
  // wait for them (rare, and far safer than rewiring a live run).
  await ctx.filterExecutor.stopAndWait()
  if (!ctx.archive || !ctx.archive.shallowCopy) {
    return reply(event, 'reorderFilter', requestId, {
      error: 'archive undefined',
    })
  }
  const { fromIndex, toIndex } = payload
  const filters = ctx.archive.filters

  // Validate indices
  if (
    fromIndex < 1 ||
    toIndex < 1 ||
    fromIndex >= filters.length ||
    toIndex >= filters.length ||
    fromIndex === toIndex
  ) {
    return reply(event, 'reorderFilter', requestId, {
      error: 'invalid indices',
    })
  }

  // Splice: remove from old position, insert at new position
  const [moved] = filters.splice(fromIndex, 1)
  filters.splice(toIndex, 0, moved)

  // A filter may only read from `files` or a filter ABOVE it. If a move turned
  // an explicit inputId into a forward (or self) reference, drop it so the
  // filter reverts to reading from the card directly above it.
  for (let i = 0; i < filters.length; i += 1) {
    const inputId = filters[i].inputId
    if (!inputId || inputId === 'files') continue
    const sourceIdx = filters.findIndex((f) => f.id === inputId)
    if (sourceIdx === -1 || sourceIdx >= i) {
      delete filters[i].inputId
    }
  }

  // Mark all filters from the earliest affected index onward as unprocessed
  const start = Math.min(fromIndex, toIndex)
  for (let i = start; i < filters.length; i += 1) {
    filters[i].isProcessed = false
    filters[i].results = 0
  }

  // Reset parser-dependent params for filters that no longer have a parser above them
  const hasParserAbove = (idx: number) =>
    filters.slice(0, idx).some((f) => f.type === 'slpParser')

  for (let i = 0; i < filters.length; i += 1) {
    if (hasParserAbove(i)) continue
    const fc = filtersConfig.find((c) => c.id === filters[i].type)
    if (!fc?.options) continue
    for (const opt of fc.options as any[]) {
      if (opt.requiresParser && filters[i].params?.[opt.id] !== undefined) {
        filters[i].params[opt.id] = opt.default ?? ''
      }
      if (
        opt.type === 'dropdown' &&
        opt.options &&
        filters[i].params?.[opt.id]
      ) {
        const selected = opt.options.find(
          (e: any) => e.id === filters[i].params[opt.id],
        )
        if (selected?.requiresParser) {
          filters[i].params[opt.id] = opt.default ?? ''
        }
      }
    }
  }

  try {
    if (ctx.archive.saveMetaData) await ctx.archive.saveMetaData()
    return reply(
      event,
      'reorderFilter',
      requestId,
      await ctx.archive.shallowCopy(),
    )
  } catch (error) {
    console.error('[reorderFilter] error:', error)
    return reply(event, 'reorderFilter', requestId, {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function updateFilter(
  ctx: Ctx,
  event: IpcMainEvent,
  data: RequestEnvelope<{
    filterIndex: number
    newFilter: ShallowFilterInterface
  }>,
) {
  const { requestId, payload } = unpackRequest<{
    filterIndex: number
    newFilter: ShallowFilterInterface
  }>(data)
  if (!payload) {
    return reply(event, 'updateFilter', requestId, {
      error: 'missing payload',
    })
  }
  const { newFilter, filterIndex } = payload
  if (!ctx.archive || !ctx.archive.shallowCopy)
    return reply(event, 'updateFilter', requestId, {
      error: 'archive undefined',
    })
  try {
    // An edit invalidates this filter and everything reading from it. Stop
    // any of those that are running and wait for them to finish first, or a
    // run could finish afterwards and mark stale results done (or its
    // cleanup could overwrite this edit).
    const branching = ctx.config.branchingEnabled === true
    const affected = new Set([
      newFilter.id,
      ...getDescendantIds(ctx.archive.filters, newFilter.id, branching),
    ])
    await ctx.filterExecutor.stopAndWait(affected)
    if (!ctx.archive || !ctx.archive.shallowCopy)
      return reply(event, 'updateFilter', requestId, {
        error: 'archive undefined',
      })
    ctx.archive.filters[filterIndex] = new Filter({
      ...newFilter,
      isProcessed: false,
      results: 0,
    })
    // Invalidate only filters that read from this one (transitively). In a
    // linear chain that's everything below; with branches it leaves unrelated
    // branches alone.
    const editedId = ctx.archive.filters[filterIndex].id
    const descendants = getDescendantIds(
      ctx.archive.filters,
      editedId,
      ctx.config.branchingEnabled === true,
    )
    ctx.archive.filters.forEach((filter) => {
      if (descendants.has(filter.id)) {
        filter.isProcessed = false
        filter.results = 0
      }
    })
    if (ctx.archive.saveMetaData) await ctx.archive.saveMetaData()
    return reply(
      event,
      'updateFilter',
      requestId,
      await ctx.archive.shallowCopy(),
    )
  } catch (error) {
    console.error('[updateFilter] error:', error)
    return reply(event, 'updateFilter', requestId, {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
