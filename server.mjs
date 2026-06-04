#!/usr/bin/env node
// Claude Code 俯瞰ダッシュボード — 依存ゼロのローカルサーバ
// 起動: node server.mjs   →  http://localhost:4317

import http from 'node:http';
import { promises as fs } from 'node:fs';
import { readFileSync, statSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = process.env.PORT ? Number(process.env.PORT) : 4317;
const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// アクティブ判定のしきい値
const ACTIVE_MS = 90 * 1000;          // 90秒以内の更新 = 稼働中
const IDLE_MS = 30 * 60 * 1000;       // 30分以内 = 待機中
const PARSE_WINDOW_MS = 36 * 60 * 60 * 1000; // 36h 以内のセッションのみ詳細解析

// ---- ファイル末尾だけ読む（大きい jsonl 対策） ----
function readTail(file, maxBytes = 256 * 1024) {
  const fd = openSync(file, 'r');
  try {
    const { size } = fstatSync(fd);
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return { text: buf.toString('utf8'), truncated: start > 0, size };
  } finally {
    closeSync(fd);
  }
}

function readHead(file, maxBytes = 64 * 1024) {
  const fd = openSync(file, 'r');
  try {
    const { size } = fstatSync(fd);
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, 0);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function parseLines(text) {
  const lines = text.split('\n');
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { out.push(JSON.parse(t)); } catch { /* 途中で切れた行は無視 */ }
  }
  return out;
}

// メッセージの content からテキスト要約を作る
function summarizeContent(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return null;
  const parts = [];
  for (const block of c) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && block.text) parts.push(block.text);
    else if (block.type === 'tool_use') parts.push(`🔧 ${block.name || 'tool'}`);
    else if (block.type === 'thinking') parts.push('💭 (thinking)');
    else if (block.type === 'tool_result') parts.push('↩︎ (tool result)');
  }
  return parts.join(' ').trim() || null;
}

function decodeProjectDir(name) {
  // "-Users-masa-work-plo-game" → "/Users/masa/work/plo-game" (推定表示用)
  return name.replace(/^-/, '/').replace(/-/g, '/');
}

// ---- 稼働中の claude プロセスを取得 ----
function getProcesses() {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid,ppid,%cpu,%mem,lstart,command'], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      const procs = [];
      for (const line of stdout.split('\n')) {
        // native-binary/claude を含み、かつ Claude.app(デスクトップ)やhelperは除外
        if (!/native-binary\/claude\b/.test(line)) continue;
        if (!/--output-format/.test(line)) continue;
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.{24})\s+(.*)$/);
        if (!m) continue;
        const [, pid, ppid, cpu, mem, lstart, command] = m;
        const resumeMatch = command.match(/--resume\s+([0-9a-f-]{36})/);
        const verMatch = command.match(/claude-code-([\d.]+)-/);
        procs.push({
          pid: Number(pid),
          ppid: Number(ppid),
          cpu: Number(cpu),
          mem: Number(mem),
          started: lstart.trim(),
          resumeSessionId: resumeMatch ? resumeMatch[1] : null,
          version: verMatch ? verMatch[1] : null,
        });
      }
      resolve(procs);
    });
  });
}

