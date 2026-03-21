import { useState, useRef, useEffect, ReactNode } from 'react'

interface TooltipProps {
  text: string
  offsetX?: number
  children: ReactNode
}

export default function Tooltip({ text, offsetX = 0, children }: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  function onEnter(e: React.MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setPos({ x: rect.left + rect.width / 2 + offsetX, y: rect.top })
    timer.current = setTimeout(() => setVisible(true), 300)
  }

  function onLeave() {
    if (timer.current) clearTimeout(timer.current)
    setVisible(false)
  }

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
          style={{
            position: 'fixed',
            left: pos.x,
            top: pos.y - 4,
            transform: 'translate(-50%, -100%)',
            background: '#222',
            color: '#ddd',
            fontSize: 12,
            lineHeight: 1.4,
            padding: '5px 8px',
            borderRadius: 4,
            border: '1px solid #444',
            maxWidth: 300,
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
