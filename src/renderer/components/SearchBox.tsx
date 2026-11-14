import { useEffect, useRef, useState } from 'react'
import ipcBridge from 'renderer/ipcBridge'
import type {
  PlayerSuggestion,
  TournamentSuggestion,
} from '../../constants/database'
import { sortedCharacters } from '../../constants/characters'
import '../styles/SearchBox.css'

/**
 * The Lunar Database search box, the same as the website's (apps/website
 * components/SearchBar.tsx): one box that finds players (tag, connect code,
 * other names) and, where they can be filtered, tournaments; picks become
 * chips. Same endpoints, grouping, ordering and keys.
 */

export type TournamentPick = { key: string; name: string }

/** Names of players seen in suggestions, by connect code, so chips and the
 *  search summary can say who a code is ("XX#02 (Hax$)"). */
const knownNames = new Map<string, string>()

/** "XX#02 (Hax$)" when the name is known, else the code. */
export function playerLabel(code: string): string {
  const name = knownNames.get(code)
  return name && name !== code ? `${code} (${name})` : code
}

type Suggestion =
  | { kind: 'player'; player: PlayerSuggestion }
  | { kind: 'tournament'; tournament: TournamentSuggestion }

const GROUP_LABEL = { player: 'Players', tournament: 'Tournaments' }
const SITE = 'https://www.lunarmelee.com'

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** 4 exact, 3 prefix, 2 word prefix, 1 contained, 0 otherwise. */
function matchScore(q: string, candidates: string[]): number {
  const n = norm(q)
  if (!n) return 0
  let best = 0
  for (const c of candidates.map(norm)) {
    if (c === n) return 4
    if (c.startsWith(n)) best = Math.max(best, 3)
    else if (` ${c}`.includes(` ${n}`)) best = Math.max(best, 2)
    else if (c.includes(n)) best = Math.max(best, 1)
  }
  return best
}

const labels = (s: Suggestion) =>
  s.kind === 'player'
    ? [s.player.connectCode, s.player.displayName ?? '']
    : [s.tournament.name, s.tournament._id]

