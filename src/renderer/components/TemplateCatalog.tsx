/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import { useState, useMemo, useRef, useEffect } from 'react'
import { SavedCustomFilter } from '../../constants/types'
import '../styles/TemplateCatalog.css'

interface TemplateCatalogProps {
  templates: SavedCustomFilter[]
  onSelect: (_template: SavedCustomFilter) => void
  onClose: () => void
}

export default function TemplateCatalog({
  templates,
  onSelect,
  onClose,
}: TemplateCatalogProps) {
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState('All')
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Derive categories from templates
  const categories = useMemo(() => {
    const builtInCats = new Set<string>()
    let hasUser = false
    for (const t of templates) {
      if (t.builtIn) {
        builtInCats.add(t.category || 'Other')
      } else {
        hasUser = true
      }
    }
    const sorted = [...builtInCats].sort()
    const cats = ['All', ...sorted]
    if (hasUser) cats.push('My Templates')
    return cats
  }, [templates])

  // Filter templates by category + search
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    return templates.filter((t) => {
      // Category filter
      if (activeCategory === 'My Templates') {
        if (t.builtIn) return false
      } else if (activeCategory !== 'All') {
        if (t.builtIn && (t.category || 'Other') !== activeCategory)
          return false
        if (!t.builtIn) return false
      }
      // Search filter
      if (q) {
        const haystack =
          `${t.name} ${t.description || ''} ${t.category || ''}`.toLowerCase()
        return haystack.includes(q)
      }
      return true
    })
  }, [templates, activeCategory, search])

  return (
    <div className="tc-overlay" onClick={onClose}>
      <div className="tc-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="tc-header">
          <span className="tc-title">Browse Templates</span>
          <div className="tc-search-wrap">
            <input
              ref={searchRef}
              className="tc-search"
              type="text"
              placeholder="Search templates..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button type="button" className="tc-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="tc-body">
          {/* Sidebar */}
          <div className="tc-sidebar">
            {categories.map((cat) => (
              <div
                key={cat}
                className={`tc-cat${activeCategory === cat ? ' tc-cat-active' : ''}${cat === 'My Templates' ? ' tc-cat-user' : ''}`}
                onClick={() => setActiveCategory(cat)}
              >
                {cat}
              </div>
            ))}
          </div>

          {/* Template list */}
          <div className="tc-list">
            {filtered.length === 0 && (
              <div className="tc-empty">
                {search
                  ? 'No templates match your search.'
                  : 'No templates in this category.'}
              </div>
            )}
            {filtered.map((t, i) => (
              <div
                key={`${t.name}-${i}`}
                className="tc-item"
                onClick={() => onSelect(t)}
              >
                <div className="tc-item-top">
                  <span className="tc-item-name">{t.name}</span>
                  {t.category && t.builtIn && (
                    <span className="tc-item-badge">{t.category}</span>
                  )}
                  {!t.builtIn && (
                    <span className="tc-item-badge tc-item-badge-user">
                      My Template
                    </span>
                  )}
                </div>
                {t.description && (
                  <div className="tc-item-desc">{t.description}</div>
                )}
                {t.customParams && t.customParams.length > 0 && (
                  <div className="tc-item-params">
                    {t.customParams.map((p) => (
                      <span key={p.name} className="tc-item-param">
                        {p.name}
                        {p.value ? `=${p.value}` : ''}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
