import { useState, memo } from 'react';
import { escapeHtml } from '../utils/format';

function ToolCall({ toolCall: tc }) {
  const [expanded, setExpanded] = useState(false);
  const inputStr = JSON.stringify(tc.input, null, 2);
  const displayInput =
    inputStr.length > 3000
      ? inputStr.slice(0, 3000) + '\n… (truncated)'
      : inputStr;

  return (
    <div className={`tool-call${expanded ? ' expanded' : ''}`}>
      <button
        className="tool-call-header"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span>🔧</span>
        <span className="tool-call-name">{tc.name}</span>
      </button>
      <div className="tool-call-body">
        <pre>{displayInput}</pre>
      </div>
    </div>
  );
}

export default memo(ToolCall);
