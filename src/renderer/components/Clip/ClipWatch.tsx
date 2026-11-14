/**
 * The full-zoom card's Watch panel: the clip itself, played on a loop with
 * slippi-viewer (the same 2D viewer as lunarmelee.com/replay), from half a
 * second before it starts to half a second after it ends. The replay comes from
 * main (readReplayFile); character animation packs ship with the app and load
 * through lunar-assets:// (main/viewerAssets.ts).
 */
import { useEffect, useRef, useState } from 'react'
import ipcBridge from '../../ipcBridge'
import Tooltip from '../Tooltip'
import { GAME_START_FRAME } from '../../../constants/frames'

const LEAD = 30
const ZIPS_BASE_URL = 'lunar-assets://app/'

type ViewerElement = HTMLElement & { setReplay?: (_file: File) => void }

/** The viewer's scrub bar (in its open shadow root): value = frame + 123. */
const scrubBar = (el: HTMLElement | null) =>
  el?.shadowRoot?.querySelector(
    'input[type="range"]',
  ) as HTMLInputElement | null

/** Dark theme over the viewer's light one (its shadow root is open), and its
 *  control bar hidden: the clip loops by itself, and the bar's icons come from a
 *  web font that isn't there offline. */
const VIEWER_CSS = `
  .bg-slate-50 { background-color: #0d0e11 !important; border-color: #25272c !important; }
  .border { border-color: #25272c !important; }
  .stroke-slippi-50 { stroke: #191c22 !important; }
  .fill-slate-800.stroke-slate-800 { fill: #262a33 !important; stroke: #3b404b !important; }
  text.fill-slate-800 { fill: #c9cfda !important; }
  .text-slate-800 { color: #c9cfda !important; }
  .rounded-b.border.border-t-0 { display: none !important; }
  /* Names and percents are drawn in the dark port colours: lift them off the dark. */
  svg text:not(.fill-slate-800) { filter: brightness(1.9) saturate(1.2); }
`

function styleViewer(el: HTMLElement) {
  const root = el.shadowRoot
  if (!root || root.getElementById('lunar-viewer-css')) return
  const style = document.createElement('style')
  style.id = 'lunar-viewer-css'
  style.textContent = VIEWER_CSS
  root.appendChild(style)
}

/** Is the viewer playing? (Its hidden bar shows a "pause" icon while it plays.) */
function viewerPlaying(el: HTMLElement): boolean | null {
  const icons = el.shadowRoot?.querySelectorAll('.material-icons') ?? []
  for (const icon of Array.from(icons)) {
    const name = icon.textContent?.trim()
    if (name === 'pause') return true
    if (name === 'play_arrow') return false
  }
  return null
}

/** The current frame (game frame numbers, -123 = first). */
function viewerFrame(el: HTMLElement): number | null {
  const bar = scrubBar(el)
  return bar ? Number(bar.value) + GAME_START_FRAME : null
}

/**
 * Keys the viewer listens for on the window (slippi-viewer's own shortcuts). While a
 * clip is open we take them first: Space/K and , . (frame step) are ours, ←/→ stay
 * Clipper's clip navigation, the rest (0-9 jumps, zoom, debug, fullscreen, speed) off.
 */
const VIEWER_KEYS = new Set([
  ' ',
  'k',
  'K',
  'j',
  'J',
  'l',
  'L',
  ',',
  '<',
  '.',
  '>',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  '-',
  '_',
  '=',
  '+',
  'd',
  'D',
  'f',
  'F',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
])

/** The viewer's own play/pause icon (a material-icons span in the hidden bar). */
function viewerToggle(el: HTMLElement) {
  const icons = el.shadowRoot?.querySelectorAll('.material-icons') ?? []
  for (const icon of Array.from(icons)) {
    const name = icon.textContent?.trim()
    if (name === 'pause' || name === 'play_arrow') {
      ;(icon as HTMLElement).click()
      return name === 'pause' ? 'paused' : 'playing'
    }
  }
  return null
}

