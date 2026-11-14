/**
 * The overview's data in the renderer (lib/overviewStore.ts): a table replaced
 * by a newer version stops reading (its chunks would otherwise go on into main's
 * disk cache), a failed chunk is asked for again, and an error doesn't stick
 * once loading starts again. Counts, not timing.
 */
type Req = {
  filterId: string
  cursor: { key: number; id: number } | null
  limit: number
}
type Reply = (_res: unknown) => void
const pending: { req: Req; cb: Reply }[] = []
jest.mock('../renderer/ipcBridge', () => ({
  __esModule: true,
  default: {
    getOverviewChunk: (req: Req, cb: Reply) => pending.push({ req, cb }),
  },
}))

// eslint-disable-next-line import/first
import {
  overviewFor,
  stageOfByte,
  toneOfByte,
} from '../renderer/lib/overviewStore'

/** Answer the oldest request with `n` rows (more to come unless `last`). */
function answer(n: number, last = false) {
  const { req, cb } = pending.shift()!
  const from = req.cursor ? req.cursor.id : 0
  cb({
    ids: new Uint32Array(n).map((_, i) => from + i + 1),
    packed: new Uint8Array(n * 3),
    next: last ? null : { key: from + n, id: from + n },
  })
}

beforeEach(() => {
  pending.length = 0
  jest.useFakeTimers()
})
afterEach(() => jest.useRealTimers())

describe('overview data', () => {
  it('a newer version of the table stops the old one reading', () => {
    const old = overviewFor('t1', '0')
    old.load(1_000_000)
    answer(250_000)
    expect(old.count).toBe(250_000)
    expect(pending).toHaveLength(1) // the old one's next chunk is on its way
    const fresh = overviewFor('t1', '1') // a removal: read afresh
    fresh.load(900_000)
    // The old one's reply arrives: used for nothing, and nothing more is asked.
    answer(250_000)
    expect(old.count).toBe(250_000)
    expect(pending).toHaveLength(1)
    expect(pending[0].req.cursor).toBeNull() // only the new read, from the start
  })

  it('a table pushed out of the cache stops reading too', () => {
    const first = overviewFor('a', '0')
    first.load(500_000)
    for (const id of ['b', 'c', 'd']) overviewFor(id, '0')
    answer(250_000)
    expect(pending).toHaveLength(0)
    expect(first.count).toBe(0)
  })

  it('asks for a failed chunk again, from the same place', () => {
    const data = overviewFor('retry', '0')
    data.load(500_000)
    answer(250_000)
    pending.shift()!.cb({ error: 'Request timed out (getOverviewChunk)' })
    expect(pending).toHaveLength(0)
    jest.advanceTimersByTime(500)
    expect(pending).toHaveLength(1)
    expect(pending[0].req.cursor).toEqual({ key: 250_000, id: 250_000 })
    answer(250_000, true)
    expect(data.count).toBe(500_000)
    expect(data.done).toBe(true)
    expect(data.error).toBeNull()
  })

  it('gives up after a few tries, and clears the error when loading again', () => {
    const data = overviewFor('fails', '0')
    data.load(500_000)
    for (let i = 0; i < 4; i += 1) {
      pending.shift()!.cb({ error: 'boom' })
      jest.advanceTimersByTime(10_000)
    }
    expect(pending).toHaveLength(0)
    expect(data.error).toBe('boom')
    data.load(500_000)
    expect(data.error).toBeNull()
    expect(pending).toHaveLength(1)
    expect(pending[0].req.cursor).toBeNull()
  })
})

describe('the tone bits', () => {
  it('arrive in the store untouched, stage and tone apart', () => {
    const data = overviewFor('tones', '0')
    data.load(3)
    const { cb } = pending.shift()!
    cb({
      ids: new Uint32Array([1, 2, 3]),
      packed: new Uint8Array([
        8 | (1 << 6),
        2,
        9,
        31 | (2 << 6),
        4,
        5,
        63,
        255,
        255,
      ]),
      next: null,
    })
    const firsts = [0, 3, 6].map((i) => data.packed[i])
    expect(firsts.map(stageOfByte)).toEqual([8, 31, 63])
    expect(firsts.map(toneOfByte)).toEqual([1, 2, 0])
  })
})
