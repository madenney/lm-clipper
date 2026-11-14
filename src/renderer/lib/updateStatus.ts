/**
 * The update banner's text and when it speaks. The launch check is silent: an offline PC, a firewall
 * or a release feed with no update file yet must not greet every start with a red error. Main's
 * updater forwards every error event (silent check or not), so the renderer decides: an error
 * counts only when the user asked for the check (Help > Check for Updates) or an update was
 * already found and is being downloaded.
 */

/** A plain sentence for an updater error (the raw text stays one click away as Details). */
export function updateErrorText(raw: string): string {
  const text = String(raw || '')
  if (
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|net::ERR_|getaddrinfo|socket hang up|timed? ?out/i.test(
      text,
    )
  )
    return "Couldn't reach the update server. Check your internet connection and try again later."
  if (/404|Cannot find (latest|channel)|no published versions/i.test(text))
    return 'No update information is published yet. Try again later.'
  if (/403|429|rate limit/i.test(text))
    return 'The update server is busy right now. Try again later.'
  return "Couldn't check for updates. Try again later."
}

/** The raw error, cut to a sane length for the Details line. */
export function updateErrorDetails(raw: string, max = 400): string {
  const text = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
