/** The warning before the Replays step removes replays from Clipper. The
 *  files themselves are never deleted (main/managers/ClipManager.ts), so the
 *  button says "Remove" and the text says how to get the disk space back. */
export function deleteReplaysCopy(games: number): {
  title: string
  body: string
} {
  const one = games === 1
  const n = games.toLocaleString('en-US')
  return {
    title: one
      ? 'Remove 1 replay from Clipper?'
      : `Remove ${n} replays from Clipper?`,
    body: one
      ? 'It will be removed from this project and your library, along with every clip made from it. The replay file stays on your disk: to get the space back, delete it yourself in your file manager.'
      : 'They will be removed from this project and your library, along with every clip made from them. The replay files stay on your disk: to get the space back, delete them yourself in your file manager.',
  }
}
