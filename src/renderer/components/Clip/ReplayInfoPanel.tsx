/**
 * The full-zoom card's Lunar Database section. A replay that came from the
 * database (Find clips, or a game in the replay library) shows where it was played
 * and a head-to-head of both players' stats. Anything else gets the upload pitch
 * (uploads aren't open yet: docs/current-work.md).
 */
import { useEffect, useState, type CSSProperties } from 'react'
import { FiExternalLink, FiUploadCloud } from 'react-icons/fi'
import ipcBridge from '../../ipcBridge'
import {
  REPLAY_PAGE,
  type ReplayInfo,
  type ReplayInfoPlayer,
} from '../../../constants/replayInfo'
import type { PlayerInterface } from '../../../constants/types'
import { portColor } from './comboView'
import { resolveCharacterImage } from '../../lib/clipAssets'

type Row = {
  label: string
  value: (_p: ReplayInfoPlayer) => number | null
  format?: (_n: number) => string
  /** Lower is better (e.g. openings per kill). */
  lower?: boolean
}

const ratio = (a: number | null, b: number | null) =>
  a != null && b != null && b > 0 ? a / b : null

// Grouped like the site's game page. Stocks and kills sit in the header (score).
const GROUPS: { title: string; rows: Row[] }[] = [
  {
    title: 'Punish',
    rows: [
      {
        label: 'Openings per kill',
        value: (p) => ratio(p.openings, p.kills),
        format: (n) => n.toFixed(1),
        lower: true,
      },
      {
        label: 'Damage per opening',
        value: (p) => ratio(p.damageDealt, p.openings),
        format: (n) => n.toFixed(1),
      },
      { label: 'Openings', value: (p) => p.openings },
    ],
  },
  {
    title: 'Neutral',
    rows: [
      { label: 'Neutral wins', value: (p) => p.neutralWins },
      { label: 'Counter hits', value: (p) => p.counterHits },
    ],
  },
  {
    title: 'Tech',
    rows: [
      {
        label: 'L-cancels',
        value: (p) =>
          p.lCancel && p.lCancel.success + p.lCancel.fail > 0
            ? (p.lCancel.success / (p.lCancel.success + p.lCancel.fail)) * 100
            : null,
        format: (n) => `${n.toFixed(0)}%`,
      },
      {
        label: 'Inputs / min',
        value: (p) => p.inputsPerMinute,
        format: (n) => n.toFixed(0),
      },
      { label: 'Wavedashes', value: (p) => p.wavedashes },
      { label: 'Dash dances', value: (p) => p.dashDances },
    ],
  },
]

/**
 * Left player's share of a stat (0..1), for one tug-of-war bar: who's ahead and
 * by how much. "Lower is better" stats compare the inverses, so the better side
 * still gets the bigger share. null when there's nothing to compare.
 */
export function shareOf(
  a: number | null,
  b: number | null,
  lower = false,
): number | null {
  if (a == null || b == null) return null
  const x = lower ? (a > 0 ? 1 / a : 0) : a
  const y = lower ? (b > 0 ? 1 / b : 0) : b
  return x + y > 0 ? x / (x + y) : 0.5
}

const START_STOCKS = 4

const SOURCE_LABEL = {
  tournament: 'Tournament',
  netplay: 'Netplay',
  ranked: 'Ranked',
}

type Props = {
  replayId?: string
  path?: string | null
  left?: PlayerInterface
  right?: PlayerInterface
}