function seek(el: HTMLElement, frame: number) {
  const bar = scrubBar(el)
  if (!bar || !(Number(bar.max) > 0)) return false
  bar.value = String(
    Math.min(Number(bar.max), Math.max(0, frame - GAME_START_FRAME)),
  )
  bar.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  return true
}

/**
 * The viewer loads character packs asynchronously and its failures escape as
 * unhandled rejections (e.g. a character it has no pack for), sometimes after its
 * panel has already closed. index.ejs catches them before anything else (the
 * dev error overlay included) and re-sends them as 'lunar-viewer-error'; this
 * tells whichever panels are open.
 */
const viewerErrorListeners = new Set<(_detail: string) => void>()
if (typeof window !== 'undefined')
  window.addEventListener('lunar-viewer-error', (e) => {
    console.warn(
      '[watch] viewer could not load a character:',
      (e as CustomEvent).detail,
    )
    viewerErrorListeners.forEach((fn) => fn(String((e as CustomEvent).detail)))
  })

export default function ClipWatch({
  path,
  startFrame,
  endFrame,
}: {
  path: string
  startFrame: number
  endFrame: number
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<HTMLElement | null>(null)
  const [paused, setPaused] = useState(false)
  const [frame, setFrame] = useState<number | null>(null)
  const [state, setState] = useState<{
    status: 'loading' | 'ready' | 'error'
    message?: string
  }>({
    status: 'loading',
  })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    let live = true
    let loop: ReturnType<typeof setInterval> | null = null
    let el: ViewerElement | null = null
    const from = startFrame - LEAD
    const to = endFrame + LEAD
    let failed = false
    const onViewerError = (detail: string) => {
      failed = true
      if (live)
        setState({
          status: 'error',
          message: `The viewer couldn’t play this clip: ${detail}`,
        })
    }
    viewerErrorListeners.add(onViewerError)
    ;(async () => {
      try {
        await import('@gcpreston/slippi-viewer')
        await customElements.whenDefined('slippi-viewer')
        if (!live) return
        // Create it only once it's defined, so it reads zips-base-url (made before
        // that, it kept its default "/", which the dev server answers with
        // index.html: "invalid zip data").
        el = document.createElement('slippi-viewer') as ViewerElement
        el.setAttribute('zips-base-url', ZIPS_BASE_URL)
        ;(el as unknown as { zipsBaseUrl: string }).zipsBaseUrl = ZIPS_BASE_URL
        el.className = 'clipwatch-viewer'
        host.appendChild(el)
        viewerRef.current = el
        const res = await new Promise<{ bytes?: Uint8Array; error?: string }>(
          (resolve) => {
            ipcBridge.readReplayFile(path, resolve)
          },
        )
        if (!live) return
        if (!res.bytes)
          throw new Error(res.error || 'Could not read the replay.')
        const viewer = el
        viewer.setReplay?.(new File([res.bytes as BlobPart], 'clip.slp'))
        // Wait for the viewer to know the replay's length, jump to the clip, then
        // keep it looping inside [from, to].
        let tries = 0
        const start = () => {
          if (!live || failed) return
          if (!seek(viewer, from)) {
            tries += 1
            // The viewer reads the replay asynchronously and gives up silently on
            // files it can't parse (e.g. no player list in the metadata).
            if (tries > 50)
              setState({
                status: 'error',
                message: 'The viewer can’t show this replay.',
              })
            else setTimeout(start, 100)
            return
          }
          styleViewer(viewer)
          setState({ status: 'ready' })
          loop = setInterval(() => {
            const now = viewerFrame(viewer)
            if (now === null) return
            const playing = viewerPlaying(viewer)
            if (playing !== null) setPaused(!playing)
            // Loop only while playing: paused, you can step past either end.
            if (playing !== false && (now > to || now < from - 5)) {
              seek(viewer, from)
              setFrame(from)
            } else setFrame(now)
          }, 100)
        }
        start()
      } catch (err) {
        if (live)
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : String(err),
          })
      }
    })()

    return () => {
      live = false
      if (loop) clearInterval(loop)
      viewerErrorListeners.delete(onViewerError)
      el?.remove()
      viewerRef.current = null
    }
  }, [path, startFrame, endFrame])

  const toggle = () => {
    const el = viewerRef.current
    const now = el && viewerToggle(el)
    if (now) setPaused(now === 'paused')
  }
  const step = (delta: number) => {
    const el = viewerRef.current
    if (!el) return
    if (viewerPlaying(el)) viewerToggle(el)
    setPaused(true)
    const now = viewerFrame(el)
    if (now === null) return
    seek(el, now + delta)
    setFrame(viewerFrame(el))
  }
  const stepRef = useRef(step)
  stepRef.current = step
  const toggleRef = useRef(toggle)
  toggleRef.current = toggle

  // Keyboard, ahead of the viewer's own window listener (capture phase).
  const ready = state.status === 'ready'
  useEffect(() => {
    if (!ready) return undefined
    const onKey = (e: KeyboardEvent) => {
      if (!VIEWER_KEYS.has(e.key) || e.ctrlKey || e.metaKey || e.altKey) return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      e.stopImmediatePropagation()
      if (e.key === ' ' || e.key === 'k' || e.key === 'K') {
        e.preventDefault()
        toggleRef.current()
      } else if (e.key === '.' || e.key === '>') {
        stepRef.current(
          e.shiftKey && e.key === '.' ? 10 : e.key === '>' ? 10 : 1,
        )
      } else if (e.key === ',' || e.key === '<') {
        stepRef.current(e.key === '<' || e.shiftKey ? -10 : -1)
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // Still Clipper's previous / next clip (Tray treats Z/X the same).
        e.preventDefault()
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: e.key === 'ArrowLeft' ? 'z' : 'x',
          }),
        )
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [ready])

  const intoClip = frame === null ? null : frame - startFrame

  return (
    <div className="clipwatch-wrap">
      <div className="clipwatch">
        <div ref={hostRef} className="clipwatch-host" />
        {state.status !== 'ready' && (
          <div className="clipwatch-status">
            {state.status === 'loading' ? 'Loading the clip…' : state.message}
          </div>
        )}
      </div>
      {state.status === 'ready' && (
        <div className="clipwatch-bar">
          <Tooltip text={'Back one frame (,)\nShift-click or < : 10 frames'}>
            <button
              type="button"
              className="clipwatch-btn"
              aria-label="Back one frame"
              onClick={(e) => {
                e.stopPropagation()
                step(e.shiftKey ? -10 : -1)
              }}
            >
              ◀︎ 1
            </button>
          </Tooltip>
          <Tooltip text="Play / pause (Space or K)">
            <button
              type="button"
              className="clipwatch-btn clipwatch-play"
              onClick={(e) => {
                e.stopPropagation()
                toggle()
              }}
            >
              {paused ? '▶ Play' : '❚❚ Pause'}
            </button>
          </Tooltip>
          <Tooltip text={'Forward one frame (.)\nShift-click or > : 10 frames'}>
            <button
              type="button"
              className="clipwatch-btn"
              aria-label="Forward one frame"
              onClick={(e) => {
                e.stopPropagation()
                step(e.shiftKey ? 10 : 1)
              }}
            >
              1 ▶︎
            </button>
          </Tooltip>
          <Tooltip
            text={
              'Frames from the start of the clip (60 a second); negative = the half-second before it.\n← / →: previous / next clip'
            }
          >
            <span className="clipwatch-frame">
              {intoClip === null
                ? ''
                : `Frame ${intoClip >= 0 ? '+' : ''}${intoClip}`}
            </span>
          </Tooltip>
          <span className="clipwatch-keys">
            Space play/pause · , . one frame (Shift: 10)
          </span>
          <button
            type="button"
            className="clipwatch-credit"
            onClick={(e) => {
              e.stopPropagation()
              window.electron.ipcRenderer.sendMessage(
                'openExternal',
                'https://github.com/gcpreston/slippi-viewer',
              )
            }}
          >
            Viewer: slippi-viewer
          </button>
        </div>
      )}
    </div>
  )
}
