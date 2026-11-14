/** @jest-environment node */
import crypto from 'crypto'
import {
  MAX_TEST_SAMPLE,
  _resetSessionApprovals,
  approveOnce,
  approvedHashes,
  clampSampleSize,
  customCodeOf,
  hashCustomCode,
  rememberApproval,
  unapprovedCodeHash,
} from '../main/customCodeApproval'

const sha = (t: string) =>
  crypto.createHash('sha256').update(t, 'utf8').digest('hex')

beforeEach(() => _resetSessionApprovals())

describe('customCodeApproval (the gate main enforces)', () => {
  it('hashes like the renderer: SHA-256 lowercase hex of the UTF-8 code', () => {
    expect(hashCustomCode('return clips')).toBe(sha('return clips'))
    expect(hashCustomCode('é')).toBe(sha('é'))
  })

  it('only custom and AI Filter steps carry code', () => {
    expect(
      customCodeOf({ type: 'custom', params: { code: 'return []' } }),
    ).toBe('return []')
    expect(
      customCodeOf({ type: 'aiFilter', params: { code: 'return x' } }),
    ).toBe('return x')
    expect(
      customCodeOf({ type: 'comboFilter', params: { code: 'x' } }),
    ).toBeUndefined()
    expect(
      customCodeOf({ type: 'custom', params: { code: '  ' } }),
    ).toBeUndefined()
    expect(customCodeOf({ type: 'custom', params: null })).toBeUndefined()
  })

  it('an unknown piece of code is unapproved; remembering or running once approves exactly it', () => {
    const config: any = { approvedCustomCodeHashes: [], savedCustomFilters: [] }
    const step = { type: 'aiFilter', params: { code: 'return clips' } }
    expect(unapprovedCodeHash(step, config)).toBe(sha('return clips'))
    approveOnce([sha('return clips')])
    expect(unapprovedCodeHash(step, config)).toBeNull()
    _resetSessionApprovals()
    expect(unapprovedCodeHash(step, config)).not.toBeNull()
    rememberApproval(config, sha('return clips'))
    rememberApproval(config, sha('return clips'))
    expect(config.approvedCustomCodeHashes).toEqual([sha('return clips')])
    expect(unapprovedCodeHash(step, config)).toBeNull()
    // An edit is a new piece of code.
    expect(
      unapprovedCodeHash(
        { type: 'aiFilter', params: { code: 'return clips;' } },
        config,
      ),
    ).not.toBeNull()
  })

  it('ignores junk passed as "run once" hashes', () => {
    approveOnce('nope')
    approveOnce([1, 'abc', null, { x: 1 }])
    expect(
      approvedHashes({ approvedCustomCodeHashes: [], savedCustomFilters: [] })
        .size,
    ).toBe(0)
  })

  it('built-in templates are approved as shipped', () => {
    const config: any = {
      approvedCustomCodeHashes: [],
      savedCustomFilters: [
        { name: 'A', code: 'return clips', builtIn: true },
        { name: 'B', code: 'return evil', builtIn: false },
      ],
    }
    expect(
      unapprovedCodeHash(
        { type: 'custom', params: { code: 'return clips' } },
        config,
      ),
    ).toBeNull()
    expect(
      unapprovedCodeHash(
        { type: 'custom', params: { code: 'return evil' } },
        config,
      ),
    ).not.toBeNull()
  })

  it('caps the test-run sample size', () => {
    expect(clampSampleSize(undefined)).toBe(5)
    expect(clampSampleSize(0)).toBe(5)
    expect(clampSampleSize(-3)).toBe(5)
    expect(clampSampleSize('1000000')).toBe(5)
    expect(clampSampleSize(7.9)).toBe(7)
    expect(clampSampleSize(10_000_000)).toBe(MAX_TEST_SAMPLE)
    expect(clampSampleSize(NaN)).toBe(5)
  })
})