export default function ReplayInfoPanel({
  replayId,
  path,
  left,
  right,
}: Props) {
  const key = replayId || path || ''
  const [result, setResult] = useState<{
    key: string
    info?: ReplayInfo | null
    error?: string
  } | null>(null)
  useEffect(() => {
    if (!key) return undefined
    let live = true
    ipcBridge.database(
      {
        action: 'replayInfo',
        ...(replayId ? { replayId } : { path: path ?? undefined }),
      },
      (res) => {
        if (live)
          setResult({ key, info: res.replayInfo ?? null, error: res.error })
      },
    )
    return () => {
      live = false
    }
    // key carries replayId/path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const current = result?.key === key ? result : null

  if (!key) return null
  if (!current)
    return (
      <section className="fullcard-panel replayinfo replayinfo--loading">
        <h3>Lunar Database</h3>
        <p className="fullcard-muted">Checking the Lunar Database…</p>
      </section>
    )
  if (current.error)
    return (
      <section className="fullcard-panel replayinfo">
        <h3>Lunar Database</h3>
        <p className="fullcard-muted">
          Couldn&apos;t reach the Lunar Database ({current.error}).
        </p>
      </section>
    )
  if (!current.info)
    return (
      <section className="fullcard-panel replayinfo replayinfo--upload">
        <FiUploadCloud className="replayinfo-upload-icon" aria-hidden />
        <div>
          <h4>Get more out of this replay</h4>
          <p>
            It isn&apos;t in the Lunar Database. Upload it to get the full
            breakdown: both players&apos; stats, the tournament and set it
            belongs to, and its own page on lunarmelee.com.
          </p>
        </div>
        <button
          type="button"
          className="fullcard-btn replayinfo-upload-btn"
          disabled
          title="Uploads open soon"
        >
          Upload to Lunar
          <span className="replayinfo-soon">Soon</span>
        </button>
      </section>
    )

  const info = current.info
  const byIndex = (p?: PlayerInterface) =>
    p ? info.players.find((x) => x.playerIndex === p.playerIndex) : undefined
  const a = byIndex(left) ?? info.players[0]
  const b = byIndex(right) ?? info.players.find((p) => p !== a)
  const context = [
    info.tournamentName,
    info.setGame ? `Game ${info.setGame}` : null,
    info.source ? SOURCE_LABEL[info.source] : null,
    info.startAt ? new Date(info.startAt).toLocaleDateString() : null,
    info.viewCount ? `${info.viewCount.toLocaleString()} views` : null,
  ].filter(Boolean)
  const colorA = portColor(left?.port ?? (a ? a.playerIndex + 1 : 1))
  const colorB = portColor(right?.port ?? (b ? b.playerIndex + 1 : 2))
  const groups =
    a && b
      ? GROUPS.map((g) => ({
          ...g,
          rows: g.rows.filter((r) => r.value(a) != null || r.value(b) != null),
        })).filter((g) => g.rows.length > 0)
      : []

  return (
    <section className="fullcard-panel replayinfo">
      <div className="replayinfo-head">
        <h3>From the Lunar Database</h3>
        <button
          type="button"
          className="replayinfo-link"
          onClick={() =>
            window.electron.ipcRenderer.sendMessage(
              'openExternal',
              REPLAY_PAGE(info.replayId),
            )
          }
        >
          Open on lunarmelee.com <FiExternalLink aria-hidden />
        </button>
      </div>
      {context.length > 0 && (
        <div className="replayinfo-context">
          {context.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
      )}
      {a && b && (
        <div className="replayinfo-match">
          {[a, b].map((p, i) => {
            const clipPlayer = i ? right : left
            const icon = resolveCharacterImage(clipPlayer)
            const stocks = p.stocksLeft
            return (
              <div
                key={p.playerIndex}
                className={`replayinfo-player replayinfo-player--${i ? 'right' : 'left'}${info.winner === p.playerIndex ? ' is-winner' : ''}`}
                style={{ '--port': i ? colorB : colorA } as CSSProperties}
              >
                {icon && (
                  <img className="replayinfo-player-icon" src={icon} alt="" />
                )}
                <div className="replayinfo-player-text">
                  <span className="replayinfo-player-name">
                    {p.name || p.connectCode || `Port ${p.playerIndex + 1}`}
                    {info.winner === p.playerIndex && (
                      <em className="replayinfo-won">Won</em>
                    )}
                  </span>
                  <span className="replayinfo-player-meta">
                    {p.connectCode && p.name ? p.connectCode : ''}
                    {stocks != null && (
                      <span
                        className="replayinfo-stocks"
                        title={`${stocks} stock${stocks === 1 ? '' : 's'} left`}
                      >
                        {Array.from({ length: START_STOCKS }, (_, k) => (
                          <i key={k} className={k < stocks ? 'is-left' : ''} />
                        ))}
                      </span>
                    )}
                  </span>
                </div>
              </div>
            )
          })}
          <div className="replayinfo-score" title="Kills">
            <span style={{ color: colorA }}>{a.kills ?? '–'}</span>
            <small>kills</small>
            <span style={{ color: colorB }}>{b.kills ?? '–'}</span>
          </div>
        </div>
      )}
      {groups.length > 0 ? (
        <div className="replayinfo-groups">
          {groups.map((g, gi) => (
            <div className="replayinfo-group" key={g.title}>
              <h4>{g.title}</h4>
              {g.rows.map((r, i) => {
                const va = r.value(a!)
                const vb = r.value(b!)
                const share = shareOf(va, vb, r.lower)
                const better =
                  share == null || share === 0.5
                    ? null
                    : share > 0.5
                      ? 'a'
                      : 'b'
                const fmt = (v: number | null) =>
                  v == null
                    ? '—'
                    : r.format
                      ? r.format(v)
                      : String(Math.round(v))
                return (
                  <div
                    className="replayinfo-stat"
                    key={r.label}
                    style={{ animationDelay: `${(gi * 4 + i) * 30}ms` }}
                    title={r.lower ? `${r.label}: lower is better` : undefined}
                  >
                    <div className="replayinfo-stat-top">
                      <span
                        className={`replayinfo-val${better === 'a' ? ' is-better' : ''}`}
                      >
                        {fmt(va)}
                      </span>
                      <span className="replayinfo-label">{r.label}</span>
                      <span
                        className={`replayinfo-val${better === 'b' ? ' is-better' : ''}`}
                      >
                        {fmt(vb)}
                      </span>
                    </div>
                    <div className="replayinfo-tug">
                      <i
                        style={{
                          width: `${(share ?? 0.5) * 100}%`,
                          background: colorA,
                          opacity: share == null ? 0.25 : undefined,
                        }}
                      />
                      <i
                        style={{
                          width: `${(1 - (share ?? 0.5)) * 100}%`,
                          background: colorB,
                          opacity: share == null ? 0.25 : undefined,
                        }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      ) : (
        <p className="fullcard-muted">
          {info.hasStats
            ? 'No stats to compare.'
            : 'Stats for this game aren’t ready yet.'}
        </p>
      )}
    </section>
  )
}
