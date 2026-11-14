/**
 * Lunar-styled replacement for dialog.showMessageBox: main asks the renderer
 * to show an in-app modal and awaits the answer.
 *
 *   const { response, checkboxChecked } = await askDialog(win, {...})
 *
 * - Requests wait until the renderer has mounted (it sends 'dialogReady'), so
 *   a startup prompt is shown once the app is up. A renderer reload sends
 *   them again (the renderer ignores ids it already has).
 * - Several dialogs are shown one after another, in the order they were asked.
 * - Asking brings the window up (restore, show, focus) like the native box.
 * - If the window closes, every open question resolves with its cancel choice.
 */
import { randomUUID } from 'crypto'

export type DialogType = 'none' | 'info' | 'question' | 'warning' | 'error'

export interface AskOptions {
  type?: DialogType
  title?: string
  message: string
  detail?: string
  /** Button labels, left to right. Defaults to ['OK']. */
  buttons?: string[]
  /** Highlighted and pressed by Enter. Defaults to 0. */
  defaultId?: number
  /** Index answered by Esc, a click outside, or the window closing. Defaults to 0. */
  cancelId?: number
  checkboxLabel?: string
  checkboxChecked?: boolean
}

export interface AskResult {
  response: number
  checkboxChecked: boolean
}

/** What the renderer receives on 'askDialog'. */
export interface DialogRequest {
  id: string
  type: DialogType
  title: string
  message: string
  detail?: string
  buttons: string[]
  defaultId: number
  cancelId: number
  checkboxLabel?: string
  checkboxChecked: boolean
}

export interface DialogWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
  webContents: { send(_channel: string, ..._args: unknown[]): void }
}

interface Pending {
  request: DialogRequest
  win: DialogWindow
  resolve: (_r: AskResult) => void
}

export class DialogHub {
  private pending: Pending[] = []

  private ready = false

  setReady(ready: boolean) {
    this.ready = ready
    if (ready) {
      for (const p of this.pending) this.send(p)
    }
  }

  /** Questions that have not been answered yet. */
  get openCount() {
    return this.pending.length
  }

  ask(win: DialogWindow, options: AskOptions): Promise<AskResult> {
    const buttons = options.buttons?.length ? [...options.buttons] : ['OK']
    const clamp = (n: number | undefined) =>
      n !== undefined && n >= 0 && n < buttons.length ? n : 0
    const request: DialogRequest = {
      id: randomUUID(),
      type: options.type ?? 'none',
      title: options.title ?? '',
      message: options.message,
      detail: options.detail,
      buttons,
      defaultId: clamp(options.defaultId),
      cancelId: clamp(options.cancelId),
      checkboxLabel: options.checkboxLabel,
      checkboxChecked: !!options.checkboxChecked,
    }
    if (win.isDestroyed())
      return Promise.resolve({
        response: request.cancelId,
        checkboxChecked: request.checkboxChecked,
      })
    return new Promise<AskResult>((resolve) => {
      const entry: Pending = { request, win, resolve }
      this.pending.push(entry)
      this.bringUp(win)
      if (this.ready) this.send(entry)
    })
  }

  /** The renderer's answer ('dialogReply'). Unknown ids are ignored. */
  reply(id: string, response: number, checkboxChecked: boolean) {
    const i = this.pending.findIndex((p) => p.request.id === id)
    if (i < 0) return
    const [p] = this.pending.splice(i, 1)
    const max = p.request.buttons.length - 1
    p.resolve({
      response:
        Number.isInteger(response) && response >= 0 && response <= max
          ? response
          : p.request.cancelId,
      checkboxChecked: !!checkboxChecked,
    })
  }

  /** The window went away: its open questions take their cancel choice. */
  windowClosed(win?: DialogWindow) {
    const rest: Pending[] = []
    for (const p of this.pending) {
      if (win && p.win !== win) rest.push(p)
      else
        p.resolve({
          response: p.request.cancelId,
          checkboxChecked: p.request.checkboxChecked,
        })
    }
    this.pending = rest
    this.ready = false
  }

  private send(p: Pending) {
    if (p.win.isDestroyed()) return
    p.win.webContents.send('askDialog', p.request)
  }

  private bringUp(win: DialogWindow) {
    try {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    } catch {
      // A window that is going away needs no attention.
    }
  }
}

/** The app's one hub (one main window). */
export const dialogHub = new DialogHub()

export const askDialog = (win: DialogWindow, options: AskOptions) =>
  dialogHub.ask(win, options)
