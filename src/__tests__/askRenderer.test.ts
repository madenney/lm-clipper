/**
 * @jest-environment node
 *
 * main -> renderer questions (askRenderer.ts): queued until the renderer is
 * ready, several in order, the window brought up, the cancel choice when the
 * window closes.
 */
import { DialogHub, DialogWindow, DialogRequest } from '../main/askRenderer'

function fakeWindow() {
  const sent: DialogRequest[] = []
  const calls: string[] = []
  let minimized = false
  let destroyed = false
  const win: DialogWindow = {
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    restore: () => {
      minimized = false
      calls.push('restore')
    },
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
    webContents: {
      send: (_c: string, r: unknown) => {
        sent.push(r as DialogRequest)
      },
    },
  }
  return {
    win,
    sent,
    calls,
    minimize: () => {
      minimized = true
    },
    destroy: () => {
      destroyed = true
    },
  }
}

describe('DialogHub', () => {
  it('holds a question until the renderer is ready, then sends it', async () => {
    const hub = new DialogHub()
    const w = fakeWindow()
    const p = hub.ask(w.win, { message: 'Hi', buttons: ['A', 'B'] })
    expect(w.sent).toHaveLength(0)
    hub.setReady(true)
    expect(w.sent).toHaveLength(1)
    hub.reply(w.sent[0].id, 1, true)
    await expect(p).resolves.toEqual({ response: 1, checkboxChecked: true })
    expect(hub.openCount).toBe(0)
  })

  it('sends right away once ready, and answers several in the order asked', async () => {
    const hub = new DialogHub()
    const w = fakeWindow()
    hub.setReady(true)
    const a = hub.ask(w.win, { message: 'one', buttons: ['x', 'y'] })
    const b = hub.ask(w.win, { message: 'two' })
    expect(w.sent.map((r) => r.message)).toEqual(['one', 'two'])
    hub.reply(w.sent[0].id, 1, false)
    hub.reply(w.sent[1].id, 0, false)
    expect(await a).toEqual({ response: 1, checkboxChecked: false })
    expect(await b).toEqual({ response: 0, checkboxChecked: false })
  })

  it('sends everything again after a reload (ready again)', () => {
    const hub = new DialogHub()
    const w = fakeWindow()
    hub.setReady(true)
    hub.ask(w.win, { message: 'one' })
    hub.setReady(false)
    hub.setReady(true)
    expect(w.sent).toHaveLength(2)
    expect(w.sent[0].id).toBe(w.sent[1].id)
  })

  it('brings a minimized window up', () => {
    const hub = new DialogHub()
    const w = fakeWindow()
    w.minimize()
    hub.ask(w.win, { message: 'x' })
    expect(w.calls).toEqual(['restore', 'show', 'focus'])
  })

  it('takes the cancel choice for every open question when the window closes', async () => {
    const hub = new DialogHub()
    const w = fakeWindow()
    const a = hub.ask(w.win, {
      message: 'a',
      buttons: ['Go', 'Cancel'],
      cancelId: 1,
      defaultId: 0,
    })
    const b = hub.ask(w.win, {
      message: 'b',
      buttons: ['Move', 'Show', 'Keep'],
      cancelId: 2,
    })
    hub.windowClosed(w.win)
    expect((await a).response).toBe(1)
    expect((await b).response).toBe(2)
    expect(hub.openCount).toBe(0)
  })

  it('answers the cancel choice at once for a destroyed window', async () => {
    const hub = new DialogHub()
    const w = fakeWindow()
    w.destroy()
    await expect(
      hub.ask(w.win, { message: 'x', buttons: ['a', 'b'], cancelId: 1 }),
    ).resolves.toEqual({ response: 1, checkboxChecked: false })
  })

  it('ignores unknown ids and out-of-range answers', async () => {
    const hub = new DialogHub()
    const w = fakeWindow()
    hub.setReady(true)
    const p = hub.ask(w.win, { message: 'x', buttons: ['a', 'b'], cancelId: 1 })
    hub.reply('nope', 0, false)
    expect(hub.openCount).toBe(1)
    hub.reply(w.sent[0].id, 9, false)
    expect((await p).response).toBe(1)
  })
})