// ---- セッション(jsonl)を解析 ----
function analyzeSession(projectName, file) {
  const full = path.join(PROJECTS_DIR, projectName, file);
  let st;
  try { st = statSync(full); } catch { return null; }
  const sessionId = file.replace(/\.jsonl$/, '');
  const age = Date.now() - st.mtimeMs;

  const base = {
    sessionId,
    project: projectName,
    projectPath: decodeProjectDir(projectName),
    mtime: st.mtimeMs,
    sizeBytes: st.size,
    title: null,
    lastPrompt: null,
    cwd: null,
    gitBranch: null,
    model: null,
    lastRole: null,
    lastText: null,
    lastTimestamp: null,
    messageCount: null,
    detailed: false,
  };

  // 古いセッションは詳細解析せず軽量表示
  if (age > PARSE_WINDOW_MS) return base;

  try {
    const { text } = readTail(full);
    const entries = parseLines(text);
    // 先頭側からも少し読んでタイトル/プロンプトの取りこぼしを防ぐ
    const headEntries = st.size > 256 * 1024 ? parseLines(readHead(full)) : [];

    let title = null, lastPrompt = null, cwd = null, branch = null, model = null;
    let lastMsgEntry = null, lastTs = null;
    let msgCount = 0;

    for (const e of [...headEntries, ...entries]) {
      if (e.type === 'ai-title' && e.aiTitle) title = e.aiTitle;
      if (e.type === 'last-prompt' && e.lastPrompt) lastPrompt = e.lastPrompt;
      if (e.cwd) cwd = e.cwd;
      if (e.gitBranch) branch = e.gitBranch;
      const m = e.message;
      if (m && typeof m === 'object') {
        if (m.model) model = m.model;
        if ((e.type === 'assistant' || e.type === 'user') && (m.role === 'assistant' || m.role === 'user')) {
          msgCount++;
          lastMsgEntry = e;
        }
      }
      if (e.timestamp) lastTs = e.timestamp;
    }

    base.title = title;
    base.lastPrompt = lastPrompt;
    base.cwd = cwd;
    base.gitBranch = branch;
    base.model = model;
    base.lastTimestamp = lastTs;
    base.messageCount = msgCount;
    base.detailed = true;
    if (lastMsgEntry) {
      base.lastRole = lastMsgEntry.message.role;
      const summary = summarizeContent(lastMsgEntry.message);
      base.lastText = summary ? summary.slice(0, 280) : null;
    }
  } catch { /* 解析失敗時は base のまま */ }

  return base;
}

// ---- 1セッションの会話タイムラインを取得 ----
function buildSessionDetail(projectName, sessionId) {
  const full = path.join(PROJECTS_DIR, projectName, sessionId + '.jsonl');
  let st;
  try { st = statSync(full); } catch { return null; }

  // 詳細表示は全文読む（大きすぎる場合は末尾2MBに制限）
  const MAX = 2 * 1024 * 1024;
  let text;
  if (st.size > MAX) {
    const fd = openSync(full, 'r');
    try {
      const buf = Buffer.alloc(MAX);
      readSync(fd, buf, 0, MAX, st.size - MAX);
      text = buf.toString('utf8');
    } finally { closeSync(fd); }
  } else {
    text = readFileSync(full, 'utf8');
  }
  const entries = parseLines(text);

  let title = null, cwd = null, branch = null, model = null;
  const timeline = [];
  for (const e of entries) {
    if (e.type === 'ai-title' && e.aiTitle) title = e.aiTitle;
    if (e.cwd) cwd = e.cwd;
    if (e.gitBranch) branch = e.gitBranch;
    const m = e.message;
    if (!m || typeof m !== 'object') continue;
    if (m.model) model = m.model;
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    if (m.role !== 'user' && m.role !== 'assistant') continue;

    const blocks = [];
    const c = m.content;
    if (typeof c === 'string') {
      if (c.trim()) blocks.push({ kind: 'text', text: c });
    } else if (Array.isArray(c)) {
      for (const b of c) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && b.text) blocks.push({ kind: 'text', text: b.text });
        else if (b.type === 'thinking') blocks.push({ kind: 'thinking', text: b.thinking || '' });
        else if (b.type === 'tool_use') {
          let arg = '';
          try { arg = JSON.stringify(b.input); } catch {}
          blocks.push({ kind: 'tool_use', name: b.name || 'tool', input: (arg || '').slice(0, 1200) });
        } else if (b.type === 'tool_result') {
          let r = b.content;
          if (Array.isArray(r)) r = r.map((x) => (x && x.text) ? x.text : (typeof x === 'string' ? x : '')).join('\n');
          if (typeof r !== 'string') { try { r = JSON.stringify(r); } catch { r = ''; } }
          blocks.push({ kind: 'tool_result', text: (r || '').slice(0, 1500), isError: !!b.is_error });
        }
      }
    }
    if (!blocks.length) continue;
    timeline.push({ role: m.role, timestamp: e.timestamp || null, blocks });
  }

  return {
    sessionId, project: projectName, projectPath: decodeProjectDir(projectName),
    title, cwd, gitBranch: branch, model, mtime: st.mtimeMs, sizeBytes: st.size,
    truncated: st.size > MAX, count: timeline.length, timeline,
  };
}

