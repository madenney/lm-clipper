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
import deduplicate from './deduplicate'
import zeroToDeaths from './zerotoDeaths'

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
  deduplicate,
  zeroToDeaths,
}

export default methods
