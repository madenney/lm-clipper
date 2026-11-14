/** @jest-environment node */
import { DatabaseRequestError, parseRetryAfter } from '../main/databaseClient'
import {
  ExportGoneError,
  MaintenanceError,
  RetryLaterError,
  classifyRemoteError,
  isNetworkError,
  isTransientServerError,
  serverWaitSeconds,
} from '../main/transfers/errors'
import { describeFileSystemError, retryFs, retryFsSync } from '../main/fsRetry'
import { clientHeaders, setClientIdentity } from '../main/clientIdentity'

jest.mock('electron', () => ({ app: { getVersion: () => '3.1.4' } }))

const fsError = (code: string, syscall = 'rename') =>
  Object.assign(new Error(`${code}: boom`), { code, syscall })

describe('busy or restarting server (launch review DL-7, XC-3)', () => {
  it.each([500, 502, 503, 504, 408, 425, 429])(
    'a %i is transient: retried, and a pause (not a failure) once the waiting is over',
    (status) => {
      const error = new DatabaseRequestError('Database API timed out', status)
      expect(isTransientServerError(error)).toBe(true)
      expect(classifyRemoteError(error)).toBeInstanceOf(RetryLaterError)
    },
  )

  it('a 502 gets a calm message, not the raw upstream text', () => {
    const e = classifyRemoteError(
      new DatabaseRequestError('Database API is not running', 502),
    )
    expect(e.message).toMatch(/busy or restarting/)
    expect(e.message).not.toMatch(/Database API/)
  })

  it('what is not transient stays as it is', () => {
    for (const e of [
      new DatabaseRequestError('x', 400),
      new DatabaseRequestError('x', 404),
      new DatabaseRequestError('Daily cap', 429, 'direct_rate_limited'),
      new DatabaseRequestError('Moving', 503, 'maintenance'),
      new DatabaseRequestError('gone', 403, 'forbidden'),
    ])
      expect(isTransientServerError(e)).toBe(false)
    expect(
      classifyRemoteError(
        new DatabaseRequestError('Moving', 503, 'maintenance'),
      ),
    ).toBeInstanceOf(MaintenanceError)
    expect(
      classifyRemoteError(new DatabaseRequestError('gone', 404, 'not_found')),
    ).toBeInstanceOf(ExportGoneError)
  })

  it('an outdated client gets an update message', () => {
    for (const e of [
      new DatabaseRequestError('x', 426),
      new DatabaseRequestError('x', 400, 'client_outdated'),
    ]) {
      const out = classifyRemoteError(e)
      expect(out).not.toBeInstanceOf(RetryLaterError)
      expect(out.message).toMatch(/Update Lunar Clipper/)
    }
  })

  it('waits for Retry-After when given, else 5, 10, 20, 40, 60 seconds', () => {
    const plain = new DatabaseRequestError('x', 502)
    expect([1, 2, 3, 4, 5, 6].map((n) => serverWaitSeconds(plain, n))).toEqual([
      5, 10, 20, 40, 60, 60,
    ])
    expect(
      serverWaitSeconds(
        new DatabaseRequestError('x', 429, 'rate_limited', 45),
        1,
      ),
    ).toBe(45)
    expect(
      serverWaitSeconds(new DatabaseRequestError('x', 429, undefined, 9999), 1),
    ).toBe(120)
  })

  it('reads Retry-After as seconds or an HTTP date', () => {
    expect(parseRetryAfter('30')).toBe(30)
    expect(parseRetryAfter(['12'])).toBe(12)
    expect(parseRetryAfter('0')).toBeUndefined()
    expect(parseRetryAfter('soon')).toBeUndefined()
    expect(parseRetryAfter(undefined)).toBeUndefined()
    const now = Date.parse('2026-11-10T12:00:00Z')
    expect(parseRetryAfter('Tue, 10 Nov 2026 12:01:30 GMT', now)).toBe(90)
    expect(
      parseRetryAfter('Tue, 10 Nov 2026 11:00:00 GMT', now),
    ).toBeUndefined()
  })
})

describe('local file errors are not "check your internet" (DL-9, UX-5)', () => {
  it('EACCES from a write is not a network error and names the folder', () => {
    const error = fsError('EACCES', 'open')
    expect(isNetworkError(error)).toBe(false)
    const out = classifyRemoteError(error)
    expect(out).not.toBeInstanceOf(RetryLaterError)
    expect(out.message).toMatch(/can't write/)
    expect(out.message).toMatch(/Ransomware protection/)
    expect(out.message).not.toMatch(/internet/)
  })

  it('a real connection error still is one', () => {
    expect(isNetworkError(fsError('ECONNRESET', 'read'))).toBe(true)
    expect(isNetworkError(fsError('ENOTFOUND', 'getaddrinfo'))).toBe(true)
  })

  it('a full drive pauses with a plain message naming the drive', () => {
    const out = classifyRemoteError(fsError('ENOSPC', 'write'))
    expect(out).toBeInstanceOf(RetryLaterError)
    expect(out.message).toMatch(/drive.*full/)
    expect(out.message).not.toMatch(/ENOSPC/)
    expect(
      describeFileSystemError(fsError('ENOSPC'), 'D:\\Library\\x', 'win32')
        ?.message,
    ).toContain('(D:\\)')
  })

  it('describes locked, long and read-only cases and ignores the rest', () => {
    expect(describeFileSystemError(fsError('EBUSY'))?.kind).toBe('locked')
    expect(describeFileSystemError(fsError('ENAMETOOLONG'))?.kind).toBe(
      'path-too-long',
    )
    expect(describeFileSystemError(fsError('EROFS'))?.kind).toBe('read-only')
    expect(describeFileSystemError(fsError('ENOENT'))).toBeNull()
    expect(describeFileSystemError(new Error('plain'))).toBeNull()
    expect(describeFileSystemError(null)).toBeNull()
  })
})

describe('retryFs', () => {
  it('retries EPERM/EBUSY and then succeeds', async () => {
    let n = 0
    const out = await retryFs(
      async () => {
        if (++n < 3) throw fsError('EPERM')
        return 'ok'
      },
      'test',
      6,
      1,
    )
    expect(out).toBe('ok')
    expect(n).toBe(3)
  })

  it('gives up on other errors at once and after the last attempt on locks', async () => {
    let n = 0
    await expect(
      retryFs(
        async () => {
          n++
          throw fsError('ENOENT')
        },
        'test',
        6,
        1,
      ),
    ).rejects.toThrow()
    expect(n).toBe(1)
    n = 0
    await expect(
      retryFs(
        async () => {
          n++
          throw fsError('EBUSY')
        },
        'test',
        3,
        1,
      ),
    ).rejects.toThrow()
    expect(n).toBe(3)
  })

  it('has a synchronous twin for transfers.json', () => {
    let n = 0
    expect(
      retryFsSync(
        () => {
          if (++n < 2) throw fsError('EBUSY')
          return 7
        },
        'test',
        4,
        1,
      ),
    ).toBe(7)
  })
})

describe('client identity headers (XC-4, DL-13)', () => {
  it('names the app and platform and never sends the install id', () => {
    setClientIdentity({ version: '3.1.4' })
    const h = clientHeaders()
    expect(h['User-Agent']).toMatch(/^LunarClipper\/3\.1\.4 \(/)
    expect(h['X-Lunar-App-Version']).toBe('3.1.4')
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain('x-lunar-install-id')
  })
})
