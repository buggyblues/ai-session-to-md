// ─── State ────────────────────────────────────────────────────
const state = {
  sessions: { claude: [], amp: [] },
  activeAgent: "all",
  activeSessionId: null,
  activeSessionAgent: null,
  searchQuery: "",
};

// ─── DOM Refs ─────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const sessionListEl = $("#session-list");
const sidebarLoadingEl = $("#sidebar-loading");
const sessionCountEl = $("#session-count");
const emptyStateEl = $("#empty-state");
const sessionViewEl = $("#session-view");
const sessionLoadingEl = $("#session-loading");
const messagesEl = $("#messages");
const searchInput = $("#search-input");
const agentBadgeEl = $("#agent-badge");
const sessionTitleEl = $("#session-title");
const sessionDateEl = $("#session-date");
const sessionModelEl = $("#session-model");
const btnExportMd = $("#btn-export-md");
const btnCopyMd = $("#btn-copy-md");
const sidebarEl = $("#sidebar");
const sidebarToggle = $("#sidebar-toggle");

// ─── Markdown Renderer (lightweight) ─────────────────────────
function renderMarkdown(text) {
  if (!text) return "";
  let html = text;

  // Escape HTML first
  html = html
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="language-${lang}">${code}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Italic
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Headers
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");

  // Horizontal rules
  html = html.replace(/^---$/gm, "<hr>");

  // Unordered lists
  html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>");

  // Links
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );

  // Paragraphs (consecutive non-tag lines)
  html = html.replace(
    /^(?!<[a-z/])((?:(?!<[a-z/]).+\n?)+)/gm,
    (match) => `<p>${match.trim()}</p>`
  );

  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, "");

  return html;
}

// ─── Toast ────────────────────────────────────────────────────
function showToast(message, type = "success") {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toast.setAttribute("aria-live", "polite");
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}

// ─── Format Helpers (using Intl for localization) ─────────────
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

const weekdayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
});

const shortDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

const fullDateFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function formatDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const diff = now - d;

  if (diff < 86400000) {
    return dateFormatter.format(d);
  }
  if (diff < 604800000) {
    return weekdayFormatter.format(d);
  }
  return shortDateFormatter.format(d);
}

function formatFullDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return fullDateFormatter.format(d);
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return timeFormatter.format(d);
}

// ─── Session List ─────────────────────────────────────────────
async function loadSessions() {
  try {
    const res = await fetch("/api/sessions");
    const data = await res.json();
    state.sessions = data;
    sidebarLoadingEl.remove();
    renderSessionList();
  } catch (err) {
    sidebarLoadingEl.innerHTML = `<p style="color: var(--error)">Failed to load sessions</p>`;
    console.error("Failed to load sessions:", err);
  }
}

function getFilteredSessions() {
  let sessions = [];

  if (state.activeAgent === "all" || state.activeAgent === "claude") {
    sessions.push(
      ...state.sessions.claude.map((s) => ({
        ...s,
        agent: "claude",
        agentParam: "claude",
      }))
    );
  }

  if (state.activeAgent === "all" || state.activeAgent === "amp") {
    sessions.push(
      ...state.sessions.amp.map((s) => ({
        ...s,
        agent: "amp",
        agentParam: "amp",
      }))
    );
  }

  // Sort by timestamp descending
  sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Search filter
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    sessions = sessions.filter(
      (s) =>
        (s.summary || "").toLowerCase().includes(q) ||
        (s.title || "").toLowerCase().includes(q) ||
        (s.projectName || "").toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q)
    );
  }

  return sessions;
}

