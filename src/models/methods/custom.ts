import { ClipInterface, EventEmitterInterface } from 'constants/types'
import { SlippiGame } from '@slippi/slippi-js'

export default (
  prevResults: ClipInterface[],
  params: { [key: string]: any },
  eventEmitter: EventEmitterInterface,
) => {
  const { code, maxFiles } = params

  if (!code || typeof code !== 'string') {
    return prevResults
  }

  const limit =
    maxFiles === '' || maxFiles === undefined
      ? prevResults.length
      : parseInt(maxFiles, 10)

  const sliced = prevResults.slice(
    0,
    Number.isNaN(limit) ? prevResults.length : limit,
  )

  eventEmitter({ current: 0, total: sliced.length })

  try {
    // eslint-disable-next-line no-new-func
    const userFn = new Function('clips', 'params', 'SlippiGame', code)
    const result = userFn(sliced, params, SlippiGame)
    return Array.isArray(result) ? result : []
  } catch (err: any) {
    throw new Error(`Custom code error: ${err?.message || String(err)}`)
  }
}
