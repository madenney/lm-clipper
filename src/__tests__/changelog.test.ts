import { CHANGELOG, type ChangelogEntry } from '../constants/changelog'
import { compareVersions, entriesToShow } from '../lib/changelog'
import packageJson from '../../package.json'

const entry = (version: string): ChangelogEntry => ({
  version,
  date: '2026-01-01',
  summary: version,
  groups: [],
})
const log = ['3.1.0', '3.0.1', '3.0.0', '2.0.0-beta.5'].map(entry)

describe('compareVersions', () => {
  it('orders numbers, not text', () => {
    expect(compareVersions('3.0.10', '3.0.9')).toBe(1)
    expect(compareVersions('2.9.0', '10.0.0')).toBe(-1)
    expect(compareVersions('3.0.0', 'v3.0.0')).toBe(0)
  })
  it('puts a prerelease before its release and orders prerelease numbers', () => {
    expect(compareVersions('3.0.0-beta.2', '3.0.0')).toBe(-1)
    expect(compareVersions('2.0.0-beta.10', '2.0.0-beta.9')).toBe(1)
    expect(compareVersions('3.0.0-beta.1', '2.9.9')).toBe(1)
  })
  it('says null when a version is unreadable', () => {
    expect(compareVersions('dev', '3.0.0')).toBeNull()
  })
})

describe('entriesToShow', () => {
  it('shows everything missed, newest first', () => {
    expect(
      entriesToShow(log, '2.0.0-beta.5', '3.1.0').map((e) => e.version),
    ).toEqual(['3.1.0', '3.0.1', '3.0.0'])
  })
  it('shows only the new version for a one-step update', () => {
    expect(entriesToShow(log, '3.0.0', '3.0.1').map((e) => e.version)).toEqual([
      '3.0.1',
    ])
  })
  it('shows nothing when nothing changed, or after a downgrade', () => {
    expect(entriesToShow(log, '3.0.1', '3.0.1')).toEqual([])
    expect(entriesToShow(log, '3.1.0', '3.0.1')).toEqual([])
  })
  it('with no history shows just the running version', () => {
    expect(
      entriesToShow(log, undefined, '3.0.1').map((e) => e.version),
    ).toEqual(['3.0.1'])
  })
  it('shows nothing for a version with no notes (a dev build)', () => {
    expect(entriesToShow(log, '3.0.0', '9.9.9')).toEqual([])
    expect(entriesToShow(log, '3.0.0', '')).toEqual([])
  })
})

describe('the real changelog', () => {
  it('is newest first with unique, readable versions and real content', () => {
    const all = CHANGELOG.map((e) => e.version)
    expect(new Set(all).size).toBe(all.length)
    for (let i = 1; i < all.length; i++) {
      expect(compareVersions(all[i - 1], all[i])).toBe(1)
    }
    for (const e of CHANGELOG) {
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(e.summary.length).toBeGreaterThan(10)
      expect(e.groups.length).toBeGreaterThan(0)
      for (const g of e.groups) expect(g.items.length).toBeGreaterThan(0)
    }
  })
  it('has an entry for the version in package.json', () => {
    const { version } = packageJson
    expect(versions()).toContain(version)
  })
  it('never names owner-only tools', () => {
    // Built from parts so this public file does not spell the private name itself.
    const ownerWord = ['stu', 'dio'].join('')
    expect(JSON.stringify(CHANGELOG)).not.toMatch(new RegExp(ownerWord, 'i'))
  })
})

function versions() {
  return CHANGELOG.map((e) => e.version)
}
