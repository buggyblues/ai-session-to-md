// lib/sessions.js — Core session parsing, listing, caching, and markdown logic
// Extracted from server.js for reuse by both the web server and CLI

import { createReadStream } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { basename, join } from "path";
import { homedir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import { createInterface } from "readline";

// ─── Paths ───────────────────────────────────────────────────
export const CLAUDE_TRANSCRIPTS_DIR = join(homedir(), ".claude", "transcripts");
export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
export const CLAUDE_INTERNAL_PROJECTS_DIR = join(homedir(), ".claude-internal", "projects");
export const AMP_THREADS_DIR = join(homedir(), ".local", "share", "amp", "threads");
export const AMP_BIN_PATH = join(homedir(), ".amp", "bin", "amp");
export const AMP_LEGACY_BIN_PATH = join(homedir(), ".local", "bin", "amp");
export const COPILOT_SESSION_DIR = join(homedir(), ".copilot", "session-state");
export const CODEBUDDY_PROJECTS_DIR = join(homedir(), ".codebuddy", "projects");
export const CODEBUDDY_HISTORY_FILE = join(homedir(), ".codebuddy", "history.jsonl");
export const CODEBUDDY_INSTANCES_FILE = join(homedir(), ".codebuddy", "instances.json");
export const BOX_CTX_DIR = join(homedir(), ".box", "ctx");
export const BOX_OUTPUT_DIR = join(homedir(), ".box", "Workspace", "output");
export const BOX_SESSIONS_DB = join(homedir(), "Library", "Application Support", "Box", "engine", "sessions.db");
export const CODEX_HOME_DIR = process.env.CODEX_HOME || join(homedir(), ".codex");
export const CODEX_SESSIONS_DIR = join(CODEX_HOME_DIR, "sessions");
export const CODEX_SESSION_INDEX_FILE = join(CODEX_HOME_DIR, "session_index.jsonl");
export const CODEX_HISTORY_FILE = join(CODEX_HOME_DIR, "history.jsonl");

// ─── Session Cache ──────────────────────────────────────────
const sessionCache = {
  claude: { data: null, timestamp: 0 },
  "claude-internal": { data: null, timestamp: 0 },
  amp: { data: null, timestamp: 0 },
  copilot: { data: null, timestamp: 0 },
  codebuddy: { data: null, timestamp: 0 },
  box: { data: null, timestamp: 0 },
  codex: { data: null, timestamp: 0 },
};
const CACHE_TTL = 10_000; // keep the sidebar fresh without rescanning on every click

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
    sessionCache.box = { data: null, timestamp: 0 };
    sessionCache.codex = { data: null, timestamp: 0 };
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

function getTimeMs(ts) {
  if (!ts) return 0;
  const ms = new Date(ts).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function getSessionSortMs(session) {
  return getTimeMs(session.sortTimestamp) || getTimeMs(session.timestamp);
}

function sortSessionsByTimeDesc(sessions) {
  sessions.sort((a, b) => getSessionSortMs(b) - getSessionSortMs(a));
}

function projectNameFromDir(projDir, prefixPattern = /^-/) {
  return projDir
    .replace(prefixPattern, "")
    .replace(/-/g, "/")
    .split("/")
    .pop();
}

async function walkFilesRecursive(rootDir, predicate) {
  const results = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(entries.map(async (entry) => {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && (!predicate || predicate(entry.name, entryPath))) {
        results.push(entryPath);
      }
    }));
  }

  await walk(rootDir);
  return results;
}

