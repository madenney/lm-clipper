/**
 * What the tray says when a step has nothing to show. It used to say "Run this filter to see
 * results" for everything: a step that had run and found nothing, a step running right now, and a
 * failed read. Each is a different situation with a different next move.
 */
export type EmptyResultsState = {
  /** The step is running right now. */
  running: boolean
  /** Reading its results failed (a busy or locked project). */
  readError: boolean
  /** The step has run. */
  processed: boolean
  /** The step's type (filter.type), to say what to loosen. */
  type?: string
}

export type EmptyResultsCopy = {
  title: string
  subtitle: string
  /** Offer a Retry button (the read failed). */
  retry?: boolean
}

const EDGEGUARD_TYPES = new Set(['edgeguard', 'edgeguardFilter'])
const COMBO_TYPES = new Set(['slpParser', 'comboFilter', 'reverse'])

export function emptyResultsCopy(state: EmptyResultsState): EmptyResultsCopy {
  if (state.readError) {
    return {
      title: "Couldn't read these results",
      subtitle:
        'The project may be busy with something else. Try again in a moment.',
      retry: true,
    }
  }
  if (state.running) {
    return {
      title: 'Running...',
      subtitle: 'Results show up here as they are found.',
    }
  }
  if (state.processed) {
    const type = state.type ?? ''
    if (EDGEGUARD_TYPES.has(type)) {
      return {
        title: 'No edgeguards found',
        subtitle:
          'Nothing matched. Try a wider stage zone, fewer conditions, or run it on more games.',
      }
    }
    if (COMBO_TYPES.has(type)) {
      return {
        title: 'No combos found',
        subtitle:
          'Nothing matched. Try fewer minimum hits or fewer characters, or run it on more games.',
      }
    }
    return {
      title: 'Nothing found',
      subtitle:
        'No clips matched this step. Loosen its settings on the left and run it again, or run it on more games.',
    }
  }
  return {
    title: 'No clips to display',
    subtitle: 'Run this filter to see results',
  }
}
