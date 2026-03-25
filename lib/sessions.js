// lib/sessions.js — Core session parsing, listing, caching, and markdown logic
// Extracted from server.js for reuse by both the web server and CLI

import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

// ─── Paths ───────────────────────────────────────────────────
export const CLAUDE_TRANSCRIPTS_DIR = join(homedir(), ".claude", "transcripts");
export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
export const CLAUDE_INTERNAL_PROJECTS_DIR = join(homedir(), ".claude-internal", "projects");
export const AMP_THREADS_DIR = join(homedir(), ".local", "share", "amp", "threads");
export const COPILOT_SESSION_DIR = join(homedir(), ".copilot", "session-state");
export const CODEBUDDY_PROJECTS_DIR = join(homedir(), ".codebuddy", "projects");
export const CODEBUDDY_HISTORY_FILE = join(homedir(), ".codebuddy", "history.jsonl");
export const CODEBUDDY_INSTANCES_FILE = join(homedir(), ".codebuddy", "instances.json");

// ─── Session Cache ──────────────────────────────────────────
const sessionCache = {
  claude: { data: null, timestamp: 0 },
  "claude-internal": { data: null, timestamp: 0 },
  amp: { data: null, timestamp: 0 },
  copilot: { data: null, timestamp: 0 },
  codebuddy: { data: null, timestamp: 0 },
};
const CACHE_TTL = 60_000; // 1 minute

export function getCachedSessions(agent) {
  const entry = sessionCache[agent];
  if (entry.data && Date.now() - entry.timestamp < CACHE_TTL) {
    return entry.data;
  }
  return null;
}

export function setCachedSessions(agent, data) {
  sessionCache[agent] = { data, timestamp: Date.now() };
}

export function invalidateCache(agent) {
  if (agent) {
    sessionCache[agent] = { data: null, timestamp: 0 };
  } else {
    sessionCache.claude = { data: null, timestamp: 0 };
    sessionCache["claude-internal"] = { data: null, timestamp: 0 };
    sessionCache.amp = { data: null, timestamp: 0 };
    sessionCache.copilot = { data: null, timestamp: 0 };
    sessionCache.codebuddy = { data: null, timestamp: 0 };
  }
}

// ─── Helpers ─────────────────────────────────────────────────

export function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

export function truncate(str, max = 120) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + "\u2026" : str;
}

export function formatTimestamp(ts) {
  if (!ts) return "";
  const d = new Date(typeof ts === "number" ? ts : ts);
  return isNaN(d.getTime()) ? "" : d.toISOString();
}

// ─── Claude Code Parser ──────────────────────────────────────

export async function scanProjectsDir(projectsDir, source) {
  const sessions = [];
  try {
    const projectDirs = await readdir(projectsDir);
    const dirResults = await Promise.all(
      projectDirs.map(async (projDir) => {
        const projPath = join(projectsDir, projDir);
        try {
          const projStat = await stat(projPath);
          if (!projStat.isDirectory()) return [];
        } catch {
          return [];
        }
        try {
          const files = await readdir(projPath);
          const jsonlFiles = files.filter(f => f.endsWith(".jsonl") && !f.startsWith("agent-"));
          const fileResults = await Promise.all(
            jsonlFiles.map(async (f) => {
              try {
                const fp = join(projPath, f);
                const st = await stat(fp);
                if (st.size < 100) return null;
                const id = `${projDir}/${f.replace(".jsonl", "")}`;
                const projectName = projDir
                  .replace(/^-/, "")
                  .replace(/-/g, "/")
                  .split("/")
                  .pop();
                return {
                  id,
                  source,
                  path: fp,
                  title: "",
                  summary: "",
                  projectName,
                  timestamp: st.mtime.toISOString(),
                  size: st.size,
                  _needsEnrich: true,
                };
              } catch {
                return null;
              }
            })
          );
          return fileResults.filter(Boolean);
        } catch {
          return [];
        }
      })
    );
    for (const dirSessions of dirResults) {
      sessions.push(...dirSessions);
    }
  } catch {}
  return sessions;
}

