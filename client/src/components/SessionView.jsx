import { useRef, useEffect, useMemo } from 'react';
import Message from './Message';
import DisplaySettings from './DisplaySettings';
import { formatFullDate } from '../utils/format';

export default function SessionView({
  session,
  loading,
  onExportMd,
  onCopyMd,
  displaySettings,
  onUpdateSetting,
  onResetSettings,
}) {
  const messagesRef = useRef(null);

  // Scroll to top when session changes
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = 0;
    }
  }, [session?.id]);

  const getAgentLabel = (agent) => {
    switch (agent) {
      case 'claude-code':
        return { label: 'Claude Code', class: 'claude' };
      case 'claude-internal':
        return { label: 'Claude Internal', class: 'claude-internal' };
      case 'amp':
        return { label: 'Amp', class: 'amp' };
      case 'copilot':
        return { label: 'GitHub Copilot CLI', class: 'copilot' };
      case 'codebuddy':
        return { label: 'CodeBuddy', class: 'codebuddy' };
      case 'box':
        return { label: 'Box', class: 'box' };
      case 'codex':
        return { label: 'Codex', class: 'codex' };
      default:
        return { label: agent, class: agent };
    }
  };

  const { label: agentLabel, class: agentClass } = getAgentLabel(session.agent);
  const firstModel = session.messages.find((m) => m.model)?.model || '';

  // Filter messages by role/type based on display settings.
  // Note: per-message inner filtering (thinking, toolCalls, tool_use payload)
  // is handled inside <Message />.
  const settings = displaySettings || {};
  const visibleMessages = useMemo(() => {
    return session.messages.filter((m) => {
      if (m.role === 'user') return settings.showUser !== false;
      if (m.role === 'assistant') {
        // assistant message survives if either text OR (tool calls allowed and present)
        if (settings.showAssistant === false) {
          // Even with assistant text hidden, keep the message if it carries
          // visible tool calls so the user can still see them.
          if (settings.showToolCalls !== false && m.toolCalls?.length) return true;
          return false;
        }
        return true;
      }
      if (m.role === 'tool') return settings.showToolResults !== false;
      return true;
    });
  }, [session.messages, settings.showUser, settings.showAssistant, settings.showToolCalls, settings.showToolResults]);



  return (
    <div
      className="session-view"
      style={loading ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
    >
      {/* Session Header */}
      <header className="session-header">
        <div className="session-meta">
          <span className={`agent-badge ${agentClass}`}>{agentLabel}</span>
          <time dateTime={session.timestamp || ''}>
            {formatFullDate(session.timestamp)}
          </time>
          {firstModel && <span className="session-model">{firstModel}</span>}
        </div>
        <h2 className="session-title" style={{ textWrap: 'balance' }}>
          {session.title || session.summary || session.id}
        </h2>
        <div className="session-actions">
          {displaySettings && (
            <DisplaySettings
              settings={displaySettings}
              onUpdate={onUpdateSetting}
              onReset={onResetSettings}
            />
          )}
          <button
            className="btn btn-secondary"
            type="button"
            aria-label="Export as Markdown"
            onClick={onExportMd}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M2 11l6 3 6-3M2 8l6 3 6-3M2 5l6 3 6-3"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Export .md
          </button>
          <button
            className="btn btn-secondary"
            type="button"
            aria-label="Copy as Markdown"
            onClick={onCopyMd}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            Copy
          </button>
        </div>
      </header>

      {/* Messages */}
      <div ref={messagesRef} className="messages" role="log" aria-label="Conversation messages">
        {visibleMessages.length === 0 && (
          <div className="messages-empty">
            <p>All content types are hidden.</p>
            <button type="button" className="btn btn-secondary" onClick={onResetSettings}>
              Reset display settings
            </button>
          </div>
        )}
        {visibleMessages.map((msg, i) => (
          <Message key={i} message={msg} settings={settings} />
        ))}
      </div>
    </div>
  );
}
