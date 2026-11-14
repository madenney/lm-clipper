import { useEffect, useRef, useState } from 'react'
import ipcBridge from 'renderer/ipcBridge'
import {
  damageValid,
  hitsValid,
  limitsProblem,
  normalizeDecimalInput,
} from '../lib/limitInput'
import { shownProjectName } from '../../constants/defaultProject'
import AnimatedCount from './AnimatedCount'
import { resolveCharacterImage } from '../lib/clipAssets'
import type { PlayerInterface } from '../../constants/types'
import { sortedCharacters } from '../../constants/characters'
import CharacterSelect from './CharacterSelect'
import { legalStages } from '../../constants/stages'
import StageSelect from './StageSelect'
import {
  ClipSearchFilters,
  ClipSearchReply,
  ClipType,
  LunarClip,
  MAX_CLIPS_PER_ADD,
  defaultClipSearch,
} from '../../constants/clipSearch'
import type { Transfer } from '../../constants/database'
import SearchBox, { TournamentPick, playerLabel } from './SearchBox'
import { OwnerClipSearchActions } from '../../owner/renderer'

const TYPES: { value: ClipType; label: string }[] = [
  { value: 'combo', label: 'Combos' },
  { value: 'edgeguard', label: 'Edgeguards' },
]

/** The clip search in words: "Kill combos by XX#02 (Hax$) as Fox vs Marth ·
 *  Battlefield · KOTJ #7". The player picked plays the Player character. */
function describeClipSearch(
  f: ClipSearchFilters,
  tournaments: TournamentPick[],
): string {
  const chars = (ids: string[]) =>
    ids.map((id) => charName(Number(id))).join(' or ')
  const players = (codes: string) =>
    codes ? codes.split(',').map(playerLabel).join(' or ') : ''
  const side = (codes: string, ids: string[]) =>
    [players(codes), ids.length ? `as ${chars(ids)}` : '']
      .filter(Boolean)
      .join(' ')
  const by = side(f.attackerConnectCode, f.attackerCharacterId)
  const kind =
    f.type === 'edgeguard'
      ? 'Edgeguards'
      : f.type === 'quitout'
        ? 'Quit-outs'
        : `${f.zeroToDeath ? 'Zero-to-death ' : f.killOnly ? 'Kill ' : ''}${f.zeroToDeath || f.killOnly ? 'combos' : 'Combos'}`
  const against = f.victimConnectCode
    ? side(f.victimConnectCode, f.victimCharacterId)
    : chars(f.victimCharacterId)
  const vs = against ? `vs ${against}` : ''
  // "Combos by XX#02 as Fox", but with no player picked just "Fox combos"
  // (it read "Combos by as Fox").
  const lead = f.attackerConnectCode
    ? [kind, `by ${by}`]
    : f.attackerCharacterId.length
      ? [
          chars(f.attackerCharacterId),
          kind.charAt(0).toLowerCase() + kind.slice(1),
        ]
      : [kind]
  const head = [...lead, vs].filter(Boolean).join(' ')
  const stage = f.stageId
    .map((id) => legalStages.find((s) => String(s.id) === id)?.name)
    .filter(Boolean)
    .join(' or ')
  const dmg = f.minDamage && f.type !== 'edgeguard' ? `${f.minDamage}%+` : ''
  const events = tournaments.map((t) => t.name).join(' or ')
  const cpu = f.includeCpu ? 'with CPU games' : ''
  return [head, stage, events, dmg, cpu].filter(Boolean).join(' · ')
}

const charName = (id: number | null) =>
  sortedCharacters.find((c) => c.id === id)?.name ?? 'Unknown'

/** How many moments one add takes, as cards (and "Exactly", up to MAX_CLIPS_PER_ADD). */
const AMOUNTS = [25, 100, 500]
const DEFAULT_AMOUNT = 100

