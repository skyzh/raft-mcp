import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { browserLogin } from '../src/browser-login.mjs';
import { RaftClient, SafeError } from '../src/client.mjs';

function fixture() {
  const calls = [];
  const sessions = [];
  let start;
  const client = {
    origin: 'https://raft.example',
    raw: async (path, options) => {
      calls.push({ path, ...options });
      if (path.endsWith('/start')) {
        start = options.body;
        return {
          authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=provider-state',
        };
      }
      assert.equal(options.body.code, 'one-time-code');
      assert.equal(
        createHash('sha256').update(options.body.codeVerifier).digest('base64url'),
        start.codeChallenge,
      );
      return {
        accessToken: 'private-access',
        refreshToken: 'private-refresh',
        user: { id: 'human' },
      };
    },
    acceptSession: async (s) => sessions.push(s),
  };
  return {
    client,
    calls,
    sessions,
    get start() {
      return start;
    },
  };
}
async function postCallback(f, data, origin) {
  const u = new URL(f.start.returnUri);
  return fetch(u.origin + '/auth/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin ?? u.origin },
    body: JSON.stringify({ state: u.hash.slice('#state='.length), code: 'one-time-code', ...data }),
  });
}

test('browser login binds loopback state, enforces PKCE, exchanges once and closes listener', async () => {
  const f = fixture();
  await browserLogin(f.client, {
    onReady: async (url) => {
      assert.equal(new URL(url).origin, 'https://accounts.google.com');
      assert.equal(f.start.mode, 'login');
      assert.equal(f.start.linkOnConflict, undefined);
      assert.equal(new URL(f.start.returnUri).hostname, '127.0.0.1');
      const page = await fetch(f.start.returnUri);
      assert.match(page.headers.get('content-security-policy'), /script-src 'sha256-/);
      assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
      assert.match(await page.text(), /history.replaceState/);
      assert.equal((await postCallback(f, {}, 'https://attacker.example')).status, 403);
      assert.equal((await postCallback(f, { state: 'wrong' })).status, 400);
      assert.equal((await postCallback(f, { code: '' })).status, 400);
      assert.equal((await postCallback(f, {})).status, 200);
      assert.equal((await postCallback(f, {})).status, 400);
    },
  });
  assert.deepEqual(
    f.calls.map((c) => c.path),
    ['/api/auth/mobile/oauth/start', '/api/auth/mobile/oauth/complete'],
  );
  assert.equal(f.sessions[0].userId, 'human');
  await assert.rejects(fetch(f.start.returnUri));
});

test('browser denial and timeout preserve existing credentials and close listener', async () => {
  for (const deny of [true, false]) {
    const f = fixture();
    await assert.rejects(
      browserLogin(f.client, {
        timeoutMs: 5,
        onReady: deny
          ? async () => {
              await postCallback(f, { error: 'secret-provider-error' });
            }
          : undefined,
      }),
      (e) => e.code === (deny ? 'browser_login_denied' : 'browser_login_timeout'),
    );
    assert.equal(f.calls.length, 1);
    assert.equal(f.sessions.length, 0);
    await assert.rejects(fetch(f.start.returnUri));
  }
});

test('untrusted authorization URL is rejected before browser navigation', async () => {
  const f = fixture();
  f.client.raw = async () => ({ authorizationUrl: 'https://attacker.example/steal' });
  await assert.rejects(browserLogin(f.client), (e) => e.code === 'unsafe_authorization_url');
  assert.equal(f.sessions.length, 0);
});

test('an existing client uses newly logged-in credentials on the next request', async () => {
  let session = { accessToken: 'device-token', expiresAt: Date.now() + 600000 };
  const seen = [];
  const client = new RaftClient({
    origin: 'https://raft.example',
    serverId: 'fixture',
    store: { load: async () => session },
    fetchImpl: async (url, options) => {
      seen.push(options.headers.Authorization);
      return new Response('{}');
    },
  });
  await client.request('/api/agents');
  session = { accessToken: 'human-token', expiresAt: Date.now() + 600000 };
  await client.request('/api/agents');
  assert.deepEqual(seen, ['Bearer device-token', 'Bearer human-token']);
});

test('password login uses only the official login endpoint and preserves cache after failed login', async () => {
  const sessions = [];
  const calls = [];
  let fail = true;
  const client = {
    origin: 'https://raft.example',
    raw: async (path, options) => {
      calls.push({ path, email: options.body.email });
      assert.equal(options.body.password, 'fixture-password');
      if (fail) throw new Error('private-response');
      return { accessToken: 'access', refreshToken: 'refresh', user: { id: 'human' } };
    },
    acceptSession: async (s) => sessions.push(s),
  };
  await browserLogin(client, {
    provider: 'password',
    onReady: async (url) => {
      const u = new URL(url);
      const page = await fetch(url);
      assert.match(await page.text(), /type="password"/);
      const post = (state, origin = u.origin) =>
        fetch(u.origin + '/auth/password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: origin },
          body: JSON.stringify({
            state,
            email: 'fixture@example.com',
            password: 'fixture-password',
          }),
        });
      assert.equal((await post('wrong')).status, 400);
      const state = u.hash.slice('#state='.length);
      assert.equal((await post(state, 'https://attacker.example')).status, 403);
      assert.equal((await post(state)).status, 401);
      assert.equal(sessions.length, 0);
      fail = false;
      assert.equal((await post(state)).status, 200);
    },
  });
  assert.deepEqual(
    calls.map((c) => c.path),
    ['/api/auth/login', '/api/auth/login'],
  );
  assert.equal(sessions[0].userId, 'human');
});

