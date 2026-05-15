import { useState, useCallback, useEffect, useRef } from 'react';
import Sidebar from './components/Sidebar';
import SessionView from './components/SessionView';
import EmptyState from './components/EmptyState';
import Toast from './components/Toast';
import useDisplaySettings from './hooks/useDisplaySettings';
import { fetchSessions, fetchSession, fetchSessionMarkdown } from './utils/api';

const SESSION_REFRESH_INTERVAL_MS = 15_000;

export default function App() {
  // ─── State ───────────────────────────────────────────────
  const [sessions, setSessions] = useState({ claude: [], 'claude-internal': [], amp: [], copilot: [], codebuddy: [], box: [], codex: [] });
  const [activeAgent, setActiveAgent] = useState('all');
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [activeSessionAgent, setActiveSessionAgent] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentSession, setCurrentSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const { settings: displaySettings, updateSetting, resetSettings } = useDisplaySettings();

  // ─── Toast ───────────────────────────────────────────────
  const showToast = useCallback((message, type = 'success') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, type });
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }, []);

  // ─── Load sessions ──────────────────────────────────────
  useEffect(() => {
    let mounted = true;

    const loadSessions = async (refresh = false) => {
      try {
        const data = await fetchSessions(refresh);
        if (mounted) setSessions(data);
      } catch (err) {
        console.error('Failed to load sessions:', err);
      } finally {
        if (mounted) setLoading(false);
      }
    };

    loadSessions();
    const interval = window.setInterval(() => loadSessions(true), SESSION_REFRESH_INTERVAL_MS);
    const onFocus = () => loadSessions(true);
    window.addEventListener('focus', onFocus);

    return () => {
      mounted = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  // ─── URL routing ─────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const agent = params.get('agent');
    const id = params.get('id');
    const tab = params.get('tab');

    if (tab) setActiveAgent(tab);
    if (agent && id) {
      handleLoadSession(agent, id);
    }

    const onPopState = () => {
      const p = new URLSearchParams(window.location.search);
      const a = p.get('agent');
      const i = p.get('id');
      if (a && i) handleLoadSession(a, i);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Keyboard shortcuts ──────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        document.getElementById('search-input')?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // ─── Load a specific session ─────────────────────────────
  const handleLoadSession = useCallback(async (agent, id) => {
    setActiveSessionId(id);
    setActiveSessionAgent(agent);
    setSessionLoading(true);

    // Update URL
    const url = new URL(window.location);
    url.searchParams.set('agent', agent);
    url.searchParams.set('id', id);
    history.pushState(null, '', url);

    try {
      const session = await fetchSession(agent, id);
      setCurrentSession(session);
    } catch (err) {
      console.error('Failed to load session:', err);
      showToast('Failed to load session', 'error');
    } finally {
      setSessionLoading(false);
    }
  }, [showToast]);

  // ─── Tab change ──────────────────────────────────────────
  const handleTabChange = useCallback((agent) => {
    setActiveAgent(agent);
    const url = new URL(window.location);
    if (agent !== 'all') {
      url.searchParams.set('tab', agent);
    } else {
      url.searchParams.delete('tab');
    }
    history.replaceState(null, '', url);
  }, []);

  // ─── Session click ───────────────────────────────────────
  const handleSessionClick = useCallback((agent, id) => {
    handleLoadSession(agent, id);
    if (window.innerWidth <= 768) {
      setSidebarOpen(false);
    }
  }, [handleLoadSession]);

  // ─── Export / Copy ───────────────────────────────────────
  const handleExportMd = useCallback(async () => {
    if (!activeSessionAgent || !activeSessionId) return;
    try {
      const { text, filename } = await fetchSessionMarkdown(
        activeSessionAgent,
        activeSessionId,
        displaySettings
      );
      const blob = new Blob([text], { type: 'text/markdown' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
      showToast('Markdown file downloaded');
    } catch {
      showToast('Export failed', 'error');
    }
  }, [activeSessionAgent, activeSessionId, displaySettings, showToast]);

  const handleCopyMd = useCallback(async () => {
    if (!activeSessionAgent || !activeSessionId) return;
    try {
      const { text } = await fetchSessionMarkdown(
        activeSessionAgent,
        activeSessionId,
        displaySettings
      );
      await navigator.clipboard.writeText(text);
      showToast('Copied to clipboard');
    } catch {
      showToast('Copy failed', 'error');
    }
  }, [activeSessionAgent, activeSessionId, displaySettings, showToast]);

  // ─── Filtered sessions ──────────────────────────────────
  const filteredSessions = getFilteredSessions(sessions, activeAgent, searchQuery);

  return (
    <div id="app">
      <a href="#main-content" className="skip-link">Skip to content</a>

      <Sidebar
        sessions={filteredSessions}
        loading={loading}
        activeSessionId={activeSessionId}
        activeSessionAgent={activeSessionAgent}
        activeAgent={activeAgent}
        searchQuery={searchQuery}
        sidebarOpen={sidebarOpen}
        onTabChange={handleTabChange}
        onSearchChange={setSearchQuery}
        onSessionClick={handleSessionClick}
        onToggle={() => setSidebarOpen((o) => !o)}
        onClose={() => setSidebarOpen(false)}
      />

      <main id="main-content" className="main">
        {!currentSession && !sessionLoading && <EmptyState />}

        {sessionLoading && !currentSession && (
          <div className="session-loading">
            <div className="spinner large" aria-hidden="true" />
            <p>Loading conversation…</p>
          </div>
        )}

        {currentSession && (
          <SessionView
            session={currentSession}
            loading={sessionLoading}
            onExportMd={handleExportMd}
            onCopyMd={handleCopyMd}
            displaySettings={displaySettings}
            onUpdateSetting={updateSetting}
            onResetSettings={resetSettings}
          />
        )}
      </main>

      <button
        className="mobile-menu-btn"
        type="button"
        aria-label="Open sidebar"
        onClick={() => setSidebarOpen(true)}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <path d="M3 5h12M3 9h12M3 13h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {toast && <Toast message={toast.message} type={toast.type} />}
    </div>
  );
}

// ─── Helper ────────────────────────────────────────────────
function getFilteredSessions(sessions, activeAgent, searchQuery) {
  let list = [];

  if (activeAgent === 'all' || activeAgent === 'claude') {
    list.push(
      ...sessions.claude.map((s) => ({ ...s, agent: 'claude', agentParam: 'claude' }))
    );
  }
  if (activeAgent === 'all' || activeAgent === 'claude-internal') {
    list.push(
      ...(sessions['claude-internal'] || []).map((s) => ({ ...s, agent: 'claude-internal', agentParam: 'claude-internal' }))
    );
  }
  if (activeAgent === 'all' || activeAgent === 'amp') {
    list.push(
      ...sessions.amp.map((s) => ({ ...s, agent: 'amp', agentParam: 'amp' }))
    );
  }
  if (activeAgent === 'all' || activeAgent === 'copilot') {
    list.push(
      ...(sessions.copilot || []).map((s) => ({ ...s, agent: 'copilot', agentParam: 'copilot' }))
    );
  }
  if (activeAgent === 'all' || activeAgent === 'codebuddy') {
    list.push(
      ...(sessions.codebuddy || []).map((s) => ({ ...s, agent: 'codebuddy', agentParam: 'codebuddy' }))
    );
  }
  if (activeAgent === 'all' || activeAgent === 'box') {
    list.push(
      ...(sessions.box || []).map((s) => ({ ...s, agent: 'box', agentParam: 'box' }))
    );
  }
  if (activeAgent === 'all' || activeAgent === 'codex') {
    list.push(
      ...(sessions.codex || []).map((s) => ({ ...s, agent: 'codex', agentParam: 'codex' }))
    );
  }

  list.sort((a, b) => getSessionSortTime(b) - getSessionSortTime(a));

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    list = list.filter(
      (s) =>
        (s.summary || '').toLowerCase().includes(q) ||
        (s.title || '').toLowerCase().includes(q) ||
        (s.projectName || '').toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q)
    );
  }

  return list;
}

function getSessionSortTime(session) {
  const value = session.sortTimestamp || session.timestamp;
  const time = value ? new Date(value).getTime() : 0;
  return Number.isNaN(time) ? 0 : time;
}
