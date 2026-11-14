/**
 * @jest-environment node
 *
 * "Warn before deleting replays": the Replays tray's warning and its setting
 * (config confirmDeleteReplays), from the default through Settings and the
 * renderer's write to the saved config file and back.
 */
import { config as defaultConfig } from '../constants/defaults'
import { videoConfig } from '../constants/config'
import { rendererConfig, rendererMayWrite } from '../main/configStore'
import { deleteReplaysCopy } from '../lib/deleteReplaysCopy'

describe('confirmDeleteReplays setting', () => {
  it('is on by default', () => {
    expect((defaultConfig as any).confirmDeleteReplays).toBe(true)
  })

  it('is a Settings checkbox, "Warn before deleting replays", default on', () => {
    const entry = (videoConfig as any[]).find(
      (c) => c.id === 'confirmDeleteReplays',
    )
    expect(entry).toMatchObject({
      label: 'Warn before deleting replays',
      type: 'checkbox',
      default: true,
      category: 'project',
    })
  })

  it('the renderer may write it and is given it back', () => {
    expect(rendererMayWrite('confirmDeleteReplays')).toBe(true)
    const cfg = { ...defaultConfig, confirmDeleteReplays: false } as any
    expect(rendererConfig(cfg).confirmDeleteReplays).toBe(false)
  })

  it('"Don\'t show this again" survives a save and a restart; Settings turns it back on', () => {
    // controller.updateConfig sets the key and saves the JSON; a launch loads
    // it as { ...defaultConfig, ...saved }.
    const load = (saved: string) => ({ ...defaultConfig, ...JSON.parse(saved) })
    let saved = JSON.stringify({
      ...defaultConfig,
      confirmDeleteReplays: false,
    })
    expect(load(saved).confirmDeleteReplays).toBe(false)
    saved = JSON.stringify({ ...load(saved), confirmDeleteReplays: true })
    expect(load(saved).confirmDeleteReplays).toBe(true)
    // An older config without the key gets the default (warn).
    expect(load('{}').confirmDeleteReplays).toBe(true)
  })
})

describe('deleteReplaysCopy', () => {
  it('names the real count and says the files stay on disk', () => {
    expect(deleteReplaysCopy(97)).toEqual({
      title: 'Remove 97 replays from Clipper?',
      body: 'They will be removed from this project and your library, along with every clip made from them. The replay files stay on your disk: to get the space back, delete them yourself in your file manager.',
    })
    expect(deleteReplaysCopy(12345).title).toBe(
      'Remove 12,345 replays from Clipper?',
    )
  })

  it('one replay', () => {
    const { title, body } = deleteReplaysCopy(1)
    expect(title).toBe('Remove 1 replay from Clipper?')
    expect(body).toMatch(
      /The replay file stays on your disk: to get the space back, delete it yourself/,
    )
  })
})