// ---- セッションの cwd を推定（送信時の作業ディレクトリ用） ----
function getSessionCwd(projectName, sessionId) {
  const full = path.join(PROJECTS_DIR, projectName, sessionId + '.jsonl');
  try {
    const { text } = readTail(full);
    // 末尾→先頭の順で最後に現れた cwd を採用（途中で切れた行は parseLines が無視）
    const entries = parseLines(text);
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].cwd) return entries[i].cwd;
    }
    const head = parseLines(readHead(full));
    for (let i = head.length - 1; i >= 0; i--) {
      if (head[i].cwd) return head[i].cwd;
    }
  } catch { /* fallthrough */ }
  return null;
}

// ---- 詳細画面からセッションへ指示を送る（claude --resume -p をヘッドレス起動） ----
function sendToSession(projectName, sessionId, text) {
  const full = path.join(PROJECTS_DIR, projectName, sessionId + '.jsonl');
  let st;
  try { st = statSync(full); } catch { return { error: 'セッションが見つかりません', code: 404 }; }

  // 稼働中(active)への送信は対話TUIとの書き込み競合を招くため拒否
  if (Date.now() - st.mtimeMs <= ACTIVE_MS) {
    return { error: '稼働中のセッションには送信できません（対話プロセスと競合します）', code: 409 };
  }

  const cwd = getSessionCwd(projectName, sessionId) || decodeProjectDir(projectName);
  // ヘッドレスで1ターン実行。同じ session jsonl に追記され、ポーリングで反映される。
  const child = spawn('claude', ['--resume', sessionId, '-p', text], {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.on('error', (e) => { console.error('claude 起動失敗:', e.message); });
  child.unref();
  return { ok: true, cwd };
}

function readBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('リクエストが大きすぎます')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function buildSnapshot() {
  let projectDirs = [];
  try {
    projectDirs = await fs.readdir(PROJECTS_DIR);
  } catch {
    return { error: `projects ディレクトリが読めません: ${PROJECTS_DIR}`, sessions: [], processes: [] };
  }

  const procs = await getProcesses();
  const resumeIds = new Set(procs.map((p) => p.resumeSessionId).filter(Boolean));
  const sessions = [];

  for (const proj of projectDirs) {
    const dir = path.join(PROJECTS_DIR, proj);
    let files;
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) continue;
      files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    } catch { continue; }

    for (const f of files) {
      const s = analyzeSession(proj, f);
      if (!s) continue;
      const age = Date.now() - s.mtime;
      let status = 'dormant';
      if (age <= ACTIVE_MS) status = 'active';
      else if (age <= IDLE_MS) status = 'idle';
      s.status = status;
      s.ageMs = age;
      s.resumed = resumeIds.has(s.sessionId);
      sessions.push(s);
    }
  }

  // 新しい順
  sessions.sort((a, b) => b.mtime - a.mtime);

  const counts = {
    active: sessions.filter((s) => s.status === 'active').length,
    idle: sessions.filter((s) => s.status === 'idle').length,
    dormant: sessions.filter((s) => s.status === 'dormant').length,
    processes: procs.length,
    total: sessions.length,
  };

  return { now: Date.now(), counts, processes: procs, sessions };
}

// ---- HTTP ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/api/sessions') {
    try {
      const snap = await buildSnapshot();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(snap));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  if (url.pathname === '/api/session') {
    const project = url.searchParams.get('project');
    const id = url.searchParams.get('id');
    if (!project || !id || /[\/\\]/.test(project) || /[\/\\.]/.test(id)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'project と id が必要です' }));
      return;
    }
    try {
      const detail = buildSessionDetail(project, id);
      if (!detail) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'セッションが見つかりません' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(detail));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  if (url.pathname === '/api/send' && req.method === 'POST') {
    const project = url.searchParams.get('project');
    const id = url.searchParams.get('id');
    if (!project || !id || /[\/\\]/.test(project) || /[\/\\.]/.test(id)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'project と id が必要です' }));
      return;
    }
    try {
      const body = await readBody(req);
      let text = '';
      try { text = (JSON.parse(body).text || '').toString(); } catch {}
      text = text.trim();
      if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'text が空です' }));
        return;
      }
      const result = sendToSession(project, id, text);
      if (result.error) {
        res.writeHead(result.code || 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: result.error }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  // 静的ファイル
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(__dirname, 'public', path.normalize(filePath).replace(/^(\.\.[/\\])+/, ''));
  try {
    const data = readFileSync(filePath);
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`\n  🛰  Claude Code ダッシュボード起動`);
  console.log(`     → http://localhost:${PORT}\n`);
});