export async function listClaudeSessions() {
  const sessions = [];

  // 1) transcripts dir
  try {
    const files = await readdir(CLAUDE_TRANSCRIPTS_DIR);
    for (const f of files) {
      if (!f.endsWith(".jsonl") || f.startsWith("agent-") || f.includes("warmup"))
        continue;
      const fp = join(CLAUDE_TRANSCRIPTS_DIR, f);
      const st = await stat(fp);
      const id = f.replace(".jsonl", "");
      let summary = "";
      let timestamp = st.mtime.toISOString();
      try {
        const content = await readFile(fp, "utf-8");
        const firstLine = content.split("\n").find((l) => l.trim());
        if (firstLine) {
          const data = safeJsonParse(firstLine);
          if (data) {
            if (data.type === "summary") summary = data.summary || "";
            else if (data.type === "user")
              summary = typeof data.content === "string" ? data.content : "";
            if (data.timestamp) timestamp = data.timestamp;
          }
        }
      } catch {}
      sessions.push({
        id,
        source: "claude-transcripts",
        path: fp,
        summary: truncate(summary),
        timestamp,
        size: st.size,
      });
    }
  } catch {}

  // 2) projects dir
  const projectSessions = await scanProjectsDir(CLAUDE_PROJECTS_DIR, "claude-projects");
  sessions.push(...projectSessions);

  sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const TOP_N = 200;
  const toEnrich = sessions.slice(0, TOP_N).filter(s => s._needsEnrich);
  await Promise.all(toEnrich.map(s => enrichClaudeSession(s)));

  return sessions;
}

export async function listClaudeInternalSessions() {
  const sessions = await scanProjectsDir(CLAUDE_INTERNAL_PROJECTS_DIR, "claude-internal-projects");

  sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const TOP_N = 200;
  const toEnrich = sessions.slice(0, TOP_N).filter(s => s._needsEnrich);
  await Promise.all(toEnrich.map(s => enrichClaudeSession(s)));

  return sessions;
}

export async function enrichClaudeSession(session) {
  try {
    const content = await readFile(session.path, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    for (const line of lines.slice(-3)) {
      const data = safeJsonParse(line);
      if (data?.type === "summary" && data.summary) {
        session.title = truncate(data.summary, 80);
        break;
      }
    }

    for (const line of lines.slice(0, 10)) {
      const data = safeJsonParse(line);
      if (!data) continue;
      if (data.type === "user") {
        const msg = data.message;
        if (msg && typeof msg.content === "string") {
          session.summary = truncate(msg.content);
          break;
        }
        if (typeof data.content === "string") {
          session.summary = truncate(data.content);
          break;
        }
      }
    }

    for (const line of lines.slice(0, 3)) {
      const data = safeJsonParse(line);
      if (data?.timestamp) {
        session.timestamp = formatTimestamp(data.timestamp);
        break;
      }
    }

    session._needsEnrich = false;
  } catch {
    session._needsEnrich = false;
  }
}

export function parseClaudeTranscriptLine(data) {
  if (data.type === "user") {
    return {
      role: "user",
      timestamp: formatTimestamp(data.timestamp),
      content: typeof data.content === "string" ? data.content : JSON.stringify(data.content),
    };
  }
  if (data.type === "tool_use") {
    return {
      role: "assistant",
      type: "tool_use",
      timestamp: formatTimestamp(data.timestamp),
      toolName: data.tool_name,
      toolInput: data.tool_input,
      content: "",
      toolCalls: [{
        name: data.tool_name,
        input: data.tool_input,
      }],
    };
  }
  if (data.type === "tool_result") {
    return {
      role: "tool",
      type: "tool_result",
      timestamp: formatTimestamp(data.timestamp),
      toolName: data.tool_name,
      toolOutput: data.tool_output,
      content: data.tool_output?.output || "",
    };
  }
  return null;
}

export function parseClaudeProjectLine(data) {
  if (data.type === "file-history-snapshot" || data.type === "progress") return null;

  if (data.type === "user") {
    const msg = data.message;
    if (!msg) return null;
    let content = "";
    if (typeof msg.content === "string") content = msg.content;
    else if (Array.isArray(msg.content)) {
      const parts = [];
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          const txt =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
              ? block.content
                  .filter((b) => b.type === "text")
                  .map((b) => b.text)
                  .join("\n")
              : "";
          if (txt)
            parts.push(
              `**Tool Result** (${block.tool_use_id?.slice(0, 12) || ""})\n${txt}`
            );
        } else if (block.type === "text") {
          parts.push(block.text);
        }
      }
      content = parts.join("\n\n");
    }
    if (!content.trim() || content.startsWith("**Tool Result**")) return null;
    return {
      role: "user",
      timestamp: formatTimestamp(data.timestamp),
      content,
    };
  }

  if (data.type === "assistant") {
    const msg = data.message;
    if (!msg) return null;
    const parts = [];
    const toolCalls = [];
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          parts.push(block.text);
        } else if (block.type === "thinking" && block.thinking) {
          parts.push(`> \u{1F4AD} *Thinking:*\n> ${block.thinking.replace(/\n/g, "\n> ")}`);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            name: block.name,
            input: block.input,
          });
        }
      }
    }
    return {
      role: "assistant",
      timestamp: formatTimestamp(data.timestamp),
      content: parts.join("\n\n"),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  return null;
}

