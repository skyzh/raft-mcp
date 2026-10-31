import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { SafeError } from './client.mjs';

const page = `<!doctype html><meta charset="utf-8"><title>Raft MCP login</title>
<p id="status">Completing Raft MCP login…</p><script>
const params = new URLSearchParams(location.search);
const state = new URLSearchParams(location.hash.slice(1)).get('state');
history.replaceState(null, '', '/auth/done');
fetch('/auth/callback', {method: 'POST', headers: {'Content-Type': 'application/json'},
body: JSON.stringify({code: params.get('code'), error: params.get('error'), state})})
.then(r => {document.getElementById('status').textContent = r.ok
? 'Callback received. Check the terminal for login completion; you can close this tab.'
: 'Login callback rejected. Check the terminal.';})
.catch(() => {document.getElementById('status').textContent = 'Login callback failed. Check the terminal.';});
</script>`;

const passwordPage = `<!doctype html><meta charset="utf-8"><title>Raft MCP sign in</title>
<h1>Sign in to Raft MCP</h1>
<p>Your email and password are sent to https://api.raft.build for sign-in. Your password is not saved.</p>
<form id="login"><p><label>Email <input name="email" type="email" autocomplete="username" required></label></p>
<p><label>Password <input name="password" type="password" autocomplete="current-password" required></label></p>
<button type="submit">Sign in</button></form><p id="status"></p><script>
const state = new URLSearchParams(location.hash.slice(1)).get('state');
history.replaceState(null, '', '/auth/done');
document.getElementById('login').addEventListener('submit', async (event) => {
 event.preventDefault(); const form = event.target; const button = form.querySelector('button');
 button.disabled = true; document.getElementById('status').textContent = 'Signing in…';
 try {
  const response = await fetch('/auth/password', {method: 'POST', headers: {'Content-Type': 'application/json'},
   body: JSON.stringify({state, email: form.elements.email.value, password: form.elements.password.value})});
  form.elements.password.value = '';
  document.getElementById('status').textContent = response.ok ? 'Signed in. You can close this tab.' : 'Sign-in failed. Check your account details and try again.';
  if (response.ok) form.remove();
 } catch { document.getElementById('status').textContent = 'Sign-in connection failed. Try again.'; }
 finally { form.elements.password && (form.elements.password.value = ''); button.disabled = false; }
});
</script>`;

export async function browserLogin(
  client,
  { provider = 'google', onReady, timeoutMs = 300000 } = {},
) {
  if (!['google', 'github', 'apple', 'password'].includes(provider))
    throw new SafeError('invalid_login_provider');
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const loginPage =
    provider === 'password'
      ? passwordPage.replace(
          'https://api.raft.build',
          client.origin.replace(
            /[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
          ),
        )
      : page;
  let resolveCallback;
  const callback = new Promise((resolve) => {
    resolveCallback = resolve;
  });
  let consumed = false;
  let localOrigin;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers.host !== new URL(localOrigin).host) {
      res.writeHead(400).end();
      return;
    }
    const url = new URL(req.url, localOrigin);
    if (req.method === 'GET' && url.pathname === '/auth/done') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'sha256-" +
          createHash('sha256')
            .update(loginPage.split('<script>')[1].split('</script>')[0])
            .digest('base64') +
          "'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      );
      res.end(loginPage);
      return;
    }
    if (
      req.method !== 'POST' ||
      url.pathname !== (provider === 'password' ? '/auth/password' : '/auth/callback')
    ) {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.origin !== localOrigin || req.headers['content-type'] !== 'application/json') {
      res.writeHead(403).end();
      return;
    }
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 4096) {
          res.writeHead(413).end();
          return;
        }
      }
      const data = JSON.parse(body);
      if (provider === 'password') {
        if (
          consumed ||
          data.state !== state ||
          typeof data.email !== 'string' ||
          typeof data.password !== 'string' ||
          !data.email ||
          !data.password
        ) {
          res.writeHead(400).end();
          return;
        }
        consumed = true;
        try {
          const session = await client.raw('/api/auth/login', {
            method: 'POST',
            body: { email: data.email, password: data.password },
          });
          data.password = '';
          await client.acceptSession({ ...session, userId: session.userId ?? session.user?.id });
          res.writeHead(200).end();
          resolveCallback({ authenticated: true });
        } catch {
          data.password = '';
          consumed = false;
          res.writeHead(401).end();
        }
        return;
      }
      if (
        consumed ||
        data.state !== state ||
        (!data.error && (typeof data.code !== 'string' || !data.code || data.code.length > 2048))
      ) {
        res.writeHead(400).end();
        return;
      }
      consumed = true;
      res.writeHead(200).end();
      resolveCallback(data.error ? { error: 'browser_login_denied' } : { code: data.code });
    } catch {
      res.writeHead(400).end();
    }
  });
  let timer;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    localOrigin = `http://127.0.0.1:${server.address().port}`;
    const returnUri = `${localOrigin}/auth/done#state=${state}`;
    if (provider === 'password') {
      await onReady?.(returnUri);
      const result = await Promise.race([
        callback,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ error: 'browser_login_timeout' }), timeoutMs);
        }),
      ]);
      if (result.error) throw new SafeError(result.error);
      return;
    }
    const started = await client.raw('/api/auth/mobile/oauth/start', {
      method: 'POST',
      body: { provider, mode: 'login', returnUri, codeChallenge: challenge },
    });
    let authorizationUrl;
    try {
      authorizationUrl = new URL(started.authorizationUrl);
    } catch {
      throw new SafeError('invalid_login_response');
    }
    if (
      authorizationUrl.origin !==
        {
          google: 'https://accounts.google.com',
          github: 'https://github.com',
          apple: 'https://appleid.apple.com',
        }[provider] ||
      authorizationUrl.username ||
      authorizationUrl.password ||
      authorizationUrl.pathname !==
        { google: '/o/oauth2/v2/auth', github: '/login/oauth/authorize', apple: '/auth/authorize' }[
          provider
        ]
    )
      throw new SafeError('unsafe_authorization_url');
    await onReady?.(authorizationUrl.href);
    const result = await Promise.race([
      callback,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ error: 'browser_login_timeout' }), timeoutMs);
      }),
    ]);
    if (result.error) throw new SafeError(result.error);
    const session = await client.raw('/api/auth/mobile/oauth/complete', {
      method: 'POST',
      body: { code: result.code, codeVerifier: verifier },
    });
    await client.acceptSession({ ...session, userId: session.userId ?? session.user?.id });
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
