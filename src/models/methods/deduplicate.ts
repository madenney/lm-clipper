import {
  ClipInterface,
  EventEmitterInterface,
  DeduplicateParams,
} from 'constants/types'

// The worker calls this once per chunk of 5,000 rows with the same params
// object; the "seen" set lives as long as that object, so duplicates are found
// across chunks (the step runs on one worker, see filterTraits.ts).
const seenByRun = new WeakMap<object, Set<string>>()

export default (
  prevResults: ClipInterface[],
  _params: DeduplicateParams,
  eventEmitter: EventEmitterInterface,
) => {
  let seen = seenByRun.get(_params)
  if (!seen) {
    seen = new Set<string>()
    if (_params && typeof _params === 'object') seenByRun.set(_params, seen)
  }
  const keys = seen
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
    // A clip without a start time cannot be told from another (startedAt 0 or
    // missing, same frames): keep it rather than merge unrelated clips.
    if (!clip.startedAt) return true
    if (keys.has(key)) return false
    keys.add(key)
    return true
  })
}