const fetchClips = (search: ClipSearchFilters, page: number, limit: number) =>
  new Promise<LunarClip[]>((resolve, reject) => {
    ipcBridge.database({ action: 'clipSearch', search, page, limit }, (res) =>
      res.error || !res.clips
        ? reject(new Error(res.error || 'Clip search failed.'))
        : resolve(res.clips.results),
    )
  })

/** "Too many requests. Please try again in about 35 seconds." → 36, else null. */
const retryAfter = (message: string): number | null => {
  const m = /try again in about (\d+) second/i.exec(message)
  return m ? Math.min(120, Number(m[1]) + 1) : null
}

/** A moment that meets the search's own limits. The server filters too: this is the check that
 *  stops a Clipper still running an older version from adding moments the search ruled out. */
const meets = (f: ClipSearchFilters, c: LunarClip) =>
  (f.type !== 'combo' ||
    ((!f.minHits || c.moves >= Number(f.minHits)) &&
      (!f.minDamage || (c.damage ?? 0) >= Number(f.minDamage)) &&
      (!f.killOnly || c.didKill))) &&
  c.type === f.type

/**
 * Lunar Database › Pre-parsed moments (root docs/clip-search.md): every combo and
 * edgeguard is already found, so this is a filter over games. It says how many
 * moments match and how many games they need, then adds the first N (in the chosen
 * order) to the project. Only games the Replay Library doesn't have are downloaded.
 */
