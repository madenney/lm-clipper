/**
 * Compressed GameCube disc images (.rvz, .gcz, .ciso, .wia, .nkit.iso) have other headers than a
 * plain .iso, so the setup wizard's check (it reads the first six bytes as the game ID) used to say
 * "This does not appear to be a Melee ISO" with binary characters in it, for an image Dolphin
 * plays happily. main/isoCheck.ts (the check before recording) already skips them; so does the
 * wizard now.
 */
const COMPRESSED = /\.(rvz|gcz|ciso|wia|nkit\.iso|nkit\.gcz)$/i

/** The image's kind (".rvz"), or null for a plain .iso / other file. */
export function compressedImageKind(path: string): string | null {
  const match = COMPRESSED.exec(String(path || '').trim())
  return match ? `.${match[1].toLowerCase()}` : null
}

/** What the wizard says for such a file. */
export const compressedImageMessage = (kind: string) =>
  `This is a compressed disc image (${kind}). Clipper can't check inside it, but Dolphin plays it as it is.`
