/**
 * @jest-environment node
 *
 * Unit tests for the filter dependency-graph helpers (src/lib/filterGraph.ts).
 *
 * This logic decides what each filter reads from (`resolveInputId`) and, by
 * extension, which filters get wiped when an upstream filter is re-run or reset
 * (`getDescendantIds`). A regression here is data loss: re-running one branch
 * could silently reset an unrelated (and possibly very expensive) branch. Hence
 * the heavy coverage of the positional fallback, explicit inputIds, `files` as
 * root, and multi-branch descendant collection.
 */
import {
  FILES_TABLE,
  resolveInputId,
  getDescendantIds,
  hasActiveBranches,
  validInputsFor,
} from '../lib/filterGraph'

// Minimal shape used by the graph helpers (a subset of ShallowFilterInterface).
type F = { id: string; inputId?: string }

const mk = (id: string, inputId?: string): F => ({ id, inputId })

describe('FILES_TABLE', () => {
  it('is the literal "files"', () => {
    expect(FILES_TABLE).toBe('files')
  })
})

describe('resolveInputId — positional fallback (no inputId set)', () => {
  const chain = [mk('a'), mk('b'), mk('c')]

  it('first filter reads from the files table', () => {
    expect(resolveInputId(chain, 0)).toBe('files')
  })

  it('a middle filter reads from the filter directly above it', () => {
    expect(resolveInputId(chain, 1)).toBe('a')
    expect(resolveInputId(chain, 2)).toBe('b')
  })
})

describe('resolveInputId — explicit inputId (branching)', () => {
  // c explicitly branches off `files` instead of off b (its positional parent).
  const branched = [mk('a'), mk('b'), mk('c', 'files')]

  it('honors an explicit inputId pointing at files', () => {
    expect(resolveInputId(branched, 2)).toBe('files')
  })

  it('honors an explicit inputId pointing at an earlier filter', () => {
    const filters = [mk('a'), mk('b'), mk('c', 'a')]
    expect(resolveInputId(filters, 2)).toBe('a')
  })

  it('ignores (but preserves) inputId when branching is disabled', () => {
    // Same branched list, branchingEnabled=false → positional parent (b).
    expect(resolveInputId(branched, 2, false)).toBe('b')
    // And the first filter still falls back to files.
    expect(resolveInputId(branched, 0, false)).toBe('files')
  })

  it('a falsy/empty inputId falls back to positional', () => {
    const filters = [mk('a'), mk('b', '')]
    expect(resolveInputId(filters, 1)).toBe('a')
  })
})

describe('getDescendantIds — linear chain', () => {
  const chain = [mk('a'), mk('b'), mk('c'), mk('d')]

  it('collects every filter below the root, transitively', () => {
    expect(getDescendantIds(chain, 'a')).toEqual(new Set(['b', 'c', 'd']))
  })

  it('descendants of a middle node exclude earlier nodes', () => {
    expect(getDescendantIds(chain, 'b')).toEqual(new Set(['c', 'd']))
  })

  it('the last node has no descendants', () => {
    expect(getDescendantIds(chain, 'd')).toEqual(new Set())
  })

  it('descendants of the files table is the whole chain', () => {
    expect(getDescendantIds(chain, FILES_TABLE)).toEqual(
      new Set(['a', 'b', 'c', 'd']),
    )
  })

  it('never includes the root itself', () => {
    expect(getDescendantIds(chain, 'a').has('a')).toBe(false)
  })
})

describe('getDescendantIds — branching tree', () => {
  // Tree:
  //   files → a
  //   a → b   (positional)
  //   a → c   (explicit branch off a)
  //   c → d   (positional, sits below c)
  //   b → e   (positional, sits below d in the list but reads from b)
  //
  // List order: a, b, c, d, e
  const tree = [
    mk('a'), // files
    mk('b'), // positional → a
    mk('c', 'a'), // explicit branch → a
    mk('d'), // positional → c
    mk('e', 'b'), // explicit → b
  ]

  it('a is the root of everything', () => {
    expect(getDescendantIds(tree, 'a')).toEqual(new Set(['b', 'c', 'd', 'e']))
  })

  it('the b-branch (b → e) is isolated from the c-branch', () => {
    // Resetting b must only wipe e, NOT c or d.
    expect(getDescendantIds(tree, 'b')).toEqual(new Set(['e']))
  })

  it('the c-branch (c → d) is isolated from the b-branch', () => {
    // Resetting c must only wipe d, NOT b or e.
    expect(getDescendantIds(tree, 'c')).toEqual(new Set(['d']))
  })

  it('leaf nodes of each branch have no descendants', () => {
    expect(getDescendantIds(tree, 'd')).toEqual(new Set())
    expect(getDescendantIds(tree, 'e')).toEqual(new Set())
  })

  it('files reaches the entire tree', () => {
    expect(getDescendantIds(tree, FILES_TABLE)).toEqual(
      new Set(['a', 'b', 'c', 'd', 'e']),
    )
  })

  it('an unknown root id yields no descendants', () => {
    expect(getDescendantIds(tree, 'does-not-exist')).toEqual(new Set())
  })

  it('respects branchingEnabled=false (collapses to positional chain)', () => {
    // With branching off, e reads from d (its positional parent), c from b, etc.
    // So resetting a wipes the whole list positionally.
    expect(getDescendantIds(tree, 'a', false)).toEqual(
      new Set(['b', 'c', 'd', 'e']),
    )
    // And b's descendants are everything below it positionally.
    expect(getDescendantIds(tree, 'b', false)).toEqual(new Set(['c', 'd', 'e']))
  })
})

describe('hasActiveBranches', () => {
  it('is false for a plain positional chain with no inputIds', () => {
    expect(hasActiveBranches([mk('a'), mk('b'), mk('c')])).toBe(false)
  })

  it('is false when inputIds merely restate the positional default', () => {
    // a reads files, b reads a — both explicit but identical to positional.
    expect(hasActiveBranches([mk('a', 'files'), mk('b', 'a')])).toBe(false)
  })

  it('is true when a filter branches off a non-adjacent source', () => {
    // c reads from a instead of its positional parent b.
    expect(hasActiveBranches([mk('a'), mk('b'), mk('c', 'a')])).toBe(true)
  })

  it('is true when a later filter jumps back to files', () => {
    expect(hasActiveBranches([mk('a'), mk('b', 'files')])).toBe(true)
  })
})

describe('validInputsFor', () => {
  const filters = [mk('a'), mk('b'), mk('c')]

  it('the first filter can only read from files', () => {
    expect(validInputsFor(filters, 0)).toEqual(['files'])
  })

  it('a middle filter can read from files plus every earlier filter', () => {
    expect(validInputsFor(filters, 1)).toEqual(['files', 'a'])
    expect(validInputsFor(filters, 2)).toEqual(['files', 'a', 'b'])
  })

  it('never offers the filter itself or a later filter (no cycles)', () => {
    const inputs = validInputsFor(filters, 1)
    expect(inputs).not.toContain('b') // itself
    expect(inputs).not.toContain('c') // later
  })
})
