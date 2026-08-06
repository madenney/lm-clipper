import { app, ipcMain, BrowserWindow, IpcMainEvent } from 'electron'
import path from 'path'
import {
  ArchiveInterface,
  ConfigInterface,
  ShallowFilterInterface,
  SavedCustomFilter,
} from '../../constants/types'
import {
  RequestEnvelope,
  unpackRequest,
  buildShallowArchive,
} from '../ipcUtils'
import { resolveHtmlPath } from '../util'
import { track } from '../telemetry'

export default class CodeEditorManager {
  private mainWindow: BrowserWindow
  private getArchive: () => ArchiveInterface | null
  private getConfig: () => ConfigInterface
  private getConfigPath: () => string
  private saveConfig: () => void

  codeEditorWindow: BrowserWindow | null = null
  codeEditorContext: { filterIndex: number; filterId: string } | null = null
  private _cleanupListeners: (() => void) | null = null

  constructor(
    mainWindow: BrowserWindow,
    deps: {
      getArchive: () => ArchiveInterface | null
      getConfig: () => ConfigInterface
      getConfigPath: () => string
      saveConfig: () => void
    },
  ) {
    this.mainWindow = mainWindow
    this.getArchive = deps.getArchive
    this.getConfig = deps.getConfig
    this.getConfigPath = deps.getConfigPath
    this.saveConfig = deps.saveConfig
  }

  cleanup() {
    if (this._cleanupListeners) {
      this._cleanupListeners()
      this._cleanupListeners = null
    }
    if (this.codeEditorWindow && !this.codeEditorWindow.isDestroyed()) {
      this.codeEditorWindow.destroy()
      this.codeEditorWindow = null
      this.codeEditorContext = null
    }
  }

  openCodeEditor(
    _event: IpcMainEvent,
    data: RequestEnvelope<{
      filterIndex: number
      filter: ShallowFilterInterface
    }>,
  ) {
    const { payload } = unpackRequest<{
      filterIndex: number
      filter: ShallowFilterInterface
    }>(data)
    if (!payload) return

    const { filterIndex, filter } = payload
    const archive = this.getArchive()
    const config = this.getConfig()
    const upstreamFields: { name: string; type: string; from: string }[] = []
    const upstreamTypes: string[] = []
    if (archive) {
      for (const f of archive.filters) {
        if (f.id === filter.id) break
        upstreamTypes.push(f.type)
        if (f.type === 'custom' && Array.isArray(f.params?.outputFields)) {
          for (const of2 of f.params.outputFields) {
            if (of2.name) {
              upstreamFields.push({
                name: of2.name,
                type: of2.type || 'any',
                from: f.label || 'Custom Code',
              })
            }
          }
        }
      }
    }
    const initData = {
      code: filter.params?.code || '',
      filterName: filter.label,
      filterId: filter.id,
      savedCustomFilters: config.savedCustomFilters || [],
      mode: 'filter' as const,
      customParams: filter.params?.customParams || [],
      outputFields: filter.params?.outputFields || [],
      upstreamFields,
      upstreamTypes,
    }

    this._openWindow(initData, { filterIndex, filterId: filter.id })
  }

  openCodeEditorForTemplate(
    _event: IpcMainEvent,
    data: RequestEnvelope<{ templateIndex: number }>,
  ) {
    const { payload } = unpackRequest<{ templateIndex: number }>(data)
    if (!payload) return
    const config = this.getConfig()
    const { templateIndex } = payload
    const tmpl = config.savedCustomFilters?.[templateIndex]
    if (!tmpl) return

    const initData = {
      code: tmpl.code,
      filterName: tmpl.name,
      filterId: '',
      savedCustomFilters: config.savedCustomFilters || [],
      mode: 'template' as const,
      templateIndex,
      customParams: tmpl.customParams || [],
    }

    this._openWindow(initData, null)
  }