export async function parseClaudeSession(sessionInfo) {
  const content = await readFile(sessionInfo.path, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());
  const rawMessages = [];
  const isProject = sessionInfo.source === "claude-projects" || sessionInfo.source === "claude-internal-projects";

  for (const line of lines) {
    const data = safeJsonParse(line);
    if (!data) continue;
    const parsed = isProject
      ? parseClaudeProjectLine(data)
      : parseClaudeTranscriptLine(data);
    if (parsed) rawMessages.push(parsed);
  }

  const messages = [];
  for (let i = 0; i < rawMessages.length; i++) {
    const msg = rawMessages[i];

    if (isProject) {
      messages.push(msg);
      continue;
    }

    if (msg.role === "user") {
      messages.push(msg);
    } else if (msg.role === "assistant" && msg.type === "tool_use") {
      const merged = {
        role: "assistant",
        timestamp: msg.timestamp,
        content: "",
        toolCalls: [...(msg.toolCalls || [])],
      };
      while (i + 1 < rawMessages.length) {
        const next = rawMessages[i + 1];
        if (next.role === "tool" && next.type === "tool_result") {
          i++;
        } else if (next.role === "assistant" && next.type === "tool_use") {
          merged.toolCalls.push(...(next.toolCalls || []));
          i++;
        } else {
          break;
        }
      }
      messages.push(merged);
    } else if (msg.role === "tool") {
      messages.push(msg);
    } else {
      messages.push(msg);
    }
  }

  return {
    id: sessionInfo.id,
    agent: "claude-code",
    source: sessionInfo.source,
    title: sessionInfo.title,
    projectName: sessionInfo.projectName,
    summary: sessionInfo.summary,
    timestamp: sessionInfo.timestamp,
    messages,
  };
}

// ─── Amp Parser ──────────────────────────────────────────────

export async function listAmpSessions() {
  const sessions = [];
  try {
    const files = await readdir(AMP_THREADS_DIR);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const fp = join(AMP_THREADS_DIR, f);
      const st = await stat(fp);
      if (st.size < 100) continue;
      const id = f.replace(".json", "");
      let summary = "";
      let timestamp = st.mtime.toISOString();
      let title = "";
      try {
        const raw = await readFile(fp, "utf-8");
        const data = safeJsonParse(raw);
        if (data) {
          title = data.title || "";
          if (data.created) timestamp = formatTimestamp(data.created);
          const msgs = data.messages || [];
          for (const m of msgs) {
            if (m.role === "user" && Array.isArray(m.content)) {
              const textBlock = m.content.find((b) => b.type === "text");
              if (textBlock) {
                summary = textBlock.text;
                break;
              }
            }
          }
        }
      } catch {}
      sessions.push({
        id,
        source: "amp",
        path: fp,
        summary: truncate(summary),
        title: truncate(title, 80),
        timestamp,
        size: st.size,
      });
    }
  } catch {}
  sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return sessions;
}

export async function parseAmpSession(sessionInfo) {
  const raw = await readFile(sessionInfo.path, "utf-8");
  const data = safeJsonParse(raw);
  if (!data) return null;

  const messages = [];
  for (const msg of data.messages || []) {
    if (msg.role === "user") {
      const parts = [];
      for (const block of msg.content || []) {
        if (block.type === "text") parts.push(block.text);
        else if (block.type === "tool_result") {
          // Skip tool results in display (noise)
        }
      }
      if (parts.join("").trim()) {
        messages.push({
          role: "user",
          timestamp: msg.meta?.sentAt
            ? formatTimestamp(msg.meta.sentAt)
            : "",
          content: parts.join("\n"),
        });
      }
    } else if (msg.role === "assistant") {
      const parts = [];
      const toolCalls = [];
      for (const block of msg.content || []) {
        if (block.type === "text" && block.text) {
          parts.push(block.text);
        } else if (block.type === "thinking" && block.thinking) {
          parts.push(`> \u{1F4AD} *Thinking:*\n> ${block.thinking.replace(/\n/g, "\n> ")}`);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            name: block.name,
            input: block.input,
          });
        }
      }
      if (parts.join("").trim() || toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          timestamp: msg.usage?.timestamp || "",
          content: parts.join("\n\n"),
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          model: msg.usage?.model,
        });
      }
    }
  }

  return {
    id: sessionInfo.id,
    agent: "amp",
    title: data.title || sessionInfo.title,
    summary: sessionInfo.summary,
    timestamp: sessionInfo.timestamp,
    agentMode: data.agentMode,
    messages,
  };
}

// ─── Copilot CLI Parser ──────────────────────────────────────

