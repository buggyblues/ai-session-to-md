import { useEffect, useRef } from 'react';
import SessionItem from './SessionItem';
import { formatDate } from '../utils/format';

export default function Sidebar({
  sessions,
  loading,
  activeSessionId,
  activeSessionAgent,
  activeAgent,
  searchQuery,
  sidebarOpen,
  onTabChange,
  onSearchChange,
  onSessionClick,
  onToggle,
  onClose,
}) {
  const sidebarRef = useRef(null);

  // Close sidebar when clicking outside on mobile
  useEffect(() => {
    const handleClick = (e) => {
      if (
        window.innerWidth <= 768 &&
        sidebarOpen &&
        sidebarRef.current &&
        !sidebarRef.current.contains(e.target)
      ) {
        onClose();
      }
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [sidebarOpen, onClose]);

  const tabs = [
    { key: 'all', label: 'All' },
    { key: 'claude', label: 'Claude Code' },
    { key: 'amp', label: 'Amp' },
  ];

  return (
    <aside
      ref={sidebarRef}
      id="sidebar"
      className={`sidebar${sidebarOpen ? ' open' : ''}`}
      role="navigation"
      aria-label="Session navigation"
    >
      <header className="sidebar-header">
        <h1 className="logo">
          <span className="logo-icon" aria-hidden="true">◈</span>
          <span>Sessions</span>
        </h1>
        <button
          className="sidebar-toggle"
          aria-label="Toggle sidebar"
          type="button"
          onClick={onToggle}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <path d="M3 5h12M3 9h12M3 13h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      {/* Agent Tabs */}
      <div className="agent-tabs" role="tablist" aria-label="Agent filter">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            role="tab"
            className={`tab${activeAgent === tab.key ? ' active' : ''}`}
            aria-selected={activeAgent === tab.key}
            onClick={() => onTabChange(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="search-wrap">
        <label htmlFor="search-input" className="sr-only">Search sessions</label>
        <input
          id="search-input"
          type="search"
          placeholder="Search sessions…"
          autoComplete="off"
          spellCheck="false"
          className="search-input"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value.trim())}
        />
      </div>

      {/* Session List */}
      <nav className="session-list" aria-label="Sessions">
        {loading && (
          <div className="loading-state">
            <div className="spinner" aria-hidden="true" />
            <p>Loading sessions…</p>
          </div>
        )}

        {!loading && sessions.length === 0 && (
          <div className="loading-state">
            <p>No sessions found</p>
          </div>
        )}

        {!loading &&
          sessions.map((session) => (
            <SessionItem
              key={`${session.agentParam}-${session.id}`}
              session={session}
              isActive={
                session.id === activeSessionId &&
                session.agentParam === activeSessionAgent
              }
              onClick={() => onSessionClick(session.agentParam, session.id)}
            />
          ))}
      </nav>

      <footer className="sidebar-footer">
        <div className="session-count" aria-live="polite">
          {!loading && `${sessions.length} session${sessions.length !== 1 ? 's' : ''}`}
        </div>
      </footer>
    </aside>
  );
}
