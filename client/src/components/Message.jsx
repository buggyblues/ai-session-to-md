import { memo } from 'react';
import ToolCall from './ToolCall';
import { formatTime, escapeHtml } from '../utils/format';
import { renderMarkdown } from '../utils/markdown';
import { splitThinkingFromContent } from '../utils/thinking';

function Message({ message: msg, settings }) {
  const s = settings || {};
  const showAssistant = s.showAssistant !== false;
  const showUser = s.showUser !== false;
  const showThinking = s.showThinking !== false;
  const showToolCalls = s.showToolCalls !== false;
  const showToolResults = s.showToolResults !== false;

  const roleLabel =
    msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'Assistant' : 'Tool';

  // Build body HTML
  let bodyHtml = '';

  // For assistant content: split out the "thinking" blockquote so it can be hidden
  let renderedContent = msg.content || '';
  if (msg.role === 'assistant' && renderedContent) {
    const { thinking, text } = splitThinkingFromContent(renderedContent);
    let combined = '';
    if (thinking && showThinking) {
      // Re-wrap thinking as a blockquote so the markdown renderer styles it.
      const quoted = thinking
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n');
      combined = `> 💭 *Thinking:*\n${quoted}\n\n`;
    }
    if (text && showAssistant) combined += text;
    renderedContent = combined;
  } else if (msg.role === 'user' && !showUser) {
    renderedContent = '';
  }

  if (renderedContent) {
    bodyHtml += renderMarkdown(renderedContent);
  }

  if (msg.type === 'tool_use' && msg.toolName) {
    if (!showToolCalls) return null;
    bodyHtml += `<p><strong>Tool:</strong> <code>${escapeHtml(msg.toolName)}</code></p>`;
    if (msg.toolInput) {
      bodyHtml += `<pre><code>${escapeHtml(JSON.stringify(msg.toolInput, null, 2))}</code></pre>`;
    }
  }

  if (msg.type === 'tool_result' && msg.toolOutput) {
    if (!showToolResults) return null;
    const output = msg.toolOutput.output || JSON.stringify(msg.toolOutput);
    bodyHtml += `<pre><code>${escapeHtml(
      typeof output === 'string' ? output : JSON.stringify(output, null, 2)
    )}</code></pre>`;
  }

  // Filter inline tool calls (assistant.toolCalls[])
  const visibleToolCalls = showToolCalls && msg.toolCalls ? msg.toolCalls : [];

  // If everything we'd render is empty, drop the whole message bubble.
  const hasBody = bodyHtml.trim().length > 0;
  const hasTools = visibleToolCalls.length > 0;
  if (!hasBody && !hasTools) return null;

  return (
    <div className={`message ${msg.role}`}>
      <div className="message-header">
        <span className="message-role">{roleLabel}</span>
        <span className="message-time">{formatTime(msg.timestamp)}</span>
      </div>
      <div className="message-body">
        {hasBody && <div dangerouslySetInnerHTML={{ __html: bodyHtml }} />}
        {hasTools && (
          <div className="tool-calls">
            {visibleToolCalls.map((tc, i) => (
              <ToolCall key={i} toolCall={tc} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(Message);
