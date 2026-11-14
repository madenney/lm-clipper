/** @jest-environment node */
import {
  goneFolderOf,
  groupGoneFolders,
  matchMoved,
} from '../main/missingReplays'

// A fake disk: these folders exist, nothing else does.
const disk = new Set(['/', '/home', '/home/u', '/home/u/Slippi', '/media'])
const exists = (p: string) => disk.has(p)

describe('goneFolderOf', () => {
  it('is null when the file was deleted but its folder is there', () => {
    expect(goneFolderOf('/home/u/Slippi/Game_1.slp', exists)).toBeNull()
  })

  it('names the highest folder that is gone', () => {
    // The drive at /media/usb is unplugged.
    expect(goneFolderOf('/media/usb/Slippi/2025-08/Game_1.slp', exists)).toBe(
      '/media/usb',
    )
    expect(goneFolderOf('/home/u/Slippi/Old/Game_1.slp', exists)).toBe(
      '/home/u/Slippi/Old',
    )
  })
})

describe('groupGoneFolders', () => {
  it('groups files under a vanished folder and counts the loose ones', () => {
    const { folders, loose } = groupGoneFolders(
      [
        '/media/usb/a/1.slp',
        '/media/usb/b/2.slp',
        '/media/usb/3.slp',
        '/home/u/Slippi/Old/4.slp',
        '/home/u/Slippi/5.slp',
      ],
      exists,
    )
    expect(folders).toEqual([
      { folder: '/media/usb', count: 3 },
      { folder: '/home/u/Slippi/Old', count: 1 },
    ])
    expect(loose).toBe(1)
  })
})

describe('matchMoved', () => {
  it('matches by file name, using the size to pick between copies', () => {
    const remap = matchMoved(
      [
        { path: '/old/Game_1.slp', size: 100 },
        { path: '/old/Game_2.slp', size: 200 },
        { path: '/old/Game_3.slp', size: null },
        { path: '/old/Game_4.slp', size: 400 },
      ],
      [
        { path: '/new/a/Game_1.slp', size: 999 },
        { path: '/new/b/Game_1.slp', size: 100 },
        { path: '/new/Game_2.slp', size: 200 },
        { path: '/new/Game_3.slp', size: 300 },
        // Same name, wrong size: not the same game.
        { path: '/new/Game_4.slp', size: 401 },
      ],
    )
    expect(Object.fromEntries(remap)).toEqual({
      '/old/Game_1.slp': '/new/b/Game_1.slp',
      '/old/Game_2.slp': '/new/Game_2.slp',
      '/old/Game_3.slp': '/new/Game_3.slp',
    })
  })

  it('leaves ambiguous names alone when the size is unknown', () => {
    const remap = matchMoved(
      [{ path: '/old/Game_1.slp', size: null }],
      [
        { path: '/new/a/Game_1.slp', size: 1 },
        { path: '/new/b/Game_1.slp', size: 2 },
      ],
    )
    expect(remap.size).toBe(0)
  })
})