for (const [method, field, correctCode] of [
  ['totp', 'code', '321987'],
  ['backup_code', 'backupCode', 'synthetic-backup'],
]) {
  test(`password sign-in saves the session only after Raft verifies a ${method} answer`, async () => {
    const challenge = 'a'.repeat(43);
    const calls = [];
    const saved = [];
    const client = {
      origin: 'https://raft.example',
      raw: async (path, { body }) => {
        calls.push({ path, body });
        if (path === '/api/auth/login') {
          return {
            secondFactorRequired: true,
            challenge,
            expiresAt: new Date(Date.now() + 120000).toISOString(),
            methods: [method, 'passkey', 'recovery'],
            maskedEmail: 'f***@example.com',
          };
        }
        if (body[field] !== correctCode) throw new SafeError('second_factor_code_invalid', 400);
        return {
          accessToken: 'synthetic-access',
          refreshToken: 'synthetic-refresh',
          user: { id: 'human' },
        };
      },
      acceptSession: async (value) => saved.push(value),
    };
    await browserLogin(client, {
      provider: 'password',
      onReady: async (url) => {
        const { origin, hash, hostname } = new URL(url);
        assert.equal(hostname, '127.0.0.1');
        const state = new URLSearchParams(hash.slice(1)).get('state');
        const page = await fetch(url);
        assert.match(page.headers.get('content-security-policy'), /form-action 'none'/);
        assert.match(await page.text(), /Verify and sign in/);
        const post = (path, body, from = origin) =>
          fetch(origin + '/auth/' + path, {
            method: 'POST',
            headers: { Origin: from, 'Content-Type': 'application/json' },
            body: JSON.stringify({ state, ...body }),
          });
        assert.equal((await post('verify', { method, code: correctCode })).status, 400);
        const first = await post('password', {
          email: 'fixture@example.com',
          password: 'synthetic-password',
        });
        assert.equal(first.status, 202);
        assert.deepEqual(await first.json(), { methods: [method] });
        assert.equal(
          (await post('verify', { method, code: correctCode }, 'https://other.example')).status,
          403,
        );
        assert.equal(
          (await post('verify', { state: 'wrong', method, code: correctCode })).status,
          400,
        );
        assert.equal((await post('verify', { method: 'passkey', code: correctCode })).status, 400);
        assert.equal((await post('verify', { method, code: 'wrong-code' })).status, 401);
        assert.equal(saved.length, 0);
        const verified = await post('verify', { method, code: correctCode, challenge: 'ignored' });
        assert.equal(verified.status, 200);
        assert.equal(await verified.text(), '');
        assert.equal((await post('verify', { method, code: correctCode })).status, 400);
      },
    });
    assert.deepEqual(calls, [
      {
        path: '/api/auth/login',
        body: { email: 'fixture@example.com', password: 'synthetic-password' },
      },
      { path: '/api/auth/second-factor/verify', body: { challenge, [field]: 'wrong-code' } },
      { path: '/api/auth/second-factor/verify', body: { challenge, [field]: correctCode } },
    ]);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].userId, 'human');
  });
}
