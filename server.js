import express from "express";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

import {
  getCachedSessions,
  setCachedSessions,
  invalidateCache,
  listClaudeSessions,
  listClaudeInternalSessions,
  listAmpSessions,
  listCopilotSessions,
  listCodebuddySessions,
  listBoxSessions,
  listCodexSessions,
  parseClaudeSession,
  parseAmpSession,
  parseCopilotSession,
  parseCodebuddySession,
  parseBoxSession,
  parseCodexSession,
  sessionToMarkdown,
} from "./lib/sessions.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3847);

// ─── Middleware ───────────────────────────────────────────────

app.use(express.static(join(__dirname, "public")));
app.use(express.json());

// ─── API Routes ──────────────────────────────────────────────

// List all sessions (with caching)
app.get("/api/sessions", async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === "true";
    if (forceRefresh) invalidateCache();

    let claude = getCachedSessions("claude");
    let claudeInternal = getCachedSessions("claude-internal");
    let amp = getCachedSessions("amp");
    let copilot = getCachedSessions("copilot");
    let codebuddy = getCachedSessions("codebuddy");
    let box = getCachedSessions("box");
    let codex = getCachedSessions("codex");

    const promises = [];
    if (!claude) promises.push(listClaudeSessions().then(d => { claude = d; setCachedSessions("claude", d); }));
    if (!claudeInternal) promises.push(listClaudeInternalSessions().then(d => { claudeInternal = d; setCachedSessions("claude-internal", d); }));
    if (!amp) promises.push(listAmpSessions().then(d => { amp = d; setCachedSessions("amp", d); }));
    if (!copilot) promises.push(listCopilotSessions().then(d => { copilot = d; setCachedSessions("copilot", d); }));
    if (!codebuddy) promises.push(listCodebuddySessions().then(d => { codebuddy = d; setCachedSessions("codebuddy", d); }));
    if (!box) promises.push(listBoxSessions().then(d => { box = d; setCachedSessions("box", d); }));
    if (!codex) promises.push(listCodexSessions().then(d => { codex = d; setCachedSessions("codex", d); }));
    if (promises.length) await Promise.all(promises);

    res.json({
      claude: claude.slice(0, 200),
      "claude-internal": claudeInternal.slice(0, 200),
      amp: amp.slice(0, 200),
      copilot: copilot.slice(0, 200),
      codebuddy: codebuddy.slice(0, 200),
      box: box.slice(0, 200),
      codex: codex.slice(0, 200),
      total: claude.length + claudeInternal.length + amp.length + copilot.length + codebuddy.length + box.length + codex.length,
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
      let allSessions = getCachedSessions("claude");
      if (!allSessions) {
        allSessions = await listClaudeSessions();
        setCachedSessions("claude", allSessions);
      }
      const found = allSessions.find((s) => s.id === id);
      if (!found) return res.status(404).json({ error: "Session not found" });
      parsed = await parseClaudeSession(found);
    } else if (agent === "claude-internal") {
      let allSessions = getCachedSessions("claude-internal");
      if (!allSessions) {
        allSessions = await listClaudeInternalSessions();
        setCachedSessions("claude-internal", allSessions);
      }
      const found = allSessions.find((s) => s.id === id);
      if (!found) return res.status(404).json({ error: "Session not found" });
      parsed = await parseClaudeSession(found);
    } else if (agent === "amp") {
      let allSessions = getCachedSessions("amp");
      if (!allSessions) {
        allSessions = await listAmpSessions();
        setCachedSessions("amp", allSessions);
      }
      const found = allSessions.find((s) => s.id === id);
      if (!found) return res.status(404).json({ error: "Session not found" });
      parsed = await parseAmpSession(found);
    } else if (agent === "copilot") {
      let allSessions = getCachedSessions("copilot");
      if (!allSessions) {
        allSessions = await listCopilotSessions();
        setCachedSessions("copilot", allSessions);
      }
      const found = allSessions.find((s) => s.id === id);
      if (!found) return res.status(404).json({ error: "Session not found" });
      parsed = await parseCopilotSession(found);
    } else if (agent === "codebuddy") {
      let allSessions = getCachedSessions("codebuddy");
      if (!allSessions) {
        allSessions = await listCodebuddySessions();
        setCachedSessions("codebuddy", allSessions);
      }
      const found = allSessions.find((s) => s.id === id);
      if (!found) return res.status(404).json({ error: "Session not found" });
      parsed = await parseCodebuddySession(found);
    } else if (agent === "box") {
      let allSessions = getCachedSessions("box");
      if (!allSessions) {
        allSessions = await listBoxSessions();
        setCachedSessions("box", allSessions);
      }
      const found = allSessions.find((s) => s.id === id);
      if (!found) return res.status(404).json({ error: "Session not found" });
      parsed = await parseBoxSession(found);
    } else if (agent === "codex") {
      let allSessions = getCachedSessions("codex");
      if (!allSessions) {
        allSessions = await listCodexSessions();
        setCachedSessions("codex", allSessions);
      }
      const found = allSessions.find((s) => s.id === id);
      if (!found) return res.status(404).json({ error: "Session not found" });
      parsed = await parseCodexSession(found);
    } else {
      return res.status(400).json({ error: "Unknown agent" });
    }

    if (wantMarkdown) {
      // A query param of "0" means "hide that content type" in the export.
      const exportOptions = {
        showUser: req.query.showUser !== "0",
        showAssistant: req.query.showAssistant !== "0",
        showThinking: req.query.showThinking !== "0",
        showToolCalls: req.query.showToolCalls !== "0",
        showToolResults: req.query.showToolResults !== "0",
      };
      const md = sessionToMarkdown(parsed, exportOptions);
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
  console.log(`\n  \u{1F680} AI Session Viewer running at http://localhost:${PORT}\n`);
});
