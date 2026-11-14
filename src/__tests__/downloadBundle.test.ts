/** @jest-environment node */
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { AddressInfo } from 'net'
import {
  DownloadLinkExpiredError,
  downloadBundle,
} from '../main/databaseClient'

// End-to-end continuation checks against a real HTTP server. Production only
// allows HTTPS storage hosts; these tests pass an allowlist for the local server.
const BODY = Buffer.from('0123456789'.repeat(1000))

type Behaviour = {
  etag?: string
  ignoreRange?: boolean
  truncateAt?: number
  status?: number
  redirectTo?: string
}

describe('downloadBundle', () => {
  let dir: string
  let server: http.Server
  let base: string
  let behaviour: Behaviour
  let lastRange: string | undefined

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      lastRange = req.headers.range
      if (behaviour.redirectTo) {
        res.writeHead(302, { Location: behaviour.redirectTo })
        res.end()
        return
      }
      if (behaviour.status) {
        res.writeHead(behaviour.status)
        res.end('denied')
        return
      }
      const etag = behaviour.etag ?? '"v1"'
      const match = req.headers.range?.match(/^bytes=(\d+)-$/)
      if (match && Number(match[1]) >= BODY.length) {
        // Storage's answer to a range that starts at the end of the object.
        res.writeHead(416, { 'Content-Range': `bytes */${BODY.length}` })
        res.end()
        return
      }
      const honour =
        match && !behaviour.ignoreRange && req.headers['if-range'] === etag
      const start = honour ? Number(match![1]) : 0
      const chunk = BODY.subarray(start)
      res.writeHead(honour ? 206 : 200, {
        ETag: etag,
        'Content-Length': String(chunk.length),
        ...(honour
          ? {
              'Content-Range': `bytes ${start}-${BODY.length - 1}/${BODY.length}`,
            }
          : {}),
      })
      if (behaviour.truncateAt != null) {
        // Flush the partial body before dropping the connection.
        res.write(chunk.subarray(0, behaviour.truncateAt), () =>
          setTimeout(() => res.destroy(), 50),
        )
      } else res.end(chunk)
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  )

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunar-download-'))
    behaviour = {}
    lastRange = undefined
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const allowLocal = (url: string) => url.startsWith(base)
  const target = () => path.join(dir, 'download.zip')
  const run = () =>
    downloadBundle(
      `${base}/bundle.zip`,
      target(),
      new AbortController().signal,
      () => {},
      allowLocal,
    )
  const seedPartial = (bytes: number, etag = '"v1"') => {
    fs.writeFileSync(`${target()}.part`, BODY.subarray(0, bytes))
    fs.writeFileSync(`${target()}.part.json`, JSON.stringify({ etag }))
  }

  it('downloads a whole file and cleans up its partial state', async () => {
    await run()
    expect(fs.readFileSync(target()).equals(BODY)).toBe(true)
    expect(fs.existsSync(`${target()}.part`)).toBe(false)
    expect(fs.existsSync(`${target()}.part.json`)).toBe(false)
  })

  it('continues a partial download of the same object', async () => {
    seedPartial(4000)
    await run()
    expect(lastRange).toBe('bytes=4000-')
    expect(fs.readFileSync(target()).equals(BODY)).toBe(true)
  })

  it('finishes a complete partial file whose rename failed, without a request (known total)', async () => {
    fs.writeFileSync(`${target()}.part`, BODY)
    fs.writeFileSync(
      `${target()}.part.json`,
      JSON.stringify({ etag: '"v1"', total: BODY.length }),
    )
    await run()
    expect(lastRange).toBeUndefined()
    expect(fs.readFileSync(target()).equals(BODY)).toBe(true)
    expect(fs.existsSync(`${target()}.part.json`)).toBe(false)
  })

  it('treats 416 "bytes */size" on a complete partial file as done (older .part.json without a total)', async () => {
    seedPartial(BODY.length)
    await run()
    expect(lastRange).toBe(`bytes=${BODY.length}-`)
    expect(fs.readFileSync(target()).equals(BODY)).toBe(true)
  })

  it('records the total in the .part.json so a later retry needs no request', async () => {
    behaviour.truncateAt = 2000
    await expect(run()).rejects.toThrow()
    const meta = JSON.parse(fs.readFileSync(`${target()}.part.json`, 'utf8'))
    expect(meta.total).toBe(BODY.length)
  })

  it('starts over when the object changed (If-Range mismatch)', async () => {
    seedPartial(4000, '"old"')
    behaviour.etag = '"v2"'
    await run()
    expect(fs.readFileSync(target()).equals(BODY)).toBe(true)
  })

  it('starts over when the server ignores the range', async () => {
    seedPartial(4000)
    behaviour.ignoreRange = true
    await run()
    expect(fs.readFileSync(target()).equals(BODY)).toBe(true)
  })

  it('keeps a truncated download so the next attempt can continue it', async () => {
    behaviour.truncateAt = 3000
    await expect(run()).rejects.toThrow()
    expect(fs.statSync(`${target()}.part`).size).toBe(3000)

    behaviour = {}
    await run()
    expect(lastRange).toBe('bytes=3000-')
    expect(fs.readFileSync(target()).equals(BODY)).toBe(true)
  })

  it('reports an expired link without discarding progress', async () => {
    seedPartial(4000)
    behaviour.status = 403
    await expect(run()).rejects.toBeInstanceOf(DownloadLinkExpiredError)
    expect(fs.statSync(`${target()}.part`).size).toBe(4000)
    expect(fs.existsSync(`${target()}.part.json`)).toBe(true)
  })

  it('refuses redirects to hosts outside the allowlist', async () => {
    behaviour.redirectTo = 'http://evil.example/bundle.zip'
    await expect(run()).rejects.toThrow(/Unsupported download redirect/)
  })
})
