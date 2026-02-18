import files from './files'
import slpParser from './slpParser'
import comboFilter from './comboFilter'
import actionStateFilter from './actionStateFilter'
import removeStarKOFrames from './removeStarKOFrames'
import reverse from './reverse'
import { sort } from './sort'
import custom from './custom'
import edgeguard from './edgeguard'

type Methods = {
  [key: string]: Function
}

const methods: Methods = {
  files,
  slpParser,
  comboFilter,
  sort,
  actionStateFilter,
  removeStarKOFrames,
  reverse,
  custom,
  edgeguard,
}

export default methods
