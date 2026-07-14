// Video Agent Studio — unified frontend for OpenMontage + Claude Agent SDK
// Project management + per-project chat (SSE) + asset review.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const http = require('http');
const { query } = require('@anthropic-ai/claude-agent-sdk');

const ROOT = __dirname;
const OM_REPO = process.env.OM_REPO || path.join(ROOT, 'OpenMontage');
const OM_PROJECTS = path.join(OM_REPO, 'projects');
const REGISTRY = path.join(ROOT, 'studio-projects.json');
const PORT = process.env.PORT || 4747;
const BACKLOT_PORT = process.env.BACKLOT_PORT || 4750;

// ---------- agent provider (claude = Claude Agent SDK · codex = OpenAI Codex CLI) ----------
const AGENT_PROVIDER = (process.env.AGENT_PROVIDER || 'claude').toLowerCase();
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const CODEX_MODEL = process.env.CODEX_MODEL || ''; // empty = respect ~/.codex/config.toml

// ---------- Backlot (OpenMontage's built-in production board) ----------
let backlotProc = null;
function backlotAlive() {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: BACKLOT_PORT, path: '/api/health', timeout: 1200 }, res => { res.resume(); resolve(res.statusCode < 500); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
async function ensureBacklot() {
  // use localhost (same-site as the studio origin) so the embedded iframe isn't storage-partitioned
  if (await backlotAlive()) return { running: true, url: `http://localhost:${BACKLOT_PORT}` };
  if (!backlotProc) {
    const py = path.join(OM_REPO, '.venv', 'bin', 'python');
    const bin = fs.existsSync(py) ? py : 'python3';
    backlotProc = spawn(bin, ['-m', 'backlot', 'serve', '--port', String(BACKLOT_PORT)], { cwd: OM_REPO, stdio: 'ignore', detached: false });
    backlotProc.on('exit', () => { backlotProc = null; });
  }
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await backlotAlive()) return { running: true, url: `http://localhost:${BACKLOT_PORT}` };
  }
  return { running: false, url: `http://localhost:${BACKLOT_PORT}` };
}

const MEDIA_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov', '.mp3', '.wav', '.m4a']);

// ---------- registry ----------
function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); } catch { return { projects: [] }; }
}
function saveRegistry(r) { fs.writeFileSync(REGISTRY, JSON.stringify(r, null, 2)); }
function slugify(name) {
  const s = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return s || 'project-' + crypto.randomUUID().slice(0, 6);
}

// ---------- per-project agent session state ----------
const sessions = new Map(); // id -> {events:[], clients:Set(res), busy:bool, abort:AbortController|null}
function st(id) {
  if (!sessions.has(id)) sessions.set(id, { events: [], clients: new Set(), busy: false, abort: null });
  return sessions.get(id);
}
function emit(id, ev) {
  const s = st(id);
  ev.i = s.events.length; ev.ts = Date.now();
  s.events.push(ev);
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of s.clients) { try { res.write(line); } catch {} }
}
// transient broadcast (streaming deltas): not stored in the replay buffer, no index
function emitTransient(id, ev) {
  const s = st(id);
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of s.clients) { try { res.write(line); } catch {} }
}

// ---------- Codex CLI shell provider ----------
const readline = require('readline');