export async function listCopilotSessions() {
  const sessions = [];
  try {
    const dirs = await readdir(COPILOT_SESSION_DIR);
    const dirResults = await Promise.all(
      dirs.map(async (dirName) => {
        const dirPath = join(COPILOT_SESSION_DIR, dirName);
        try {
          const dirStat = await stat(dirPath);
          if (!dirStat.isDirectory()) return null;
        } catch {
          return null;
        }
        const eventsPath = join(dirPath, "events.jsonl");
        try {
          const st = await stat(eventsPath);
          if (st.size < 100) return null;
          return {
            id: dirName,
            source: "copilot",
            path: eventsPath,
            title: "",
            summary: "",
            timestamp: st.mtime.toISOString(),
            size: st.size,
            _needsEnrich: true,
          };
        } catch {
          return null;
        }
      })
    );
    sessions.push(...dirResults.filter(Boolean));
  } catch {}

  sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const TOP_N = 200;
  const toEnrich = sessions.slice(0, TOP_N).filter((s) => s._needsEnrich);
  await Promise.all(toEnrich.map((s) => enrichCopilotSession(s)));

  return sessions;
}

export async function enrichCopilotSession(session) {
  try {
    const content = await readFile(session.path, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    for (const line of lines.slice(0, 5)) {
      const data = safeJsonParse(line);
      if (!data) continue;

      if (data.type === "session.start" && data.data?.startTime) {
        session.timestamp = formatTimestamp(data.data.startTime);
        const ctx = data.data.context;
        if (ctx?.repository) {
          session.projectName = ctx.repository.split("/").pop();
        } else if (ctx?.cwd) {
          session.projectName = ctx.cwd.split("/").pop();
        }
        if (ctx?.branch) {
          session.branch = ctx.branch;
        }
      }
    }

    for (const line of lines.slice(0, 20)) {
      const data = safeJsonParse(line);
      if (!data) continue;
      if (data.type === "user.message" && data.data?.content) {
        session.summary = truncate(data.data.content);
        if (!session.title) {
          session.title = truncate(data.data.content, 80);
        }
        break;
      }
    }

    for (const line of lines.slice(-3)) {
      const data = safeJsonParse(line);
      if (data?.type === "session.shutdown" && data.data?.currentModel) {
        session.model = data.data.currentModel;
      }
    }

    session._needsEnrich = false;
  } catch {
    session._needsEnrich = false;
  }
}

export async function parseCopilotSession(sessionInfo) {
  const content = await readFile(sessionInfo.path, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());
  const messages = [];

  let sessionTitle = sessionInfo.title || "";
  let sessionTimestamp = sessionInfo.timestamp || "";
  let projectName = sessionInfo.projectName || "";
  let currentModel = "";

  const pendingToolCalls = new Map();

  for (const line of lines) {
    const data = safeJsonParse(line);
    if (!data) continue;

    const type = data.type;
    const payload = data.data || {};
    const ts = data.timestamp || "";

    if (type === "session.start") {
      if (payload.startTime) sessionTimestamp = formatTimestamp(payload.startTime);
      const ctx = payload.context;
      if (ctx?.repository) projectName = ctx.repository.split("/").pop();
      continue;
    }

    if (type === "session.model_change") {
      currentModel = payload.newModel || currentModel;
      continue;
    }

    if (type === "user.message") {
      const userContent = payload.content || "";
      if (!userContent.trim()) continue;
      if (!sessionTitle) sessionTitle = truncate(userContent, 80);
      messages.push({
        role: "user",
        timestamp: formatTimestamp(ts),
        content: userContent,
      });
      continue;
    }

    if (type === "assistant.message") {
      const textContent = (payload.content || "").trim();
      const toolCalls = [];

      let reasoning = "";
      if (payload.reasoningText) {
        reasoning = payload.reasoningText;
      }

      if (Array.isArray(payload.toolRequests)) {
        for (const req of payload.toolRequests) {
          if (req.name === "report_intent") continue;
          toolCalls.push({
            name: req.name,
            input: req.arguments || {},
          });
          if (req.toolCallId) {
            pendingToolCalls.set(req.toolCallId, {
              name: req.name,
              arguments: req.arguments,
            });
          }
        }
      }

      const parts = [];
      if (reasoning) {
        parts.push(`> \u{1F4AD} *Thinking:*\n> ${reasoning.replace(/\n/g, "\n> ")}`);
      }
      if (textContent) {
        parts.push(textContent);
      }

      if (parts.length > 0 || toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          timestamp: formatTimestamp(ts),
          content: parts.join("\n\n"),
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          model: currentModel || undefined,
        });
      }
      continue;
    }

    if (type === "tool.execution_complete") {
      const toolCallId = payload.toolCallId;
      const toolInfo = pendingToolCalls.get(toolCallId);
      if (!toolInfo) continue;
      if (toolInfo.name === "report_intent") continue;
      pendingToolCalls.delete(toolCallId);

      const resultContent = payload.result?.content || "";
      if (!resultContent.trim()) continue;

      const display = resultContent.length > 2000
        ? resultContent.slice(0, 2000) + "\n\u2026 (truncated)"
        : resultContent;

      messages.push({
        role: "tool",
        type: "tool_result",
        timestamp: formatTimestamp(ts),
        toolName: toolInfo.name,
        content: display,
      });
      continue;
    }

    if (type === "subagent.started") {
      const agentName = payload.agentDisplayName || payload.agentName || "Agent";
      messages.push({
        role: "assistant",
        timestamp: formatTimestamp(ts),
        content: `*Started background agent: ${agentName}*`,
      });
      continue;
    }
  }

  return {
    id: sessionInfo.id,
    agent: "copilot",
    source: "copilot",
    title: sessionTitle,
    projectName,
    summary: sessionInfo.summary,
    timestamp: sessionTimestamp,
    messages,
  };
}

