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

export async function fetchSessionMarkdown(agent, id, settings) {
  const params = new URLSearchParams({ format: 'markdown' });
  if (settings) {
    // Only include the keys that are explicitly disabled to keep the URL short.
    for (const [k, v] of Object.entries(settings)) {
      if (v === false) params.set(k, '0');
    }
  }
  const url = `/api/session/${agent}/${encodeURIComponent(id)}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return {
    text: await res.text(),
    filename:
      res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] ||
      'session.md',
  };
}
