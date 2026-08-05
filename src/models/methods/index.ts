import files from './files'
import slpParser from './slpParser'
import earlyQuitOut from './earlyQuitOut'
import comboFilter from './comboFilter'
import actionStateFilter from './actionStateFilter'
import removeStarKOFrames from './removeStarKOFrames'
import reverse from './reverse'
import trim from './trim'
import koDirection from './koDirection'
import custom from './custom'
import edgeguard from './edgeguard'
import edgeguardFilter from './edgeguardFilter'
import phantom from './phantom'
import phantomFilter from './phantomFilter'
import deduplicate from './deduplicate'
import zeroToDeaths from './zerotoDeaths'
import afkDetection from './afkDetection'
import stageCenter from './stageCenter'
// Pressure filter parked for now — keep pressure.ts intact; re-enable by
// uncommenting this import, the registry entry below, the sort option in
// sort.ts, and the config entry in config.ts.
// import pressure from './pressure'

/**
 * Filter method signature. Each method takes data + params (+ optional emitter)
 * and returns filtered results. Uses `any` at the dispatch boundary because
 * Worker.ts calls methods generically; individual methods have strict types.
 */
type FilterMethod = (..._args: any[]) => any

const methods: Record<string, FilterMethod> = {
  files,
  slpParser,
  earlyQuitOut,
  comboFilter,
  actionStateFilter,
  removeStarKOFrames,
  reverse,
  trim,
  koDirection,
  custom,
  edgeguard,
  edgeguardFilter,
  phantom,
  phantomFilter,
  deduplicate,
  zeroToDeaths,
  afkDetection,
  stageCenter,
  // pressure,
}

export default methods
