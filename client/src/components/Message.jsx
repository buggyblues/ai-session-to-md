import { memo } from 'react';
import ToolCall from './ToolCall';
import { formatTime, escapeHtml } from '../utils/format';
import { renderMarkdown } from '../utils/markdown';

function Message({ message: msg }) {
  const roleLabel =
    msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'Assistant' : 'Tool';

  // Build body HTML
  let bodyHtml = '';

  if (msg.content) {
    bodyHtml += renderMarkdown(msg.content);
  }

  if (msg.type === 'tool_use' && msg.toolName) {
    bodyHtml += `<p><strong>Tool:</strong> <code>${escapeHtml(msg.toolName)}</code></p>`;
    if (msg.toolInput) {
      bodyHtml += `<pre><code>${escapeHtml(JSON.stringify(msg.toolInput, null, 2))}</code></pre>`;
    }
  }

  if (msg.type === 'tool_result' && msg.toolOutput) {
    const output = msg.toolOutput.output || JSON.stringify(msg.toolOutput);
    bodyHtml += `<pre><code>${escapeHtml(
      typeof output === 'string' ? output : JSON.stringify(output, null, 2)
    )}</code></pre>`;
  }

  return (
    <div className={`message ${msg.role}`}>
      <div className="message-header">
        <span className="message-role">{roleLabel}</span>
        <span className="message-time">{formatTime(msg.timestamp)}</span>
      </div>
      <div className="message-body">
        <div dangerouslySetInnerHTML={{ __html: bodyHtml }} />
        {msg.toolCalls && msg.toolCalls.length > 0 && (
          <div className="tool-calls">
            {msg.toolCalls.map((tc, i) => (
              <ToolCall key={i} toolCall={tc} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(Message);
