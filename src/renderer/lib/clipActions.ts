/**
 * Play / Record on one clip (the card's buttons, Single view, the P and R keys) must not start a
 * second Dolphin on top of a recording or a preview that is still running: the first job lost
 * its Stop button and the footer said "Done" while the second ran. The action bar already hides
 * its own buttons then; this is the same rule for the per-clip ones.
 */
export type ClipJobState = { isGenerating: boolean; isPlaying: boolean }

/** Why a per-clip Play or Record can't start right now, or null when it can. */
export function clipActionBlock(
  state: ClipJobState,
  action: 'play' | 'record',
): string | null {
  if (state.isGenerating) {
    return action === 'record'
      ? 'A recording is already running. Stop it, or wait for it to finish, before recording another clip.'
      : 'A recording is running. Wait for it to finish (or stop it) before playing a clip.'
  }
  if (state.isPlaying) {
    return action === 'record'
      ? 'A clip is playing in Dolphin. Close it before recording.'
      : 'A clip is already playing in Dolphin. Close it before playing another.'
  }
  return null
}
