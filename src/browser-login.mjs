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
<p>This temporary local page sends your sign-in details to https://api.raft.build. Your password and verification code are not saved.</p>
<form id="login" method="post"><p><label>Email <input name="email" type="email" autocomplete="username" required></label></p>
<p><label>Password <input name="password" type="password" autocomplete="current-password" required></label></p>
<button type="submit">Sign in</button></form>
<form id="second-step" method="post" hidden>
<p><label>Verification method <select name="method"></select></label></p>
<p><label>Code <input name="code" type="password" autocomplete="one-time-code" required></label></p>
<button type="submit">Verify and sign in</button></form>
<p id="status" role="status"></p><script>
const state = new URLSearchParams(location.hash.slice(1)).get('state');
history.replaceState(null, '', '/auth/done');
const login = document.getElementById('login');
const secondStep = document.getElementById('second-step');
const status = document.getElementById('status');
const labels = {totp: 'Authenticator app', backup_code: 'Backup code'};
async function submit(form, endpoint, fields, secretInput) {
 const button = form.querySelector('button');
 button.disabled = true;
 status.textContent = 'Signing in…';
 try {
  const response = await fetch(endpoint, {method: 'POST', headers: {'Content-Type': 'application/json'},
   body: JSON.stringify({state, ...fields})});
  if (response.status === 202) {
   const {methods} = await response.json();
   secondStep.elements.method.replaceChildren(...methods.map(method => new Option(labels[method], method)));
   login.hidden = true;
   secondStep.hidden = false;
   secondStep.elements.code.focus();
   status.textContent = 'Enter the verification code.';
  } else if (response.ok) {
   login.remove();
   secondStep.remove();
   status.textContent = 'Signed in. You can close this tab.';
  } else if (response.status === 410) {
   secondStep.hidden = true;
   login.hidden = false;
   status.textContent = 'This verification expired. Sign in again.';
  } else if (response.status === 422) {
   status.textContent = 'This page supports authenticator and backup codes. Use Raft’s own sign-in for other methods.';
  } else if (response.status === 429) {
   status.textContent = 'Raft has limited further attempts. Wait before trying again.';
  } else {
   status.textContent = form === login ? 'Sign-in failed. Check your account details and try again.' : 'Verification failed. Check the code and try again.';
  }
 } catch { status.textContent = 'Sign-in connection failed. Try again.'; }
 finally { secretInput.value = ''; button.disabled = false; }
}
login.addEventListener('submit', (event) => {
 event.preventDefault();
 submit(login, '/auth/password', {email: login.elements.email.value, password: login.elements.password.value}, login.elements.password);
});
secondStep.addEventListener('submit', (event) => {
 event.preventDefault();
 submit(secondStep, '/auth/verify', {method: secondStep.elements.method.value, code: secondStep.elements.code.value}, secondStep.elements.code);
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
  let pendingFactor = null;
  let closed = false;
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
          "'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      res.end(loginPage);
      return;
    }
    const verify = url.pathname === '/auth/verify';
    const acceptedPath =
      provider === 'password'
        ? url.pathname === '/auth/password' || verify
        : url.pathname === '/auth/callback';
    if (req.method !== 'POST' || !acceptedPath) {
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
        if (consumed || data?.state !== state) {
          res.writeHead(400).end();
          return;
        }
        if (pendingFactor && pendingFactor.expiresAt <= Date.now()) {
          pendingFactor = null;
          res.writeHead(410).end();
          return;
        }
        const code = typeof data.code === 'string' ? data.code.trim() : '';
        const validInput = verify
          ? pendingFactor?.methods.includes(data.method) && code
          : !pendingFactor &&
            typeof data.email === 'string' &&
            data.email &&
            typeof data.password === 'string' &&
            data.password;
        if (!validInput) {
          res.writeHead(400).end();
          return;
        }
        consumed = true;
        let signedIn = false;
        try {
          const session = await client.raw(
            verify ? '/api/auth/second-factor/verify' : '/api/auth/login',
            {
              method: 'POST',
              body: verify
                ? {
                    challenge: pendingFactor.challenge,
                    [data.method === 'totp' ? 'code' : 'backupCode']: code,
                  }
                : { email: data.email, password: data.password },
            },
          );
          if (closed) return;
          if (session?.secondFactorRequired === true) {
            if (verify) throw new SafeError('invalid_session_response');
            const methods = ['totp', 'backup_code'].filter(
              (method) => Array.isArray(session.methods) && session.methods.includes(method),
            );
            const expiresAt = Date.parse(session.expiresAt);
            if (
              !methods.length ||
              !/^[A-Za-z0-9_-]{43}$/.test(session.challenge ?? '') ||
              !Number.isFinite(expiresAt)
            ) {
              res.writeHead(422).end();
              return;
            }
            pendingFactor = { challenge: session.challenge, expiresAt, methods };
            res
              .writeHead(202, { 'Content-Type': 'application/json' })
              .end(JSON.stringify({ methods }));
            return;
          }
          pendingFactor = null;
          await client.acceptSession({ ...session, userId: session.userId ?? session.user?.id });
          signedIn = true;
          res.writeHead(200).end();
          resolveCallback({ authenticated: true });
        } catch (error) {
          if (verify && error instanceof SafeError && error.code === 'challenge_expired') {
            pendingFactor = null;
            res.writeHead(410).end();
          } else {
            res.writeHead(error instanceof SafeError && error.status === 429 ? 429 : 401).end();
          }
        } finally {
          data.password = '';
          data.code = '';
          if (!signedIn) consumed = false;
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
    closed = true;
    pendingFactor = null;
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
