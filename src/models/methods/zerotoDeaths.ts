import {
  ClipInterface,
  EventEmitterInterface,
  ZeroToDeathsParams,
} from 'constants/types'

export default (
  prevResults: ClipInterface[],
  params: ZeroToDeathsParams,
  eventEmitter: EventEmitterInterface,
) => {
  const threshold = parseInt(params.startThreshold, 10) || 0
  return prevResults.filter((clip, index) => {
    eventEmitter({ current: index, total: prevResults.length })
    if (!clip.combo) return false
    return clip.combo.startPercent <= threshold && clip.combo.didKill
  })
}
