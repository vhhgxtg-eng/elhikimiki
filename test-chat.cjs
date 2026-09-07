const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createChatServer } = require('./server');

async function setup(t, opts = {}) {
  const server = createChatServer(opts);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  async function call(route, token, data, extra = {}) {
    const r = await fetch(base + '/api/' + route, { method: data === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...extra },
      body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: r.status, ...await r.json() };
  }
  async function session() { return (await call('session', null, { adult: true, rules: true })).token; }
  async function pair() { const a = await session(), b = await session(); await call('queue', a, {}); const state = await call('queue', b, {}); return { a, b, room: state.room }; }
  return { base, call, session, pair };
}

test('adult gate, origin and private state require consent and authorization', async t => {
  const { call } = await setup(t);
  assert.equal((await call('session', null, { adult: false, rules: true })).status, 400);
  assert.equal((await call('state')).status, 401);
  assert.equal((await call('session', null, { adult: true, rules: true }, { Origin: 'https://evil.test' })).status, 403);
});
test('two people pair; third person cannot read messages; duplicates are not sent twice', async t => {
  const { call, pair, session } = await setup(t);
  const { a, b, room } = await pair(); const stranger = await session();
  const message = { room, id: 'one', text: 'أهلًا <img src=x onerror=alert(1)>' };
  assert.equal((await call('message', a, message)).status, 200);
  await call('message', a, message);
  const peerState = await call('state', b);
  assert.equal(peerState.messages.length, 1); assert.equal(peerState.messages[0].mine, false);
  assert.equal(peerState.messages[0].text, message.text);
  assert.equal((await call('state', stranger)).messages.length, 0);
  assert.equal((await call('message', stranger, message)).status, 409);
});
test('leave cancels queue and terminates both ends; old room message is rejected', async t => {
  const { call, pair } = await setup(t); const { a, b, room } = await pair();
  await call('leave', a, {});
  assert.equal((await call('state', b)).state, 'idle');
  assert.equal((await call('message', a, { room, id: 'late', text: 'late' })).status, 409);
  await call('queue', a, {}); await call('leave', a, {});
  assert.equal((await call('queue', b, {})).state, 'waiting');
});
test('block prevents this pair matching again within these sessions', async t => {
  const { call, pair, session } = await setup(t); const { a, b, room } = await pair();
  await call('block', a, { room });
  assert.equal((await call('queue', a, {})).state, 'waiting');
  assert.equal((await call('queue', b, {})).state, 'waiting');
  const c = await session(); assert.equal((await call('queue', c, {})).state, 'matched');
});
test('expired peers leave the room and reconnect requires a new session', async t => {
  let time = 0; const { call, pair } = await setup(t, { ttl: 100, now: () => time }); const { a, b } = await pair();
  time = 80; await call('state', a); time = 120;
  assert.equal((await call('state', a)).state, 'idle'); assert.equal((await call('state', b)).status, 401);
});
test('new room ignores a stale message cursor; text length and rate limits enforced', async t => {
  const { call, pair } = await setup(t); const { a, b, room } = await pair();
  assert.equal((await call('message', a, { room, id: 'big', text: 'x'.repeat(1001) })).status, 400);
  await call('message', a, { room, id: 'first', text: 'hello' });
  assert.equal((await call('state?after=999&room=old-room', b)).messages.length, 1);
  for (let i = 0; i < 11; i++) await call('message', a, { room, id: `m${i}`, text: 'hello' });
  assert.equal((await call('message', a, { room, id: 'too-fast', text: 'hello' })).status, 429);
});
test('reports persist evidence before acknowledgement; disabled collection never claims success', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elhikimiki-reports-'));
  t.after(() => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); return fs.rm(dir, { recursive: true, force: true }); });
  const reportsFile = path.join(dir, 'reports.ndjson');
  const { call, pair, base } = await setup(t, { reportsFile }); const { a, b, room } = await pair();
  await call('message', b, { room, id: 'm', text: 'evidence' });
  assert.equal((await call('report', a, { room, reason: 'harassment' })).status, 200);
  const report = JSON.parse((await fs.readFile(reportsFile, 'utf8')).trim());
  assert.equal(report.messages[0].text, 'evidence');
  assert.equal((await fetch(base + '/server.js')).status, 404);
  assert.equal((await fetch(base + '/data/reports.ndjson')).status, 404);
  const noReports = await setup(t); const p = await noReports.pair();
  assert.equal((await noReports.call('report', p.a, { room: p.room, reason: 'other' })).status, 503);
});
