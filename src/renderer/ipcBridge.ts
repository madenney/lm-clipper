import {
  ShallowFilterInterface,
  ClipInterface,
  FileInterface,
  LiteItem,
} from 'constants/types'

type ResponseHandler<T> = (_payload: T) => void

type ResponseEnvelope<T> = {
  requestId?: string
  payload?: T
}

const pendingByChannel = new Map<string, Map<string, ResponseHandler<any>>>()
const requestTimestamps = new Map<string, number>()
const responseListeners = new Map<string, () => void>()
let requestCounter = 0
const STALE_REQUEST_MS = 30_000
const REAP_INTERVAL_MS = 10_000

const nextRequestId = () => {
  requestCounter += 1
  return `${Date.now()}-${requestCounter}`
}

// Periodically clean up pending handlers that never got a response
setInterval(() => {
  const now = Date.now()
  for (const [channel, pending] of pendingByChannel) {
    for (const [requestId] of pending) {
      const ts = requestTimestamps.get(requestId)
      if (ts && now - ts > STALE_REQUEST_MS) {
        pending.delete(requestId)
        requestTimestamps.delete(requestId)
        console.warn(
          `[ipcBridge] Reaped stale request ${requestId} on ${channel}`,
        )
      }
    }
  }
}, REAP_INTERVAL_MS)

const ensureListener = (channel: string) => {
  if (responseListeners.has(channel)) return
  const remove = window.electron.ipcRenderer.on(
    channel,
    (data: ResponseEnvelope<any>) => {
      if (!data || typeof data !== 'object') return
      const { requestId } = data
      if (!requestId) return
      const pending = pendingByChannel.get(channel)
      if (!pending) return
      const handler = pending.get(requestId)
      if (!handler) return
      pending.delete(requestId)
      requestTimestamps.delete(requestId)
      handler(data.payload)
    },
  )
  responseListeners.set(channel, remove)
}

const request = <TPayload, TResponse>(
  channel: string,
  payload: TPayload,
  responseChannel: string,
  handler?: ResponseHandler<TResponse>,
) => {
  const requestId = nextRequestId()
  if (handler) {
    ensureListener(responseChannel)
    let pending = pendingByChannel.get(responseChannel)
    if (!pending) {
      pending = new Map()
      pendingByChannel.set(responseChannel, pending)
    }
    pending.set(requestId, handler as ResponseHandler<any>)
    requestTimestamps.set(requestId, Date.now())
  }
  window.electron.ipcRenderer.sendMessage(channel, { requestId, payload })
  return requestId
}

const send = <TPayload>(channel: string, payload: TPayload) =>
  request<TPayload, never>(channel, payload, channel)