function runAgentCodex(projectId, userText) {
  const s = st(projectId);
  if (s.busy) return Promise.reject(new Error('agent busy'));
  s.busy = true;
  const reg = loadRegistry();
  const proj = reg.projects.find(p => p.id === projectId);
  if (!proj) { s.busy = false; return Promise.reject(new Error('project not found')); }

  emit(projectId, { type: 'user', text: userText });
  emit(projectId, { type: 'status', text: 'running' });

  let prompt = userText;
  if (!proj.codexThreadId) {
    prompt = `[Project context] This conversation belongs to the studio project "${proj.name}" (slug: ${proj.slug}). When you create the OpenMontage project/working directory for this production, name the folder "${proj.slug}". Follow the OpenMontage agent contract (AGENTS.md) and pause at approval gates by asking me in chat.\n\nUser request: ${userText}`;
  }

  const args = ['exec'];
  if (proj.codexThreadId) args.push('resume', proj.codexThreadId);
  args.push('--json', '--skip-git-repo-check', '-C', OM_REPO, '--dangerously-bypass-approvals-and-sandbox');
  if (CODEX_MODEL) args.push('-m', CODEX_MODEL);
  args.push(prompt);

  return new Promise(resolve => {
    let child;
    try {
      child = spawn(CODEX_BIN, args, { cwd: OM_REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      emit(projectId, { type: 'error', text: `codex CLI not available: ${e.message}` });
      s.busy = false; emit(projectId, { type: 'status', text: 'idle' });
      return resolve();
    }
    const abort = new AbortController();
    s.abort = abort;
    abort.signal.addEventListener('abort', () => { try { child.kill('SIGTERM'); } catch {} }, { once: true });

    let inTok = 0, outTok = 0, failed = null, stderrBuf = '';
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', line => {
      let ev; try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'thread.started' && ev.thread_id) {
        if (proj.codexThreadId !== ev.thread_id) {
          const r2 = loadRegistry();
          const p2 = r2.projects.find(p => p.id === projectId);
          if (p2) { p2.codexThreadId = ev.thread_id; saveRegistry(r2); }
          proj.codexThreadId = ev.thread_id;
        }
      } else if (ev.type === 'item.completed' && ev.item) {
        const it = ev.item;
        if (it.type === 'agent_message' && it.text) emit(projectId, { type: 'assistant', text: it.text });
        else if (it.type === 'command_execution') emit(projectId, { type: 'tool', text: `bash ${String(it.command || '').slice(0, 220)}` });
        else if (it.type === 'file_change') emit(projectId, { type: 'tool', text: `edit ${(it.changes || []).map(c => c.path).join(', ').slice(0, 220)}` });
        else if (it.type === 'mcp_tool_call') emit(projectId, { type: 'tool', text: `${it.server || 'mcp'}.${it.tool || ''}` });
        else if (it.type === 'error' && it.message) emit(projectId, { type: 'tool', text: `[codex] ${String(it.message).slice(0, 300)}` });
      } else if (ev.type === 'turn.completed' && ev.usage) {
        inTok += ev.usage.input_tokens || 0; outTok += ev.usage.output_tokens || 0;
      } else if (ev.type === 'turn.failed') {
        failed = (ev.error && ev.error.message) || 'turn failed';
      } else if (ev.type === 'error' && ev.message) {
        failed = failed || ev.message;
      }
    });
    child.stderr.on('data', d => { stderrBuf += d; if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000); });
    child.on('close', code => {
      if (abort.signal.aborted) emit(projectId, { type: 'result', text: 'interrupted' });
      else if (failed) emit(projectId, { type: 'error', text: String(failed).slice(0, 600) });
      else if (code !== 0) emit(projectId, { type: 'error', text: `codex exited ${code}: ${stderrBuf.slice(-400) || 'no stderr'}` });
      else emit(projectId, { type: 'result', text: 'done', turns: 1, tokens: { in: inTok, out: outTok } });
      s.busy = false; s.abort = null;
      emit(projectId, { type: 'status', text: 'idle' });
      resolve();
    });
    child.on('error', e => {
      emit(projectId, { type: 'error', text: `codex spawn failed: ${e.message}` });
      s.busy = false; s.abort = null;
      emit(projectId, { type: 'status', text: 'idle' });
      resolve();
    });
  });
}

// ---------- agent runner (Claude Agent SDK) ----------
async function runAgentClaude(projectId, userText) {
  const s = st(projectId);
  if (s.busy) throw new Error('agent busy');
  s.busy = true;
  const reg = loadRegistry();
  const proj = reg.projects.find(p => p.id === projectId);
  if (!proj) { s.busy = false; throw new Error('project not found'); }

  emit(projectId, { type: 'user', text: userText });
  emit(projectId, { type: 'status', text: 'running' });

  const abort = new AbortController();
  s.abort = abort;

  // First message of a project carries working-folder guidance so assets are discoverable.
  let prompt = userText;
  if (!proj.sessionId) {
    prompt = `[Project context] This conversation belongs to the studio project "${proj.name}" (slug: ${proj.slug}). When you create the OpenMontage project/working directory for this production, name the folder "${proj.slug}" so its assets can be tracked. Follow OpenMontage pipelines and pause at approval gates by asking me in chat.\n\nUser request: ${userText}`;
  }

  try {
    const q = query({
      prompt,
      options: {
        cwd: OM_REPO,
        resume: proj.sessionId || undefined,
        permissionMode: 'bypassPermissions',
        abortController: abort,
        // Behave exactly like Claude Code opened in the OpenMontage repo:
        // full Claude Code system prompt + all setting sources (loads the
        // repo's CLAUDE.md / AGENT_GUIDE so OpenMontage's agent contract applies).
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        includePartialMessages: true, // token-level streaming to the chat UI
      },
    });
    for await (const msg of q) {
      if (msg.type === 'stream_event') {
        const e = msg.event;
        if (e && e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta' && e.delta.text) {
          emitTransient(projectId, { type: 'delta', text: e.delta.text });
        }
      } else if (msg.type === 'system' && msg.subtype === 'init') {
        if (msg.session_id && msg.session_id !== proj.sessionId) {
          proj.sessionId = msg.session_id;
          const r2 = loadRegistry();
          const p2 = r2.projects.find(p => p.id === projectId);
          if (p2) { p2.sessionId = msg.session_id; saveRegistry(r2); }
        }
      } else if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            emit(projectId, { type: 'assistant', text: block.text });
          } else if (block.type === 'tool_use') {
            const inp = JSON.stringify(block.input || {});
            emit(projectId, { type: 'tool', text: `${block.name} ${inp.length > 220 ? inp.slice(0, 220) + '…' : inp}` });
          }
        }
      } else if (msg.type === 'result') {
        emit(projectId, {
          type: 'result',
          text: msg.subtype === 'success' ? 'done' : `ended: ${msg.subtype}`,
          cost: msg.total_cost_usd, turns: msg.num_turns,
        });
      }
    }
  } catch (e) {
    emit(projectId, { type: 'error', text: String(e.message || e) });
  } finally {
    s.busy = false; s.abort = null;
    emit(projectId, { type: 'status', text: 'idle' });
  }
}

