import express from "express";
import { readdir, readFile, stat } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3847;

// ─── Paths ───────────────────────────────────────────────────
const CLAUDE_TRANSCRIPTS_DIR = join(homedir(), ".claude", "transcripts");
const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const AMP_THREADS_DIR = join(homedir(), ".local", "share", "amp", "threads");

// ─── Helpers ─────────────────────────────────────────────────

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function truncate(str, max = 120) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + "…" : str;
}

function formatTimestamp(ts) {
  if (!ts) return "";
  const d = new Date(typeof ts === "number" ? ts : ts);
  return isNaN(d.getTime()) ? "" : d.toISOString();
}

// ─── Claude Code Parser ──────────────────────────────────────

async function listClaudeSessions() {
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
      // Read first line for summary
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

  // 2) projects dir — only top-level session files
  try {
    const projectDirs = await readdir(CLAUDE_PROJECTS_DIR);
    for (const projDir of projectDirs) {
      const projPath = join(CLAUDE_PROJECTS_DIR, projDir);
      try {
        const projStat = await stat(projPath);
        if (!projStat.isDirectory()) continue;
      } catch {
        continue;
      }
      try {
        const files = await readdir(projPath);
        for (const f of files) {
          if (!f.endsWith(".jsonl")) continue;
          // Skip subagent files
          if (f.startsWith("agent-")) continue;
          const fp = join(projPath, f);
          const st = await stat(fp);
          if (st.size < 100) continue; // skip tiny/empty
          const id = `${projDir}/${f.replace(".jsonl", "")}`;
          let summary = "";
          let title = "";
          let timestamp = st.mtime.toISOString();
          try {
            const content = await readFile(fp, "utf-8");
            const lines = content.split("\n").filter((l) => l.trim());

            // summary type is usually at the END of the file
            for (const line of lines.slice(-3)) {
              const data = safeJsonParse(line);
              if (data?.type === "summary" && data.summary) {
                title = data.summary;
                break;
              }
            }

            // Find first user message for summary
            for (const line of lines.slice(0, 10)) {
              const data = safeJsonParse(line);
              if (!data) continue;
              if (data.type === "user") {
                const msg = data.message;
                if (msg && typeof msg.content === "string") {
                  summary = msg.content;
                  break;
                }
                if (typeof data.content === "string") {
                  summary = data.content;
                  break;
                }
              }
            }

            // Find first timestamp
            for (const line of lines.slice(0, 3)) {
              const data = safeJsonParse(line);
              if (data?.timestamp) {
                timestamp = formatTimestamp(data.timestamp);
                break;
              }
            }
          } catch {}

          // Derive project name
          const projectName = projDir
            .replace(/^-/, "")
            .replace(/-/g, "/")
            .split("/")
            .pop();

          sessions.push({
            id,
            source: "claude-projects",
            path: fp,
            title: truncate(title, 80),
            summary: truncate(summary),
            projectName,
            timestamp,
            size: st.size,
          });
        }
      } catch {}
    }
  } catch {}

  sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return sessions;
}