  private _openWindow(
    initData: {
      code: string
      filterName: string
      filterId: string
      savedCustomFilters: { name: string; code: string }[]
      mode: 'filter' | 'template'
      templateIndex?: number
      customParams?: { name: string; type: string; value: string }[]
      outputFields?: { name: string; type: string }[]
      upstreamFields?: { name: string; type: string; from: string }[]
      upstreamTypes?: string[]
    },
    filterContext: { filterIndex: number; filterId: string } | null,
  ) {
    const windowTitle =
      initData.mode === 'template'
        ? `Lunar Clipper Code Editor - ${initData.filterName}`
        : `Lunar Clipper Custom Code Editor - ${initData.filterName}`

    if (this._cleanupListeners) {
      this._cleanupListeners()
      this._cleanupListeners = null
    }

    if (this.codeEditorWindow && !this.codeEditorWindow.isDestroyed()) {
      this.codeEditorContext = filterContext
      this.codeEditorWindow.setTitle(windowTitle)
      this.codeEditorWindow.webContents.send('code-editor-init', initData)
      this.codeEditorWindow.focus()
      return
    }

    this.codeEditorContext = filterContext

    const preloadPath = app.isPackaged
      ? path.join(__dirname, 'preload.js')
      : path.join(__dirname, '../../.erb/dll/preload.js')

    this.codeEditorWindow = new BrowserWindow({
      title: windowTitle,
      width: 1100,
      height: 750,
      webPreferences: {
        preload: preloadPath,
        devTools: false,
      },
      autoHideMenuBar: true,
    })

    this.codeEditorWindow.setMenu(null)

    const editorWindow = this.codeEditorWindow

    ipcMain.once('code-editor-ready', () => {
      if (editorWindow && !editorWindow.isDestroyed()) {
        editorWindow.webContents.send('code-editor-init', initData)
      }
    })

    const onSave = (
      _saveEvent: IpcMainEvent,
      saveData: {
        code: string
        filterId: string
        mode?: string
        templateIndex?: number
      },
    ) => {
      if (!saveData) return
      const config = this.getConfig()

      if (
        saveData.mode === 'template' &&
        typeof saveData.templateIndex === 'number'
      ) {
        const idx = saveData.templateIndex
        if (
          config.savedCustomFilters &&
          idx >= 0 &&
          idx < config.savedCustomFilters.length
        ) {
          config.savedCustomFilters[idx].code = saveData.code
          this.saveConfig()
          if (editorWindow && !editorWindow.isDestroyed()) {
            editorWindow.webContents.send('code-editor-templates-updated', [
              ...config.savedCustomFilters,
            ])
          }
          this.mainWindow.webContents.send(
            'config-templates-updated',
            config.savedCustomFilters,
          )
        }
        return
      }

      const archive = this.getArchive()
      if (!archive || !this.codeEditorContext) return
      const { filterIndex: idx, filterId } = this.codeEditorContext
      if (saveData.filterId !== filterId) return
      const existingFilter = archive.filters[idx]
      if (!existingFilter) return
      existingFilter.params = { ...existingFilter.params, code: saveData.code }

      const matchedTemplate = (config.savedCustomFilters || []).find(
        (t) => t.code.trim() === saveData.code.trim(),
      )
      if (matchedTemplate) {
        existingFilter.label = matchedTemplate.name
        if (matchedTemplate.customParams) {
          existingFilter.params.customParams = JSON.parse(
            JSON.stringify(matchedTemplate.customParams),
          )
        }
        if (matchedTemplate.outputFields) {
          existingFilter.params.outputFields = JSON.parse(
            JSON.stringify(matchedTemplate.outputFields),
          )
        }
      }
      existingFilter.isProcessed = false
      existingFilter.results = 0
      archive.filters.slice(idx + 1).forEach((f) => {
        f.isProcessed = false
        f.results = 0
      })
      if (archive.saveMetaData) archive.saveMetaData()
      const shallow = buildShallowArchive(archive)
      this.mainWindow.webContents.send('code-editor-saved', shallow)
    }
    ipcMain.on('code-editor-save', onSave)

    const onSaveTemplate = (
      _e: IpcMainEvent,
      tmplData: {
        name: string
        code: string
        customParams?: { name: string; type: string; value: string }[]
        outputFields?: { name: string; type: string }[]
      },
    ) => {
      if (!tmplData?.name || !tmplData?.code) return
      const config = this.getConfig()
      if (!config.savedCustomFilters) config.savedCustomFilters = []
      const existing = config.savedCustomFilters.findIndex(
        (t) => t.name === tmplData.name,
      )
      // IPC-payload boundary: the renderer sends param `type` as a plain
      // string; assert it back to the SavedCustomFilter union here.
      const entry = {
        name: tmplData.name,
        code: tmplData.code,
        customParams: tmplData.customParams,
        outputFields: tmplData.outputFields,
      } as SavedCustomFilter
      if (existing >= 0) {
        config.savedCustomFilters[existing] = entry
      } else {
        config.savedCustomFilters.push(entry)
      }
      this.saveConfig()
      const templates = [...config.savedCustomFilters]
      if (editorWindow && !editorWindow.isDestroyed()) {
        editorWindow.webContents.send(
          'code-editor-templates-updated',
          templates,
        )
      }
      this.mainWindow.webContents.send('config-templates-updated', templates)
    }
    ipcMain.on('code-editor-save-template', onSaveTemplate)

    const onDeleteTemplate = (_e: IpcMainEvent, index: number) => {
      const config = this.getConfig()
      if (
        !config.savedCustomFilters ||
        typeof index !== 'number' ||
        index < 0 ||
        index >= config.savedCustomFilters.length
      )
        return
      config.savedCustomFilters.splice(index, 1)
      this.saveConfig()
      const templates = [...config.savedCustomFilters]
      if (editorWindow && !editorWindow.isDestroyed()) {
        editorWindow.webContents.send(
          'code-editor-templates-updated',
          templates,
        )
      }
      this.mainWindow.webContents.send('config-templates-updated', templates)
    }
    ipcMain.on('code-editor-delete-template', onDeleteTemplate)

    const onTestRun = async (
      _e: IpcMainEvent,
      testData: { code: string; customParams?: any[]; sampleSize?: number },
    ) => {
      const archive = this.getArchive()
      if (!archive || !this.codeEditorContext) {
        editorWindow?.webContents.send('code-editor-test-result', {
          error: 'No archive or filter context',
        })
        return
      }
      const { filterIndex } = this.codeEditorContext
      try {
        const prevFilterId =
          filterIndex > 0 ? archive.filters[filterIndex - 1].id : 'files'
        const sampleSize =
          testData.sampleSize && testData.sampleSize > 0
            ? testData.sampleSize
            : 5
        const items = await archive.getItems!({
          filterId: prevFilterId,
          limit: sampleSize,
          offset: 0,
        })
        if (!items || items.length === 0) {
          editorWindow?.webContents.send('code-editor-test-result', {
            error: 'No clips available from previous filter',
          })
          return
        }

        const params: any = { code: testData.code }
        const reserved = new Set(['code', 'maxFiles', 'customParams'])
        if (Array.isArray(testData.customParams)) {
          params.customParams = testData.customParams
          for (const cp of testData.customParams) {
            if (!cp.name || reserved.has(cp.name)) continue
            if (cp.type === 'int') {
              const n = parseInt(cp.value, 10)
              params[cp.name] = Number.isNaN(n) ? 0 : n
            } else if (cp.type === 'array') {
              params[cp.name] = (cp.value ?? '')
                .split(',')
                .map((s: string) => s.trim())
                .filter(Boolean)
            } else {
              params[cp.name] = cp.value ?? ''
            }
          }
        }

        const logs: string[] = []
        const fakeConsole = {
          log: (...args: any[]) => {
            logs.push(
              args
                .map((a) =>
                  typeof a === 'object'
                    ? JSON.stringify(a, null, 2)
                    : String(a),
                )
                .join(' '),
            )
          },
          warn: (...args: any[]) => {
            logs.push(
              `[warn] ${args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')}`,
            )
          },
          error: (...args: any[]) => {
            logs.push(
              `[error] ${args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')}`,
            )
          },
        }

        // eslint-disable-next-line global-require
        // eslint-disable-next-line global-require
        const { SlippiGame } = require('@slippi/slippi-js')
        // eslint-disable-next-line global-require
        const vm = require('vm')
        const sandbox = {
          clips: items,
          params,
          SlippiGame,
          console: fakeConsole,
        }
        vm.createContext(sandbox)
        const result = vm.runInNewContext(
          `(function(clips, params, SlippiGame, console) { ${testData.code} })(clips, params, SlippiGame, console)`,
          sandbox,
          { timeout: 30000 },
        )

        const outputClips = Array.isArray(result) ? result : []

        editorWindow?.webContents.send('code-editor-test-result', {
          logs,
          inputClips: items,
          outputClips: outputClips.slice(0, 20),
          inputCount: items.length,
          outputCount: outputClips.length,
        })
      } catch (err: any) {
        editorWindow?.webContents.send('code-editor-test-result', {
          error: err?.message || String(err),
        })
      }
    }
    ipcMain.on('code-editor-test-run', onTestRun)

    const onClose = () => {
      if (editorWindow && !editorWindow.isDestroyed()) {
        editorWindow.close()
      }
    }
    ipcMain.on('code-editor-close', onClose)

    // "Copy AI Prompt" button — track who reaches for AI help writing custom
    // code. Anonymous (installId only), fire-and-forget like all telemetry.
    const onAiPromptCopied = (_e: IpcMainEvent, data: { mode?: string }) => {
      track('ai_prompt_copied', { mode: data?.mode ?? 'filter' })
    }
    ipcMain.on('code-editor-ai-prompt-copied', onAiPromptCopied)

    const cleanupListeners = () => {
      ipcMain.removeListener('code-editor-save', onSave)
      ipcMain.removeListener('code-editor-save-template', onSaveTemplate)
      ipcMain.removeListener('code-editor-delete-template', onDeleteTemplate)
      ipcMain.removeListener('code-editor-test-run', onTestRun)
      ipcMain.removeListener('code-editor-close', onClose)
      ipcMain.removeListener('code-editor-ai-prompt-copied', onAiPromptCopied)
    }
    this._cleanupListeners = cleanupListeners

    editorWindow.on('closed', () => {
      cleanupListeners()
      this._cleanupListeners = null
      this.codeEditorWindow = null
      this.codeEditorContext = null
    })

    editorWindow.loadURL(resolveHtmlPath('codeEditor.html'))
  }
}
