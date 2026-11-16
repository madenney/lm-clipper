import {
  ShallowFilterInterface,
  ClipInterface,
  FileInterface,
  LiteItem,
  VideoFolder,
  OverlayFont,
} from 'constants/types'
import type { ClipTrack } from '../main/clipTrack'
import type { SelectionWire } from '../lib/selection'
import { OWNER_LONG_CHANNELS } from '../owner/channels'

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
const LONG_RUNNING_CHANNELS = new Set([
  'databaseRequest',
  // Owner tools may upload files before they reply.
  ...OWNER_LONG_CHANNELS,
  // Locate… waits on a folder dialog and a disk search.
  'missingReplaysAction',
  // Waits on a file dialog.
  'overlayFontsImport',
  // Waits on dialogs and can move many GB.
  'moveReplayLibrary',
  'runFilter',
  'resumeFilter',
  // A selection's duration: a sum over a whole table can take a while on huge ones.
  'getSelectionDuration',
  'getTableDuration',
  // An overview chunk can wait behind long DbWorker work (a removal, a count);
  // a reaped one would leave the overview stuck on an error.
  'getOverviewChunk',
  // Removing millions of rows runs in 5,000-row statements; the tray re-reads
  // the overview when the reply comes.
  'removeResult',
  'removeGame',
  // Resolves a Select All over the whole table to count it.
  'previewRemoveGames',
  'generateVideo',
  'recordClip',
  'videoToolsRun',
  'videoToolsProbe',
  'addFilesManual',
  'addDroppedFiles',
  // Opening a project can legitimately take a while on a large DB; never reap
  // these as "stale" or the renderer gets an error reply and can crash.
  'archive',
  'openExistingArchive',
  'newProject',
  'openMyReplays',
])

const nextRequestId = () => {
  requestCounter += 1
  return `${Date.now()}-${requestCounter}`
}

