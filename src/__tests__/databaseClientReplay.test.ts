import http from 'http'
import zlib from 'zlib'
import { AddressInfo } from 'net'
import { DatabaseClient, DatabaseRequestError } from '../main/databaseClient'

const SLP = Buffer.concat([
  Buffer.from('{U\x03raw[$U#l', 'latin1'),
  Buffer.alloc(100, 7),
])

describe('DatabaseClient.replay', () => {
  let server: http.Server
  let client: DatabaseClient
  const seen: string[] = []

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push(req.url || '')
      const id = new URL(req.url || '/', 'http://x').searchParams.get(
        'replayId',
      )
      if (id === 'a'.repeat(24)) {
        res.writeHead(200, { 'Content-Encoding': 'gzip' })
        res.end(zlib.gzipSync(SLP))
      } else if (id === 'b'.repeat(24)) {
        res.writeHead(200)
        res.end(SLP)
      } else if (id === 'c'.repeat(24)) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': '7',
        })
        res.end(JSON.stringify({ code: 'rate_limited', error: 'Slow down' }))
      } else if (id === 'f'.repeat(24)) {
        // Half a gzip body, then the connection is cut.
        const gz = zlib.gzipSync(Buffer.alloc(256 * 1024, 3))
        res.writeHead(200, { 'Content-Encoding': 'gzip' })
        res.write(gz.subarray(0, gz.length >> 1), () => res.destroy())
      } else if (id === 'e'.repeat(24)) {
        res.writeHead(200)
        res.end(Buffer.alloc(65 * 1024 * 1024))
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Replay not found' }))
      }
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    client = new DatabaseClient(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    )
  })
  afterAll(() => server.close())

  it('returns the .slp, gzip or not, from the replay route', async () => {
    expect((await client.replay('a'.repeat(24))).equals(SLP)).toBe(true)
    expect((await client.replay('b'.repeat(24))).equals(SLP)).toBe(true)
    expect(seen[0]).toBe(
      `/api/download?action=replay&replayId=${'a'.repeat(24)}`,
    )
  })

  it('throws errors with status, code and Retry-After', async () => {
    const busy = await client.replay('c'.repeat(24)).catch((e) => e)
    expect(busy).toBeInstanceOf(DatabaseRequestError)
    expect(busy).toMatchObject({
      status: 429,
      code: 'rate_limited',
      retryAfterSeconds: 7,
    })
    const missing = await client.replay('d'.repeat(24)).catch((e) => e)
    expect(missing).toMatchObject({ status: 404, message: 'Replay not found' })
  })

  it('fails, never hangs, when a gzip body is cut off', async () => {
    await expect(client.replay('f'.repeat(24))).rejects.toThrow()
  }, 10000)

  it('refuses bad ids and runaway files', async () => {
    await expect(client.replay('nope')).rejects.toThrow('Invalid replay id')
    await expect(client.replay('e'.repeat(24))).rejects.toThrow('too large')
  })
})
