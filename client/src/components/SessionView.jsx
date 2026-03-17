import { useRef, useEffect } from 'react';
import Message from './Message';
import { formatFullDate } from '../utils/format';

export default function SessionView({ session, loading, onExportMd, onCopyMd }) {
  const messagesRef = useRef(null);

  // Scroll to top when session changes
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = 0;
    }
  }, [session?.id]);

  const agentLabel = session.agent === 'claude-code' ? 'Claude Code' : 'Amp';
  const agentClass = session.agent === 'claude-code' ? 'claude' : 'amp';
  const firstModel = session.messages.find((m) => m.model)?.model || '';

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
        {session.messages.map((msg, i) => (
          <Message key={i} message={msg} />
        ))}
      </div>
    </div>
  );
}