// ─── CodeBuddy Parser ────────────────────────────────────────

export async function listCodebuddySessions() {
  const sessions = [];

  // 1) Projects directory
  try {
    const projectDirs = await readdir(CODEBUDDY_PROJECTS_DIR);
    const dirResults = await Promise.all(
      projectDirs.map(async (projDir) => {
        const projPath = join(CODEBUDDY_PROJECTS_DIR, projDir);
        try {
          const projStat = await stat(projPath);
          if (!projStat.isDirectory()) return [];
        } catch {
          return [];
        }
        try {
          const files = await readdir(projPath);
          const jsonlFiles = files.filter(f => f.endsWith(".jsonl") && !f.startsWith("agent-"));
          const fileResults = await Promise.all(
            jsonlFiles.map(async (f) => {
              try {
                const fp = join(projPath, f);
                const st = await stat(fp);
                if (st.size < 100) return null;
                const id = `${projDir}/${f.replace(".jsonl", "")}`;
                const projectName = projDir
                  .replace(/^Users-/, "")
                  .replace(/-/g, "/")
                  .split("/")
                  .pop();
                return {
                  id,
                  source: "codebuddy-projects",
                  path: fp,
                  title: "",
                  summary: "",
                  projectName,
                  timestamp: st.mtime.toISOString(),
                  size: st.size,
                  _needsEnrich: true,
                };
              } catch {
                return null;
              }
            })
          );
          return fileResults.filter(Boolean);
        } catch {
          return [];
        }
      })
    );
    for (const dirSessions of dirResults) {
      sessions.push(...dirSessions);
    }
  } catch {}

  // 2) Global history file
  try {
    const historyPath = CODEBUDDY_HISTORY_FILE;
    const st = await stat(historyPath);
    if (st.size > 0) {
      const content = await readFile(historyPath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());
      for (let i = 0; i < lines.length; i++) {
        const data = safeJsonParse(lines[i]);
        if (!data) continue;
        const id = `history/${i}`;
        let summary = data.display || "";
        const projectPath = data.project || "";
        const projectName = projectPath.split("/").pop() || "global";
        const timestamp = data.timestamp ? formatTimestamp(data.timestamp) : new Date().toISOString();
        sessions.push({
          id,
          source: "codebuddy-history",
          path: historyPath,
          lineIndex: i,
          title: "",
          summary: truncate(summary),
          projectName,
          timestamp,
          size: 0,
          _needsEnrich: false,
        });
      }
    }
  } catch {}

  sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const TOP_N = 200;
  const toEnrich = sessions.slice(0, TOP_N).filter(s => s._needsEnrich);
  await Promise.all(toEnrich.map(s => enrichCodebuddySession(s)));

  return sessions;
}

