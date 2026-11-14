import { DatabaseRequestError } from '../databaseClient'
import { describeFileSystemError } from '../fsRetry'
import {
  EXPORT_GONE_CODES,
  RETRY_LATER_CODES,
  MAINTENANCE_CODES,
} from '../../constants/database'

/** The server-side export can't be used any more (expired, removed, failed,
 *  or the desktop grant lapsed). Only a new export can continue. */
export class ExportGoneError extends Error {}

/** A temporary server condition (rate limit, download cap, busy storage). */
export class RetryLaterError extends Error {}

/** The owner took the database down for maintenance: transfers wait (keeping
 *  what's on disk) and resume by themselves once it's back. */
export class MaintenanceError extends Error {}

/** A transfer's line while the database is down for maintenance. */
export function maintenanceDetail(message: string): string {
  const text = message.trim().replace(/[.!]+$/, '') || 'Down for maintenance'
  return `Lunar Database: ${text}. Resumes by itself when it's back.`
}

/** Is this error the database's maintenance answer? */
export function isMaintenanceError(error: unknown): boolean {
  return (
    error instanceof DatabaseRequestError &&
    !!error.code &&
    (MAINTENANCE_CODES as readonly string[]).includes(error.code)
  )
}

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  // Not EACCES: a refused local write (read-only or protected folder, antivirus)
  // has that code too, and is not an internet problem (launch review DL-9).
  'EPIPE',
])

/**
 * The connection itself failed (no answer from the server): Wi-Fi dropped, a
 * firewall, DNS. Node reports a failed connect to a host with IPv4 and IPv6
 * addresses as an AggregateError with an EMPTY message (seen on the Windows
 * rig, 2026-10-15: the transfer said only "Transfer needs attention.").
 */
export function isNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if (error instanceof DatabaseRequestError) return false
  const e = error as { code?: unknown; errors?: unknown; message?: unknown }
  if (typeof e.code === 'string' && NETWORK_CODES.has(e.code)) return true
  if (Array.isArray(e.errors) && e.errors.length)
    return e.errors.every((x) => isNetworkError(x))
  return (
    typeof e.message === 'string' &&
    /^(Connection timed out\. Please retry\.|socket hang up)$/.test(e.message)
  )
}

/** A network failure in words, with the code(s) Node gave. */
export function networkErrorMessage(error: unknown): string {
  const codes = new Set<string>()
  const walk = (x: unknown) => {
    const e = x as { code?: unknown; errors?: unknown }
    if (typeof e?.code === 'string') codes.add(e.code)
    if (Array.isArray(e?.errors)) e.errors.forEach(walk)
  }
  walk(error)
  return `Can't reach lunarmelee.com${codes.size ? ` (${[...codes].join(', ')})` : ''}. Check your internet connection, then Resume: games already downloaded are kept.`
}

/** Statuses that mean "the website or database is busy or restarting": wait
 *  and try again (launch review DL-7: the home database behind a tunnel). */
const TRANSIENT_STATUSES = [408, 425, 429, 500, 502, 503, 504]

/** The website/database answered with something that passes: a rate limit, a
 *  busy or restarting server (502/504 from the tunnel or Cloudflare). Not the
 *  daily direct-download cap, not maintenance, not a gone export. */
export function isTransientServerError(error: unknown): boolean {
  if (!(error instanceof DatabaseRequestError)) return false
  if (isMaintenanceError(error)) return false
  if (error.code === 'direct_rate_limited') return false
  if (
    error.code &&
    (EXPORT_GONE_CODES as readonly string[]).includes(error.code)
  )
    return false
  if (error.code === 'client_outdated' || error.status === 426) return false
  return TRANSIENT_STATUSES.includes(error.status)
}

/** Seconds to wait before retry number `attempt` (1-based) of a transient
 *  server answer: its Retry-After when it gave one, else 5, 10, 20, 40, 60. */
export function serverWaitSeconds(
  error: DatabaseRequestError,
  attempt: number,
): number {
  const backoff = Math.min(5 * 2 ** (attempt - 1), 60)
  return Math.min(error.retryAfterSeconds || backoff, 120)
}

/** The server told this build to update (HTTP 426 / code client_outdated). */
export function isClientOutdatedError(error: unknown): boolean {
  return (
    error instanceof DatabaseRequestError &&
    (error.status === 426 || error.code === 'client_outdated')
  )
}

/** Classify a failed website/database request for the transfer state machine. */
export function classifyRemoteError(error: unknown): Error {
  if (isNetworkError(error)) return new Error(networkErrorMessage(error))
  if (!(error instanceof DatabaseRequestError)) {
    // A failed write into the library: say what is wrong with the folder, not
    // the raw errno. A full drive pauses (Resume once there is room).
    const problem = describeFileSystemError(error)
    if (problem)
      return problem.kind === 'disk-full' || problem.kind === 'locked'
        ? new RetryLaterError(problem.message)
        : new Error(problem.message)
    return error as Error
  }
  const code = error.code as string | undefined
  // Before the generic 503 rule: maintenance waits and resumes by itself.
  if (isMaintenanceError(error)) return new MaintenanceError(error.message)
  if (isClientOutdatedError(error))
    return new Error(
      "This version of Lunar Clipper is too old for Lunar's servers. Update Lunar Clipper (Help > Check for updates), then Resume.",
    )
  if (code && (EXPORT_GONE_CODES as readonly string[]).includes(code))
    return new ExportGoneError(error.message)
  if (code && (RETRY_LATER_CODES as readonly string[]).includes(code))
    return new RetryLaterError(error.message)
  if (error.status === 429 || error.status === 503)
    return new RetryLaterError(error.message)
  if (isTransientServerError(error))
    return new RetryLaterError(
      "Lunar's servers are busy or restarting; nothing is lost.",
    )
  return error
}
