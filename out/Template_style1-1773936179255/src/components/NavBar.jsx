import React from 'react'

// Icon used by the reset action button.
function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M19.2 8.8A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.76-4.24L13 11h8V3l-1.8 1.8Z"
        fill="currentColor"
      />
    </svg>
  )
}

// Top navigation with app branding, optional links, and quick actions.
export default function NavBar({ appName, logoPath, links, theme, onToggleTheme, onReset }) {
  // Compact two-letter badge for current theme mode.
  const badgeLabel = theme === 'dark' ? 'DK' : 'LT'

  return (
    <header className="navbar">
      <div className="brand">
        {logoPath ? <img src={logoPath} alt={`${appName} logo`} /> : null}
        <span>{appName}</span>
      </div>
      <div className="nav-actions">
        {links?.length ? (
          <nav className="top-links" aria-label="Helpful links">
            {links.slice(0, 2).map((l, i) => (
              <a key={i} href={l.href}>{l.label}</a>
            ))}
          </nav>
        ) : null}
        <button
          type="button"
          className="icon-btn"
          onClick={onReset}
          aria-label="Reset conversation"
          title="Reset conversation"
        >
          <RefreshIcon />
        </button>
        <button
          type="button"
          className="mode-pill"
          onClick={onToggleTheme}
          aria-label="Toggle dark or light mode"
          title="Toggle theme"
        >
          {badgeLabel}
        </button>
      </div>
    </header>
  )
}
