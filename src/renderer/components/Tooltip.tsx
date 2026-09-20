import { useState, useRef, useEffect, useLayoutEffect, ReactNode } from 'react'

interface TooltipProps {
  text: string
  offsetX?: number
  children: ReactNode
}

// Keep the bubble at least this far from the viewport edges.
const EDGE = 10
// Narrower than before (was 300) so long text wraps to more, shorter lines
// instead of two very wide ones.
const MAX_WIDTH = 220

export default function Tooltip({ text, offsetX = 0, children }: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const [anchor, setAnchor] = useState({ cx: 0, top: 0, bottom: 0 })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tipRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  function onEnter(e: React.MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setAnchor({
      cx: rect.left + rect.width / 2 + offsetX,
      top: rect.top,
      bottom: rect.bottom,
    })
    timer.current = setTimeout(() => setVisible(true), 300)
  }

  function onLeave() {
    if (timer.current) clearTimeout(timer.current)
    setVisible(false)
  }

  // Once shown, measure the bubble and nudge it so it never touches a screen
  // edge: clamp horizontally within EDGE, and flip below the anchor if it would
  // clip the top. Runs before paint (useLayoutEffect) so there's no flicker.
  useLayoutEffect(() => {
    const el = tipRef.current
    if (!visible || !el) return
    const half = el.offsetWidth / 2
    const minCx = EDGE + half
    const maxCx = window.innerWidth - EDGE - half
    // If the viewport is narrower than the bubble, just pin to the left margin.
    const cx =
      minCx > maxCx ? minCx : Math.max(minCx, Math.min(anchor.cx, maxCx))
    el.style.left = `${cx}px`

    if (anchor.top - 4 - el.offsetHeight < EDGE) {
      el.style.top = `${anchor.bottom + 4}px`
      el.style.transform = 'translate(-50%, 0)'
    } else {
      el.style.top = `${anchor.top - 4}px`
      el.style.transform = 'translate(-50%, -100%)'
    }
  }, [visible, anchor])

  return (
    <span
      style={{ display: 'inline-flex' }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onMouseDown={onLeave}
    >
      {children}
      {visible && (
        <span
          ref={tipRef}
          style={{
            position: 'fixed',
            left: anchor.cx,
            top: anchor.top - 4,
            transform: 'translate(-50%, -100%)',
            background: '#222',
            color: '#ddd',
            fontSize: 12,
            lineHeight: 1.4,
            padding: '5px 8px',
            borderRadius: 4,
            border: '1px solid #444',
            maxWidth: MAX_WIDTH,
            whiteSpace: 'pre-wrap',
            wordWrap: 'break-word',
            zIndex: 100000,
            pointerEvents: 'none',
          }}
        >
          {text}
        </span>
      )}
    </span>
  )
}