export default {
  getConfig(handler?: ResponseHandler<any>) {
    return request('getConfig', null, 'config', handler)
  },
  getArchive(handler?: ResponseHandler<any>) {
    return request('getArchive', null, 'archive', handler)
  },
  getImportStatus(handler?: ResponseHandler<any>) {
    return request('getImportStatus', null, 'getImportStatus', handler)
  },
  getDirectory(handler?: ResponseHandler<any>) {
    return request('getDirectory', null, 'directory', handler)
  },
  createNewArchive(
    params: { name: string; location: string },
    handler?: ResponseHandler<any>,
  ) {
    return request('createNewArchive', params, 'createNewArchive', handler)
  },
  openExistingArchive(handler?: ResponseHandler<any>) {
    return request('openExistingArchive', null, 'openExistingArchive', handler)
  },
  newProject(handler?: ResponseHandler<any>) {
    return request('newProject', null, 'newProject', handler)
  },
  saveAsArchive(handler?: ResponseHandler<any>) {
    return request('saveAsArchive', null, 'saveAsArchive', handler)
  },
  getRecentProjects(handler?: ResponseHandler<any>) {
    return request('getRecentProjects', null, 'getRecentProjects', handler)
  },
  openRecentProject(projectPath: string, handler?: ResponseHandler<any>) {
    return request(
      'openRecentProject',
      projectPath,
      'openRecentProject',
      handler,
    )
  },
  importSlpFiles(handler?: ResponseHandler<any>) {
    return request('addFilesManual', null, 'addFilesManual', handler)
  },
  importDroppedSlpFiles(files: string[], handler?: ResponseHandler<any>) {
    return request('addDroppedFiles', files, 'addDroppedFiles', handler)
  },
  closeArchive(handler?: ResponseHandler<any>) {
    return request('closeArchive', null, 'closeArchive', handler)
  },
  addFilter(type: string, handler?: ResponseHandler<any>) {
    return request('addFilter', type, 'addFilter', handler)
  },
  saveArchive(handler?: ResponseHandler<any>) {
    return request('saveArchive', null, 'saveArchive', handler)
  },
  removeFilter(id: string, handler?: ResponseHandler<any>) {
    return request('removeFilter', id, 'removeFilter', handler)
  },
  getResults(
    params: {
      filterId: string
      currentPage?: number
      numPerPage?: number
      offset?: number
      limit?: number
      lite?: boolean
    },
    handler?: ResponseHandler<{
      items: (ClipInterface | FileInterface | LiteItem)[]
      total: number
    }>,
  ) {
    return request('getResults', params, 'getResults', handler)
  },
  getNames(handler?: ResponseHandler<any>) {
    return request('getNames', null, 'getNames', handler)
  },
  updateFilter(
    params: {
      filterIndex: number
      newFilter: ShallowFilterInterface
    },
    handler?: ResponseHandler<any>,
  ) {
    return request('updateFilter', params, 'updateFilter', handler)
  },
  runFilter(filterId: string, handler?: ResponseHandler<any>) {
    return request('runFilter', filterId, 'runFilter', handler)
  },
  runFilters(handler?: ResponseHandler<any>) {
    return request('runFilters', null, 'runFilters', handler)
  },
  cancelRunningFilters(handler?: ResponseHandler<any>) {
    return request(
      'cancelRunningFilters',
      null,
      'cancelRunningFilters',
      handler,
    )
  },
  stopRunningFilters(handler?: ResponseHandler<any>) {
    return request('stopRunningFilters', null, 'stopRunningFilters', handler)
  },
  stopFilter(filterId: string, handler?: ResponseHandler<any>) {
    return request('stopFilter', filterId, 'stopFilter', handler)
  },
  cancelFilter(filterId: string, handler?: ResponseHandler<any>) {
    return request('cancelFilter', filterId, 'cancelFilter', handler)
  },
  cancelImport(handler?: ResponseHandler<any>) {
    return request('cancelImport', null, 'cancelImport', handler)
  },
  stopImport(handler?: ResponseHandler<any>) {
    return request('stopImport', null, 'stopImport', handler)
  },
  updateConfig(config: {
    key: string
    value: string | number | boolean | null
  }) {
    return send('updateConfig', config)
  },
  getPath(type: 'openFile' | 'openDirectory', handler?: ResponseHandler<any>) {
    return request('getPath', type, 'getPath', handler)
  },
  generateVideo(
    payload: { filterId: string; selectedIds: string[] },
    handler?: ResponseHandler<any>,
  ) {
    return request('generateVideo', payload, 'generateVideo', handler)
  },
  stopVideo(handler?: ResponseHandler<any>) {
    return request('stopVideo', null, 'stopVideo', handler)
  },
  cancelVideo(handler?: ResponseHandler<any>) {
    return request('cancelVideo', null, 'cancelVideo', handler)
  },
  playClip(payload: {
    path: string
    startFrame?: number
    endFrame?: number
    lastFrame?: number
  }) {
    return send('playClip', payload)
  },
  recordClip(payload: {
    path: string
    startFrame?: number
    endFrame?: number
    lastFrame?: number
  }) {
    return send('recordClip', payload)
  },
  logPerfEvents(events: any[]) {
    return send('logPerfEvents', events)
  },
  debugLog(lines: string[]) {
    return send('debugLog', lines)
  },
  testDolphin() {
    return send('testDolphin', null)
  },
}