const fmtDay = (d: string) =>
  new Date(d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
const dateRange = (a: string | null, b: string | null) => {
  if (!a && !b) return ''
  const x = fmtDay((a || b)!)
  const y = fmtDay((b || a)!)
  return x === y ? x : `${x} – ${y}`
}

/** "Mewtwo", "Fox or Falco", or "picked-character" for more. */
function characterWords(ids: string[]) {
  const names = ids
    .map((id) => sortedCharacters.find((c) => String(c.id) === id)?.name)
    .filter(Boolean)
  return names.length && names.length <= 2
    ? names.join(' or ')
    : 'picked-character'
}

export default function SearchBox({
  codes,
  onCodes,
  tournaments,
  onTournaments,
  placeholder,
  characters = [],
  disabled = false,
}: {
  codes: string[]
  onCodes: (_codes: string[]) => void
  /** Leave out where tournaments can't be filtered (e.g. clips). */
  tournaments?: TournamentPick[]
  onTournaments?: (_picks: TournamentPick[]) => void
  placeholder?: string
  /** Characters picked for this side: suggest only their players, most games
   *  on them first. */
  characters?: string[]
  /** Nothing to search for here (ranked games are anonymous). */
  disabled?: boolean
}) {
  const withTournaments = !!tournaments && !!onTournaments
  const [input, setInput] = useState('')
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [show, setShow] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const requestRef = useRef(0)

  function load(q: string) {
    const id = ++requestRef.current
    ipcBridge.database(
      {
        action: 'autocomplete',
        q,
        tournaments: withTournaments,
        characters,
      },
      (res) => {
        if (id !== requestRef.current) return
        for (const p of res.players ?? [])
          if (p.displayName) knownNames.set(p.connectCode, p.displayName)
        const groups: Suggestion[][] = [
          (res.players ?? [])
            .slice(0, q ? 6 : 5)
            .map((player): Suggestion => ({ kind: 'player', player })),
          (res.tournaments ?? [])
            .slice(0, 5)
            .map(
              (tournament): Suggestion => ({ kind: 'tournament', tournament }),
            ),
        ]
        // The group with the closest match comes first, so Enter picks what was
        // meant ("kotj 7" -> the tournament, not a player whose code starts KOT).
        const best = (g: Suggestion[]) =>
          Math.max(0, ...g.map((x) => matchScore(q, labels(x))))
        setSuggestions(
          groups
            .map((g, i) => ({ g, i, score: best(g) }))
            .sort((x, y) => y.score - x.score || x.i - y.i)
            .flatMap((x) => x.g),
        )
        setActiveIndex(-1)
        setShow(true)
      },
    )
  }

  // New characters: the old suggestions are for someone else's characters.
  const characterKey = characters.join(',')
  const firstCharacters = useRef(true)
  useEffect(() => {
    if (firstCharacters.current) {
      firstCharacters.current = false
      return
    }
    setSuggestions([])
    if (show) load(input)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterKey])

  useEffect(() => {
    if (input.length < 1) return undefined
    const t = setTimeout(() => load(input), 200)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input])

  useEffect(() => {
    const outside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node))
        setShow(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [])

  function select(s: Suggestion) {
    if (s.kind === 'player') {
      if (!codes.includes(s.player.connectCode))
        onCodes([...codes, s.player.connectCode])
    } else if (
      onTournaments &&
      tournaments &&
      !tournaments.some((t) => t.key === s.tournament._id)
    ) {
      onTournaments([
        ...tournaments,
        { key: s.tournament._id, name: s.tournament.name },
      ])
    }
    setInput('')
    setShow(false)
    setSuggestions([])
    inputRef.current?.focus()
  }

  // Chips in display order; Backspace removes the last one.
  const chips: {
    id: string
    label: string
    name?: string
    tournament: boolean
    remove: () => void
  }[] = [
    ...(tournaments ?? []).map((t) => ({
      id: `t:${t.key}`,
      label: t.name,
      tournament: true,
      remove: () =>
        onTournaments?.(tournaments!.filter((x) => x.key !== t.key)),
    })),
    ...codes.map((c) => ({
      id: `p:${c}`,
      label: c,
      name: knownNames.get(c),
      tournament: false,
      remove: () => onCodes(codes.filter((x) => x !== c)),
    })),
  ]

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Backspace' && input === '' && chips.length > 0) {
      chips[chips.length - 1].remove()
      return
    }
    if (!show || suggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      select(suggestions[Math.max(activeIndex, 0)])
    } else if (e.key === 'Escape') {
      setShow(false)
    }
  }

  const openSite = (e: React.MouseEvent, path: string) => {
    e.preventDefault()
    e.stopPropagation()
    window.open(`${SITE}${path}`)
  }

  return (
    <div className="search-box" ref={wrapperRef}>
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div
        className="search-box-control"
        onClick={() => inputRef.current?.focus()}
      >
        {chips.map((c) => (
          <span
            key={c.id}
            className={`search-chip${c.tournament ? ' search-chip--tournament' : ''}`}
          >
            {c.label}
            {c.name && c.name !== c.label ? (
              <span className="search-chip-name">· {c.name}</span>
            ) : null}
            <button
              type="button"
              className="search-chip-x"
              aria-label={`Remove ${c.label}`}
              onClick={(e) => {
                e.stopPropagation()
                c.remove()
              }}
            >
              &times;
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="search-box-input"
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            if (!e.target.value) load('')
          }}
          disabled={disabled}
          onFocus={() => {
            if (suggestions.length > 0) setShow(true)
            else load(input)
          }}
          onKeyDown={handleKeyDown}
          placeholder={chips.length === 0 ? placeholder : ''}
          aria-label={
            withTournaments ? 'Search players or tournaments' : 'Search players'
          }
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      {show && (
        <ul className="search-box-dropdown" role="listbox">
          {suggestions.length === 0 ? (
            <li className="search-box-none">No results</li>
          ) : (
            suggestions.map((s, i) => {
              const header = i === 0 || suggestions[i - 1].kind !== s.kind
              const cls = `search-box-item${i === activeIndex ? ' active' : ''}`
              const hover = () => setActiveIndex(i)
              return [
                header && (
                  <li key={`h:${s.kind}`} className="search-box-group">
                    {GROUP_LABEL[s.kind]}
                  </li>
                ),
                s.kind === 'player' ? (
                  <li
                    key={`p:${s.player.connectCode}`}
                    className={cls}
                    role="option"
                    aria-selected={i === activeIndex}
                    onMouseDown={() => select(s)}
                    onMouseEnter={hover}
                  >
                    <span className="search-box-code">
                      {s.player.connectCode}
                    </span>
                    {/* One name per code: other names a player has used are not shown (privacy). */}
                    {s.player.displayName && (
                      <span className="search-box-name">
                        {s.player.displayName}
                      </span>
                    )}
                    <span className="search-box-count">
                      {s.player.characterGames !== undefined
                        ? `${s.player.characterGames.toLocaleString()} ${characterWords(characters)} games`
                        : `${s.player.gameCount.toLocaleString()} games`}
                    </span>
                    <button
                      type="button"
                      className="search-box-link"
                      title={`Open ${s.player.displayName || s.player.connectCode}'s profile on lunarmelee.com`}
                      onMouseDown={(e) =>
                        openSite(
                          e,
                          `/player/${encodeURIComponent(s.player.connectCode.replace('#', '-'))}`,
                        )
                      }
                    >
                      Profile
                    </button>
                  </li>
                ) : (
                  <li
                    key={`t:${s.tournament._id}`}
                    className={cls}
                    role="option"
                    aria-selected={i === activeIndex}
                    onMouseDown={() => select(s)}
                    onMouseEnter={hover}
                  >
                    <span className="search-box-code">{s.tournament.name}</span>
                    <span className="search-box-name">
                      {dateRange(s.tournament.firstAt, s.tournament.lastAt)}
                    </span>
                    <span className="search-box-count">
                      {s.tournament.games.toLocaleString()} games
                    </span>
                    <button
                      type="button"
                      className="search-box-link"
                      title={`Open ${s.tournament.name} on lunarmelee.com`}
                      onMouseDown={(e) =>
                        openSite(
                          e,
                          `/tournament/${encodeURIComponent(s.tournament._id)}`,
                        )
                      }
                    >
                      Page
                    </button>
                  </li>
                ),
              ]
            })
          )}
        </ul>
      )}
    </div>
  )
}
