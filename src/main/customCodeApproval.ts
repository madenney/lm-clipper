/*
 * The consent gate for Custom Code and AI Filter steps, enforced in the main
 * process (launch review SEC-1, SEC-2, FLT-20).
 *
 * Custom code runs with the user's full privileges (node:vm is not a sandbox),
 * so it must never run unless the user said yes to exactly that code. The
 * renderer asks (the "Run custom code?" modal) and remembers "Always trust" by
 * the code's SHA-256 in config.approvedCustomCodeHashes; "Run once" is told to
 * main through approveOnce. Main refuses to run any custom code whose hash is in
 * neither list nor a built-in template, so a renderer bug, Run All or a workflow
 * cannot start code the user was never asked about.
 */
import crypto from 'crypto'
import type { ConfigInterface } from '../constants/types'

/** Most rows a code test, or a sample of one, may load. */
export const MAX_TEST_SAMPLE = 50

/** Longest custom code accepted for a test run (characters). */
export const MAX_TEST_CODE_CHARS = 200_000

const sessionApproved = new Set<string>()

export const hashCustomCode = (code: string): string =>
  crypto.createHash('sha256').update(code, 'utf8').digest('hex')

/** "Run once": this code may run for the rest of this session (not saved). */
export function approveOnce(hashes: unknown) {
  if (!Array.isArray(hashes)) return
  for (const h of hashes)
    if (typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)) {
      // A bounded set: it only lives until the app closes.
      if (sessionApproved.size > 1000) sessionApproved.clear()
      sessionApproved.add(h)
    }
}

/** The set of hashes allowed to run: remembered ones, this session's, and the
 *  built-in templates that ship with the app (their unmodified code). */
export function approvedHashes(
  config: Pick<
    ConfigInterface,
    'approvedCustomCodeHashes' | 'savedCustomFilters'
  >,
): Set<string> {
  const out = new Set<string>(sessionApproved)
  for (const h of config.approvedCustomCodeHashes ?? []) out.add(h)
  for (const t of config.savedCustomFilters ?? [])
    if (t.builtIn && typeof t.code === 'string' && t.code.trim())
      out.add(hashCustomCode(t.code))
  return out
}

/** The code a step would run, when it has some. */
export function customCodeOf(filter: {
  type?: string
  params?: Record<string, unknown> | null
}): string | undefined {
  if (filter.type !== 'custom' && filter.type !== 'aiFilter') return undefined
  const code = filter.params?.code
  return typeof code === 'string' && code.trim() ? code : undefined
}

/** The hash of this step's code when it is NOT approved to run; null when the
 *  step has no custom code or its code is approved. */
export function unapprovedCodeHash(
  filter: { type?: string; params?: Record<string, unknown> | null },
  config: Pick<
    ConfigInterface,
    'approvedCustomCodeHashes' | 'savedCustomFilters'
  >,
): string | null {
  const code = customCodeOf(filter)
  if (code === undefined) return null
  const hash = hashCustomCode(code)
  return approvedHashes(config).has(hash) ? null : hash
}

/** "Always trust": remember this code (by hash) in the config's list. */
export function rememberApproval(
  config: Pick<ConfigInterface, 'approvedCustomCodeHashes'>,
  hash: string,
) {
  const list = config.approvedCustomCodeHashes ?? []
  if (!list.includes(hash)) config.approvedCustomCodeHashes = [...list, hash]
}

export const UNAPPROVED_CODE_MESSAGE =
  'This step has custom code you have not approved to run on this computer. Run it from the Filters panel and choose Run once or Always trust.'

/** A test run's sample size: a whole number from 1 to MAX_TEST_SAMPLE (default 5). */
export function clampSampleSize(value: unknown): number {
  const n = typeof value === 'number' ? Math.floor(value) : NaN
  if (!Number.isFinite(n) || n < 1) return 5
  return Math.min(n, MAX_TEST_SAMPLE)
}

/** Test hook. */
export function _resetSessionApprovals() {
  sessionApproved.clear()
}
