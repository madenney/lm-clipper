import files from './files'
import slpParser from './slpParser'
import slpParser2 from './slpParser2'
import comboFilter from './comboFilter'
import actionStateFilter from './actionStateFilter'
import removeStarKOFrames from './removeStarKOFrames'
import { sort } from './sort'
import custom from './custom'

type Methods = {
  [key: string]: Function
}

const methods: Methods = {
  files,
  slpParser,
  slpParser2,
  comboFilter,
  sort,
  actionStateFilter,
  removeStarKOFrames,
  custom,
}

export default methods