export async function enrichCodebuddySession(session) {
  try {
    if (session.source === "codebuddy-history") {
      session._needsEnrich = false;
      return;
    }

    const content = await readFile(session.path, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    // Find first user message for summary
    for (const line of lines.slice(0, 20)) {
      const data = safeJsonParse(line);
      if (!data || data.type !== "message") continue;
      if (data.role === "user" && Array.isArray(data.content)) {
        const textBlock = data.content.find((b) => b.type === "input_text");
        if (textBlock?.text) {
          session.summary = truncate(textBlock.text);
          session.title = truncate(textBlock.text, 80);
          break;
        }
      }
    }

    // Find topic line if available
    for (const line of lines) {
      const data = safeJsonParse(line);
      if (data?.type === "topic" && data.topic) {
        session.title = truncate(data.topic, 80);
        break;
      }
    }

    session._needsEnrich = false;
  } catch {
    session._needsEnrich = false;
  }
}

export async function parseCodebuddySession(sessionInfo) {
  const messages = [];

  // Handle history entries (lightweight, no parsing needed)
  if (sessionInfo.source === "codebuddy-history") {
    return {
      id: sessionInfo.id,
      agent: "codebuddy",
      source: "codebuddy-history",
      title: sessionInfo.title || sessionInfo.summary,
      projectName: sessionInfo.projectName,
      summary: sessionInfo.summary,
      timestamp: sessionInfo.timestamp,
      messages: [{
        role: "user",
        timestamp: sessionInfo.timestamp,
        content: sessionInfo.summary,
      }],
    };
  }

  // Parse project JSONL file
  const content = await readFile(sessionInfo.path, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());

  for (const line of lines) {
    const data = safeJsonParse(line);
    if (!data) continue;

    const type = data.type;
    const ts = data.timestamp ? formatTimestamp(data.timestamp) : "";

    // Message (user or assistant)
    if (type === "message") {
      const role = data.role;
      if (role === "user" && Array.isArray(data.content)) {
        const parts = [];
        for (const block of data.content) {
          if (block.type === "input_text" && block.text) {
            parts.push(block.text);
          }
        }
        const content = parts.join("\n");
        if (content.trim()) {
          messages.push({
            role: "user",
            timestamp: ts,
            content,
          });
        }
      } else if (role === "assistant" && Array.isArray(data.content)) {
        const textParts = [];
        const toolCalls = [];
        for (const block of data.content) {
          if (block.type === "output_text" && block.text) {
            textParts.push(block.text);
          } else if (block.type === "thinking" && block.content) {
            textParts.push(`> 💭 *Thinking:*\n> ${block.content.replace(/\n/g, "\n> ")}`);
          } else if (block.type === "tool_use") {
            toolCalls.push({
              name: block.name,
              input: block.input || {},
            });
          }
        }
        const content = textParts.join("\n\n");
        if (content.trim() || toolCalls.length > 0) {
          messages.push({
            role: "assistant",
            timestamp: ts,
            content,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            model: data.providerData?.model,
          });
        }
      }
    }
    // Function calls
    else if (type === "function_call") {
      const toolName = data.name;
      let toolInput = {};
      if (typeof data.arguments === "string") {
        toolInput = safeJsonParse(data.arguments) || {};
      } else if (typeof data.arguments === "object") {
        toolInput = data.arguments;
      }
      messages.push({
        role: "assistant",
        type: "tool_use",
        timestamp: ts,
        toolName,
        content: `Called: ${toolName}`,
        toolCalls: [{
          name: toolName,
          input: toolInput,
        }],
      });
    }
    // Tool results
    else if (type === "function_call_result") {
      const toolName = data.name;
      let output = "";
      if (data.output?.type === "text" && data.output.text) {
        output = data.output.text;
      } else if (typeof data.output === "string") {
        output = data.output;
      }
      if (output.trim()) {
        const display = output.length > 2000
          ? output.slice(0, 2000) + "\n… (truncated)"
          : output;
        messages.push({
          role: "tool",
          type: "tool_result",
          timestamp: ts,
          toolName,
          content: display,
        });
      }
    }
    // Topics (navigation)
    else if (type === "topic") {
      if (data.topic && !sessionInfo.title) {
        sessionInfo.title = truncate(data.topic, 80);
      }
    }
  }

  return {
    id: sessionInfo.id,
    agent: "codebuddy",
    source: sessionInfo.source,
    title: sessionInfo.title || sessionInfo.summary || sessionInfo.id,
    projectName: sessionInfo.projectName,
    summary: sessionInfo.summary,
    timestamp: sessionInfo.timestamp,
    messages,
  };
}

// ─── Markdown Export ─────────────────────────────────────────

export function sessionToMarkdown(session) {
  const lines = [];
  const agentLabel = session.agent === "claude-code" ? "Claude Code" : 
                     session.agent === "amp" ? "Amp" : 
                     session.agent === "copilot" ? "GitHub Copilot CLI" : 
                     session.agent === "codebuddy" ? "CodeBuddy" : 
                     session.agent;

  lines.push(`# ${session.title || session.summary || session.id}`);
  lines.push("");

  const meta = [];
  meta.push(`| | |`);
  meta.push(`|---|---|`);
  meta.push(`| **Agent** | ${agentLabel} |`);
  if (session.projectName) meta.push(`| **Project** | ${session.projectName} |`);
  if (session.agentMode) meta.push(`| **Mode** | ${session.agentMode} |`);
  if (session.timestamp) {
    const d = new Date(session.timestamp);
    if (!isNaN(d.getTime())) {
      meta.push(`| **Date** | ${d.toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" })} |`);
    }
  }
  const msgCount = session.messages.filter(m => m.role === "user").length;
  const toolCount = session.messages.reduce((n, m) => n + (m.toolCalls?.length || 0), 0);
  meta.push(`| **Turns** | ${msgCount} user messages, ${toolCount} tool calls |`);
  lines.push(...meta);
  lines.push("");
  lines.push("---");
  lines.push("");

  const merged = mergeConsecutiveAssistant(session.messages);

  let turnNum = 0;
  for (const msg of merged) {
    if (msg.role === "user") {
      turnNum++;
      lines.push(`## Turn ${turnNum}`);
      lines.push("");
      lines.push(`### \u{1F4AC} User`);
      if (msg.timestamp) {
        const d = new Date(msg.timestamp);
        if (!isNaN(d.getTime())) lines.push(`<sub>${d.toLocaleTimeString()}</sub>`);
      }
      lines.push("");
      if (msg.content) {
        lines.push(msg.content);
      }
      lines.push("");
    } else if (msg.role === "assistant") {
      lines.push(`### \u{1F916} Assistant`);
      const timeParts = [];
      if (msg.model) timeParts.push(msg.model);
      if (msg.timestamp) {
        const d = new Date(msg.timestamp);
        if (!isNaN(d.getTime())) timeParts.push(d.toLocaleTimeString());
      }
      if (timeParts.length) lines.push(`<sub>${timeParts.join(" \u00B7 ")}</sub>`);
      lines.push("");

      const { thinking, text } = splitThinkingFromContent(msg.content || "");

      if (thinking) {
        lines.push(`<details>`);
        lines.push(`<summary>\u{1F4AD} <em>Thinking process</em></summary>`);
        lines.push("");
        lines.push(thinking);
        lines.push("");
        lines.push(`</details>`);
        lines.push("");
      }

      if (text.trim()) {
        lines.push(text);
        lines.push("");
      }

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        if (msg.toolCalls.length === 1) {
          const tc = msg.toolCalls[0];
          lines.push(formatToolCall(tc));
          lines.push("");
        } else {
          lines.push(`<details>`);
          lines.push(`<summary>\u{1F527} <strong>${msg.toolCalls.length} tool calls</strong></summary>`);
          lines.push("");
          for (const tc of msg.toolCalls) {
            lines.push(formatToolCall(tc));
            lines.push("");
          }
          lines.push(`</details>`);
          lines.push("");
        }
      }
    } else if (msg.role === "tool") {
      const output = msg.toolOutput?.output || msg.content;
      if (output) {
        const display = typeof output === "string" ? output : JSON.stringify(output, null, 2);
        const trimmed = display.length > 2000
          ? display.slice(0, 2000) + "\n\u2026 (truncated)"
          : display;
        lines.push(`<details>`);
        lines.push(`<summary>\u{1F4CE} Tool result: <code>${msg.toolName || "unknown"}</code></summary>`);
        lines.push("");
        lines.push("```");
        lines.push(trimmed);
        lines.push("```");
        lines.push("");
        lines.push(`</details>`);
        lines.push("");
      }
    }
  }

  lines.push("---");
  lines.push("");
  lines.push(`*Exported from AI Session Viewer*`);
  lines.push("");

  return lines.join("\n");
}