// ---------- asset scanning ----------
function findProjectDirs(slug) {
  if (!fs.existsSync(OM_PROJECTS)) return [];
  const dirs = fs.readdirSync(OM_PROJECTS, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  const norm = x => x.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const target = norm(slug);
  const matched = dirs.filter(d => norm(d).includes(target) || target.includes(norm(d)));
  return matched.length ? matched : [];
}
function walkMedia(dirAbs, relBase, out, depth) {
  if (depth > 6 || out.length > 500) return;
  let entries = [];
  try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const abs = path.join(dirAbs, e.name);
    const rel = path.posix.join(relBase, e.name);
    if (e.isDirectory()) walkMedia(abs, rel, out, depth + 1);
    else {
      const ext = path.extname(e.name).toLowerCase();
      if (MEDIA_EXT.has(ext)) {
        let stat; try { stat = fs.statSync(abs); } catch { continue; }
        out.push({ rel, name: e.name, ext, size: stat.size, mtime: stat.mtimeMs, kind: ['.mp4', '.webm', '.mov'].includes(ext) ? 'video' : ['.mp3', '.wav', '.m4a'].includes(ext) ? 'audio' : 'image' });
      } else if (ext === '.json' && /checkpoint|approval|gate|decision/i.test(e.name)) {
        let stat; try { stat = fs.statSync(abs); } catch { continue; }
        if (stat.size < 200000) out.push({ rel, name: e.name, ext, size: stat.size, mtime: stat.mtimeMs, kind: 'checkpoint' });
      }
    }
  }
}

// ---------- app ----------
const app = express();
app.use(express.json());
// CORS: allow the Backlot origin (:4750) to call the studio API from the injected chat widget
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (/^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(ROOT, 'public')));

// single entrance is the Backlot library — 4747 root just redirects there (after ensuring Backlot is up)
app.get('/', async (req, res) => {
  await ensureBacklot();
  res.redirect(`http://localhost:${BACKLOT_PORT}/`);
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, omRepo: OM_REPO, omExists: fs.existsSync(OM_REPO), omProjectsDir: fs.existsSync(OM_PROJECTS), provider: AGENT_PROVIDER, model: AGENT_PROVIDER === 'codex' ? (CODEX_MODEL || 'codex-config-default') : 'claude-code-default' });
});

app.get('/api/projects', (req, res) => {
  const reg = loadRegistry();
  const out = reg.projects.map(p => {
    const dirs = findProjectDirs(p.slug);
    let assetCount = 0, lastActivity = p.createdAt;
    for (const d of dirs) {
      const media = [];
      walkMedia(path.join(OM_PROJECTS, d), d, media, 0);
      assetCount += media.length;
      for (const m of media) if (m.mtime > lastActivity) lastActivity = m.mtime;
    }
    const s = sessions.get(p.id);
    return { ...p, dirs, assetCount, lastActivity, busy: !!(s && s.busy), messages: s ? s.events.filter(e => e.type === 'user' || e.type === 'assistant').length : 0 };
  });
  res.json({ projects: out.sort((a, b) => b.lastActivity - a.lastActivity) });
});

