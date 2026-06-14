import files from './files'
import slpParser from './slpParser'
import comboFilter from './comboFilter'
import actionStateFilter from './actionStateFilter'
import removeStarKOFrames from './removeStarKOFrames'
import reverse from './reverse'
import trim from './trim'
import koDirection from './koDirection'
import custom from './custom'
import edgeguard from './edgeguard'
import edgeguard2 from './edgeguard2'
import edgeguardFilter from './edgeguardFilter'
import deduplicate from './deduplicate'
import zeroToDeaths from './zerotoDeaths'
import afkDetection from './afkDetection'
import stageCenter from './stageCenter'

/**
 * Filter method signature. Each method takes data + params (+ optional emitter)
 * and returns filtered results. Uses `any` at the dispatch boundary because
 * Worker.ts calls methods generically; individual methods have strict types.
 */
type FilterMethod = (..._args: any[]) => any

const methods: Record<string, FilterMethod> = {
  files,
  slpParser,
  comboFilter,
  actionStateFilter,
  removeStarKOFrames,
  reverse,
  trim,
  koDirection,
  custom,
  edgeguard,
  edgeguard2,
  edgeguardFilter,
  deduplicate,
  zeroToDeaths,
  afkDetection,
  stageCenter,
}

export default methods