export default function ClipSearchTab({
  initial,
  initialPicks,
  onLive,
  projectName,
  onTransfers,
  onAdded,
}: {
  /** Start on this search instead of the default (Surprise me). */
  initial?: ClipSearchFilters
  /** Tournament chips for `initial` (carried over from Download games). */
  initialPicks?: TournamentPick[]
  /** Reports the form as it changes, so a tab switch can carry it. */
  onLive?: (_filters: ClipSearchFilters, _picks: TournamentPick[]) => void
  projectName: string | null
  onTransfers: (_transfers: Transfer[]) => void
  onAdded: () => void
}) {
  // Never wobbles/infinites or CPU games here (owner's call, 2026-10-25).
  const [filters, setFilters] = useState<ClipSearchFilters>({
    ...(initial ?? defaultClipSearch),
    includeCpu: false,
    includeInfinites: false,
  })
  const [tournamentPicks, setTournamentPicks] = useState<TournamentPick[]>(
    initialPicks ?? [],
  )
  const [searched, setSearched] = useState<ClipSearchFilters | null>(null)
  const [results, setResults] = useState<ClipSearchReply | null>(null)
  const [loading, setLoading] = useState(false)
  const [adding, setAdding] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const [error, setError] = useState('')
  // How many moments to add: a card, or a typed number.
  const [amount, setAmount] = useState(DEFAULT_AMOUNT)
  const [custom, setCustom] = useState(false)
  const [customText, setCustomText] = useState('')
  // The moments fetched so far for the counted search, so a bigger amount only asks for the rest.
  const pool = useRef<{
    key: string
    clips: LunarClip[]
    page: number
    done: boolean
    /** Moments the server sent that the search rules out (an older Clipper main ignoring a filter). */
    dropped: number
  } | null>(null)
  const [retry, setRetry] = useState(0)
  // Rapid clicking: only the newest search counts, and a search seen in the last few minutes is not asked for again.
  const searchSeq = useRef(0)
  const searchCache = useRef(
    new Map<
      string,
      {
        at: number
        reply: ClipSearchReply
        pool: NonNullable<typeof pool.current>
      }
    >(),
  )
  // One rate-limit retry waiting at a time: a new search replaces it.
  const searchRetry = useRef<ReturnType<typeof setTimeout>>()
  // The moments that would be added, fetched so the games they need are exact.
  const [plan, setPlan] = useState<{
    clips: LunarClip[]
    loading: boolean
    error: string
  }>({ clips: [], loading: false, error: '' })
  const outOfDate = (pool.current?.dropped ?? 0) > 0

  useEffect(() => {
    onLive?.(filters, tournamentPicks)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, tournamentPicks])

  function update<K extends keyof ClipSearchFilters>(
    key: K,
    value: ClipSearchFilters[K],
  ) {
    setFilters((f) => ({ ...f, [key]: value }))
  }

  const limitsMessage = limitsProblem(filters.minHits, filters.minDamage)
  const valid = limitsMessage === null

  // The count updates by itself shortly after any filter changes.
  useEffect(() => {
    if (searched && JSON.stringify(filters) === JSON.stringify(searched))
      return undefined
    if (!valid) return undefined
    const t = setTimeout(() => search(filters), searched ? 650 : 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters])

  function search(snapshot = filters) {
    clearTimeout(searchRetry.current)
    searchSeq.current += 1
    const mine = searchSeq.current
    const key = JSON.stringify(snapshot)
    const cached = searchCache.current.get(key)
    if (cached && Date.now() - cached.at < 5 * 60_000) {
      pool.current = cached.pool
      setLoading(false)
      setError('')
      setSearched(snapshot)
      setResults(cached.reply)
      return
    }
    setLoading(true)
    setError('')
    // The first page (up to 100 moments) is also the start of what gets added, and its
    // reply carries the exact count and games: one request per change.
    ipcBridge.database(
      { action: 'clipSearch', search: snapshot, page: 1, limit: 100 },
      (res) => {
        if (mine !== searchSeq.current) return // a newer search took over
        if (res.error || !res.clips) {
          const message = res.error || 'Clip search failed.'
          const wait = retryAfter(message)
          if (wait) {
            setError(`${message} Trying again by itself.`)
            searchRetry.current = setTimeout(
              () => search(snapshot),
              wait * 1000,
            )
            return
          }
          setLoading(false)
          setError(message)
          return
        }
        setLoading(false)
        const got = res.clips.results
        const kept = got.filter((c) => meets(snapshot, c))
        pool.current = {
          key: JSON.stringify(snapshot),
          clips: kept,
          dropped: got.length - kept.length,
          page: 1,
          done:
            got.length === 0 ||
            (res.clips.total != null && got.length >= res.clips.total),
        }
        searchCache.current.set(key, {
          at: Date.now(),
          reply: res.clips,
          pool: pool.current!,
        })
        if (searchCache.current.size > 40)
          searchCache.current.delete(searchCache.current.keys().next().value!)
        setSearched(snapshot)
        setResults(res.clips)
      },
    )
  }

  const total = results?.total ?? null
  const dirty = JSON.stringify(filters) !== JSON.stringify(searched)
  const want = Math.max(0, Math.min(amount, MAX_CLIPS_PER_ADD, total ?? amount))

  // The first `want` moments of the counted search: what is already fetched, then the rest.
  useEffect(() => {
    const p = pool.current
    if (
      !searched ||
      dirty ||
      !results ||
      want === 0 ||
      !p ||
      p.key !== JSON.stringify(searched)
    ) {
      setPlan({ clips: [], loading: false, error: '' })
      return undefined
    }
    if (p.clips.length >= want || p.done) {
      setPlan({ clips: p.clips.slice(0, want), loading: false, error: '' })
      return undefined
    }
    let live = true
    let again: ReturnType<typeof setTimeout> | undefined
    setPlan((prev) => ({ ...prev, loading: true, error: '' }))
    const t = setTimeout(async () => {
      try {
        while (p.clips.length < want && !p.done) {
          // eslint-disable-next-line no-await-in-loop
          const got = await fetchClips(searched, p.page + 1, 100)
          if (!live) return
          p.page += 1
          const kept = got.filter((c) => meets(searched, c))
          p.dropped += got.length - kept.length
          p.clips.push(...kept)
          if (
            got.length === 0 ||
            (results.total != null && p.clips.length >= results.total)
          )
            p.done = true
        }
        if (live)
          setPlan({
            clips: p.clips.slice(0, want),
            loading: false,
            error: '',
          })
      } catch (e) {
        if (!live) return
        const message = (e as Error).message
        const wait = retryAfter(message)
        setPlan({
          clips: [],
          loading: false,
          error: wait ? `${message} Trying again by itself.` : message,
        })
        if (wait) again = setTimeout(() => setRetry((r) => r + 1), wait * 1000)
      }
    }, 200)
    return () => {
      live = false
      clearTimeout(t)
      clearTimeout(again)
    }
  }, [searched, dirty, results, want, retry])

  function add() {
    setAdding(true)
    setError('')
    ipcBridge.database({ action: 'addClips', clips: plan.clips }, (res) => {
      setAdding(false)
      if (res.error) {
        setError(res.error)
        return
      }
      if (res.transfers) onTransfers(res.transfers)
      onAdded()
    })
  }

  // The default holding project reads as "my project"; a project you named is shown as it is.
  const projectLabel = shownProjectName(projectName) ?? 'my project'
  const isCombo = filters.type === 'combo'
  const moreCount = [
    filters.victimConnectCode,
    filters.victimCharacterId.length,
    filters.stageId.length,
    filters.minHits,
    filters.minDamage,
    filters.killOnly,
    filters.zeroToDeath,
    filters.sort !== 'newest',
  ].filter(Boolean).length
  const what = describeClipSearch(filters, tournamentPicks)
  const plain = describeClipSearch(
    { ...defaultClipSearch, type: filters.type },
    [],
  )
  const noun =
    filters.type === 'edgeguard'
      ? total === 1
        ? 'edgeguard'
        : 'edgeguards'
      : total === 1
        ? 'combo'
        : 'combos'
  const pickCharacter = (id: string) =>
    update(
      'attackerCharacterId',
      filters.attackerCharacterId.includes(id) ? [] : [id],
    )
  const pickCustom = (text: string) => {
    const digits = text.replace(/[^\d]/g, '').slice(0, 4)
    setCustomText(digits)
    setCustom(true)
    const n = parseInt(digits, 10)
    if (n > 0) setAmount(Math.min(n, MAX_CLIPS_PER_ADD))
  }

  // What adding would do, from the moments themselves.
  const planGames = new Set(plan.clips.map((c) => c.replayId))
  const toDownload = new Set(
    plan.clips.filter((c) => !c.inLibrary).map((c) => c.replayId),
  ).size
  const owned = planGames.size - toDownload

  return (
    <div className="database-find">
      {error && (
        <div className="database-error" role="alert">
          {error}
        </div>
      )}
      <div className="database-find-body">
        <section className="database-step" aria-labelledby="moments-what">
          <h3 id="moments-what">What moments do you want?</h3>
          {/* Same box as Download games: players and tournaments, as chips. */}
          <div className="database-big-search">
            <SearchBox
              placeholder="Any player or tournament"
              characters={filters.attackerCharacterId}
              codes={
                filters.attackerConnectCode
                  ? filters.attackerConnectCode.split(',')
                  : []
              }
              onCodes={(v) => update('attackerConnectCode', v.join(','))}
              tournaments={tournamentPicks}
              onTournaments={(picks) => {
                setTournamentPicks(picks)
                update(
                  'tournaments',
                  picks.map((t) => t.key),
                )
              }}
            />
          </div>
          <div className="database-chars" role="group" aria-label="Character">
            {sortedCharacters.map((c) => {
              const id = String(c.id)
              const on = filters.attackerCharacterId.includes(id)
              const icon = resolveCharacterImage({
                characterId: c.id,
                characterColor: 0,
              } as PlayerInterface)
              return (
                <button
                  type="button"
                  key={id}
                  className={on ? 'selected' : ''}
                  aria-pressed={on}
                  title={c.name}
                  onClick={() => pickCharacter(id)}
                >
                  {icon ? <img src={icon} alt={c.name} /> : c.name}
                </button>
              )
            })}
          </div>
          <div className="database-from-row">
            <div
              className="database-from"
              role="radiogroup"
              aria-label="What kind of moment"
            >
              {TYPES.map((t) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={filters.type === t.value}
                  key={t.value}
                  className={filters.type === t.value ? 'selected' : ''}
                  onClick={() => update('type', t.value)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="database-more-toggle"
              aria-expanded={showMore}
              onClick={() => setShowMore((v) => !v)}
            >
              {showMore ? '▾' : '▸'} More filters
              {!showMore && moreCount > 0 && ` (${moreCount} on)`}
            </button>
          </div>
          {showMore && (
            <div className="database-more">
              {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
              <label>
                {isCombo ? 'Opponent player' : 'Victim player'}
                <SearchBox
                  placeholder="Anyone (tag or code)"
                  characters={filters.victimCharacterId}
                  codes={
                    filters.victimConnectCode
                      ? filters.victimConnectCode.split(',')
                      : []
                  }
                  onCodes={(v) => update('victimConnectCode', v.join(','))}
                />
              </label>
              <label>
                {isCombo ? 'Opponent character' : 'Victim character'}
                <CharacterSelect
                  value={filters.victimCharacterId}
                  onChange={(v) => update('victimCharacterId', v.slice(0, 1))}
                  anyLabel="Anyone"
                  ariaLabel="Opponent character"
                />
              </label>
              <label>
                Stage
                <StageSelect
                  value={filters.stageId}
                  ariaLabel="Stage"
                  onChange={(next) => update('stageId', next)}
                />
              </label>
              {isCombo && (
                <label>
                  Minimum hits
                  <input
                    inputMode="numeric"
                    placeholder="hits"
                    value={filters.minHits}
                    onChange={(e) => update('minHits', e.target.value.trim())}
                    aria-invalid={!hitsValid(filters.minHits) || undefined}
                  />
                </label>
              )}
              {isCombo && (
                <label>
                  Minimum damage
                  <input
                    inputMode="decimal"
                    placeholder="%"
                    value={filters.minDamage}
                    onChange={(e) =>
                      update('minDamage', normalizeDecimalInput(e.target.value))
                    }
                    aria-invalid={!damageValid(filters.minDamage) || undefined}
                  />
                </label>
              )}
              <label>
                Order
                <select
                  value={filters.sort}
                  onChange={(e) =>
                    update('sort', e.target.value as ClipSearchFilters['sort'])
                  }
                >
                  <option value="newest">Newest first</option>
                  <option value="best">
                    {isCombo ? 'Most damage first' : 'Best score first'}
                  </option>
                  <option value="oldest">Oldest first</option>
                </select>
              </label>
              {isCombo && (
                <div className="database-checks">
                  <label className="database-check">
                    <input
                      type="checkbox"
                      checked={filters.killOnly}
                      onChange={(e) => update('killOnly', e.target.checked)}
                    />
                    Kills only
                  </label>
                  <label className="database-check">
                    <input
                      type="checkbox"
                      checked={filters.zeroToDeath}
                      onChange={(e) => update('zeroToDeath', e.target.checked)}
                    />
                    Zero-to-death
                  </label>
                </div>
              )}
            </div>
          )}
          {limitsMessage && (
            <p className="database-amount-note" role="alert">
              {limitsMessage} The results shown are from the last search that
              worked.
            </p>
          )}
          <div className="database-hero" aria-live="polite">
            <div
              className={`database-hero-number${loading ? ' is-updating' : ''}`}
            >
              {results && total != null ? (
                <>
                  <AnimatedCount value={total} />
                  {results.capped ? '+' : ''}
                </>
              ) : loading ? (
                '…'
              ) : (
                '—'
              )}
            </div>
            <div className="database-hero-unit">
              {loading ? (
                <span className="footer-dots-anim">counting</span>
              ) : (
                noun
              )}
              {what !== plain && (
                <span className="database-hero-what"> · {what}</span>
              )}
            </div>
            {!loading && results?.games && (
              <div className="database-hero-games">
                in {results.games.count.toLocaleString()}{' '}
                {results.games.count === 1 ? 'game' : 'games'}
              </div>
            )}
          </div>
        </section>

        <section className="database-step" aria-labelledby="moments-many">
          <div className="database-many-head">
            <h3 id="moments-many">How many do you want to add?</h3>
            {total !== null && total > 0 && total <= MAX_CLIPS_PER_ADD && (
              <button
                type="button"
                role="radio"
                aria-checked={!custom && amount === total}
                className={`database-all${!custom && amount === total ? ' selected' : ''}`}
                onClick={() => {
                  setCustom(false)
                  setAmount(total)
                }}
              >
                All <strong>{total.toLocaleString()}</strong>
              </button>
            )}
          </div>
          <div
            className="database-amounts"
            role="radiogroup"
            aria-label="How many moments"
          >
            {AMOUNTS.map((value) => {
              const on = !custom && value === amount
              return (
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  key={value}
                  className={on ? 'selected' : ''}
                  onClick={() => {
                    setCustom(false)
                    setAmount(value)
                  }}
                >
                  <strong>{value.toLocaleString()}</strong>
                  <small>
                    {value === DEFAULT_AMOUNT ? 'Quick start' : 'moments'}
                  </small>
                </button>
              )
            })}
            {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
            <label
              className={`database-amount-exact${custom ? ' selected' : ''}`}
            >
              <strong>Exactly</strong>
              <input
                type="text"
                inputMode="numeric"
                placeholder={`up to ${MAX_CLIPS_PER_ADD}`}
                aria-label="How many moments, any number"
                value={custom ? customText : ''}
                onFocus={() => {
                  if (!custom && customText) pickCustom(customText)
                }}
                onChange={(e) => pickCustom(e.target.value)}
              />
            </label>
          </div>
          <small className="database-amount-note">
            The first {Math.min(amount, MAX_CLIPS_PER_ADD).toLocaleString()} in
            your chosen order ({' '}
            {filters.sort === 'best'
              ? isCombo
                ? 'most damage'
                : 'best score'
              : filters.sort === 'oldest'
                ? 'oldest'
                : 'newest'}
            ). Up to {MAX_CLIPS_PER_ADD} at a time.
          </small>
        </section>
      </div>

      <footer className="database-add">
        <div className="database-add-actions">
          <OwnerClipSearchActions
            searched={searched}
            dirty={dirty}
            total={total}
            selected={plan.clips}
            describeSearched={
              searched ? describeClipSearch(searched, tournamentPicks) : ''
            }
            describeForm={describeClipSearch(filters, tournamentPicks)}
          />
          <button
            type="button"
            className="database-primary"
            disabled={
              adding ||
              loading ||
              dirty ||
              plan.loading ||
              plan.clips.length === 0
            }
            onClick={add}
          >
            {adding ? (
              'Adding…'
            ) : plan.loading || loading ? (
              <span className="footer-dots-anim">Working it out</span>
            ) : (
              `Add ${plan.clips.length.toLocaleString()} ${
                plan.clips.length === 1
                  ? noun.replace(/s$/, '')
                  : filters.type === 'edgeguard'
                    ? 'edgeguards'
                    : 'combos'
              } to ${projectLabel}`
            )}
          </button>
        </div>
        <p className="database-what-happens">
          {outOfDate
            ? 'This Clipper is older than this screen, so the server sent moments your filters rule out. They were left out here. Quit Clipper and start it again to get exact results.'
            : plan.error
              ? plan.error
              : plan.clips.length === 0
                ? total === 0
                  ? 'Nothing matches. Loosen a filter.'
                  : 'Pick what you want above. Their games are downloaded once into your Replay Library, straight from storage.'
                : toDownload
                  ? `From ${planGames.size.toLocaleString()} ${planGames.size === 1 ? 'game' : 'games'}: ${toDownload.toLocaleString()} to download${owned ? `, ${owned.toLocaleString()} already in your library` : ''}. Then they open as “Lunar Database clips”.`
                  : `From ${planGames.size.toLocaleString()} ${planGames.size === 1 ? 'game' : 'games'}, all already in your library, so the clips open right away.`}
        </p>
      </footer>
    </div>
  )
}
