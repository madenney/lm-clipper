/* eslint-disable jsx-a11y/no-static-element-interactions */
/* eslint-disable jsx-a11y/click-events-have-key-events */
import { useState, useMemo, useRef, useEffect } from 'react'
import { SavedCustomFilter } from '../../constants/types'
import { FILTER_LAYOUT, PRODUCER_LABEL } from '../../constants/config'
import '../styles/TemplateCatalog.css'

interface TemplateCatalogProps {
  templates: SavedCustomFilter[]
  onSelect: (_template: SavedCustomFilter) => void
  onClose: () => void
  // Filter types currently in the chain — used to grey entries whose required
  // upstream producer isn't present yet.
  presentTypes: string[]
}

export default function TemplateCatalog({
  templates,
  onSelect,
  onClose,
  presentTypes,
}: TemplateCatalogProps) {
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState('All')
  const searchRef = useRef<HTMLInputElement>(null)
  const presentSet = useMemo(() => new Set(presentTypes), [presentTypes])

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
    // Tab order comes from FILTER_LAYOUT (the single source of truth); any
    // category not listed there (e.g. a future template-only one) falls back
    // to alphabetical after the known tabs.
    const rank = (c: string) => {
      const i = FILTER_LAYOUT.modalTabs.indexOf(c)
      return i === -1 ? FILTER_LAYOUT.modalTabs.length : i
    }
    const sorted = [...builtInCats].sort(
      (a, b) => rank(a) - rank(b) || a.localeCompare(b),
    )
    const cats = ['All', ...sorted]
    if (hasUser) cats.push('My Templates')
    cats.push('Community')
    return cats
  }, [templates])

  // Filter templates by category + search, then sort alphabetically. This is a
  // browse list, so A–Z makes a known filter easy to find; native filters and
  // code templates interleave by name. (The main dropdown deliberately does NOT
  // sort — it reads in workflow/pipeline order.)
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    return templates
      .filter((t) => {
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
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [templates, activeCategory, search])

  return (
    <div className="tc-overlay" onClick={onClose}>
      <div className="tc-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="tc-header">
          <span className="tc-title">Browse more</span>
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
                className={`tc-cat${activeCategory === cat ? ' tc-cat-active' : ''}${cat === 'My Templates' ? ' tc-cat-user' : ''}${cat === 'Community' ? ' tc-cat-community' : ''}`}
                onClick={() => setActiveCategory(cat)}
              >
                {cat}
              </div>
            ))}
          </div>

          {/* Template list */}
          <div className="tc-list">
            {activeCategory === 'Community' && (
              <div className="tc-community">
                <div className="tc-community-title">Community Templates</div>
                <p className="tc-community-text">
                  Community-submitted templates will show up here in future
                  updates. Have a cool filter you think others would find
                  useful?
                </p>
                <p className="tc-community-text">
                  Join the{' '}
                  <span
                    className="tc-community-link"
                    onClick={() => window.open('https://discord.gg/ThjMCW3F4R')}
                  >
                    Discord
                  </span>{' '}
                  and share your template — we&apos;ll review it and add it to
                  the built-in list for everyone to use.
                </p>
              </div>
            )}
            {activeCategory !== 'Community' && filtered.length === 0 && (
              <div className="tc-empty">
                {search
                  ? 'No templates match your search.'
                  : 'No templates in this category.'}
              </div>
            )}
            {activeCategory !== 'Community' &&
              filtered.map((t, i) => {
                // A native catalog entry names its exact producer; a JS template
                // uses the legacy `requiresParser` shorthand for the combo parser.
                const needProducer =
                  t.requiredProducer ??
                  (t.requiresParser ? 'slpParser' : undefined)
                const needLabel = needProducer
                  ? PRODUCER_LABEL[needProducer] || needProducer
                  : ''
                const disabled = !!needProducer && !presentSet.has(needProducer)
                return (
                  <div
                    key={`${t.name}-${i}`}
                    className={`tc-item${disabled ? ' tc-item-disabled' : ''}`}
                    onClick={() => !disabled && onSelect(t)}
                    title={disabled ? `Add a ${needLabel} first` : undefined}
                  >
                    <div className="tc-item-top">
                      <span className="tc-item-name">{t.name}</span>
                      {disabled && (
                        <span className="tc-item-badge tc-item-badge-parser">
                          Needs {needLabel}
                        </span>
                      )}
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
                )
              })}
          </div>
        </div>
      </div>
    </div>
  )
}