export function mergeConsecutiveAssistant(messages) {
  const result = [];
  for (const msg of messages) {
    const prev = result[result.length - 1];
    if (
      msg.role === "assistant" &&
      prev?.role === "assistant"
    ) {
      if (msg.content) {
        prev.content = prev.content
          ? prev.content + "\n\n" + msg.content
          : msg.content;
      }
      if (msg.toolCalls?.length) {
        prev.toolCalls = (prev.toolCalls || []).concat(msg.toolCalls);
      }
      if (msg.model) prev.model = msg.model;
    } else {
      result.push({ ...msg, toolCalls: msg.toolCalls ? [...msg.toolCalls] : undefined });
    }
  }
  return result;
}

export function splitThinkingFromContent(content) {
  const thinkingLines = [];
  const textLines = [];
  let inThinking = false;

  for (const line of content.split("\n")) {
    if (line.startsWith("> \u{1F4AD} *Thinking:*") || line.startsWith("> \u{1F4AD} *Thinking*")) {
      inThinking = true;
      continue;
    }
    if (inThinking) {
      if (line.startsWith("> ")) {
        thinkingLines.push(line.slice(2));
      } else if (line === ">") {
        thinkingLines.push("");
      } else {
        inThinking = false;
        if (line.trim()) textLines.push(line);
      }
    } else {
      textLines.push(line);
    }
  }

  return {
    thinking: thinkingLines.join("\n").trim(),
    text: textLines.join("\n").trim(),
  };
}

