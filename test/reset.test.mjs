import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/controller.mjs';
import { RaftClient } from '../src/client.mjs';
import { createServer } from '../src/server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const id = '11111111-1111-4111-8111-111111111111';
const machineId = '22222222-2222-4222-8222-222222222222';
function backend() {
  const b = { serverId: id, posts: [], agent: { id, name: 'Fixture', serverId: id, machineId, runtime: 'codex', model: 'fixture-model', status: 'starting' }, request: async (path, opts = {}) => {
    if (opts.method === 'POST') { b.posts.push({ path, body: opts.body }); return { ok: true, status: 'accepted' }; }
    return structuredClone(b.agent);
  } }; return b;
}
test('ordinary restart/session use explicit mode and return acceptance, never completion', async () => {
  const b = backend(); const c = new Controller(b);
  for (const mode of ['restart', 'session']) {
    const r = await c.reset(id, mode); assert.equal(r.accepted, true); assert.equal(r.completed, false); assert.equal(r.observedState.status, 'starting');
  }
  assert.deepEqual(b.posts, [{ path: `/api/agents/${id}/reset`, body: { mode: 'restart' } }, { path: `/api/agents/${id}/reset`, body: { mode: 'session' } }]);
  await assert.rejects(c.reset(id, undefined), /invalid_reset_mode/); await assert.rejects(c.reset(id, 'other'), /invalid_reset_mode/);
});
test('full reset only prepares; denied or expired confirmation sends no reset', async () => {
  const b = backend(); let now = 0; const c = new Controller(b, { now: () => now });
  for (const result of [{ action: 'decline' }, { action: 'cancel' }, { action: 'accept', content: { agentName: 'Fixture', deleteWorkspace: false } }]) {
    const p = await c.reset(id, 'full'); assert.equal(p.accepted, false); assert.equal(b.posts.length, 0);
    await assert.rejects(c.confirmFullReset(p.confirmationId, async () => result), /full_reset_not_confirmed/);
    await assert.rejects(c.confirmFullReset(p.confirmationId, async () => result), /confirmation_missing_or_expired/);
  }
  const p = await c.reset(id, 'full'); now = 300001;
  await assert.rejects(c.confirmFullReset(p.confirmationId, async () => ({ action: 'accept', content: { agentName: 'Fixture', deleteWorkspace: true } })), /confirmation_missing_or_expired/);
  assert.equal(b.posts.length, 0);
});
test('target/server drift and expiry while human decides refuse full reset', async () => {
  const b = backend(); let now = 0; const c = new Controller(b, { now: () => now });
  let p = await c.reset(id, 'full'); b.agent.machineId = '33333333-3333-4333-8333-333333333333';
  await assert.rejects(c.confirmFullReset(p.confirmationId, async () => ({ action: 'accept', content: { agentName: 'Fixture', deleteWorkspace: true } })), /reset_target_changed/);
  p = await c.reset(id, 'full');
  await assert.rejects(c.confirmFullReset(p.confirmationId, async () => { now = 300001; return { action: 'accept', content: { agentName: 'Fixture', deleteWorkspace: true } }; }), /confirmation_missing_or_expired/);
  now = 0; p = await c.reset(id, 'full'); b.serverId = '44444444-4444-4444-8444-444444444444';
  await assert.rejects(c.confirmFullReset(p.confirmationId, async () => ({ action: 'accept', content: { agentName: 'Fixture', deleteWorkspace: true } })), /confirmation_server_changed/);
  assert.equal(b.posts.length, 0);
});
test('external runtime or no machine cannot prepare full workspace reset', async () => {
  const b = backend(); const c = new Controller(b); b.agent.runtime = 'external';
  await assert.rejects(c.reset(id, 'full'), /external_runtime_unsupported/);
  b.agent.runtime = 'codex'; b.agent.machineId = null; await assert.rejects(c.reset(id, 'full'), /full_reset_machine_required/); assert.equal(b.posts.length, 0);
});
test('MCP full reset requires actual separate elicitation response; acceptance makes one request', async () => {
  const b = backend(); const server = createServer(b);
  const client = new Client({ name: 'human-ui-fixture', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  let prompts = 0;
  client.setRequestHandler(ElicitRequestSchema, async req => { prompts++; assert.equal(req.params.mode, 'form'); assert.ok(req.params.message.includes(id)); assert.equal(req.params.requestedSchema.properties.deleteWorkspace.default, false); return { action: 'accept', content: { agentName: 'Fixture', deleteWorkspace: true } }; });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const p = JSON.parse((await client.callTool({ name: 'reset_agent', arguments: { agentId: id, mode: 'full' } })).content[0].text); assert.equal(b.posts.length, 0);
    const r = await client.callTool({ name: 'confirm_full_reset', arguments: { confirmationId: p.confirmationId } }); const receipt = JSON.parse(r.content[0].text);
    assert.equal(receipt.accepted, true); assert.equal(receipt.completed, false); assert.equal(receipt.mode, 'full'); assert.equal(prompts, 1); assert.deepEqual(b.posts, [{ path: `/api/agents/${id}/reset`, body: { mode: 'full' } }]);
    await client.callTool({ name: 'confirm_full_reset', arguments: { confirmationId: p.confirmationId } }); assert.equal(b.posts.length, 1); assert.equal(prompts, 1);
  } finally { await client.close(); await server.close(); }
});
test('unsupported MCP clients cannot confirm full reset', async () => {
  const b = backend(); const server = createServer(b); const client = new Client({ name: 'no-ui', version: '1' }); const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const p = JSON.parse((await client.callTool({ name: 'reset_agent', arguments: { agentId: id, mode: 'full' } })).content[0].text);
    const r = await client.callTool({ name: 'confirm_full_reset', arguments: { confirmationId: p.confirmationId } }); assert.equal(r.isError, true); assert.equal(JSON.parse(r.content[0].text).error, 'human_confirmation_unsupported'); assert.equal(b.posts.length, 0);
  } finally { await client.close(); await server.close(); }
});
test('reset HTTP wire has server binding and truthful 202 accepted-but-still-starting state', async () => {
  const calls = [];
  const api = new RaftClient({ origin: 'https://raft.example', serverId: id, store: { load: async () => ({ accessToken: 'fixture', refreshToken: 'fixture', expiresAt: Date.now() + 600000 }) }, fetchImpl: async (url, opts) => {
    calls.push({ url, opts }); return new Response(JSON.stringify(opts.method === 'POST' ? { ok: true, status: 'accepted' } : { id, name: 'Fixture', runtime: 'codex', status: 'starting' }), { status: opts.method === 'POST' ? 202 : 200 });
  } });
  const r = await new Controller(api).reset(id, 'restart'); assert.equal(r.completed, false); assert.equal(r.observedState.status, 'starting');
  const post = calls.find(x => x.opts.method === 'POST'); assert.equal(post.url, `https://raft.example/api/agents/${id}/reset`); assert.equal(post.opts.headers['X-Server-Id'], id); assert.deepEqual(JSON.parse(post.opts.body), { mode: 'restart' });
});
test('accepted reset with unavailable readback remains accepted, not completed, and never repeats', async () => {
  const b = backend(); const request = b.request; let dispatched = false;
  b.request = async (path, opts) => {
    if (opts?.method === 'POST') { dispatched = true; return request(path, opts); }
    if (dispatched) throw new Error('Fixture state unavailable');
    return request(path, opts);
  };
  const r = await new Controller(b).reset(id, 'session'); assert.equal(r.accepted, true); assert.equal(r.completed, false); assert.equal(r.observedState, null); assert.equal(b.posts.length, 1);
});
