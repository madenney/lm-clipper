/**
 * How each filter type runs: the one place to declare it (structure review
 * step 2, docs/structure-review.md E13). Filter.ts and Worker.ts read these
 * instead of keeping their own lists, which had drifted apart (`highlight` and
 * `afkDetection` once missed the bigger heap). A test checks every filter type
 * in constants/config.ts and every method in methods/index.ts has an entry.
 */
export type FilterTraits = {
  /**
   * How Worker.ts runs it:
   * - parser:   per game, returns { combos, lastFrame } (streamed, resumable)
   * - chunks:   the method gets chunks of input rows
   * - sort / sample / range: handled in SQL / by Worker.ts itself
   * - supplied: rows are added, not computed (Lunar Database clips); no run
   */
  run: 'parser' | 'chunks' | 'sort' | 'sample' | 'range' | 'supplied'
  /** Opens and parses each replay itself: bigger worker heap, one item per
   *  chunk (results show as each file finishes), missing-file count. */
  readsReplays?: boolean
  /** Needs the whole input on one worker (global order, position or sample). */
  singleWorker?: boolean
  /** A stopped run starts again from nothing instead of resuming: its result
   *  depends on the whole input (order, position, a sample, "seen so far"), so
   *  rows from a partial run would be duplicated or wrong. */
  restartOnResume?: boolean
  /** The method takes a progress emitter as its third argument. */
  emitter?: boolean
  /** Rows per chunk when not reading replays (default 5,000). */
  chunkSize?: number
  /** Raw detector output is cached per game (models/detectionCache.ts); the
   *  cache is passed after the method's other arguments. */
  detectorCache?: boolean
  /** Runs the user's own code (Custom Code, AI Filter). That code may open
   *  each replay, so it gets small batches (one game at a time when its input
   *  is whole games) and progress after each batch. */
  userCode?: boolean
}

export const FILTER_TRAITS: Record<string, FilterTraits> = {
  files: { run: 'chunks', emitter: true },
  slpParser: { run: 'parser', readsReplays: true, detectorCache: true },
  earlyQuitOut: { run: 'parser', readsReplays: true },
  comboFilter: { run: 'chunks', emitter: true },
  edgeguardFilter: { run: 'chunks', emitter: true },
  phantomFilter: { run: 'chunks', emitter: true },
  zeroToDeaths: { run: 'chunks', emitter: true },
  // One worker and one "seen" set for the whole input: duplicates farther apart
  // than a chunk, or on another thread, must still go.
  deduplicate: {
    run: 'chunks',
    emitter: true,
    singleWorker: true,
    restartOnResume: true,
  },
  trim: { run: 'chunks' },
  // User code runs over a whole batch at once and may open every replay:
  // small batches, so progress ticks and one batch never nears the time limit.
  custom: { run: 'chunks', emitter: true, chunkSize: 25, userCode: true },
  // AI-written code, run exactly like Custom Code.
  aiFilter: { run: 'chunks', emitter: true, chunkSize: 25, userCode: true },
  edgeguard: {
    run: 'chunks',
    readsReplays: true,
    emitter: true,
    detectorCache: true,
  },
  actionStateFilter: { run: 'chunks', readsReplays: true, emitter: true },
  afkDetection: { run: 'chunks', readsReplays: true, emitter: true },
  highlight: { run: 'chunks', readsReplays: true, emitter: true },
  koDirection: { run: 'chunks', readsReplays: true },
  phantom: { run: 'chunks', readsReplays: true, emitter: true },
  removeStarKOFrames: { run: 'chunks', readsReplays: true, emitter: true },
  reverse: { run: 'chunks', readsReplays: true, emitter: true },
  stageCenter: { run: 'chunks', readsReplays: true, emitter: true },
  // Parked: in the config registry but no method (commented out).
  pressure: { run: 'chunks', readsReplays: true },
  sort: { run: 'sort', singleWorker: true, restartOnResume: true },
  randomSample: { run: 'sample', singleWorker: true, restartOnResume: true },
  range: { run: 'range', singleWorker: true, restartOnResume: true },
  lunarClips: { run: 'supplied' },
}

/** Traits of a filter type; unknown types run as plain chunked filters. */
export function traitsOf(type: string): FilterTraits {
  return FILTER_TRAITS[type] ?? { run: 'chunks' }
}

const typesWhere = (pick: (_t: FilterTraits) => boolean) =>
  new Set(
    Object.entries(FILTER_TRAITS)
      .filter(([, t]) => pick(t))
      .map(([id]) => id),
  ) as ReadonlySet<string>

/** Filter types that open and parse each replay themselves. */
export const REPLAY_READING_FILTERS = typesWhere((t) => !!t.readsReplays)

/** Parsers return `{ combos, lastFrame }` per game (Worker.ts streaming path). */
export const PARSER_FILTERS = typesWhere((t) => t.run === 'parser')
