import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Controller, publicAgent } from '../src/controller.mjs';
import { SafeError, RaftClient } from '../src/client.mjs';
import { createServer } from '../src/server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const id = '11111111-1111-4111-8111-111111111111';
async function fixture(name) {
  return JSON.parse(await readFile(new URL(`fixtures/${name}.edit.json`, import.meta.url)));
}
function backend(form) {
  const b = {
    form: structuredClone(form),
    requests: [],
    request: async (path, options = {}) => {
      b.requests.push({ path, ...options });
      if (path.endsWith('/runtime-form')) return structuredClone(b.form);
      if (options.method === 'PATCH') {
        b.form.values = structuredClone(options.body.formValues);
        return { id, envVars: { SECRET: 'never-return-this' } };
      }
      if (path.endsWith('/start') || path.endsWith('/stop'))
        return { ok: true, appliesOnReconnect: path.endsWith('/stop') };
      const agent = {
        id,
        name: 'Example',
        runtime: 'codex',
        model: b.form.values.model,
        status: 'active',
        envVars: { SECRET: 'never-return-this' },
        runtimeConfig: {
          envVars: { SECRET: 'never-return-this' },
          provider: { apiKey: 'credential' },
        },
      };
      return path === '/api/agents' ? [agent] : agent;
    },
  };
  return b;
}
for (const runtime of ['codex', 'claude', 'builtin'])
  test(`${runtime}: partial edits preserve env/provider fields; no implicit restart; secrets omitted`, async () => {
    const original = await fixture(runtime);
    original.values.envVars.KEEP = 'retained-secret';
    const b = backend(original);
    const c = new Controller(b);
    const plan = await c.planConfig({
      agentId: id,
      model: 'new-model',
      envSet: { FLAG: 'private-value' },
      envUnset: ['EXAMPLE_FLAG'],
    });
    assert.ok(!JSON.stringify(plan).includes('private-value'));
    assert.ok(!JSON.stringify(plan).includes('retained-secret'));
    assert.equal(b.requests.filter((x) => x.method === 'PATCH').length, 0);
    const receipt = await c.commitConfig(plan.planId);
    assert.equal(receipt.verification, 'matched');
    const patch = b.requests.find((x) => x.method === 'PATCH').body;
    assert.equal(patch.restartMode, undefined);
    assert.deepEqual(patch.formDefinitionRef, { protocolVersion: 2, runtimeId: runtime });
    assert.deepEqual(patch.formValues.envVars, { KEEP: 'retained-secret', FLAG: 'private-value' });
    for (const key of Object.keys(original.values).filter((k) => !['model', 'envVars'].includes(k)))
      assert.deepEqual(patch.formValues[key], original.values[key]);
    assert.ok(!JSON.stringify(receipt).includes('retained-secret'));
    await assert.rejects(c.commitConfig(plan.planId), /plan_missing_or_expired/);
  });
