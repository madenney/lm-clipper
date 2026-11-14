import fs from 'fs'
import os from 'os'
import path from 'path'
import { checkIso } from '../main/isoCheck'

describe('checkIso', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-iso-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const file = (name: string, head: string, bytes = 4096) => {
    const p = path.join(dir, name)
    const b = Buffer.alloc(bytes)
    b.write(head, 0, 'latin1')
    fs.writeFileSync(p, b)
    return p
  }

  it('stops at once for another game, PAL or not a disc', async () => {
    expect((await checkIso(file('a.iso', 'GZZE01'))).fatal).toMatch(
      /another game \(game ID "GZZE01"\)/,
    )
    expect((await checkIso(file('b.iso', 'GALP01'))).fatal).toMatch(/PAL/)
    expect((await checkIso(file('c.iso', '\0\0\0\0\0\0'))).fatal).toMatch(
      /not a GameCube disc image/,
    )
  })

  it('only hints that a short Melee ISO may be incomplete', async () => {
    const r = await checkIso(file('Melee.iso', 'GALE01'))
    expect(r.fatal).toBeNull()
    expect(r.hint).toMatch(/smaller than a full disc .* may be incomplete/)
  })

  it('leaves compressed images and unreadable paths to Dolphin', async () => {
    expect(await checkIso(file('Melee.rvz', 'RVZ\x01'))).toEqual({
      fatal: null,
      hint: null,
    })
    expect(await checkIso(path.join(dir, 'missing.iso'))).toEqual({
      fatal: null,
      hint: null,
    })
  })
})