function parseClaudeTranscriptLine(data) {
  // Transcripts format: flat {type, timestamp, content/tool_name/tool_input/tool_output}
  // NOTE: This format has NO assistant text messages — only user + tool_use + tool_result
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

function parseClaudeProjectLine(data) {
  if (data.type === "file-history-snapshot" || data.type === "progress") return null;

  if (data.type === "user") {
    const msg = data.message;
    if (!msg) return null;
    let content = "";
    if (typeof msg.content === "string") content = msg.content;
    else if (Array.isArray(msg.content)) {
      // tool_result arrays from user
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
    // Skip empty tool-result-only user messages
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
          parts.push(`> 💭 *Thinking:*\n> ${block.thinking.replace(/\n/g, "\n> ")}`);
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

async function parseClaudeSession(sessionInfo) {
  const content = await readFile(sessionInfo.path, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());
  const rawMessages = [];
  const isProject = sessionInfo.source === "claude-projects";

  for (const line of lines) {
    const data = safeJsonParse(line);
    if (!data) continue;
    const parsed = isProject
      ? parseClaudeProjectLine(data)
      : parseClaudeTranscriptLine(data);
    if (parsed) rawMessages.push(parsed);
  }

  // For transcripts format: merge consecutive tool_use into a single assistant message
  // and pair tool_result with their corresponding tool_use
  const messages = [];
  for (let i = 0; i < rawMessages.length; i++) {
    const msg = rawMessages[i];

    if (isProject) {
      // Project format already has proper assistant messages
      messages.push(msg);
      continue;
    }

    // Transcripts format merging
    if (msg.role === "user") {
      messages.push(msg);
    } else if (msg.role === "assistant" && msg.type === "tool_use") {
      // Look ahead: merge consecutive tool_use calls into one assistant message
      const merged = {
        role: "assistant",
        timestamp: msg.timestamp,
        content: "",
        toolCalls: [...(msg.toolCalls || [])],
      };
      // Collect consecutive tool_use + tool_result pairs
      while (i + 1 < rawMessages.length) {
        const next = rawMessages[i + 1];
        if (next.role === "tool" && next.type === "tool_result") {
          // Attach result to the tool call, skip as separate message
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
      // Standalone tool result (not preceded by tool_use) — keep it
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

async function listAmpSessions() {
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
          // Find first user message for summary
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

async function parseAmpSession(sessionInfo) {
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
          parts.push(`> 💭 *Thinking:*\n> ${block.thinking.replace(/\n/g, "\n> ")}`);
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

// ─── Markdown Export ─────────────────────────────────────────

function sessionToMarkdown(session) {
  const lines = [];
  const agentLabel = session.agent === "claude-code" ? "Claude Code" : session.agent === "amp" ? "Amp" : session.agent;

  // ── Title & Metadata ──
  lines.push(`# ${session.title || session.summary || session.id}`);
  lines.push("");

  // Metadata as a clean table
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

  // ── Pre-process: merge consecutive assistant messages ──
  const merged = mergeConsecutiveAssistant(session.messages);

  // ── Conversation turns ──
  let turnNum = 0;
  for (const msg of merged) {
    if (msg.role === "user") {
      turnNum++;
      lines.push(`## Turn ${turnNum}`);
      lines.push("");
      lines.push(`### 💬 User`);
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
      lines.push(`### 🤖 Assistant`);
      const timeParts = [];
      if (msg.model) timeParts.push(msg.model);
      if (msg.timestamp) {
        const d = new Date(msg.timestamp);
        if (!isNaN(d.getTime())) timeParts.push(d.toLocaleTimeString());
      }
      if (timeParts.length) lines.push(`<sub>${timeParts.join(" · ")}</sub>`);
      lines.push("");

      // Separate thinking from content
      const { thinking, text } = splitThinkingFromContent(msg.content || "");

      // Render thinking as collapsed details
      if (thinking) {
        lines.push(`<details>`);
        lines.push(`<summary>💭 <em>Thinking process</em></summary>`);
        lines.push("");
        lines.push(thinking);
        lines.push("");
        lines.push(`</details>`);
        lines.push("");
      }

      // Render main text
      if (text.trim()) {
        lines.push(text);
        lines.push("");
      }

      // Render tool calls as compact collapsible sections
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        if (msg.toolCalls.length === 1) {
          const tc = msg.toolCalls[0];
          lines.push(formatToolCall(tc));
          lines.push("");
        } else {
          // Multiple tool calls — group them
          lines.push(`<details>`);
          lines.push(`<summary>🔧 <strong>${msg.toolCalls.length} tool calls</strong></summary>`);
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
      // Tool results — keep minimal
      const output = msg.toolOutput?.output || msg.content;
      if (output) {
        const display = typeof output === "string" ? output : JSON.stringify(output, null, 2);
        const trimmed = display.length > 2000
          ? display.slice(0, 2000) + "\n… (truncated)"
          : display;
        lines.push(`<details>`);
        lines.push(`<summary>📎 Tool result: <code>${msg.toolName || "unknown"}</code></summary>`);
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

  // Footer
  lines.push("---");
  lines.push("");
  lines.push(`*Exported from AI Session Viewer*`);
  lines.push("");

  return lines.join("\n");
}

// Merge consecutive assistant messages into one to avoid fragmentation
function mergeConsecutiveAssistant(messages) {
  const result = [];
  for (const msg of messages) {
    const prev = result[result.length - 1];
    if (
      msg.role === "assistant" &&
      prev?.role === "assistant"
    ) {
      // Merge content
      if (msg.content) {
        prev.content = prev.content
          ? prev.content + "\n\n" + msg.content
          : msg.content;
      }
      // Merge tool calls
      if (msg.toolCalls?.length) {
        prev.toolCalls = (prev.toolCalls || []).concat(msg.toolCalls);
      }
      // Keep earliest timestamp, latest model
      if (msg.model) prev.model = msg.model;
    } else {
      result.push({ ...msg, toolCalls: msg.toolCalls ? [...msg.toolCalls] : undefined });
    }
  }
  return result;
}

// Split thinking blocks (> 💭 ...) from regular content
function splitThinkingFromContent(content) {
  const thinkingLines = [];
  const textLines = [];
  let inThinking = false;

  for (const line of content.split("\n")) {
    if (line.startsWith("> 💭 *Thinking:*") || line.startsWith("> 💭 *Thinking*")) {
      inThinking = true;
      continue; // skip the header line
    }
    if (inThinking) {
      if (line.startsWith("> ")) {
        thinkingLines.push(line.slice(2));
      } else if (line === ">") {
        thinkingLines.push("");
      } else {
        // End of thinking block
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

// Format a single tool call compactly
function formatToolCall(tc) {
  const lines = [];
  const inputStr = tc.input ? JSON.stringify(tc.input, null, 2) : "";

  // For small inputs, show inline; for large, collapse
  if (inputStr.length <= 200) {
    lines.push(`> 🔧 **${tc.name}**`);
    if (inputStr) {
      // Show key params inline
      lines.push(`> \`\`\`json`);
      lines.push(`> ${inputStr.replace(/\n/g, "\n> ")}`);
      lines.push(`> \`\`\``);
    }
  } else {
    const display = inputStr.length > 3000
      ? inputStr.slice(0, 3000) + "\n// … truncated"
      : inputStr;
    lines.push(`<details>`);
    lines.push(`<summary>🔧 <code>${tc.name}</code></summary>`);
    lines.push("");
    lines.push("```json");
    lines.push(display);
    lines.push("```");
    lines.push("");
    lines.push(`</details>`);
  }
  return lines.join("\n");
}

// ─── API Routes ──────────────────────────────────────────────

app.use(express.static(join(__dirname, "public")));
app.use(express.json());

// List all sessions
app.get("/api/sessions", async (req, res) => {
  try {
    const [claude, amp] = await Promise.all([
      listClaudeSessions(),
      listAmpSessions(),
    ]);
    res.json({
      claude: claude.slice(0, 200),
      amp: amp.slice(0, 200),
      total: claude.length + amp.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get parsed session (supports ?format=markdown for export)
app.get("/api/session/:agent/:id(*)", async (req, res) => {
  try {
    const { agent, id } = req.params;
    const wantMarkdown = req.query.format === "markdown";
    let parsed;

    if (agent === "claude") {
      const allSessions = await listClaudeSessions();
      const found = allSessions.find((s) => s.id === id);
      if (!found) return res.status(404).json({ error: "Session not found" });
      parsed = await parseClaudeSession(found);
    } else if (agent === "amp") {
      const allSessions = await listAmpSessions();
      const found = allSessions.find((s) => s.id === id);
      if (!found) return res.status(404).json({ error: "Session not found" });
      parsed = await parseAmpSession(found);
    } else {
      return res.status(400).json({ error: "Unknown agent" });
    }

    if (wantMarkdown) {
      const md = sessionToMarkdown(parsed);
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${parsed.id.replace(/\//g, "_")}.md"`
      );
      return res.send(md);
    }

    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  🚀 AI Session Viewer running at http://localhost:${PORT}\n`);
});
