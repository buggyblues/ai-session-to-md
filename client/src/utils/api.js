// ─── API Client ──────────────────────────────────────────────

export async function fetchSessions(refresh = false) {
  const url = refresh ? '/api/sessions?refresh=true' : '/api/sessions';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchSession(agent, id) {
  const res = await fetch(`/api/session/${agent}/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchSessionMarkdown(agent, id) {
  const url = `/api/session/${agent}/${encodeURIComponent(id)}?format=markdown`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return {
    text: await res.text(),
    filename:
      res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] ||
      'session.md',
  };
}
