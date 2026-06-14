// Helpers for the filter dependency graph.
//
// Filters used to form a strict linear chain: each read from the one directly
// above it. With per-filter `inputId` (branching), a filter can read from any
// earlier filter — or from `files` — so the chain becomes a tree. These helpers
// centralize "what does this filter read from?" and "what depends on it?" so the
// executor, reorder, and reset paths all agree.
//
// Backward-compatible: when no filter sets `inputId`, every function behaves
// exactly as the old positional logic (input = previous filter; descendants =
// everything below).

export const FILES_TABLE = 'files'

type GraphFilter = { id: string; inputId?: string }

/**
 * The table id a filter reads from: its explicit `inputId` when set, otherwise
 * the filter directly above it (or `files` for the first filter).
 */
export function resolveInputId(
  filters: GraphFilter[],
  index: number,
  branchingEnabled = true,
): string {
  const f = filters[index]
  // When branching is disabled, ignore (but preserve) saved inputIds and fall
  // back to the positional chain — each filter reads from the one above it.
  if (branchingEnabled && f?.inputId) return f.inputId
  return index === 0 ? FILES_TABLE : filters[index - 1].id
}

/**
 * Ids of every filter that (transitively) reads from `rootId`. Does NOT include
 * `rootId` itself. Resolves the positional fallback for filters without an
 * explicit inputId, so it's correct for mixed linear/branched lists.
 */
export function getDescendantIds(
  filters: GraphFilter[],
  rootId: string,
  branchingEnabled = true,
): Set<string> {
  const descendants = new Set<string>()
  let added = true
  while (added) {
    added = false
    // Plain for-loop (not forEach) so the body isn't a function declared in the
    // loop closing over `added` — keeps the linter happy and is just as clear.
    for (let i = 0; i < filters.length; i += 1) {
      const f = filters[i]
      if (descendants.has(f.id)) continue
      const input = resolveInputId(filters, i, branchingEnabled)
      if (input === rootId || descendants.has(input)) {
        descendants.add(f.id)
        added = true
      }
    }
  }
  return descendants
}

/**
 * True if any filter reads from a source other than the one directly above it —
 * i.e. the project actually uses branching (ignores inputIds that merely restate
 * the positional default). Used to decide whether disabling branching needs a
 * heads-up.
 */
export function hasActiveBranches(filters: GraphFilter[]): boolean {
  return filters.some((f, i) => {
    if (!f.inputId) return false
    const positional = i === 0 ? FILES_TABLE : filters[i - 1].id
    return f.inputId !== positional
  })
}

/**
 * Filters that are valid inputs for the filter at `index`: `files` plus every
 * filter earlier in the list. Restricting to earlier filters guarantees no
 * cycles and that run-all (which executes top-to-bottom) always has the input
 * table ready before it reaches the consumer.
 */
export function validInputsFor(
  filters: GraphFilter[],
  index: number,
): string[] {
  const earlier = filters.slice(0, index).map((f) => f.id)
  return [FILES_TABLE, ...earlier]
}
