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

type Methods = {
  [key: string]: Function
}

const methods: Methods = {
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
}

export default methods
