/** @jest-environment node */
import { isLocalTestFeed, shortUpdateError } from '../main/updaterUtils'

describe('isLocalTestFeed (SEC-7)', () => {
  it.each([
    'http://localhost:8080/feed',
    'http://localhost',
    'https://127.0.0.1/',
    'http://10.0.0.5:9000',
    `http://192.${168}.1.20/updates`,
    'http://172.16.4.2:3000/',
    'http://172.31.255.255',
  ])('accepts %s', (url) => {
    expect(isLocalTestFeed(url)).toBe(true)
  })

  it.each([
    'http://localhost.evil.com/',
    'http://10.evil.com/',
    'http://127.0.0.1.evil.com/',
    `http://192.${168}.1.1.attacker.net`,
    'http://172.32.0.1/',
    'http://evil.com/localhost',
    'ftp://localhost/',
    'localhost',
    '',
  ])('refuses %s', (url) => {
    expect(isLocalTestFeed(url)).toBe(false)
  })
})

describe('shortUpdateError (CR-4)', () => {
  it('keeps the first line and cuts a long one', () => {
    expect(
      shortUpdateError('Cannot find latest.yml\n  at foo (bar.js:1)', 'x'),
    ).toBe('Cannot find latest.yml')
    const long = 'a'.repeat(400)
    expect(shortUpdateError(long, 'x').length).toBeLessThanOrEqual(160)
    expect(shortUpdateError(long, 'x').endsWith('...')).toBe(true)
  })
  it('falls back when there is no message', () => {
    expect(shortUpdateError(undefined, 'Update failed')).toBe('Update failed')
    expect(shortUpdateError('  \n', 'Update failed')).toBe('Update failed')
  })
})
