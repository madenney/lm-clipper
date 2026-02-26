import { useState, useEffect, useRef } from 'react'

type CodeEditorModalProps = {
  code: string
  filterName: string
  onSave: (_code: string) => void
  onClose: () => void
}

export default function CodeEditorModal({
  code,
  filterName,
  onSave,
  onClose,
}: CodeEditorModalProps) {
  const [local, setLocal] = useState(code)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onSave(local)
        onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [local, onSave, onClose])

  const handleTab = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      const ta = e.currentTarget
      const start = ta.selectionStart
      const end = ta.selectionEnd
      const val = ta.value
      const next = `${val.substring(0, start)}  ${val.substring(end)}`
      setLocal(next)
      requestAnimationFrame(() => {
        ta.selectionStart = start + 2
        ta.selectionEnd = start + 2
      })
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={() => {
        onSave(local)
        onClose()
      }}
    >
      <div
        style={{
          background: '#1e1e2e',
          borderRadius: 8,
          width: '80%',
          maxWidth: 800,
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderBottom: '1px solid #333',
          }}
        >
          <span style={{ color: '#cdd6f4', fontSize: 14, fontWeight: 600 }}>
            {filterName}
          </span>
          <button
            type="button"
            onClick={() => {
              onSave(local)
              onClose()
            }}
            style={{
              background: '#45475a',
              color: '#cdd6f4',
              border: 'none',
              borderRadius: 4,
              padding: '4px 14px',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Done
          </button>
        </div>
        <textarea
          ref={textareaRef}
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          onKeyDown={handleTab}
          spellCheck={false}
          style={{
            flex: 1,
            minHeight: 400,
            background: '#181825',
            color: '#cdd6f4',
            border: 'none',
            padding: 16,
            fontFamily: "'Fira Code', 'Consolas', 'Monaco', monospace",
            fontSize: 13,
            lineHeight: 1.5,
            resize: 'vertical',
            outline: 'none',
            tabSize: 2,
            borderRadius: '0 0 8px 8px',
          }}
        />
      </div>
    </div>
  )
}