function renderSessionList() {
  const sessions = getFilteredSessions();

  // Remove old items (but keep loading indicator if present)
  const existingItems = sessionListEl.querySelectorAll(".session-item");
  existingItems.forEach((el) => el.remove());

  if (sessions.length === 0 && document.contains(sidebarLoadingEl)) return;

  if (sessions.length === 0) {
    const emptyEl = document.createElement("div");
    emptyEl.className = "loading-state session-item";
    emptyEl.innerHTML = "<p>No sessions found</p>";
    sessionListEl.appendChild(emptyEl);
  }

  // Use DocumentFragment for performance
  const fragment = document.createDocumentFragment();

  for (const session of sessions) {
    const btn = document.createElement("button");
    btn.className = "session-item";
    btn.type = "button";
    if (
      session.id === state.activeSessionId &&
      session.agentParam === state.activeSessionAgent
    ) {
      btn.classList.add("active");
    }

    const displayTitle =
      session.title || session.summary || session.id.split("/").pop();

    btn.innerHTML = `
      <div class="session-item-header">
        <span class="session-agent-dot ${session.agent}" aria-hidden="true"></span>
        <span class="session-item-title">${escapeHtml(displayTitle)}</span>
        <span class="session-item-time">${formatDate(session.timestamp)}</span>
      </div>
      ${session.summary && session.summary !== displayTitle ? `<span class="session-item-summary">${escapeHtml(session.summary)}</span>` : ""}
      ${session.projectName ? `<span class="session-item-project">${escapeHtml(session.projectName)}</span>` : ""}
    `;

    btn.addEventListener("click", () => {
      loadSession(session.agentParam, session.id);
      // Close sidebar on mobile
      if (window.innerWidth <= 768) {
        sidebarEl.classList.remove("open");
      }
    });

    fragment.appendChild(btn);
  }

  sessionListEl.appendChild(fragment);

  // Update count
  sessionCountEl.textContent = `${sessions.length} session${sessions.length !== 1 ? "s" : ""}`;
}

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Load & Render Session ────────────────────────────────────
async function loadSession(agent, id) {
  state.activeSessionId = id;
  state.activeSessionAgent = agent;

  // Update URL
  const url = new URL(window.location);
  url.searchParams.set("agent", agent);
  url.searchParams.set("id", id);
  history.pushState(null, "", url);

  // Update sidebar active state
  renderSessionList();

  // Show loading
  emptyStateEl.hidden = true;
  sessionViewEl.hidden = true;
  sessionLoadingEl.hidden = false;

  try {
    const res = await fetch(`/api/session/${agent}/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const session = await res.json();

    renderSession(session);

    sessionLoadingEl.hidden = true;
    sessionViewEl.hidden = false;
  } catch (err) {
    sessionLoadingEl.hidden = true;
    emptyStateEl.hidden = false;
    showToast("Failed to load session", "error");
    console.error("Failed to load session:", err);
  }
}

function renderSession(session) {
  // Header
  const agentLabel = session.agent === "claude-code" ? "Claude Code" : "Amp";
  const agentClass =
    session.agent === "claude-code" ? "claude" : "amp";

  agentBadgeEl.className = `agent-badge ${agentClass}`;
  agentBadgeEl.textContent = agentLabel;

  sessionTitleEl.textContent =
    session.title || session.summary || session.id;
  sessionDateEl.textContent = formatFullDate(session.timestamp);
  sessionDateEl.setAttribute("datetime", session.timestamp || "");

  // Find first model used
  const firstModel = session.messages.find((m) => m.model)?.model || "";
  sessionModelEl.textContent = firstModel;

  // Messages
  messagesEl.innerHTML = "";
  const fragment = document.createDocumentFragment();

  for (const msg of session.messages) {
    const div = document.createElement("div");
    div.className = `message ${msg.role}`;

    const roleLabel =
      msg.role === "user"
        ? "You"
        : msg.role === "assistant"
          ? "Assistant"
          : "Tool";

    let bodyHtml = "";

    if (msg.content) {
      bodyHtml += renderMarkdown(msg.content);
    }

    if (msg.type === "tool_use" && msg.toolName) {
      bodyHtml += `<p><strong>Tool:</strong> <code>${escapeHtml(msg.toolName)}</code></p>`;
      if (msg.toolInput) {
        bodyHtml += `<pre><code>${escapeHtml(JSON.stringify(msg.toolInput, null, 2))}</code></pre>`;
      }
    }

    if (msg.type === "tool_result" && msg.toolOutput) {
      const output = msg.toolOutput.output || JSON.stringify(msg.toolOutput);
      bodyHtml += `<pre><code>${escapeHtml(typeof output === "string" ? output : JSON.stringify(output, null, 2))}</code></pre>`;
    }

    // Tool calls
    let toolCallsHtml = "";
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      toolCallsHtml = `<div class="tool-calls">`;
      for (const tc of msg.toolCalls) {
        const inputStr = JSON.stringify(tc.input, null, 2);
        // Truncate very large inputs
        const displayInput =
          inputStr.length > 3000
            ? inputStr.slice(0, 3000) + "\n… (truncated)"
            : inputStr;
        toolCallsHtml += `
          <div class="tool-call">
            <button class="tool-call-header" type="button" aria-expanded="false" onclick="this.parentElement.classList.toggle('expanded'); this.setAttribute('aria-expanded', this.parentElement.classList.contains('expanded'))">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
              <span>🔧</span>
              <span class="tool-call-name">${escapeHtml(tc.name)}</span>
            </button>
            <div class="tool-call-body">
              <pre>${escapeHtml(displayInput)}</pre>
            </div>
          </div>
        `;
      }
      toolCallsHtml += `</div>`;
    }

    div.innerHTML = `
      <div class="message-header">
        <span class="message-role">${roleLabel}</span>
        <span class="message-time">${formatTime(msg.timestamp)}</span>
      </div>
      <div class="message-body">
        ${bodyHtml}
        ${toolCallsHtml}
      </div>
    `;

    fragment.appendChild(div);
  }

  messagesEl.appendChild(fragment);
  messagesEl.scrollTop = 0;
}

// ─── Export / Copy ────────────────────────────────────────────
btnExportMd.addEventListener("click", async () => {
  if (!state.activeSessionAgent || !state.activeSessionId) return;
  btnExportMd.disabled = true;
  try {
    const url = `/api/session/${state.activeSessionAgent}/${encodeURIComponent(state.activeSessionId)}?format=markdown`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download =
      res.headers
        .get("Content-Disposition")
        ?.match(/filename="(.+)"/)?.[1] || "session.md";
    a.click();
    URL.revokeObjectURL(a.href);
    showToast("Markdown file downloaded");
  } catch {
    showToast("Export failed", "error");
  } finally {
    btnExportMd.disabled = false;
  }
});

btnCopyMd.addEventListener("click", async () => {
  if (!state.activeSessionAgent || !state.activeSessionId) return;
  btnCopyMd.disabled = true;
  try {
    const url = `/api/session/${state.activeSessionAgent}/${encodeURIComponent(state.activeSessionId)}?format=markdown`;
    const res = await fetch(url);
    const text = await res.text();
    await navigator.clipboard.writeText(text);
    showToast("Copied to clipboard");
  } catch {
    showToast("Copy failed", "error");
  } finally {
    btnCopyMd.disabled = false;
  }
});

// ─── Tab Switching ────────────────────────────────────────────
$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => {
      t.classList.remove("active");
      t.setAttribute("aria-selected", "false");
    });
    tab.classList.add("active");
    tab.setAttribute("aria-selected", "true");
    state.activeAgent = tab.dataset.agent;

    // Sync to URL
    const url = new URL(window.location);
    if (state.activeAgent !== "all") {
      url.searchParams.set("tab", state.activeAgent);
    } else {
      url.searchParams.delete("tab");
    }
    history.replaceState(null, "", url);

    renderSessionList();
  });
});

// ─── Search ───────────────────────────────────────────────────
searchInput.addEventListener("input", () => {
  state.searchQuery = searchInput.value.trim();
  renderSessionList();
});

// ─── Keyboard Shortcuts ───────────────────────────────────────
document.addEventListener("keydown", (e) => {
  // Cmd/Ctrl+K → focus search
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

// ─── Sidebar Toggle (mobile) ─────────────────────────────────
sidebarToggle.addEventListener("click", () => {
  sidebarEl.classList.toggle("open");
});

const mobileMenuBtn = document.getElementById("mobile-menu-btn");
if (mobileMenuBtn) {
  mobileMenuBtn.addEventListener("click", () => {
    sidebarEl.classList.add("open");
  });
}

// Close sidebar when clicking outside on mobile
document.addEventListener("click", (e) => {
  if (
    window.innerWidth <= 768 &&
    sidebarEl.classList.contains("open") &&
    !sidebarEl.contains(e.target) &&
    e.target !== mobileMenuBtn
  ) {
    sidebarEl.classList.remove("open");
  }
});

// ─── URL Routing ──────────────────────────────────────────────
function handleRoute() {
  const params = new URLSearchParams(window.location.search);
  const agent = params.get("agent");
  const id = params.get("id");
  const tab = params.get("tab");

  if (tab) {
    state.activeAgent = tab;
    $$(".tab").forEach((t) => {
      const isActive = t.dataset.agent === tab;
      t.classList.toggle("active", isActive);
      t.setAttribute("aria-selected", isActive ? "true" : "false");
    });
  }

  if (agent && id) {
    loadSession(agent, id);
  }
}

window.addEventListener("popstate", handleRoute);

// ─── Init ─────────────────────────────────────────────────────
(async function init() {
  await loadSessions();
  handleRoute();
})();
