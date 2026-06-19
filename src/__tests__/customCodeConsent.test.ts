/**
 * @jest-environment node
 *
 * Custom-code consent gate.
 *
 * NOTE: the actual `sha256Hex` helper in src/renderer/components/Filters.tsx is
 * module-scope and NOT exported, so it can't be imported and unit-tested
 * directly without editing source. Instead this file tests the consent CONCEPT
 * that the gate is built on:
 *   1. the hex-digest format / algorithm the gate keys on (SHA-256, lowercase
 *      hex), reproduced here with node's crypto and asserted to be stable, and
 *   2. the approval-set semantics from Filters.tsx (lines ~442-462): an
 *      already-approved hash skips the prompt; an unknown one does not; newly
 *      approved hashes union into the saved list without duplicates.
 */
import crypto from 'crypto'

// Mirror of the renderer's sha256Hex contract: SHA-256, lowercase hex, no
// separators. (The renderer uses WebCrypto's crypto.subtle; node's crypto must
// produce the identical digest for the same input — that equivalence is the
// whole point of keying consent on the hash.)
function sha256HexNode(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

describe('sha256 digest format the consent gate keys on', () => {
  it('produces lowercase 64-char hex with no separators', () => {
    const h = sha256HexNode('return clips')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is stable for a known input (regression anchor)', () => {
    // SHA-256("") — the canonical empty-string digest.
    expect(sha256HexNode('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('differs when the code differs (a tweak invalidates prior approval)', () => {
    expect(sha256HexNode('return clips')).not.toBe(
      sha256HexNode('return clips // edited'),
    )
  })
})

// Replicates the gate logic in Filters.tsx: build a Set from
// config.approvedCustomCodeHashes, and a piece of custom code needs prompting
// iff its hash is not in that set.
function needsConsent(code: string, approvedHashes: string[]): boolean {
  const approved = new Set(approvedHashes)
  return !approved.has(sha256HexNode(code))
}

// Replicates the merge in Filters.tsx: union of existing + newly-approved
// hashes, deduplicated.
function mergeApproved(existing: string[], newlyApproved: string[]): string[] {
  return [...new Set([...existing, ...newlyApproved])]
}

describe('approval-set semantics', () => {
  const code = 'return clips.filter(c => c.combo?.didKill)'
  const codeHash = sha256HexNode(code)

  it('unknown code (empty approval list) requires consent', () => {
    expect(needsConsent(code, [])).toBe(true)
  })

  it('already-approved code skips the prompt', () => {
    expect(needsConsent(code, [codeHash])).toBe(false)
  })

  it('a different approved hash does not approve this code', () => {
    expect(needsConsent(code, [sha256HexNode('something else')])).toBe(true)
  })

  it('editing approved code re-triggers consent (hash no longer matches)', () => {
    const edited = `${code} // tweak`
    expect(needsConsent(edited, [codeHash])).toBe(true)
  })
})

describe('approved-hash merge (dedup union)', () => {
  it('adds a new hash to the saved list', () => {
    const merged = mergeApproved(['aaa'], ['bbb'])
    expect(merged).toEqual(['aaa', 'bbb'])
  })

  it('does not duplicate an already-saved hash', () => {
    const merged = mergeApproved(['aaa', 'bbb'], ['bbb', 'ccc'])
    expect(merged).toEqual(['aaa', 'bbb', 'ccc'])
  })

  it('is a no-op when re-approving the same hash', () => {
    expect(mergeApproved(['aaa'], ['aaa'])).toEqual(['aaa'])
  })
})
