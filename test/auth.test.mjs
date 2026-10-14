import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, chmod, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, RaftClient, originUrl } from '../src/client.mjs';

const origin = 'https://raft.example'; const serverId = '11111111-1111-4111-8111-111111111111';
function memoryStore(session = null) { return { session, load: async function () { return this.session; }, save: async function (s) { this.session = s; }, clear: async function () { this.session = null; } }; }
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
test('device grant follows supported endpoints and stores tokens privately', async () => {
  const calls = []; const store = memoryStore(); const c = new RaftClient({ origin, serverId, store, now: () => 0, fetchImpl: async (url, opts) => {
    calls.push({ url, opts }); return url.endsWith('/authorize') ? response({ deviceCode: 'private-device', userCode: 'PUBLIC', verificationUri: 'https://app.example/login/device', expiresIn: 300, interval: 5 }, 201) : response({ accessToken: 'private-access', refreshToken: 'private-refresh', userId: 'human' });
  } });
  const grant = await c.beginLogin(); await c.pollLogin(grant);
  assert.equal(calls[0].url, origin + '/api/auth/device/authorize'); assert.equal(calls[1].url, origin + '/api/auth/device/token');
  assert.equal(JSON.parse(calls[1].opts.body).deviceCode, 'private-device'); assert.equal(store.session.refreshToken, 'private-refresh');
  assert.equal(calls[0].opts.redirect, 'error');
});
test('feature-gated device login fails without fallback; provider errors sanitized', async () => {
  let count = 0; const c = new RaftClient({ origin, serverId, store: memoryStore(), fetchImpl: async () => { count++; return response({ code: 'device_login_disabled', error: 'private-secret' }, 404); } });
  await assert.rejects(c.beginLogin(), e => e.code === 'device_login_disabled' && !e.message.includes('private-secret')); assert.equal(count, 1);
});
test('refresh single-flight rotates before concurrent reads and includes server header', async () => {
  const store = memoryStore({ accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 0 }); let refreshes = 0; const calls = [];
  const c = new RaftClient({ origin, serverId, store, now: () => 100, fetchImpl: async (url, opts) => {
    calls.push({ url, opts }); if (url.endsWith('/refresh')) { refreshes++; await new Promise(r => setTimeout(r, 5)); return response({ accessToken: 'new-access', refreshToken: 'new-refresh' }); } return response([]);
  } });
  await Promise.all([c.request('/api/agents'), c.request('/api/agents')]); assert.equal(refreshes, 1);
  assert.equal(store.session.refreshToken, 'new-refresh');
  for (const call of calls.filter(c => c.url.endsWith('/agents'))) { assert.equal(call.opts.headers.Authorization, 'Bearer new-access'); assert.equal(call.opts.headers['X-Server-Id'], serverId); }
});
test('mutation HTTP/network failures never retry or leak response text', async () => {
  const store = memoryStore({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 600000 }); let calls = 0;
  const c = new RaftClient({ origin, serverId, store, fetchImpl: async () => { calls++; return response({ error: 'secret-env-value' }, 401); } });
  await assert.rejects(c.request('/api/agents/example', { method: 'PATCH', body: {} }), e => e.status === 401 && e.code === 'authentication_required'); assert.equal(calls, 1);
  c.fetch = async () => { calls++; throw new Error('contains token'); };
  await assert.rejects(c.request('/api/agents/example', { method: 'PATCH', body: {} }), /outcome_unknown_do_not_retry/); assert.equal(calls, 2);
});
test('session file is private, origin-bound, symlink-safe and lock-protected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'raft-mcp-test-')); const file = join(dir, 'cache', 'session.json'); const s = new SessionStore(file, origin);
  try {
    await s.save({ accessToken: 'a', refreshToken: 'r', expiresAt: 100 }); assert.equal((await stat(file)).mode & 0o777, 0o600); assert.equal((await stat(join(dir, 'cache'))).mode & 0o777, 0o700);
    assert.equal((await s.load()).origin, origin); await assert.rejects(new SessionStore(file, 'https://other.example').load(), /session_origin_mismatch/);
    await s.withLock(async () => { await assert.rejects(s.withLock(async () => {}), /session_busy/); });
    await chmod(file, 0o644); await assert.rejects(s.load(), /unsafe_session_file/); await chmod(file, 0o600);
    const link = join(dir, 'cache', 'link.json'); await symlink(file, link); await assert.rejects(new SessionStore(link, origin).load(), /unsafe_session_file/);
    assert.ok((await readFile(file, 'utf8')).includes('refreshToken')); await s.clear(); assert.equal(await s.load(), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('credentials cannot be sent to insecure or path-bearing API origins', () => {
  for (const value of ['http://remote.example', 'https://user:password@raft.example', 'https://raft.example/api', 'https://raft.example/?token=x']) assert.throws(() => originUrl(value));
  assert.equal(originUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
});
test('pending, denied and expired device grants are truthful; no session stored', async () => {
  const store = memoryStore(); let now = 0;
  const c = new RaftClient({ origin, serverId, store, now: () => now, fetchImpl: async () => response({ code: 'authorization_pending' }, 400) });
  const grant = { deviceCode: 'd', deadline: 100 };
  await assert.rejects(c.pollLogin(grant), /authorization_pending/); assert.equal(store.session, null);
  c.fetch = async () => response({ code: 'access_denied' }, 403);
  await assert.rejects(c.pollLogin(grant), /access_denied/); assert.equal(store.session, null);
  now = 101; await assert.rejects(c.pollLogin(grant), /expired_token/);
});
test('logout revokes the session and removes cache without returning tokens', async () => {
  const store = memoryStore({ accessToken: 'a', refreshToken: 'private-r' }); let body;
  const c = new RaftClient({ origin, serverId, store, fetchImpl: async (url, opts) => { assert.equal(url, origin + '/api/auth/logout'); body = JSON.parse(opts.body); return response({ ok: true }); } });
  assert.equal(await c.logout(), undefined); assert.deepEqual(body, { refreshToken: 'private-r' }); assert.equal(store.session, null);
});
test('failed refresh blocks future replay across client restart', async () => {
  const store = memoryStore({ accessToken: 'a', refreshToken: 'r', expiresAt: 0 }); let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('private'); };
  const c = new RaftClient({ origin, serverId, store, fetchImpl });
  await assert.rejects(c.access(), /outcome_unknown/);
  await assert.rejects(new RaftClient({ origin, serverId, store, fetchImpl }).access(), /refresh_failed_login_required/); assert.equal(calls, 1);
});
test('normal backend field validation survives without raw values', async () => {
  const c = new RaftClient({ origin, serverId, store: memoryStore({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 600000 }), fetchImpl: async () => response({ error: 'private value', issues: [{ code: 'invalid_reasoning_effort', pointer: '/formValues/reasoningEffort' }] }, 400) });
  await assert.rejects(c.request('/api/agents/example', { method: 'PATCH', body: {} }), e => { assert.deepEqual(e.issues, [{ code: 'invalid_reasoning_effort', pointer: '/formValues/reasoningEffort' }]); return !e.message.includes('private value'); });
});