// Periodically clean up pending handlers that never got a response
setInterval(() => {
  const now = Date.now()
  for (const [channel, pending] of pendingByChannel) {
    for (const [requestId, handler] of pending) {
      const ts = requestTimestamps.get(requestId)
      if (
        ts &&
        now - ts > STALE_REQUEST_MS &&
        !LONG_RUNNING_CHANNELS.has(channel)
      ) {
        pending.delete(requestId)
        requestTimestamps.delete(requestId)
        console.warn(`[ipcBridge] Timed out request ${requestId} on ${channel}`)
        // Notify the caller instead of silently dropping
        try {
          handler({ error: `Request timed out (${channel})` })
        } catch (_) {
          // handler may not expect error shape, don't crash
        }
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
  database(
    params: import('../constants/database').DatabaseRequest,
    handler: ResponseHandler<import('../constants/database').DatabaseReply>,
  ) {
    return request('databaseRequest', params, 'databaseRequest', handler)
  },
  /** Owner tools (src/owner; empty in release builds): request/reply on their own channel. */
  ownerRequest<TPayload, TResponse>(
    channel: string,
    params: TPayload,
    handler: ResponseHandler<TResponse>,
  ) {
    return request(channel, params, channel, handler)
  },
  getMissingReplays(
    handler: ResponseHandler<
      import('../main/missingReplays').MissingReport | null
    >,
  ) {
    return request('getMissingReplays', null, 'getMissingReplays', handler)
  },
  missingReplaysAction(
    action: 'locate' | 'download' | 'remove',
    handler: ResponseHandler<any>,
  ) {
    return request(
      'missingReplaysAction',
      { action },
      'missingReplaysAction',
      handler,
    )
  },
  getCpuScanStatus(
    handler: ResponseHandler<import('../lib/cpuPlayers').CpuScanStatus | null>,
  ) {
    return request('getCpuScanStatus', null, 'getCpuScanStatus', handler)
  },
  cpuScanAction(
    action: 'stop' | 'continue',
    handler: ResponseHandler<import('../lib/cpuPlayers').CpuScanStatus | null>,
  ) {
    return request('cpuScanAction', { action }, 'cpuScanAction', handler)
  },
  getLastFrameScanStatus(
    handler: ResponseHandler<
      import('../lib/lastFrame').LastFrameScanStatus | null
    >,
  ) {
    return request(
      'getLastFrameScanStatus',
      null,
      'getLastFrameScanStatus',
      handler,
    )
  },
  lastFrameScanAction(
    action: 'stop' | 'continue',
    handler: ResponseHandler<
      import('../lib/lastFrame').LastFrameScanStatus | null
    >,
  ) {
    return request(
      'lastFrameScanAction',
      { action },
      'lastFrameScanAction',
      handler,
    )
  },
  /** File › Extract Replays… from the screen (Add replays). */
  extractReplays(kind: 'files' | 'folder') {
    return send('extractReplays', { kind })
  },
  detectorCache(
    action: 'stats' | 'clear',
    handler: ResponseHandler<{ stats?: { entries: number; bytes: number } }>,
  ) {
    return request('detectorCache', { action }, 'detectorCache', handler)
  },
  moveReplayLibrary(
    folder: string,
    handler: ResponseHandler<{ config: any; cancelled?: boolean }>,
  ) {
    return request('moveReplayLibrary', folder, 'moveReplayLibrary', handler)
  },
  getConfig(handler?: ResponseHandler<any>) {
    return request('getConfig', null, 'config', handler)
  },
  setDefaultOutputPath(handler?: ResponseHandler<string>) {
    return request(
      'setDefaultOutputPath',
      null,
      'setDefaultOutputPath',
      handler,
    )
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
  /** Open My Replays (created the first time): the one default project. */
  openMyReplays(handler?: ResponseHandler<any>) {
    return request('openMyReplays', null, 'openMyReplays', handler)
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
  applyStarterChain(key: string, handler?: ResponseHandler<any>) {
    return request('applyStarterChain', key, 'applyStarterChain', handler)
  },
  removeFilter(id: string, handler?: ResponseHandler<any>) {
    return request('removeFilter', id, 'removeFilter', handler)
  },
  reorderFilter(
    params: { fromIndex: number; toIndex: number },
    handler?: ResponseHandler<any>,
  ) {
    return request('reorderFilter', params, 'reorderFilter', handler)
  },
  getResults(
    params: {
      filterId: string
      currentPage?: number
      numPerPage?: number
      offset?: number
      limit?: number
      lite?: boolean
      /** A newer request on this lane supersedes this one (reply `stale`). */
      lane?: string
    },
    handler?: ResponseHandler<{
      items: (ClipInterface | FileInterface | LiteItem)[]
      total: number
      stale?: boolean
    }>,
  ) {
    return request('getResults', params, 'getResults', handler)
  },
  /** A selection's length in frames and row count, added up in main. */
  getSelectionDuration(
    params: { filterId: string; selection: SelectionWire },
    handler?: ResponseHandler<
      { frames: number; count: number } | { error: string }
    >,
  ) {
    return request(
      'getSelectionDuration',
      params,
      'getSelectionDuration',
      handler,
    )
  },
  getTableDuration(filterId: string, handler?: ResponseHandler<number>) {
    return request(
      'getTableDuration',
      { filterId },
      'getTableDuration',
      handler,
    )
  },
  getFilterCount(
    filterId: string,
    handler?: ResponseHandler<{ filterId: string; count: number }>,
  ) {
    return request('getFilterCount', { filterId }, 'getFilterCount', handler)
  },
  getNames(handler?: ResponseHandler<any>) {
    return request('getNames', null, 'getNames', handler)
  },
  getConnectCodes(handler?: ResponseHandler<any>) {
    return request('getConnectCodes', null, 'getConnectCodes', handler)
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
  resumeFilter(filterId: string, handler?: ResponseHandler<any>) {
    return request('resumeFilter', filterId, 'resumeFilter', handler)
  },
  dismissFilterResume(filterId: string, handler?: ResponseHandler<any>) {
    return request(
      'dismissFilterResume',
      filterId,
      'dismissFilterResume',
      handler,
    )
  },
  /** Accept a stopped or failed run's results as they are (the step counts as done). */
  keepFilterResults(filterId: string, handler?: ResponseHandler<any>) {
    return request('keepFilterResults', filterId, 'keepFilterResults', handler)
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
    value: string | number | boolean | null | string[]
  }) {
    return send('updateConfig', config)
  },
  getPath(
    typeOrOpts:
      | 'openFile'
      | 'openDirectory'
      | { type: 'openFile' | 'openDirectory'; defaultPath?: string },
    handler?: ResponseHandler<any>,
  ) {
    return request('getPath', typeOrOpts, 'getPath', handler)
  },
  // Settings > Overlay: fonts the user imported, and the label as a recording draws it.
  overlayFontsList(handler?: ResponseHandler<{ fonts: OverlayFont[] }>) {
    return request('overlayFontsList', null, 'overlayFontsList', handler)
  },
  overlayFontsImport(
    handler?: ResponseHandler<{
      imported: OverlayFont[]
      failed: { name: string; reason: string }[]
      canceled: boolean
      fonts: OverlayFont[]
    }>,
  ) {
    return request('overlayFontsImport', null, 'overlayFontsImport', handler)
  },
  overlayFontsRemove(
    file: string,
    handler?: ResponseHandler<{ removed: boolean; fonts: OverlayFont[] }>,
  ) {
    return request('overlayFontsRemove', file, 'overlayFontsRemove', handler)
  },
  overlayPreview(
    payload: { text: string; font?: string; size?: number },
    handler?: ResponseHandler<{ dataUrl: string | null }>,
  ) {
    return request('overlayPreview', payload, 'overlayPreview', handler)
  },
  openDolphinFolder(
    folderPath: string,
    handler?: ResponseHandler<{ found: boolean }>,
  ) {
    return request(
      'openDolphinFolder',
      folderPath,
      'openDolphinFolder',
      handler,
    )
  },
  detectDolphinPath(handler?: ResponseHandler<string | null>) {
    return request('detectDolphinPath', null, 'detectDolphinPath', handler)
  },
  detectIsoPath(handler?: ResponseHandler<string | null>) {
    return request('detectIsoPath', null, 'detectIsoPath', handler)
  },
  detectSlippiReplays(
    handler?: ResponseHandler<{ dir: string; count: number } | null>,
  ) {
    return request('detectSlippiReplays', null, 'detectSlippiReplays', handler)
  },
  openLogsFolder() {
    window.electron.ipcRenderer.sendMessage('openLogsFolder', null)
  },
  openFolder(folderPath: string, opts?: { create?: boolean }) {
    window.electron.ipcRenderer.sendMessage(
      'openFolder',
      opts?.create ? { path: folderPath, create: true } : folderPath,
    )
  },
  validateDolphinPath(
    dolphinPath: string,
    handler?: ResponseHandler<{
      valid: boolean
      message: string
      /** The cleaned-up path (quotes stripped) when it differs: save it. */
      path?: string
      /** Valid, but worth a look. */
      warning?: string
    }>,
  ) {
    return request(
      'validateDolphinPath',
      dolphinPath,
      'validateDolphinPath',
      handler,
    )
  },
  /** The tray overview's next chunk (main/overview.ts); pass `next` back. */
  getOverviewChunk(
    params: {
      filterId: string
      cursor: { key: number; id: number; cached?: boolean } | null
      limit: number
    },
    handler?: ResponseHandler<{
      ids?: Uint32Array
      packed?: Uint8Array
      next?: { key: number; id: number; cached?: boolean } | null
      error?: string
    }>,
  ) {
    return request('getOverviewChunk', params, 'getOverviewChunk', handler)
  },
  readReplayFile(
    path: string,
    handler?: ResponseHandler<{ bytes?: Uint8Array; error?: string }>,
  ) {
    return request('readReplayFile', { path }, 'readReplayFile', handler)
  },
  getClipTrack(
    clip: {
      path: string
      startFrame: number
      endFrame: number
      playerIndexes: number[]
    },
    handler?: ResponseHandler<{ track?: ClipTrack; error?: string }>,
  ) {
    return request('getClipTrack', clip, 'getClipTrack', handler)
  },
  validateIsoPath(
    isoPath: string,
    handler?: ResponseHandler<{ valid: boolean; message: string }>,
  ) {
    return request('validateIsoPath', isoPath, 'validateIsoPath', handler)
  },
  generateVideo(
    payload: {
      filterId: string
      selectedIds?: string[]
      selection?: SelectionWire
    },
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
  // Video Tools (the top bar's film button): the videos in the output folder,
  // combined into one and/or compressed.
  videoToolsList(handler?: ResponseHandler<{ folders: VideoFolder[] }>) {
    return request('videoToolsList', null, 'videoToolsList', handler)
  },
  videoToolsRun(
    payload: {
      items: { folder: string; name: string }[]
      compress?: boolean
      videoKbps?: number
    },
    handler?: ResponseHandler<{
      ok: boolean
      output?: string
      dir?: string
      error?: string
      cancelled?: boolean
    }>,
  ) {
    return request('videoToolsRun', payload, 'videoToolsRun', handler)
  },
  videoToolsProbe(
    payload: { items: { folder: string; name: string }[] },
    handler?: ResponseHandler<{ seconds: number; bitrateKbps: number }>,
  ) {
    return request('videoToolsProbe', payload, 'videoToolsProbe', handler)
  },
  videoToolsCancel(handler?: ResponseHandler<any>) {
    return request('videoToolsCancel', null, 'videoToolsCancel', handler)
  },
  videoToolsReveal(file: string, handler?: ResponseHandler<any>) {
    return request('videoToolsReveal', file, 'videoToolsReveal', handler)
  },
  playClips(payload: {
    filterId: string
    selectedIds?: string[]
    selection?: SelectionWire
  }) {
    return send('playClips', payload)
  },
  stopPlayback() {
    return send('stopPlayback', null)
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
  saveCustomFilter(
    payload: {
      name: string
      code: string
      customParams?: { name: string; type: string; value: string }[]
      outputFields?: { name: string; type: string }[]
    },
    handler?: ResponseHandler<any>,
  ) {
    return request('saveCustomFilter', payload, 'saveCustomFilter', handler)
  },
  deleteCustomFilter(index: number, handler?: ResponseHandler<any>) {
    return request('deleteCustomFilter', index, 'deleteCustomFilter', handler)
  },
  /** Remove games by id, or a whole selection (main resolves it). */
  removeGames(
    games: number[] | { selection: SelectionWire },
    handler?: ResponseHandler<any>,
  ) {
    const payload = Array.isArray(games) ? { fileIds: games } : games
    return request('removeGame', payload, 'removeGame', handler)
  },
  /** How many replays deleting these Replays-tray rows would remove (main
   *  resolves a selection), for the warning before it. */
  previewRemoveGames(
    params:
      | { filterId: string; ids: number[] }
      | { filterId: string; selection: SelectionWire },
    handler?: ResponseHandler<{ games?: number; error?: string }>,
  ) {
    return request('previewRemoveGames', params, 'previewRemoveGames', handler)
  },
  removeResults(
    params:
      | { filterId: string; rowIds: number[] }
      | { filterId: string; selection: SelectionWire },
    handler?: ResponseHandler<any>,
  ) {
    return request('removeResult', params, 'removeResult', handler)
  },
  reorderClips(
    params: {
      filterId: string
      updates: { id: number; sort_order: number }[]
    },
    handler?: ResponseHandler<any>,
  ) {
    return request('reorderClips', params, 'reorderClips', handler)
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
  openCodeEditor(payload: {
    filterIndex: number
    filter: ShallowFilterInterface
  }) {
    return send('openCodeEditor', payload)
  },
  openCodeEditorForTemplate(payload: { templateIndex: number }) {
    return send('openCodeEditorForTemplate', payload)
  },
}
