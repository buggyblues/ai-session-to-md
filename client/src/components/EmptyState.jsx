export default function EmptyState() {
  return (
    <div className="empty-state">
      <div className="empty-icon" aria-hidden="true">
        <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
          <rect x="8" y="12" width="48" height="40" rx="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
          <path d="M20 28h24M20 36h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.3" />
        </svg>
      </div>
      <h2 style={{ textWrap: 'balance' }}>Select a session to view</h2>
      <p className="empty-hint">
        Choose a conversation from the sidebar, or use <kbd>⌘</kbd><kbd>K</kbd> to search.
      </p>
    </div>
  );
}