test('changed config and expired plans refuse without a write', async () => {
  const b = backend(await fixture('codex'));
  let now = 0;
  const c = new Controller(b, { now: () => now });
  const first = await c.planConfig({ agentId: id, envSet: { A: '1' } });
  b.form.values.envVars.NEW = 'another-writer';
  await assert.rejects(c.commitConfig(first.planId), /configuration_changed_replan/);
  const second = await c.planConfig({ agentId: id, model: 'new-model' });
  now = 300001;
  await assert.rejects(c.commitConfig(second.planId), /plan_missing_or_expired/);
  assert.equal(b.requests.filter((x) => x.method === 'PATCH').length, 0);
});
test('explicit session application is sent; readback mismatch is not declared verified', async () => {
  const b = backend(await fixture('codex'));
  const request = b.request;
  b.request = async (path, opts) => {
    const r = await request(path, opts);
    if (opts?.method === 'PATCH') b.form.values.model = 'other';
    return r;
  };
  const c = new Controller(b);
  const p = await c.planConfig({ agentId: id, model: 'new', applyMode: 'session' });
  const result = await c.commitConfig(p.planId);
  assert.equal(result.saved, true);
  assert.equal(result.verification, 'mismatch');
  assert.equal(b.requests.find((x) => x.method === 'PATCH').body.restartMode, 'session');
});
test('uncertain mutation failure consumes plan; no retries', async () => {
  const b = backend(await fixture('codex'));
  const request = b.request;
  let writes = 0;
  b.request = async (path, opts) => {
    if (opts?.method === 'PATCH') {
      writes++;
      throw new SafeError('outcome_unknown_do_not_retry');
    }
    return request(path, opts);
  };
  const c = new Controller(b);
  const p = await c.planConfig({ agentId: id, model: 'new' });
  const result = await c.commitConfig(p.planId);
  assert.equal(result.writeOutcome, 'unknown');
  assert.equal(result.saved, null);
  assert.equal(result.verification, 'mismatch');
  await assert.rejects(c.commitConfig(p.planId), /plan_missing/);
  assert.equal(writes, 1);
});
test('config persists but requested restart fails: observe matching settings, never claim applied', async () => {
  const form = await fixture('codex');
  const store = {
    load: async () => ({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 600000 }),
  };
  let writes = 0;
  const api = new RaftClient({
    origin: 'https://raft.example',
    serverId: id,
    store,
    fetchImpl: async (url, opts) => {
      if (opts.method === 'PATCH') {
        writes++;
        form.values = JSON.parse(opts.body).formValues;
        return new Response(
          JSON.stringify({
            code: 'internal_error',
            error: 'Restart failed after settings persisted',
          }),
          { status: 500 },
        );
      }
      return new Response(
        JSON.stringify(url.endsWith('/runtime-form') ? form : { id, runtime: 'codex' }),
      );
    },
  });
  const server = createServer(api);
  const client = new Client({ name: 'partial-failure', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const p = JSON.parse(
      (
        await client.callTool({
          name: 'plan_agent_config',
          arguments: { agentId: id, model: 'new', applyMode: 'restart' },
        })
      ).content[0].text,
    );
    const result = await client.callTool({
      name: 'commit_agent_config',
      arguments: { planId: p.planId },
    });
    const receipt = JSON.parse(result.content[0].text);
    assert.equal(result.isError, true);
    assert.equal(receipt.writeOutcome, 'unknown');
    assert.equal(receipt.saved, null);
    assert.equal(receipt.verification, 'matched');
    assert.equal(receipt.runtimeApplication, 'unknown');
    assert.equal(writes, 1);
    await client.callTool({ name: 'commit_agent_config', arguments: { planId: p.planId } });
    assert.equal(writes, 1);
  } finally {
    await client.close();
    await server.close();
  }
});
test('unsupported fields, invalid env and empty changes refuse', async () => {
  const b = backend(await fixture('builtin'));
  const c = new Controller(b);
  await assert.rejects(c.planConfig({ agentId: id, fastMode: true }), /unsupported_field_fastMode/);
  await assert.rejects(
    c.planConfig({ agentId: id, envSet: { 'BAD-KEY': '1' } }),
    /invalid_env_key/,
  );
  await assert.rejects(c.planConfig({ agentId: id, envSet: { A: '\0' } }), /invalid_env_value/);
  await assert.rejects(
    c.planConfig({ agentId: id, envSet: { A: '1' }, envUnset: ['A'] }),
    /conflicting_env/,
  );
  await assert.rejects(c.planConfig({ agentId: id }), /empty_change/);
});
test('saved connection fields and write-only secrets are never submitted', async () => {
  const f = await fixture('builtin');
  f.values.providerId = 'connection:example';
  f.values.apiKey = 'should-never-appear';
  f.dataSchema.properties.baseUrl['x-connectionOwned'] = true;
  const b = backend(f);
  const c = new Controller(b);
  const p = await c.planConfig({ agentId: id, model: 'new' });
  await c.commitConfig(p.planId);
  const values = b.requests.find((x) => x.method === 'PATCH').body.formValues;
  assert.equal(values.apiKey, undefined);
  assert.equal(values.baseUrl, undefined);
  assert.equal(values.providerId, 'connection:example');
});
test('start/stop return observed state and deferred-stop flag without leaking secrets', async () => {
  const b = backend(await fixture('codex'));
  const c = new Controller(b);
  for (const action of ['start', 'stop']) {
    const r = await c.lifecycle(id, action);
    assert.equal(r.accepted, true);
    assert.equal(r.observedState.id, id);
    assert.equal(r.appliesOnReconnect, action === 'stop');
    assert.ok(!JSON.stringify(r).includes('never-return-this'));
  }
  assert.equal(b.requests.filter((x) => x.method === 'POST').length, 2);
  assert.deepEqual(
    publicAgent({ id, runtimeConfig: { provider: { apiKey: 'x' }, envVars: { SECRET: 'x' } } }),
    { id, environmentKeys: ['SECRET'] },
  );
});
test('MCP client handshake, tool schemas and calls work; errors never reflect server secrets', async () => {
  const b = backend(await fixture('codex'));
  const server = createServer(b);
  const client = new Client({ name: 'fixture-client', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const tools = (await client.listTools()).tools;
    const policy =
      'Access policy: Only Cindy, Raft agent administrators, or human administrators may use this MCP.';
    assert.ok(client.getInstructions().startsWith(policy));
    assert.ok(client.getInstructions().includes('behavioral policy, not caller authentication'));
    for (const tool of tools) {
      assert.ok(tool.description.startsWith(policy));
      assert.ok(tool.description.includes('requests use the signed-in human'));
    }
    assert.equal(tools.length, 10);
    assert.equal(tools.find((t) => t.name === 'stop_agent').annotations.destructiveHint, true);
    const listed = await client.callTool({ name: 'list_agents', arguments: {} });
    assert.ok(!JSON.stringify(listed).includes('never-return-this'));
    const p = await client.callTool({
      name: 'plan_agent_config',
      arguments: { agentId: id, envSet: { X: 'secret-value' } },
    });
    assert.ok(!JSON.stringify(p).includes('secret-value'));
    const planId = JSON.parse(p.content[0].text).planId;
    const done = await client.callTool({ name: 'commit_agent_config', arguments: { planId } });
    assert.equal(JSON.parse(done.content[0].text).verification, 'matched');
    b.request = async () => {
      throw new Error('credential: raw-secret');
    };
    const failed = await client.callTool({ name: 'get_agent', arguments: { agentId: id } });
    assert.equal(failed.isError, true);
    assert.ok(!JSON.stringify(failed).includes('raw-secret'));
  } finally {
    await client.close();
    await server.close();
  }
});
test('device login → MCP config and lifecycle fixture path verifies real HTTP wire contracts', async () => {
  const form = await fixture('codex');
  const calls = [];
  let status = 'stopped';
  const store = {
    value: null,
    load: async function () {
      return this.value;
    },
    save: async function (s) {
      this.value = s;
    },
  };
  const api = new RaftClient({
    origin: 'https://raft.example',
    serverId: id,
    store,
    fetchImpl: async (url, opts) => {
      const path = new URL(url).pathname;
      calls.push({ path, opts });
      let result;
      if (path === '/api/auth/device/authorize')
        result = {
          deviceCode: 'fixture-private',
          userCode: 'PUBLIC',
          verificationUri: 'https://app.example/device',
          expiresIn: 100,
          interval: 5,
        };
      else if (path === '/api/auth/device/token')
        result = {
          accessToken: 'fixture-access',
          refreshToken: 'fixture-refresh',
          userId: 'fixture-human',
        };
      else if (path === '/api/servers') result = [{ id, name: 'Fixture' }];
      else if (path.endsWith('/runtime-form')) result = form;
      else if (opts.method === 'PATCH') {
        form.values = JSON.parse(opts.body).formValues;
        result = { id, runtime: 'codex', model: form.values.model };
      } else if (path.endsWith('/start') || path.endsWith('/stop')) {
        status = path.endsWith('/start') ? 'active' : 'stopped';
        result = { ok: true };
      } else {
        const a = { id, name: 'Fixture', runtime: 'codex', model: form.values.model, status };
        result = path === '/api/agents' ? [a] : a;
      }
      return new Response(JSON.stringify(result), { status: 200 });
    },
  });
  await api.pollLogin(await api.beginLogin());
  const server = createServer(api);
  const client = new Client({ name: 'wire-fixture', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name, args = {}) =>
    JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  try {
    assert.equal((await call('list_servers'))[0].id, id);
    assert.equal((await call('list_agents'))[0].id, id);
    const p = await call('plan_agent_config', {
      agentId: id,
      model: 'wire-model',
      envSet: { NEW: 'private-value' },
    });
    assert.equal((await call('commit_agent_config', { planId: p.planId })).verification, 'matched');
    assert.equal((await call('start_agent', { agentId: id })).observedState.status, 'active');
    assert.equal((await call('stop_agent', { agentId: id })).observedState.status, 'stopped');
    const patch = calls.find((c) => c.opts.method === 'PATCH');
    const body = JSON.parse(patch.opts.body);
    assert.equal(patch.path, `/api/agents/${id}`);
    assert.equal(patch.opts.headers['X-Server-Id'], id);
    assert.equal(patch.opts.headers.Authorization, 'Bearer fixture-access');
    assert.deepEqual(body.formValues.envVars, { EXAMPLE_FLAG: '1', NEW: 'private-value' });
    assert.equal(body.restartMode, undefined);
    assert.ok(calls.every((c) => !c.path.includes('oauth')));
  } finally {
    await client.close();
    await server.close();
  }
});
test('real stdio process supports discovery and returns login_required without network', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'raft-mcp-stdio-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'serve'],
    env: {
      PATH: process.env.PATH,
      RAFT_MCP_API_URL: 'http://127.0.0.1:1',
      RAFT_MCP_SERVER_ID: id,
      RAFT_MCP_SESSION_FILE: join(dir, 'missing.json'),
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-fixture', version: '1' });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 10);
    const r = await client.callTool({ name: 'get_agent', arguments: { agentId: id } });
    assert.equal(r.isError, true);
    assert.equal(JSON.parse(r.content[0].text).error, 'login_required');
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
