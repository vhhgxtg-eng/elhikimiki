const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');

function createChatServer(options = {}) {
  const sessions = new Map();
  const waiting = new Set();
  const rooms = new Map();
  const root = options.root || __dirname;
  const ttl = options.ttl || 90000;
  const now = options.now || Date.now;
  const maxSessions = options.maxSessions || 1000;
  const reportsFile = options.reportsFile || process.env.REPORTS_FILE;
  const configuredOrigin = options.origin || process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL;
  let reportWrite = Promise.resolve();
  function detach(s, reason) {
    waiting.delete(s.token);
    const room = rooms.get(s.room);
    s.room = null;
    if (!room) return;
    rooms.delete(room.id);
    const other = sessions.get(room.members.find(t => t !== s.token));
    if (other) { other.room = null; other.notice = reason; }
    if (other) { s.lastPeer = other.id; other.lastPeer = s.id; }
  }
  function sweep() {
    for (const s of sessions.values()) {
      if (now() - s.seen > ttl) { detach(s, 'disconnected'); sessions.delete(s.token); }
    }
  }
  const timer = setInterval(sweep, 5000);
  timer.unref();
  function state(s, cursor = 0) {
    const room = rooms.get(s.room);
    return {
      state: room ? 'matched' : waiting.has(s.token) ? 'waiting' : 'idle',
      room: room?.id || null,
      notice: s.notice || null,
      messages: room ? room.messages.filter(m => m.seq > cursor).map(m => ({
        id: m.id, seq: m.seq, text: m.text, mine: m.sender === s.id
      })) : [],
      reporting: Boolean(reportsFile)
    };
  }
  async function body(req) {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 8192) throw Object.assign(new Error('too_large'), { status: 413 });
    }
    try { return JSON.parse(raw || '{}'); }
    catch { throw Object.assign(new Error('bad_json'), { status: 400 }); }
  }
  function fail(code, status = 400) { throw Object.assign(new Error(code), { status }); }
  const server = http.createServer(async (req, res) => {
    const reply = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'same-origin');
      if (url.pathname.startsWith('/api/')) {
        const origin = req.headers.origin;
        const ownOrigin = configuredOrigin || `http://${req.headers.host}`;
        if (origin && origin !== ownOrigin) fail('origin_not_allowed', 403);
        if (req.method !== 'GET' && req.method !== 'POST') fail('method_not_allowed', 405);
        sweep();
        if (url.pathname === '/api/session' && req.method === 'POST') {
          const data = await body(req);
          if (data.adult !== true || data.rules !== true) fail('consent_required');
          if (sessions.size >= maxSessions) fail('busy', 503);
          const token = randomBytes(32).toString('hex');
          sessions.set(token, { token, id: randomUUID(), seen: now(), room: null, blocked: new Set(), recent: [], actions: [], notice: null });
          return reply(201, { token });
        }
        const token = (req.headers.authorization || '').replace(/^Bearer /, '');
        const s = sessions.get(token);
        if (!s) fail('session_expired', 401);
        s.seen = now();
        if (url.pathname === '/api/state' && req.method === 'GET') {
          const cursor = Number(url.searchParams.get('after'));
          return reply(200, state(s, url.searchParams.get('room') === s.room && Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0));
        }
        if (req.method !== 'POST') fail('not_found', 404);
        const data = await body(req);
        if (url.pathname === '/api/queue') {
          s.actions = s.actions.filter(t => now() - t < 10000);
          if (s.actions.length >= 8) fail('slow_down', 429);
          s.actions.push(now());
          if (s.room || waiting.has(s.token)) return reply(200, state(s));
          s.notice = null;
          for (const candidate of waiting) {
            const peer = sessions.get(candidate);
            if (!peer || peer.token === token || s.lastPeer === peer.id || peer.lastPeer === s.id || s.blocked.has(peer.id) || peer.blocked.has(s.id)) continue;
            const id = randomUUID();
            waiting.delete(candidate);
            rooms.set(id, { id, members: [token, candidate], messages: [], seq: 0, dedup: new Map() });
            s.room = peer.room = id;
            peer.notice = null;
            return reply(200, state(s));
          }
          waiting.add(token);
          return reply(200, state(s));
        }
        if (url.pathname === '/api/leave') {
          detach(s, 'left'); s.notice = null;
          return reply(200, state(s));
        }
        const room = rooms.get(s.room);
        if (!room || data.room !== room.id) fail('conversation_ended', 409);
        if (url.pathname === '/api/message') {
          if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 1000) fail('invalid_message');
          if (typeof data.id !== 'string' || !/^[\w-]{1,80}$/.test(data.id)) fail('invalid_message_id');
          const dedupKey = `${s.id}:${data.id}`;
          if (room.dedup.has(dedupKey)) return reply(200, { ok: true });
          s.recent = s.recent.filter(t => now() - t < 10000);
          if (s.recent.length >= 12) fail('slow_down', 429);
          s.recent.push(now());
          room.messages.push({ id: randomUUID(), seq: ++room.seq, sender: s.id, text: data.text.trim() });
          room.dedup.set(dedupKey, true);
          if (room.messages.length > 200) room.messages.shift();
          if (room.dedup.size > 400) room.dedup.delete(room.dedup.keys().next().value);
          return reply(200, { ok: true });
        }
        if (url.pathname === '/api/block' || url.pathname === '/api/report') {
          const peer = sessions.get(room.members.find(t => t !== token));
          if (url.pathname === '/api/report') {
            if (!reportsFile) fail('reporting_unavailable', 503);
            if (!['harassment', 'underage', 'sexual', 'other'].includes(data.reason)) fail('invalid_reason');
            const report = { id: randomUUID(), at: new Date(now()).toISOString(), reporter: s.id, reported: peer?.id,
              reason: data.reason, messages: room.messages.slice(-30) };
            reportWrite = reportWrite.catch(() => {}).then(async () => {
              await fs.mkdir(path.dirname(reportsFile), { recursive: true });
              await fs.appendFile(reportsFile, JSON.stringify(report) + '\n', { mode: 0o600 });
            });
            await reportWrite;
          }
          if (peer) { s.blocked.add(peer.id); peer.blocked.add(s.id); }
          detach(s, 'left'); s.notice = 'blocked';
          return reply(200, { ok: true });
        }
        fail('not_found', 404);
      }
      if (!['GET', 'HEAD'].includes(req.method)) fail('method_not_allowed', 405);
      if (url.pathname === '/healthz') return reply(200, { ok: true });
      const name = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const files = new Set(['/index.html', '/style.css', '/favicon.png', '/angry-cat-eyes.png', '/chat.html', '/chat.css', '/chat.js']);
      if (!files.has(name) && !/^\/images\/[a-zA-Z0-9_.-]+\.(png|jpg|webp)$/.test(name)) fail('not_found', 404);
      const file = path.join(root, name);
      const bytes = await fs.readFile(file);
      const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(file)];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': /\.(html|js|css)$/.test(file) ? 'no-cache' : 'public, max-age=3600' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      reply(error.status || (error.code === 'ENOENT' ? 404 : 500), { error: error.status ? error.message : 'server_error' });
    }
  });
  server.on('close', () => clearInterval(timer));
  return server;
}

if (require.main === module) {
  createChatServer().listen(Number(process.env.PORT) || 3001, '0.0.0.0', () => console.log('Elhikimiki chat is ready.'));
}
module.exports = { createChatServer };