async function readJsonlHead(filePath, maxLines = 80) {
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const lines = [];

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      lines.push(line);
      if (lines.length >= maxLines) {
        rl.close();
        break;
      }
    }
  } catch {
    return lines;
  } finally {
    stream.destroy();
  }

  return lines;
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
          const projectName = projectNameFromDir(projDir);
          const fileResults = await Promise.all(
            jsonlFiles.map(async (f) => {
              try {
                const fp = join(projPath, f);
                const st = await stat(fp);
                if (st.size < 100) return null;
                const id = `${projDir}/${f.replace(".jsonl", "")}`;
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

          const sessionDirs = await Promise.all(
            files.map(async (entry) => {
              try {
                const entryPath = join(projPath, entry);
                const entryStat = await stat(entryPath);
                return entryStat.isDirectory() ? entry : null;
              } catch {
                return null;
              }
            })
          );
          const subagentResults = await Promise.all(
            sessionDirs.filter(Boolean).map(async (sessionDir) => {
              const subagentsPath = join(projPath, sessionDir, "subagents");
              try {
                const subagentFiles = await readdir(subagentsPath);
                const jsonlSubagents = subagentFiles.filter(f => f.endsWith(".jsonl") && f.startsWith("agent-"));
                const results = await Promise.all(
                  jsonlSubagents.map(async (f) => {
                    try {
                      const fp = join(subagentsPath, f);
                      const st = await stat(fp);
                      if (st.size < 100) return null;
                      const subagentName = f.replace(".jsonl", "");
                      return {
                        id: `${projDir}/${sessionDir}/subagents/${subagentName}`,
                        source: `${source}-subagent`,
                        path: fp,
                        title: subagentName,
                        summary: "",
                        projectName,
                        timestamp: st.mtime.toISOString(),
                        size: st.size,
                        _needsEnrich: true,
                        _isSubagent: true,
                      };
                    } catch {
                      return null;
                    }
                  })
                );
                return results.filter(Boolean);
              } catch {
                return [];
              }
            })
          );
          return [...fileResults.filter(Boolean), ...subagentResults.flat()];
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

  sortSessionsByTimeDesc(sessions);

  const TOP_N = 200;
  const toEnrich = sessions.slice(0, TOP_N).filter(s => s._needsEnrich);
  await Promise.all(toEnrich.map(s => enrichClaudeSession(s)));

  return sessions;
}

export async function listClaudeInternalSessions() {
  const sessions = await scanProjectsDir(CLAUDE_INTERNAL_PROJECTS_DIR, "claude-internal-projects");

  sortSessionsByTimeDesc(sessions);

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
  const isProject =
    sessionInfo.source?.startsWith("claude-projects") ||
    sessionInfo.source?.startsWith("claude-internal-projects");

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

function timestampFromAmpThreadIdMs(id) {
  const match = id?.match(/^T-([0-9a-fA-F]{8})-([0-9a-fA-F]{4})/);
  if (!match) return 0;
  const ms = Number.parseInt(`${match[1]}${match[2]}`, 16);
  return Number.isFinite(ms) ? ms : 0;
}

function timestampFromAmpThreadId(id) {
  return formatTimestamp(timestampFromAmpThreadIdMs(id));
}

function stripAnsiControl(str) {
  if (!str) return "";
  return str
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[@-Z\\-_]/g, "");
}

function jsonFromCliOutput(stdout) {
  const cleaned = stripAnsiControl(stdout).trim();
  const parsed = safeJsonParse(cleaned);
  if (parsed) return parsed;

  const objectIdx = cleaned.indexOf("{");
  const arrayIdx = cleaned.indexOf("[");
  const firstIdx = [objectIdx, arrayIdx].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (firstIdx === undefined) return null;

  const closer = cleaned[firstIdx] === "[" ? "]" : "}";
  const lastIdx = cleaned.lastIndexOf(closer);
  if (lastIdx <= firstIdx) return null;
  return safeJsonParse(cleaned.slice(firstIdx, lastIdx + 1));
}

async function runAmpCli(args, opts = {}) {
  const candidates = [AMP_BIN_PATH, AMP_LEGACY_BIN_PATH, "amp"];
  let lastError;

  for (const bin of candidates) {
    try {
      if (bin !== "amp") await stat(bin);
      const { stdout } = await execFileAsync(bin, args, {
        timeout: opts.timeout || 15_000,
        maxBuffer: opts.maxBuffer || 25 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
      });
      return stripAnsiControl(stdout);
    } catch (err) {
      lastError = err;
      if (err.code === "ENOENT") continue;
    }
  }

  throw lastError || new Error("Amp CLI not found");
}

function projectNameFromAmpTree(tree) {
  if (!tree || typeof tree !== "string") return "";
  try {
    const url = new URL(tree);
    if (url.protocol === "file:") {
      return basename(decodeURIComponent(url.pathname));
    }
  } catch {}
  return basename(tree.replace(/^file:\/\//, ""));
}

function textFromAmpContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block?.type === "text" && typeof block.text === "string") return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function ampMessageTimestamp(msg) {
  const candidates = [
    msg?.meta?.sentAt,
    msg?.usage?.timestamp,
    msg?.timestamp,
    msg?.createdAt,
  ];

  for (const candidate of candidates) {
    const formatted = formatTimestamp(candidate);
    if (formatted) return formatted;
  }
  return "";
}

function ampThreadUpdatedTimestamp(data, fallbackTimestamp = "") {
  let latest = Math.max(
    getTimeMs(formatTimestamp(data?.updatedAt)),
    getTimeMs(formatTimestamp(data?.updated)),
    getTimeMs(formatTimestamp(data?.created)),
    getTimeMs(fallbackTimestamp)
  );

  for (const msg of data?.messages || []) {
    latest = Math.max(latest, getTimeMs(ampMessageTimestamp(msg)));
  }

  return latest ? new Date(latest).toISOString() : "";
}

function hasAmpConversationMessages(data) {
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  return messages.some((msg) => {
    if (msg.role !== "user" && msg.role !== "assistant") return false;
    if (textFromAmpContent(msg.content).trim()) return true;
    return Array.isArray(msg.content) && msg.content.some((block) => block?.type === "tool_use");
  });
}

function ampToolResultContent(block) {
  if (typeof block?.text === "string") return block.text;
  if (typeof block?.content === "string") return block.content;
  if (typeof block?.output === "string") return block.output;
  if (typeof block?.run?.result?.output === "string") return block.run.result.output;
  if (block?.run?.result) return JSON.stringify(block.run.result, null, 2);
  return JSON.stringify(block, null, 2);
}

async function listAmpLocalThreadSessions() {
  const sessionsById = new Map();
  try {
    const files = (await readdir(AMP_THREADS_DIR))
      .filter((f) => /\.json(?:\.amptmp)?$/.test(f))
      .sort((a, b) => Number(a.endsWith(".amptmp")) - Number(b.endsWith(".amptmp")));

    for (const f of files) {
      const fp = join(AMP_THREADS_DIR, f);
      const st = await stat(fp);
      if (st.size < 100) continue;

      const id = f.replace(/\.json(?:\.amptmp)?$/, "");
      const isTemp = f.endsWith(".amptmp");
      if (isTemp && sessionsById.has(id)) continue;

      let data;
      try {
        data = safeJsonParse(await readFile(fp, "utf-8"));
      } catch {
        data = null;
      }
      if (!data || !hasAmpConversationMessages(data)) continue;

      const messages = Array.isArray(data.messages) ? data.messages : [];
      const firstUser = messages.find((m) => m.role === "user" && textFromAmpContent(m.content).trim());
      const timestamp = ampThreadUpdatedTimestamp(data, st.mtime.toISOString()) ||
        timestampFromAmpThreadId(id) ||
        st.mtime.toISOString();
      const created = formatTimestamp(data.created) || timestampFromAmpThreadId(id);

      sessionsById.set(id, {
        id,
        source: isTemp ? "amp-temp" : "amp",
        path: fp,
        summary: truncate(textFromAmpContent(firstUser?.content)),
        title: truncate(data.title || "", 80),
        timestamp,
        sortTimestamp: timestamp,
        created,
        size: st.size,
        _messageCount: messages.length,
      });
    }
  } catch {}

  const sessions = [...sessionsById.values()];
  sortSessionsByTimeDesc(sessions);
  return sessions;
}

async function listAmpCliSessions(localById = new Map()) {
  const stdout = await runAmpCli(["threads", "list", "--json", "--include-archived", "--no-color"], {
    timeout: 20_000,
    maxBuffer: 40 * 1024 * 1024,
  });
  const rows = jsonFromCliOutput(stdout);
  if (!Array.isArray(rows)) return [];

  return rows
    .filter((row) => typeof row?.id === "string" && row.id.startsWith("T-"))
    .map((row) => {
      const local = localById.get(row.id);
      const timestamp =
        formatTimestamp(row.updated) ||
        local?.timestamp ||
        timestampFromAmpThreadId(row.id);
      const created = timestampFromAmpThreadId(row.id);
      const projectName = projectNameFromAmpTree(row.tree) || local?.projectName || "";

      return {
        id: row.id,
        source: "amp-cli",
        path: local?.path || "",
        title: truncate(row.title || local?.title || "", 100),
        summary: local?.summary || "",
        timestamp,
        sortTimestamp: timestamp,
        created,
        projectName,
        size: local?.size || 0,
        _messageCount: Number.isFinite(row.messageCount) ? row.messageCount : local?._messageCount,
      };
    });
}

async function readAmpCliThread(id) {
  const stdout = await runAmpCli(["threads", "export", id, "--no-color"], {
    timeout: 45_000,
    maxBuffer: 120 * 1024 * 1024,
  });
  const data = jsonFromCliOutput(stdout);
  if (!data) throw new Error(`Unable to parse Amp thread export: ${id}`);
  return data;
}

function ampThreadToSession(data, sessionInfo) {
  const messages = [];
  const toolNameById = new Map();

  for (const msg of data.messages || []) {
    const timestamp = ampMessageTimestamp(msg);

    if (msg.role === "user") {
      const parts = [];
      const toolResults = [];

      for (const block of msg.content || []) {
        if (block.type === "text" && block.text) {
          parts.push(block.text);
        } else if (block.type === "tool_result") {
          const toolUseId = block.toolUseID || block.tool_use_id || block.id || "";
          toolResults.push({
            toolUseId,
            toolName: toolNameById.get(toolUseId) || toolUseId || "tool_result",
            content: ampToolResultContent(block),
          });
        }
      }

      if (parts.join("").trim()) {
        messages.push({
          role: "user",
          timestamp,
          content: parts.join("\n"),
        });
      }

      for (const result of toolResults) {
        if (!result.content?.trim()) continue;
        messages.push({
          role: "tool",
          type: "tool_result",
          timestamp,
          toolName: result.toolName,
          content: result.content,
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
          if (block.id && block.name) toolNameById.set(block.id, block.name);
          toolCalls.push({
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
      }

      if (parts.join("").trim() || toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          timestamp,
          content: parts.join("\n\n"),
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          model: msg.usage?.model,
        });
      }
    }
  }

  const timestamp =
    sessionInfo.timestamp ||
    ampThreadUpdatedTimestamp(data) ||
    formatTimestamp(data.updatedAt) ||
    formatTimestamp(data.created);

  return {
    id: sessionInfo.id,
    agent: "amp",
    source: sessionInfo.source,
    title: data.title || sessionInfo.title,
    summary: sessionInfo.summary,
    projectName: sessionInfo.projectName,
    timestamp,
    agentMode: data.agentMode,
    messages,
  };
}

export async function listAmpSessions() {
  const localSessions = await listAmpLocalThreadSessions();
  const sessionsById = new Map(localSessions.map((session) => [session.id, session]));

  try {
    const cliSessions = await listAmpCliSessions(sessionsById);
    for (const session of cliSessions) {
      const local = sessionsById.get(session.id);
      sessionsById.set(session.id, {
        ...local,
        ...session,
        summary: session.summary || local?.summary || "",
        path: session.path || local?.path || "",
      });
    }
  } catch {}

  const sessions = [...sessionsById.values()];
  sortSessionsByTimeDesc(sessions);
  return sessions;
}

export async function parseAmpSession(sessionInfo) {
  if (sessionInfo.source === "amp-cli") {
    let data = null;
    try {
      data = await readAmpCliThread(sessionInfo.id);
    } catch (err) {
      if (!sessionInfo.path) throw err;
    }

    if (!data && sessionInfo.path) {
      data = safeJsonParse(await readFile(sessionInfo.path, "utf-8"));
    }

    return data ? ampThreadToSession(data, sessionInfo) : null;
  }

  const raw = await readFile(sessionInfo.path, "utf-8");
  const data = safeJsonParse(raw);
  return data ? ampThreadToSession(data, sessionInfo) : null;
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

  sortSessionsByTimeDesc(sessions);

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
          const projectName = projectNameFromDir(projDir, /^Users-/);
          const fileResults = await Promise.all(
            jsonlFiles.map(async (f) => {
              try {
                const fp = join(projPath, f);
                const st = await stat(fp);
                if (st.size < 100) return null;
                const id = `${projDir}/${f.replace(".jsonl", "")}`;
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

          const sessionDirs = await Promise.all(
            files.map(async (entry) => {
              try {
                const entryPath = join(projPath, entry);
                const entryStat = await stat(entryPath);
                return entryStat.isDirectory() ? entry : null;
              } catch {
                return null;
              }
            })
          );
          const subagentResults = await Promise.all(
            sessionDirs.filter(Boolean).map(async (sessionDir) => {
              const subagentsPath = join(projPath, sessionDir, "subagents");
              try {
                const subagentFiles = await readdir(subagentsPath);
                const jsonlSubagents = subagentFiles.filter(f => f.endsWith(".jsonl") && f.startsWith("agent-"));
                const results = await Promise.all(
                  jsonlSubagents.map(async (f) => {
                    try {
                      const fp = join(subagentsPath, f);
                      const st = await stat(fp);
                      if (st.size < 100) return null;
                      const subagentName = f.replace(".jsonl", "");
                      return {
                        id: `${projDir}/${sessionDir}/subagents/${subagentName}`,
                        source: "codebuddy-projects-subagent",
                        path: fp,
                        title: subagentName,
                        summary: "",
                        projectName,
                        timestamp: st.mtime.toISOString(),
                        size: st.size,
                        _needsEnrich: true,
                        _isSubagent: true,
                      };
                    } catch {
                      return null;
                    }
                  })
                );
                return results.filter(Boolean);
              } catch {
                return [];
              }
            })
          );
          return [...fileResults.filter(Boolean), ...subagentResults.flat()];
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

  sortSessionsByTimeDesc(sessions);

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

// ─── Box Parser ──────────────────────────────────────────────

async function listFilesSafe(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

function parseBoxHistoryMetadata(content) {
  const sessionMatch = content.match(/^- \*\*Session\*\*: (.+)$/m);
  const exportedMatch = content.match(/^- \*\*Exported at\*\*: (.+)$/m);
  const messagesMatch = content.match(/^- \*\*Messages\*\*: (\d+)(?: \(([^~)]+)\s*~\s*([^)]+)\))?/m);
  const roundsMatch = content.match(/^- \*\*Rounds\*\*: (\d+)/m);
  const userMatch = content.match(/^## \[User\] [^\n]*\n([\s\S]*?)(?=^---$|^## \[)/m);
  const assistantMatch = content.match(/^## \[Assistant\] [^\n]*\n([\s\S]*?)(?=^---$|^## \[)/m);
  const firstUser = userMatch?.[1]?.trim() || "";
  const firstAssistant = assistantMatch?.[1]?.trim() || "";

  return {
    sessionId: sessionMatch?.[1]?.trim() || "",
    exportedAt: formatTimestamp(exportedMatch?.[1]?.trim()) || "",
    messageCount: messagesMatch?.[1] ? Number.parseInt(messagesMatch[1], 10) : 0,
    startTime: formatTimestamp(messagesMatch?.[2]?.trim()) || "",
    endTime: formatTimestamp(messagesMatch?.[3]?.trim()) || "",
    rounds: roundsMatch?.[1] ? Number.parseInt(roundsMatch[1], 10) : 0,
    firstUser,
    firstAssistant,
  };
}

function parseBoxMessageBlocks(content) {
  const headingRe = /^## \[(User|Assistant|Tool)\] ([^\n]+)$/gm;
  const matches = [...content.matchAll(headingRe)];
  const messages = [];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const next = matches[i + 1];
    const label = match[1];
    const timestamp = formatTimestamp(match[2].trim()) || "";
    const start = match.index + match[0].length;
    const end = next ? next.index : content.length;
    let body = content.slice(start, end).trim();
    body = body.replace(/\n---\s*$/m, "").trim();
    if (!body) continue;

    if (label === "User") {
      messages.push({ role: "user", timestamp, content: body });
    } else if (label === "Assistant") {
      messages.push({ role: "assistant", timestamp, content: body });
    } else {
      messages.push({
        role: "tool",
        type: "tool_result",
        timestamp,
        toolName: "box",
        content: body,
      });
    }
  }

  return messages;
}

function sqlString(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

async function runSqliteJson(dbPath, sql) {
  try {
    const { stdout } = await execFileAsync(
      "sqlite3",
      ["-readonly", "-json", dbPath, sql],
      { maxBuffer: 100 * 1024 * 1024 }
    );
    const text = stdout.trim();
    if (!text) return [];
    const data = safeJsonParse(text);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function normalizeBoxToolCalls(raw) {
  const parsed = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (!Array.isArray(parsed)) return [];

  return parsed.map((call) => {
    const input = call?.arguments ?? call?.input ?? {};
    return {
      id: call?.id || call?.toolCallId || "",
      name: call?.name || call?.toolName || "tool",
      input,
    };
  }).filter((call) => call.name);
}

function normalizeBoxToolResults(raw, fallbackContent = "") {
  const parsed = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  if (parsed && typeof parsed === "object") return [parsed];

  const contentParsed = safeJsonParse(fallbackContent);
  if (Array.isArray(contentParsed) && contentParsed.length > 0) return contentParsed;
  if (contentParsed && typeof contentParsed === "object" && ("output" in contentParsed || "toolCallId" in contentParsed)) {
    return [contentParsed];
  }

  return fallbackContent ? [{ output: fallbackContent }] : [];
}

function boxMessageContentWithReasoning(content, reasoningContent) {
  const parts = [];
  if (reasoningContent) {
    parts.push(`> \u{1F4AD} *Thinking:*\n> ${reasoningContent.replace(/\n/g, "\n> ")}`);
  }
  if (content) parts.push(content);
  return parts.join("\n\n");
}

async function listBoxDbSessions() {
  const sql = `
    SELECT
      s.id,
      s.title,
      s.mode,
      s.work_dir AS workDir,
      s.created_at AS createdAt,
      s.updated_at AS updatedAt,
      s.token_total AS tokenTotal,
      COUNT(m.id) AS messageCount,
      (
        SELECT content
        FROM messages m2
        WHERE m2.session_id = s.id AND m2.role = 'user'
        ORDER BY m2.id ASC
        LIMIT 1
      ) AS firstUser
    FROM sessions s
    LEFT JOIN messages m ON m.session_id = s.id
    GROUP BY s.id
    HAVING messageCount > 0
    ORDER BY s.updated_at DESC
  `;
  const rows = await runSqliteJson(BOX_SESSIONS_DB, sql);
  if (rows.length === 0) return [];

  return rows.map((row) => {
    const firstUser = typeof row.firstUser === "string" ? row.firstUser : "";
    const timestamp = formatTimestamp(row.updatedAt) || formatTimestamp(row.createdAt);
    return {
      id: row.id,
      source: "box-db",
      path: BOX_SESSIONS_DB,
      title: truncate(row.title || firstUser, 80) || `Box session ${row.id}`,
      summary: truncate(firstUser || row.title),
      projectName: "Box",
      timestamp,
      sortTimestamp: timestamp,
      created: formatTimestamp(row.createdAt),
      mode: row.mode,
      workDir: row.workDir,
      size: 0,
      messageCount: Number(row.messageCount) || 0,
      tokenTotal: Number(row.tokenTotal) || 0,
    };
  });
}

async function parseBoxDbSession(sessionInfo) {
  const rows = await runSqliteJson(
    BOX_SESSIONS_DB,
    `
      SELECT id, role, content, reasoning_content AS reasoningContent,
             tool_calls AS toolCalls, tool_results AS toolResults,
             token_count AS tokenCount, timestamp, metadata
      FROM messages
      WHERE session_id = ${sqlString(sessionInfo.id)}
      ORDER BY id ASC
    `
  );

  const messages = [];
  const toolCallNames = new Map();

  for (const row of rows) {
    const role = row.role;
    const timestamp = formatTimestamp(row.timestamp);
    const content = typeof row.content === "string" ? row.content : "";
    const reasoningContent = typeof row.reasoningContent === "string" ? row.reasoningContent : "";

    if (role === "user") {
      if (!content.trim()) continue;
      messages.push({
        role: "user",
        timestamp,
        content,
      });
      continue;
    }

    if (role === "assistant") {
      const toolCalls = normalizeBoxToolCalls(row.toolCalls);
      for (const call of toolCalls) {
        if (call.id) toolCallNames.set(call.id, call.name);
      }
      messages.push({
        role: "assistant",
        timestamp,
        content: boxMessageContentWithReasoning(content, reasoningContent),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        tokenCount: Number(row.tokenCount) || undefined,
      });
      continue;
    }

    if (role === "tool") {
      const results = normalizeBoxToolResults(row.toolResults, content);
      for (const result of results) {
        const output = result?.output ?? result?.content ?? content;
        if (output == null || output === "") continue;
        const toolCallId = result?.toolCallId || result?.tool_call_id || "";
        const toolName = result?.name || toolCallNames.get(toolCallId) || "box";
        messages.push({
          role: "tool",
          type: "tool_result",
          timestamp,
          toolName,
          content: typeof output === "string" ? output : JSON.stringify(output, null, 2),
          toolOutput: { output },
        });
      }
      continue;
    }

    if (content.trim()) {
      messages.push({ role, timestamp, content });
    }
  }

  return {
    id: sessionInfo.id,
    agent: "box",
    source: "box-db",
    title: sessionInfo.title || sessionInfo.summary || sessionInfo.id,
    projectName: sessionInfo.projectName,
    summary: sessionInfo.summary,
    timestamp: sessionInfo.timestamp,
    agentMode: sessionInfo.mode,
    messages,
  };
}

async function getNewestFileStat(dir, files) {
  let newest = null;
  let totalSize = 0;
  for (const f of files) {
    try {
      const fp = join(dir, f);
      const st = await stat(fp);
      if (!st.isFile()) continue;
      totalSize += st.size;
      if (!newest || st.mtimeMs > newest.mtimeMs) {
        newest = {
          path: fp,
          file: f,
          size: st.size,
          mtime: st.mtime,
          mtimeMs: st.mtimeMs,
        };
      }
    } catch {}
  }
  return { newest, totalSize };
}

export async function listBoxSessions() {
  const dbSessions = await listBoxDbSessions();
  if (dbSessions.length > 0) return dbSessions;

  const sessions = [];
  try {
    const entries = await readdir(BOX_CTX_DIR);
    const results = await Promise.all(
      entries.map(async (entry) => {
        if (entry.startsWith(".")) return null;
        const ctxPath = join(BOX_CTX_DIR, entry);
        try {
          const ctxStat = await stat(ctxPath);
          if (!ctxStat.isDirectory()) return null;

          const historyDir = join(ctxPath, "history");
          const toolOutputsDir = join(ctxPath, "tool-outputs");
          const outputDir = join(BOX_OUTPUT_DIR, entry);
          const historyFiles = (await listFilesSafe(historyDir))
            .filter((f) => f.endsWith(".md"))
            .sort();
          const toolOutputFiles = (await listFilesSafe(toolOutputsDir))
            .filter((f) => !f.startsWith("."));
          const outputFiles = (await listFilesSafe(outputDir))
            .filter((f) => !f.startsWith("."));

          if (historyFiles.length === 0) return null;

          let title = "";
          let summary = "";
          let timestamp = ctxStat.mtime.toISOString();
          let sortTimestamp = timestamp;
          let size = 0;
          let messageCount = 0;
          let rounds = 0;
          const source = "box-history";
          const firstHistoryPath = join(historyDir, historyFiles[0]);
          const historyStats = await Promise.all(historyFiles.map(async (f) => {
            try {
              const fp = join(historyDir, f);
              const st = await stat(fp);
              return { fp, st };
            } catch {
              return null;
            }
          }));
          const validHistoryStats = historyStats.filter(Boolean);
          const newestHistory = validHistoryStats
            .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)[0];
          size += validHistoryStats.reduce((sum, item) => sum + item.st.size, 0);

          const metadata = parseBoxHistoryMetadata(await readFile(firstHistoryPath, "utf-8"));
          title = truncate(metadata.firstUser, 80) || `Box session ${entry}`;
          summary = truncate(metadata.firstUser || metadata.firstAssistant);
          timestamp = metadata.endTime || metadata.startTime || metadata.exportedAt || newestHistory?.st.mtime.toISOString() || timestamp;
          sortTimestamp = timestamp;
          messageCount = metadata.messageCount;
          rounds = metadata.rounds;

          return {
            id: entry,
            source,
            path: ctxPath,
            historyDir,
            toolOutputsDir,
            outputDir,
            title,
            summary,
            projectName: "Box",
            timestamp,
            sortTimestamp,
            size,
            messageCount,
            rounds,
            historyCount: historyFiles.length,
            toolOutputCount: toolOutputFiles.length,
            outputCount: outputFiles.length,
          };
        } catch {
          return null;
        }
      })
    );
    sessions.push(...results.filter(Boolean));
  } catch {}

  sortSessionsByTimeDesc(sessions);
  return sessions;
}

export async function parseBoxSession(sessionInfo) {
  if (sessionInfo.source === "box-db") {
    return parseBoxDbSession(sessionInfo);
  }

  const messages = [];

  if (sessionInfo.historyCount > 0 || sessionInfo.source === "box-history") {
    const historyFiles = (await listFilesSafe(sessionInfo.historyDir))
      .filter((f) => f.endsWith(".md"))
      .sort();
    for (const f of historyFiles) {
      try {
        const content = await readFile(join(sessionInfo.historyDir, f), "utf-8");
        messages.push(...parseBoxMessageBlocks(content));
      } catch {}
    }
  }

  if (messages.length === 0) {
    const parts = [];
    if (sessionInfo.toolOutputCount) parts.push(`${sessionInfo.toolOutputCount} tool outputs`);
    if (sessionInfo.outputCount) parts.push(`${sessionInfo.outputCount} workspace outputs`);
    messages.push({
      role: "assistant",
      timestamp: sessionInfo.timestamp || "",
      content: parts.length
        ? `Box context with ${parts.join(" and ")}. No exported conversation history markdown was found for this context.`
        : "Box context without exported conversation history.",
    });
  }

  return {
    id: sessionInfo.id,
    agent: "box",
    source: sessionInfo.source,
    title: sessionInfo.title || sessionInfo.summary || sessionInfo.id,
    projectName: sessionInfo.projectName,
    summary: sessionInfo.summary,
    timestamp: sessionInfo.timestamp,
    messages,
  };
}

// ─── Codex Parser ────────────────────────────────────────────

function codexSessionIdFromPath(filePath) {
  const file = basename(filePath, ".jsonl");
  const matches = file.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
  return matches?.length ? matches[matches.length - 1] : file;
}

async function readCodexSessionIndex() {
  const index = new Map();
  try {
    const raw = await readFile(CODEX_SESSION_INDEX_FILE, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const data = safeJsonParse(line);
      if (!data?.id) continue;
      index.set(data.id, {
        title: data.thread_name || "",
        updatedAt: formatTimestamp(data.updated_at),
      });
    }
  } catch {}
  return index;
}

async function readCodexHistoryBySession() {
  const history = new Map();
  try {
    const raw = await readFile(CODEX_HISTORY_FILE, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const data = safeJsonParse(line);
      if (!data?.session_id) continue;
      const timestamp = data.ts ? formatTimestamp(Number(data.ts) * 1000) : "";
      const existing = history.get(data.session_id);
      if (!existing || getTimeMs(timestamp) >= getTimeMs(existing.timestamp)) {
        history.set(data.session_id, {
          text: typeof data.text === "string" ? data.text : "",
          timestamp,
        });
      }
    }
  } catch {}
  return history;
}

function codexTextFromContentBlocks(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (typeof block.text === "string") {
      parts.push(block.text);
    } else if (typeof block.content === "string") {
      parts.push(block.content);
    } else if (block.type === "input_image" || block.image_url || block.file_id) {
      parts.push("[Image]");
    }
  }
  return parts.join("\n\n");
}

function codexUserMessageContent(payload) {
  const parts = [];
  if (typeof payload.message === "string" && payload.message.trim()) {
    parts.push(payload.message.trim());
  }
  if (Array.isArray(payload.local_images) && payload.local_images.length) {
    parts.push(`Attached local images:\n${payload.local_images.map((p) => `- ${p}`).join("\n")}`);
  }
  if (Array.isArray(payload.images) && payload.images.length) {
    parts.push(`Attached images: ${payload.images.length}`);
  }
  if (Array.isArray(payload.text_elements) && payload.text_elements.length) {
    const text = payload.text_elements
      .map((el) => typeof el === "string" ? el : el?.text)
      .filter(Boolean)
      .join("\n");
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

function isCodexSyntheticUserContent(content) {
  const trimmed = content.trim();
  return (
    trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("<permissions instructions>") ||
    trimmed.startsWith("<app-context>") ||
    trimmed.startsWith("<collaboration_mode>") ||
    trimmed.startsWith("<skills_instructions>") ||
    trimmed.startsWith("<plugins_instructions>")
  );
}

function codexReasoningText(payload) {
  const parts = [];
  const content = codexTextFromContentBlocks(payload.content);
  if (content.trim()) parts.push(content.trim());
  if (Array.isArray(payload.summary)) {
    const summary = codexTextFromContentBlocks(payload.summary);
    if (summary.trim()) parts.push(summary.trim());
  } else if (typeof payload.summary === "string" && payload.summary.trim()) {
    parts.push(payload.summary.trim());
  }
  return parts.join("\n\n");
}

function parseCodexToolInput(payload) {
  const raw = payload.arguments ?? payload.input ?? {};
  if (typeof raw !== "string") return raw;
  return safeJsonParse(raw) ?? raw;
}

function codexToolOutputToString(output) {
  const text = typeof output === "string" ? output : JSON.stringify(output, null, 2);
  return truncate(text || "", 6000);
}

async function inspectCodexSessionFile(filePath, indexById, historyBySession) {
  try {
    const st = await stat(filePath);
    if (!st.isFile() || st.size < 20) return null;

    let id = codexSessionIdFromPath(filePath);
    let timestamp = st.mtime.toISOString();
    let sortTimestamp = st.mtime.toISOString();
    let summary = "";
    let projectName = "";
    let model = "";
    let originator = "";
    let source = "codex";

    const lines = await readJsonlHead(filePath, 120);
    for (const line of lines) {
      const data = safeJsonParse(line);
      if (!data) continue;

      if (data.type === "session_meta") {
        const payload = data.payload || {};
        if (payload.id) id = payload.id;
        if (payload.timestamp) timestamp = formatTimestamp(payload.timestamp) || timestamp;
        if (payload.cwd) projectName = basename(payload.cwd);
        if (payload.originator) originator = payload.originator;
        if (payload.source) source = `codex-${payload.source}`;
        continue;
      }

      if (data.type === "turn_context") {
        const payload = data.payload || {};
        if (!projectName && payload.cwd) projectName = basename(payload.cwd);
        if (payload.model) model = payload.model;
        continue;
      }

      if (data.type === "event_msg" && data.payload?.type === "user_message" && !summary) {
        summary = codexUserMessageContent(data.payload);
        continue;
      }

      if (
        data.type === "response_item" &&
        data.payload?.type === "message" &&
        data.payload.role === "user" &&
        !summary
      ) {
        const text = codexTextFromContentBlocks(data.payload.content);
        if (text.trim() && !isCodexSyntheticUserContent(text)) {
          summary = text;
        }
      }
    }

    const indexEntry = indexById.get(id);
    const historyEntry = historyBySession.get(id);
    if (!summary && historyEntry?.text) summary = historyEntry.text;

    return {
      id,
      source,
      path: filePath,
      title: truncate(indexEntry?.title || summary, 80),
      summary: truncate(summary),
      projectName,
      timestamp,
      sortTimestamp,
      size: st.size,
      model,
      originator,
    };
  } catch {
    return null;
  }
}

export async function listCodexSessions() {
  const [indexById, historyBySession, files] = await Promise.all([
    readCodexSessionIndex(),
    readCodexHistoryBySession(),
    walkFilesRecursive(CODEX_SESSIONS_DIR, (name) => name.endsWith(".jsonl")),
  ]);

  const results = await Promise.all(
    files.map((filePath) => inspectCodexSessionFile(filePath, indexById, historyBySession))
  );
  const sessions = results.filter(Boolean);
  sortSessionsByTimeDesc(sessions);
  return sessions;
}

export async function parseCodexSession(sessionInfo) {
  const raw = await readFile(sessionInfo.path, "utf-8");
  const entries = raw
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => safeJsonParse(line))
    .filter(Boolean);

  const hasEventUserMessages = entries.some(
    (data) => data.type === "event_msg" && data.payload?.type === "user_message"
  );

  const messages = [];
  const pendingToolCalls = new Map();
  let title = sessionInfo.title || "";
  let timestamp = sessionInfo.timestamp || "";
  let projectName = sessionInfo.projectName || "";
  let model = sessionInfo.model || "";
  let originator = sessionInfo.originator || "";

  for (const data of entries) {
    const payload = data.payload || {};
    const ts = formatTimestamp(data.timestamp);

    if (data.type === "session_meta") {
      if (payload.timestamp) timestamp = formatTimestamp(payload.timestamp) || timestamp;
      if (payload.cwd) projectName = basename(payload.cwd);
      if (payload.originator) originator = payload.originator;
      continue;
    }

    if (data.type === "turn_context") {
      if (payload.cwd) projectName = basename(payload.cwd);
      if (payload.model) model = payload.model;
      continue;
    }

    if (data.type === "event_msg") {
      if (payload.type === "user_message") {
        const content = codexUserMessageContent(payload);
        if (content.trim()) {
          if (!title) title = truncate(content, 80);
          messages.push({
            role: "user",
            timestamp: ts,
            content,
          });
        }
        continue;
      }

      if (payload.type === "agent_reasoning" && payload.text) {
        messages.push({
          role: "assistant",
          timestamp: ts,
          content: `> \u{1F4AD} *Thinking:*\n> ${payload.text.replace(/\n/g, "\n> ")}`,
          model: model || undefined,
        });
      }
      continue;
    }

    if (data.type !== "response_item") continue;

    if (payload.type === "message") {
      const content = codexTextFromContentBlocks(payload.content);
      if (!content.trim()) continue;

      if (payload.role === "assistant") {
        messages.push({
          role: "assistant",
          timestamp: ts,
          content,
          model: model || undefined,
        });
      } else if (payload.role === "user" && !hasEventUserMessages && !isCodexSyntheticUserContent(content)) {
        if (!title) title = truncate(content, 80);
        messages.push({
          role: "user",
          timestamp: ts,
          content,
        });
      }
      continue;
    }

    if (payload.type === "reasoning") {
      const thinking = codexReasoningText(payload);
      if (thinking) {
        messages.push({
          role: "assistant",
          timestamp: ts,
          content: `> \u{1F4AD} *Thinking:*\n> ${thinking.replace(/\n/g, "\n> ")}`,
          model: model || undefined,
        });
      }
      continue;
    }

    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const name = payload.name || "tool";
      const input = parseCodexToolInput(payload);
      if (payload.call_id) {
        pendingToolCalls.set(payload.call_id, { name, input });
      }
      messages.push({
        role: "assistant",
        timestamp: ts,
        content: "",
        toolCalls: [{ name, input }],
        model: model || undefined,
      });
      continue;
    }

    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const call = pendingToolCalls.get(payload.call_id) || {};
      if (payload.call_id) pendingToolCalls.delete(payload.call_id);
      const content = codexToolOutputToString(payload.output);
      if (!content.trim()) continue;
      messages.push({
        role: "tool",
        type: "tool_result",
        timestamp: ts,
        toolName: call.name || "tool",
        content,
      });
    }
  }

  return {
    id: sessionInfo.id,
    agent: "codex",
    source: sessionInfo.source || "codex",
    title: title || sessionInfo.summary || sessionInfo.id,
    projectName,
    summary: sessionInfo.summary,
    timestamp,
    originator,
    messages,
  };
}

// ─── Markdown Export ─────────────────────────────────────────

export function sessionToMarkdown(session, options = {}) {
  // Filtering toggles. Defaults preserve previous behavior (everything shown).
  const showUser = options.showUser !== false;
  const showAssistant = options.showAssistant !== false;
  const showThinking = options.showThinking !== false;
  const showToolCalls = options.showToolCalls !== false;
  const showToolResults = options.showToolResults !== false;

  const lines = [];
  const agentLabel = session.agent === "claude-code" ? "Claude Code" : 
                     session.agent === "amp" ? "Amp" : 
                     session.agent === "copilot" ? "GitHub Copilot CLI" : 
                     session.agent === "codebuddy" ? "CodeBuddy" : 
                     session.agent === "box" ? "Box" :
                     session.agent === "codex" ? "Codex" :
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
      if (!showUser) continue;
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
      const { thinking, text } = splitThinkingFromContent(msg.content || "");
      const hasVisibleThinking = !!thinking && showThinking;
      const hasVisibleText = !!text.trim() && showAssistant;
      const hasVisibleTools = showToolCalls && msg.toolCalls && msg.toolCalls.length > 0;

      // Skip the entire assistant block if nothing inside is visible.
      if (!hasVisibleThinking && !hasVisibleText && !hasVisibleTools) continue;

      lines.push(`### \u{1F916} Assistant`);
      const timeParts = [];
      if (msg.model) timeParts.push(msg.model);
      if (msg.timestamp) {
        const d = new Date(msg.timestamp);
        if (!isNaN(d.getTime())) timeParts.push(d.toLocaleTimeString());
      }
      if (timeParts.length) lines.push(`<sub>${timeParts.join(" \u00B7 ")}</sub>`);
      lines.push("");

      if (hasVisibleThinking) {
        lines.push(`<details>`);
        lines.push(`<summary>\u{1F4AD} <em>Thinking process</em></summary>`);
        lines.push("");
        lines.push(thinking);
        lines.push("");
        lines.push(`</details>`);
        lines.push("");
      }

      if (hasVisibleText) {
        lines.push(text);
        lines.push("");
      }

      if (hasVisibleTools) {
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
      if (!showToolResults) continue;
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
  box: listBoxSessions,
  codex: listCodexSessions,
};

const AGENT_PARSERS = {
  claude: parseClaudeSession,
  "claude-internal": parseClaudeSession,
  amp: parseAmpSession,
  copilot: parseCopilotSession,
  codebuddy: parseCodebuddySession,
  box: parseBoxSession,
  codex: parseCodexSession,
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
    all = all.filter(s => getSessionSortMs(s) >= sinceDate.getTime());
  }
  if (untilDate) {
    all = all.filter(s => getSessionSortMs(s) <= untilDate.getTime());
  }
  if (opts.project) {
    const q = opts.project.toLowerCase();
    all = all.filter(s => (s.projectName || "").toLowerCase().includes(q));
  }

  // Sort by timestamp descending
  sortSessionsByTimeDesc(all);

  return all.slice(0, limit);
}

/**
 * Get and parse a single session by agent key and id.
 * @param {string} agent - "claude", "claude-internal", "amp", "copilot", "codebuddy", "box"
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
