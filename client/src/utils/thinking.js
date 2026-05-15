// ─── Split assistant content into thinking + text ───────────
// Mirrors lib/sessions.js#splitThinkingFromContent so the client can
// hide the "Thinking" portion without re-fetching from the server.

export function splitThinkingFromContent(content) {
  const thinkingLines = [];
  const textLines = [];
  let inThinking = false;

  for (const line of (content || '').split('\n')) {
    if (line.startsWith('> 💭 *Thinking:*') || line.startsWith('> 💭 *Thinking*')) {
      inThinking = true;
      continue;
    }
    if (inThinking) {
      if (line.startsWith('> ')) {
        thinkingLines.push(line.slice(2));
      } else if (line === '>') {
        thinkingLines.push('');
      } else {
        inThinking = false;
        if (line.trim()) textLines.push(line);
      }
    } else {
      textLines.push(line);
    }
  }

  return {
    thinking: thinkingLines.join('\n').trim(),
    text: textLines.join('\n').trim(),
  };
}
