import { memo } from 'react';
import { formatDate } from '../utils/format';

function SessionItem({ session, isActive, onClick }) {
  const displayTitle =
    session.title || session.summary || session.id.split('/').pop();

  return (
    <button
      className={`session-item${isActive ? ' active' : ''}`}
      type="button"
      onClick={onClick}
    >
      <div className="session-item-header">
        <span className={`session-agent-dot ${session.agent}`} aria-hidden="true" />
        <span className="session-item-title">{displayTitle}</span>
        <span className="session-item-time">{formatDate(session.timestamp)}</span>
      </div>
      {session.summary && session.summary !== displayTitle && (
        <span className="session-item-summary">{session.summary}</span>
      )}
      {session.projectName && (
        <span className="session-item-project">{session.projectName}</span>
      )}
    </button>
  );
}

export default memo(SessionItem);
