#!/usr/bin/env node

// cli.js — CLI entry point for agent-friendly session access
// Outputs structured JSON to stdout, diagnostics to stderr
// Exit codes: 0=success, 1=error, 2=not found

import { writeFile } from "fs/promises";
import {
  listAllSessions,
  getSession,
  sessionToMarkdown,
  parseRelativeDate,
} from "./lib/sessions.js";

// ─── Argv Parser ─────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2); // skip node + script
  const command = args[0] && !args[0].startsWith("-") ? args[0] : null;
  const positional = [];
  const flags = {};

  for (let i = command ? 1 : 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else if (arg.startsWith("--no-")) {
        flags[arg.slice(5)] = false;
      } else {
        // Next arg is the value, unless it's another flag or missing
        const next = args[i + 1];
        if (next && !next.startsWith("--")) {
          flags[arg.slice(2)] = next;
          i++;
        } else {
          flags[arg.slice(2)] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

function die(msg, code = 1) {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(code);
}

function output(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

function info(msg) {
  process.stderr.write(msg + "\n");
}

// Parse comma-separated agent list, normalize aliases
function parseAgents(str) {
  if (!str) return undefined;
  const map = {
    claude: "claude",
    "claude-code": "claude",
    "claude-internal": "claude-internal",
    amp: "amp",
    copilot: "copilot",
  };
  return str.split(",").map(a => {
    const key = map[a.trim().toLowerCase()];
    if (!key) die(`Unknown agent: ${a.trim()}. Valid: claude, claude-internal, amp, copilot`);
    return key;
  });
}

// ─── Commands ────────────────────────────────────────────────

async function cmdList(positional, flags) {
  const agents = parseAgents(flags.agent);
  const limit = flags.limit ? parseInt(flags.limit, 10) : 50;
  const format = flags.format || "json";

  const sessions = await listAllSessions({
    agents,
    limit,
    since: flags.since,
    until: flags.until,
    project: flags.project,
  });

  // Strip internal fields
  const clean = sessions.map(s => ({
    id: s.id,
    agent: s.agent,
    title: s.title || "",
    summary: s.summary || "",
    timestamp: s.timestamp || "",
    projectName: s.projectName || "",
  }));

  if (format === "ids") {
    for (const s of clean) {
      process.stdout.write(`${s.agent === "claude-code" ? "claude" : s.agent}/${s.id}\n`);
    }
  } else if (format === "table") {
    // Simple text table for human readability
    const header = "AGENT\tTIMESTAMP\tPROJECT\tTITLE";
    process.stdout.write(header + "\n");
    for (const s of clean) {
      const ts = s.timestamp ? s.timestamp.slice(0, 19).replace("T", " ") : "";
      process.stdout.write(`${s.agent}\t${ts}\t${s.projectName || "-"}\t${s.title || s.summary || s.id}\n`);
    }
  } else {
    output({ count: clean.length, sessions: clean });
  }
}

async function cmdShow(positional, flags) {
  if (positional.length < 2) {
    die("Usage: cli.js show <agent> <id> [--format json|markdown|summary] [--no-tools] [--no-thinking] [--messages-only] [--role user|assistant]");
  }

  const agent = positional[0];
  const id = positional.slice(1).join("/"); // IDs can contain slashes
  const format = flags.format || "json";

  const session = await getSession(agent, id);
  if (!session) {
    die(`Session not found: ${agent}/${id}`, 2);
  }

  let messages = session.messages;

  // Apply filters
  if (flags.tools === false) {
    messages = messages.filter(m => m.role !== "tool");
    messages = messages.map(m => {
      if (m.toolCalls) {
        const { toolCalls, ...rest } = m;
        return rest;
      }
      return m;
    });
  }

  if (flags.thinking === false) {
    messages = messages.map(m => {
      if (m.role === "assistant" && m.content) {
        // Remove thinking blocks
        const lines = m.content.split("\n");
        const filtered = [];
        let inThinking = false;
        for (const line of lines) {
          if (line.startsWith("> \u{1F4AD} *Thinking")) {
            inThinking = true;
            continue;
          }
          if (inThinking) {
            if (line.startsWith("> ") || line === ">") continue;
            inThinking = false;
          }
          filtered.push(line);
        }
        return { ...m, content: filtered.join("\n").trim() };
      }
      return m;
    });
  }

  if (flags.role) {
    messages = messages.filter(m => m.role === flags.role);
  }

  if (flags["messages-only"]) {
    output(messages);
    return;
  }

  if (format === "markdown") {
    const md = sessionToMarkdown({ ...session, messages });
    process.stdout.write(md);
    return;
  }

  if (format === "summary") {
    output({
      id: session.id,
      agent: session.agent,
      title: session.title,
      summary: session.summary,
      timestamp: session.timestamp,
      projectName: session.projectName,
      messageCount: messages.length,
      userMessages: messages.filter(m => m.role === "user").length,
      assistantMessages: messages.filter(m => m.role === "assistant").length,
      toolCalls: messages.reduce((n, m) => n + (m.toolCalls?.length || 0), 0),
    });
    return;
  }

  // Default: full JSON
  output({ ...session, messages });
}

async function cmdSearch(positional, flags) {
  if (positional.length < 1) {
    die("Usage: cli.js search <query> [--agent ...] [--since ...] [--limit 20] [--deep] [--format json|table|ids]");
  }

  const query = positional.join(" ").toLowerCase();
  const agents = parseAgents(flags.agent);
  const limit = flags.limit ? parseInt(flags.limit, 10) : 20;
  const deep = flags.deep === true;
  const format = flags.format || "json";

  // Get all sessions (use high limit for search)
  const sessions = await listAllSessions({
    agents,
    limit: 1000,
    since: flags.since,
    until: flags.until,
  });

  let matches = [];

  // Shallow search: title + summary + project
  for (const s of sessions) {
    const hay = [s.title, s.summary, s.projectName].filter(Boolean).join(" ").toLowerCase();
    if (hay.includes(query)) {
      matches.push({
        id: s.id,
        agent: s.agent,
        title: s.title || "",
        summary: s.summary || "",
        timestamp: s.timestamp || "",
        projectName: s.projectName || "",
        matchType: "metadata",
      });
    }
  }

  // Deep search: look inside message content
  if (deep) {
    info(`Deep searching ${sessions.length} sessions...`);
    const alreadyFound = new Set(matches.map(m => `${m.agent}/${m.id}`));

    for (const s of sessions) {
      const key = `${s.agent}/${s.id}`;
      if (alreadyFound.has(key)) continue;
      if (matches.length >= limit) break;

      try {
        const agentKey = s._agentKey || (s.agent === "claude-code" ? "claude" : s.agent);
        const parsed = await getSession(agentKey, s.id);
        if (!parsed) continue;

        for (const msg of parsed.messages) {
          if ((msg.content || "").toLowerCase().includes(query)) {
            matches.push({
              id: s.id,
              agent: s.agent,
              title: s.title || "",
              summary: s.summary || "",
              timestamp: s.timestamp || "",
              projectName: s.projectName || "",
              matchType: "content",
            });
            break;
          }
        }
      } catch {
        // Skip sessions that fail to parse
      }
    }
  }

  matches = matches.slice(0, limit);

  if (format === "ids") {
    for (const m of matches) {
      process.stdout.write(`${m.agent === "claude-code" ? "claude" : m.agent}/${m.id}\n`);
    }
  } else if (format === "table") {
    process.stdout.write("AGENT\tMATCH\tTIMESTAMP\tTITLE\n");
    for (const m of matches) {
      const ts = m.timestamp ? m.timestamp.slice(0, 19).replace("T", " ") : "";
      process.stdout.write(`${m.agent}\t${m.matchType}\t${ts}\t${m.title || m.summary || m.id}\n`);
    }
  } else {
    output({ count: matches.length, query, matches });
  }
}

async function cmdExport(positional, flags) {
  if (positional.length < 2) {
    die("Usage: cli.js export <agent> <id> [--format markdown|json] [--output path] [--no-tools]");
  }

  const agent = positional[0];
  const id = positional.slice(1).join("/");
  const format = flags.format || "markdown";
  const outputPath = flags.output || flags.o;

  const session = await getSession(agent, id);
  if (!session) {
    die(`Session not found: ${agent}/${id}`, 2);
  }

  // Apply --no-tools filter
  if (flags.tools === false) {
    session.messages = session.messages.filter(m => m.role !== "tool");
    session.messages = session.messages.map(m => {
      if (m.toolCalls) {
        const { toolCalls, ...rest } = m;
        return rest;
      }
      return m;
    });
  }

  let content;
  if (format === "markdown") {
    content = sessionToMarkdown(session);
  } else {
    content = JSON.stringify(session, null, 2);
  }

  if (outputPath) {
    await writeFile(outputPath, content, "utf-8");
    info(`Written to ${outputPath}`);
  } else {
    process.stdout.write(content);
    if (!content.endsWith("\n")) process.stdout.write("\n");
  }
}

async function cmdStats(positional, flags) {
  const agents = parseAgents(flags.agent);
  const format = flags.format || "json";

  const sessions = await listAllSessions({
    agents,
    limit: 10000,
    since: flags.since,
    until: flags.until,
  });

  // Aggregate by agent
  const byAgent = {};
  for (const s of sessions) {
    const a = s.agent || "unknown";
    if (!byAgent[a]) byAgent[a] = { count: 0, oldest: null, newest: null, projects: new Set() };
    byAgent[a].count++;
    const ts = s.timestamp ? new Date(s.timestamp) : null;
    if (ts && !isNaN(ts.getTime())) {
      if (!byAgent[a].oldest || ts < byAgent[a].oldest) byAgent[a].oldest = ts;
      if (!byAgent[a].newest || ts > byAgent[a].newest) byAgent[a].newest = ts;
    }
    if (s.projectName) byAgent[a].projects.add(s.projectName);
  }

  const stats = {
    total: sessions.length,
    agents: {},
  };

  for (const [agent, data] of Object.entries(byAgent)) {
    stats.agents[agent] = {
      count: data.count,
      projects: data.projects.size,
      oldest: data.oldest ? data.oldest.toISOString() : null,
      newest: data.newest ? data.newest.toISOString() : null,
    };
  }

  if (format === "table") {
    process.stdout.write("AGENT\tCOUNT\tPROJECTS\tNEWEST\n");
    for (const [agent, data] of Object.entries(stats.agents)) {
      const newest = data.newest ? data.newest.slice(0, 19).replace("T", " ") : "-";
      process.stdout.write(`${agent}\t${data.count}\t${data.projects}\t${newest}\n`);
    }
    process.stdout.write(`\nTotal: ${stats.total} sessions\n`);
  } else {
    output(stats);
  }
}

// ─── Help ────────────────────────────────────────────────────

function showHelp() {
  process.stderr.write(`
ai-session-to-md CLI — Agent-friendly session access

Usage:
  node cli.js <command> [options]

Commands:
  list     List sessions
           [--agent claude,amp] [--since 7d] [--until 2026-03-20]
           [--limit 50] [--project myapp] [--format json|table|ids]

  show     Get full session detail
           <agent> <id> [--format json|markdown|summary]
           [--no-tools] [--no-thinking] [--messages-only] [--role user|assistant]

  search   Search sessions by keyword
           <query> [--agent ...] [--since ...] [--limit 20]
           [--deep] [--format json|table|ids]

  export   Export session to file
           <agent> <id> [--format markdown|json] [--output path] [--no-tools]

  stats    Aggregate statistics
           [--agent ...] [--since ...] [--format json|table]

  help     Show this help message

Options:
  --agent    Comma-separated list: claude, claude-internal, amp, copilot
  --since    Filter by date: ISO date or relative (7d, 2w, 1m, 3h)
  --until    Filter by date: ISO date or relative
  --limit    Max results (default varies by command)
  --format   Output format (default: json)

Exit codes:
  0  Success
  1  Error
  2  Not found

Examples:
  node cli.js list --limit 5
  node cli.js list --agent claude --since 7d --format table
  node cli.js show claude <session-id>
  node cli.js show claude <session-id> --format summary
  node cli.js search "authentication" --deep
  node cli.js export claude <session-id> --format markdown --output session.md
  node cli.js stats --since 30d
  node cli.js list --format ids | head -1
`);
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const { command, positional, flags } = parseArgs(process.argv);

  if (!command || command === "help" || flags.help) {
    showHelp();
    process.exit(0);
  }

  try {
    switch (command) {
      case "list":
        await cmdList(positional, flags);
        break;
      case "show":
        await cmdShow(positional, flags);
        break;
      case "search":
        await cmdSearch(positional, flags);
        break;
      case "export":
        await cmdExport(positional, flags);
        break;
      case "stats":
        await cmdStats(positional, flags);
        break;
      default:
        die(`Unknown command: ${command}. Run 'node cli.js help' for usage.`);
    }
  } catch (err) {
    die(err.message);
  }
}

main();
