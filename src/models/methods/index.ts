import files from './files'
import slpParser from './slpParser'
import comboFilter from './comboFilter'
import actionStateFilter from './actionStateFilter'
import removeStarKOFrames from './removeStarKOFrames'
import { sort } from './sort'

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
}

export default methods