export function formatToolCall(tc) {
  const lines = [];
  const inputStr = tc.input ? JSON.stringify(tc.input, null, 2) : "";

  if (inputStr.length <= 200) {
    lines.push(`> \u{1F527} **${tc.name}**`);
    if (inputStr) {
      lines.push(`> \`\`\`json`);
      lines.push(`> ${inputStr.replace(/\n/g, "\n> ")}`);
      lines.push(`> \`\`\``);
    }
  } else {
    const display = inputStr.length > 3000
      ? inputStr.slice(0, 3000) + "\n// \u2026 truncated"
      : inputStr;
    lines.push(`<details>`);
    lines.push(`<summary>\u{1F527} <code>${tc.name}</code></summary>`);
    lines.push("");
    lines.push("```json");
    lines.push(display);
    lines.push("```");
    lines.push("");
    lines.push(`</details>`);
  }
  return lines.join("\n");
}

// ─── Unified Wrappers (used by CLI and server) ──────────────

const AGENT_LISTERS = {
  claude: listClaudeSessions,
  "claude-internal": listClaudeInternalSessions,
  amp: listAmpSessions,
  copilot: listCopilotSessions,
  codebuddy: listCodebuddySessions,
};

const AGENT_PARSERS = {
  claude: parseClaudeSession,
  "claude-internal": parseClaudeSession,
  amp: parseAmpSession,
  copilot: parseCopilotSession,
  codebuddy: parseCodebuddySession,
};

/**
 * List sessions across all (or specified) agents.
 * @param {Object} opts
 * @param {string[]} [opts.agents] - Filter to these agents (default: all)
 * @param {number} [opts.limit] - Max sessions per agent (default: 200)
 * @param {string} [opts.since] - ISO date or relative (e.g. "7d", "2w", "1m")
 * @param {string} [opts.until] - ISO date or relative
 * @param {string} [opts.project] - Filter by project name (substring match)
 * @param {string} [opts.sort] - Sort field: "timestamp" (default)
 * @returns {Promise<Array>} Flat array of session objects with agent field
 */
export async function listAllSessions(opts = {}) {
  const agentKeys = opts.agents || Object.keys(AGENT_LISTERS);
  const limit = opts.limit || 200;
  const sinceDate = opts.since ? parseRelativeDate(opts.since) : null;
  const untilDate = opts.until ? parseRelativeDate(opts.until) : null;

  const results = await Promise.all(
    agentKeys
      .filter(a => AGENT_LISTERS[a])
      .map(async (agent) => {
        let cached = getCachedSessions(agent);
        if (!cached) {
          cached = await AGENT_LISTERS[agent]();
          setCachedSessions(agent, cached);
        }
        // Tag each session with its agent type
        const agentLabel = agent === "claude" || agent === "claude-internal" ? "claude-code" : agent;
        return cached.map(s => ({
          ...s,
          agent: s.agent || agentLabel,
          _agentKey: agent, // internal: the key used for getSession lookup
        }));
      })
  );

  let all = results.flat();

  // Apply filters
  if (sinceDate) {
    all = all.filter(s => new Date(s.timestamp) >= sinceDate);
  }
  if (untilDate) {
    all = all.filter(s => new Date(s.timestamp) <= untilDate);
  }
  if (opts.project) {
    const q = opts.project.toLowerCase();
    all = all.filter(s => (s.projectName || "").toLowerCase().includes(q));
  }

  // Sort by timestamp descending
  all.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  return all.slice(0, limit);
}

/**
 * Get and parse a single session by agent key and id.
 * @param {string} agent - "claude", "claude-internal", "amp", "copilot"
 * @param {string} id - Session ID
 * @returns {Promise<Object|null>} Parsed session or null
 */
export async function getSession(agent, id) {
  const lister = AGENT_LISTERS[agent];
  const parser = AGENT_PARSERS[agent];
  if (!lister || !parser) return null;

  let allSessions = getCachedSessions(agent);
  if (!allSessions) {
    allSessions = await lister();
    setCachedSessions(agent, allSessions);
  }

  const found = allSessions.find(s => s.id === id);
  if (!found) return null;

  return parser(found);
}

// ─── Date Utilities ──────────────────────────────────────────

/**
 * Parse a date string that can be ISO date or relative like "7d", "2w", "1m", "3h"
 */
export function parseRelativeDate(str) {
  if (!str) return null;

  // Try relative patterns: 7d, 2w, 1m, 3h
  const match = str.match(/^(\d+)([hdwmyHDWMY])$/);
  if (match) {
    const num = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const now = new Date();
    switch (unit) {
      case "h": now.setHours(now.getHours() - num); break;
      case "d": now.setDate(now.getDate() - num); break;
      case "w": now.setDate(now.getDate() - num * 7); break;
      case "m": now.setMonth(now.getMonth() - num); break;
      case "y": now.setFullYear(now.getFullYear() - num); break;
    }
    return now;
  }

  // Try ISO / parseable date
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}
