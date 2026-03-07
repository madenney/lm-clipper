import { ClipInterface, EventEmitterInterface } from 'constants/types'

export default (
  prevResults: ClipInterface[],
  _params: { [key: string]: any },
  eventEmitter: EventEmitterInterface,
) => {
  const seen = new Set<string>()
  return prevResults.filter((clip, index) => {
    eventEmitter({ current: index, total: prevResults.length })
    const key = [
      clip.startedAt ?? '',
      clip.stage,
      clip.startFrame,
      clip.endFrame,
      clip.comboer?.characterId ?? '',
      clip.comboee?.characterId ?? '',
    ].join(':')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