app.post('/api/projects', (req, res) => {
  const { name, brief } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  const reg = loadRegistry();
  const id = crypto.randomUUID().slice(0, 8);
  const proj = { id, name: name.trim(), brief: (brief || '').trim(), slug: slugify(name), createdAt: Date.now(), sessionId: null };
  reg.projects.push(proj); saveRegistry(reg);
  res.json({ project: proj });
});

app.delete('/api/projects/:id', (req, res) => {
  const reg = loadRegistry();
  reg.projects = reg.projects.filter(p => p.id !== req.params.id);
  saveRegistry(reg); sessions.delete(req.params.id);
  res.json({ ok: true });
});

app.get('/api/projects/:id', (req, res) => {
  const reg = loadRegistry();
  const p = reg.projects.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json({ project: p });
});

app.get('/api/projects/:id/assets', (req, res) => {
  const reg = loadRegistry();
  const p = reg.projects.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const dirs = findProjectDirs(p.slug);
  const media = [];
  for (const d of dirs) walkMedia(path.join(OM_PROJECTS, d), d, media, 0);
  media.sort((a, b) => b.mtime - a.mtime);
  res.json({ dirs, assets: media });
});

// serve asset files (path-traversal safe)
app.get(/^\/om-assets\/(.+)/, (req, res) => {
  const rel = decodeURIComponent(req.params[0] || '');
  const abs = path.normalize(path.join(OM_PROJECTS, rel));
  if (!abs.startsWith(OM_PROJECTS)) return res.status(403).end();
  if (!fs.existsSync(abs)) return res.status(404).end();
  res.sendFile(abs);
});

// SSE stream of chat events
app.get('/api/projects/:id/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const s = st(req.params.id);
  const from = parseInt(req.query.from || '0', 10);
  for (const ev of s.events.slice(from)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  s.clients.add(res);
  const ping = setInterval(() => { try { res.write(':ping\n\n'); } catch {} }, 15000);
  req.on('close', () => { clearInterval(ping); s.clients.delete(res); });
});

app.post('/api/projects/:id/message', (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
  const s = st(req.params.id);
  if (s.busy) return res.status(409).json({ error: 'agent is busy — wait or interrupt' });
  const run = AGENT_PROVIDER === 'codex' ? runAgentCodex : runAgentClaude;
  run(req.params.id, text.trim()).catch(() => {});
  res.json({ ok: true });
});

app.get('/api/backlot', async (req, res) => {
  res.json(await ensureBacklot());
});

// pre-create the OpenMontage project skeleton (canonical init_project, idempotent)
// so Backlot renders a proper empty board instead of "PROJECT NOT FOUND"
function ensureOmProject(proj) {
  return new Promise(resolve => {
    try {
      if (fs.existsSync(path.join(OM_PROJECTS, proj.slug))) return resolve(true);
      const py = path.join(OM_REPO, '.venv', 'bin', 'python');
      const bin = fs.existsSync(py) ? py : 'python3';
      const code = `from lib.checkpoint import init_project; init_project(${JSON.stringify(proj.slug)}, title=${JSON.stringify(proj.name)}, pipeline_type="cinematic")`;
      require('child_process').execFile(bin, ['-c', code], { cwd: OM_REPO, timeout: 15000 }, err => resolve(!err));
    } catch { resolve(false); }
  });
}

// find-or-create a studio project bound to an OpenMontage folder (used by the Backlot chat widget)
app.get('/api/bind', async (req, res) => {
  const om = (req.query.slug || '').toString().trim();
  if (!om) return res.status(400).json({ error: 'slug required' });
  const norm = x => x.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const reg = loadRegistry();
  // exact normalized match only — fuzzy `includes` matching once bound
  // "test-new-project" to an existing project named "test"
  let proj = reg.projects.find(p => norm(p.slug) === norm(om));
  if (!proj) {
    proj = { id: crypto.randomUUID().slice(0, 8), name: om, brief: '', slug: slugify(om), createdAt: Date.now(), sessionId: null };
    reg.projects.push(proj); saveRegistry(reg);
  }
  await ensureOmProject(proj);
  const s = sessions.get(proj.id);
  res.json({ project: proj, busy: !!(s && s.busy), events: s ? s.events.length : 0, provider: AGENT_PROVIDER, model: AGENT_PROVIDER === 'codex' ? (CODEX_MODEL || 'codex') : 'claude' });
});

app.post('/api/projects/:id/interrupt', (req, res) => {
  const s = st(req.params.id);
  if (s.abort) s.abort.abort();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Video Agent Studio → http://localhost:${PORT}`);
  console.log(`OpenMontage repo: ${OM_REPO} (exists: ${fs.existsSync(OM_REPO)})`);
});
