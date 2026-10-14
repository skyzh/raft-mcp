import { readFile, writeFile, mkdir, rename, lstat, unlink, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class SafeError extends Error {
  constructor(code, status = null, issues = []) { super(code); this.code = code; this.status = status; this.issues = issues; }
}
export function originUrl(value) {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new SafeError('api_origin_required');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) throw new SafeError('https_required');
  return u.origin;
}
const safeCode = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value) ? value : 'request_failed';
export class SessionStore {
  constructor(file, origin) { this.file = file; this.origin = origin; }
  async load() {
    try {
      const st = await lstat(this.file);
      if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077)) throw new SafeError('unsafe_session_file');
      const s = JSON.parse(await readFile(this.file, 'utf8'));
      if (s.origin !== this.origin || !s.accessToken || !s.refreshToken) throw new SafeError('session_origin_mismatch');
      return s;
    } catch (e) { if (e.code === 'ENOENT') return null; if (e instanceof SafeError) throw e; throw new SafeError('session_read_failed'); }
  }
  async save(session) {
    const dir = dirname(this.file);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const ds = await lstat(dir);
    if (!ds.isDirectory() || ds.isSymbolicLink() || (ds.mode & 0o077)) throw new SafeError('unsafe_session_directory');
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ ...session, origin: this.origin }), { mode: 0o600, flag: 'wx' });
      await rename(temp, this.file);
    } finally { await unlink(temp).catch(() => {}); }
  }
  async clear() { await unlink(this.file).catch(e => { if (e.code !== 'ENOENT') throw new SafeError('session_remove_failed'); }); }
  async withLock(fn) {
    const lock = `${this.file}.lock`;
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (e) { if (e.code === 'EEXIST') throw new SafeError('session_busy'); throw new SafeError('session_lock_failed'); }
    try { return await fn(); } finally { await rmdir(lock); }
  }
}

export class RaftClient {
  constructor({ origin, serverId, store, fetchImpl = fetch, now = Date.now }) {
    this.origin = originUrl(origin); this.serverId = serverId; this.store = store; this.fetch = fetchImpl; this.now = now;
    this.session = null; this.refreshing = null;
  }
  async raw(path, { method = 'GET', body, token, server = false } = {}) {
    let res;
    try {
      res = await this.fetch(`${this.origin}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(server ? { 'X-Server-Id': this.serverId } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new SafeError(method === 'GET' ? 'network_error' : 'outcome_unknown_do_not_retry'); }
    let data;
    try { data = await res.json(); } catch { throw new SafeError(method === 'GET' ? 'invalid_response' : 'outcome_unknown_do_not_retry', res.status); }
    if (!res.ok) {
      const issues = Array.isArray(data?.issues) ? data.issues.slice(0, 20).filter(i => typeof i?.pointer === 'string' && /^\/(?:runtimeConfig|formValues|formDefinitionRef)(?:\/[A-Za-z0-9_]+)*$/.test(i.pointer)).map(i => ({ code: safeCode(i.code), pointer: i.pointer })) : [];
      const fallback = res.status === 403 ? 'permission_denied' : res.status === 401 ? 'authentication_required' : 'request_failed';
      throw new SafeError(method !== 'GET' && res.status >= 500 ? 'outcome_unknown_do_not_retry' : data?.code ? safeCode(data.code) : fallback, res.status, issues); // Never reflect provider messages, bodies or env values.
    }
    return data;
  }
  async access() {
    if (!this.session) this.session = await this.store.load();
    if (!this.session) throw new SafeError('login_required');
    if (this.session.refreshBlocked) throw new SafeError('refresh_failed_login_required');
    if (this.session.expiresAt > this.now() + 60000) return this.session.accessToken;
    if (!this.refreshing) this.refreshing = this.refresh().finally(() => { this.refreshing = null; });
    await this.refreshing;
    return this.session.accessToken;
  }
  async refresh() {
    const operation = async () => {
      const latest = await this.store.load();
      if (!latest) throw new SafeError('login_required');
      if (latest.refreshBlocked) throw new SafeError('refresh_failed_login_required');
      if (latest.expiresAt > this.now() + 60000) { this.session = latest; return; }
      let data;
      try { data = await this.raw('/api/auth/refresh', { method: 'POST', body: { refreshToken: latest.refreshToken } }); }
      catch (e) { this.session = { ...latest, refreshBlocked: true }; await this.store.save(this.session); throw e; }
      await this.acceptSession({ ...latest, ...data });
    };
    if (this.store.withLock) await this.store.withLock(operation); else await operation();
  }
  async acceptSession(data) {
    if (typeof data.accessToken !== 'string' || typeof data.refreshToken !== 'string') throw new SafeError('invalid_session_response');
    const session = { accessToken: data.accessToken, refreshToken: data.refreshToken, userId: data.userId, expiresAt: this.now() + 14 * 60000 };
    await this.store.save(session); this.session = session;
  }
  async request(path, options = {}) { return this.raw(path, { ...options, token: await this.access(), server: options.server ?? true }); }
  async beginLogin() {
    const g = await this.raw('/api/auth/device/authorize', { method: 'POST', body: { clientName: 'Raft Agent Control MCP (local)' } });
    if (typeof g.deviceCode !== 'string' || typeof g.userCode !== 'string' || typeof g.verificationUri !== 'string' || !Number.isFinite(g.expiresIn) || g.expiresIn <= 0 || !Number.isFinite(g.interval) || g.interval <= 0) throw new SafeError('invalid_device_response');
    const u = new URL(g.verificationUriComplete ?? g.verificationUri);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) throw new SafeError('unsafe_verification_uri');
    if (u.username || u.password) throw new SafeError('unsafe_verification_uri');
    if (u.href.includes(g.deviceCode)) throw new SafeError('unsafe_verification_uri');
    return { ...g, url: u.href, deadline: this.now() + g.expiresIn * 1000 };
  }
  async pollLogin(grant) {
    if (this.now() >= grant.deadline) throw new SafeError('expired_token');
    const data = await this.raw('/api/auth/device/token', { method: 'POST', body: { deviceCode: grant.deviceCode } });
    await this.acceptSession(data);
  }
  async logout() {
    this.session ??= await this.store.load();
    if (this.session) await this.raw('/api/auth/logout', { method: 'POST', body: { refreshToken: this.session.refreshToken } });
    await this.store.clear(); this.session = null;
  }
}
