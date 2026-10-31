const fs = require('node:fs');
const path = require('node:path');

const ORIGIN = 'https://dealers.virtualyard.com.au';
const REFERER = `${ORIGIN}/HARMONY-NEW-ENERGY-AUTO-SERVICE-(WSP)-PTY-LTD/`;
const sessionError = (message, code = 'VY_SESSION_EXPIRED') => Object.assign(new Error(message), { statusCode: 503, code });

// One server-side session shared with the local scraper. Never return cookies to the CRM.
class VirtualyardSession {
  constructor({ fetchImpl = global.fetch, file = process.env.VIRTUALYARD_SESSION_FILE || path.resolve(__dirname, '../../.runtime/virtualyard-session.json'), cookie = process.env.VIRTUALYARD_COOKIE || '' } = {}) {
    this.fetchImpl = fetchImpl;
    this.file = file;
    this.cookie = cookie;
    this.lastCheckedAt = null;
    this.connected = false;
    this.timer = null;
  }

  readCookie() {
    try {
      const stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (typeof stored.cookie !== 'string') throw new Error('Invalid session file');
      this.cookie = stored.cookie;
    }
    catch (error) { if (error.code !== 'ENOENT') throw sessionError('Cannot read the Virtual Yard session file.', 'VY_SESSION_STORAGE'); }
    return this.cookie;
  }

  persist(cookie) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ cookie }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.cookie = cookie;
  }

  rotate(headers) {
    const setCookies = headers.getSetCookie?.() || (headers.get('set-cookie') || '').split(/,(?=\s*[^;,=]+=[^;,]*)/).filter(Boolean);
    if (!setCookies.length) return;
    const jar = new Map(this.cookie.split(';').map(item => item.trim()).filter(Boolean).map(item => {
      const i = item.indexOf('='); return [item.slice(0, i), item.slice(i + 1)];
    }));
    for (const item of setCookies) {
      const [pair] = item.split(';');
      const i = pair.indexOf('=');
      if (i < 1) continue;
      const name = pair.slice(0, i).trim();
      const expires = item.match(/expires=([^;]+)/i);
      const expired = /max-age=0(?:;|$)/i.test(item) || (expires && Date.parse(expires[1]) < Date.now());
      if (expired) jar.delete(name); else jar.set(name, pair.slice(i + 1));
    }
    this.persist([...jar].map(([name, value]) => `${name}=${value}`).join('; '));
  }

  async request(resource, { method = 'GET', body, cookie, timeoutMs = 20000 } = {}) {
    const activeCookie = cookie === undefined ? this.readCookie() : cookie;
    if (!/(?:^|;\s*)PHPSESSID=[^;\s]+/.test(activeCookie)) {
      throw sessionError('Connect a Virtual Yard session in CRM Settings first.', 'VY_NOT_CONNECTED');
    }
    const url = new URL(resource, ORIGIN);
    if (url.origin !== ORIGIN) throw sessionError('Invalid Virtual Yard resource.', 'VY_INVALID_URL');
    let response;
    try {
      response = await this.fetchImpl(url, {
        method, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: '*/*', Cookie: activeCookie, Referer: REFERER, 'X-Requested-With': 'XMLHttpRequest',
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}) },
      });
    } catch (_) {
      throw Object.assign(sessionError('Virtual Yard could not be reached.', 'VY_NETWORK'), { mayHaveCreated: method === 'POST' });
    }
    // A reconnect is committed only after its read-only probe succeeds.
    try {
      if (cookie === undefined && this.readCookie() === activeCookie) this.rotate(response.headers);
    } catch (_) { throw Object.assign(sessionError('Could not persist the Virtual Yard session.', 'VY_SESSION_STORAGE'), { mayHaveCreated: method === 'POST' }); }
    const location = response.headers.get('location') || '';
    const text = await response.text().catch(() => {
      throw Object.assign(sessionError('Virtual Yard response was interrupted.', 'VY_NETWORK'), { mayHaveCreated: method === 'POST' });
    });
    if ([401, 403].includes(response.status) || /login|sign.?in/i.test(location) || /<title>[^<]*login|id=["']frmLogin|window\.location[^;]*login\.php/i.test(text)) {
      this.connected = false;
      throw sessionError('Virtual Yard session expired. Sign in to Virtual Yard and reconnect its session in CRM Settings.');
    }
    if (!response.ok) throw Object.assign(sessionError('Virtual Yard returned an unexpected response.', 'VY_HTTP'), { mayHaveCreated: method === 'POST' });
    return { text, headers: response.headers };
  }

  async json(resource, options) {
    const { text } = await this.request(resource, options);
    try { return JSON.parse(text.trim()); }
    catch (_) { throw sessionError('Virtual Yard returned an invalid lookup response. Reconnect the session.', 'VY_INVALID_RESPONSE'); }
  }

  async check() {
    this.connected = false;
    const rows = await this.json('/ajax/JSON/lookup.php?key=users&users=&categoryId=0');
    if (!Array.isArray(rows)) throw sessionError('Virtual Yard session check failed.', 'VY_INVALID_RESPONSE');
    this.connected = true;
    this.lastCheckedAt = new Date().toISOString();
    this.persist(this.cookie);
    return this.status();
  }

  async connect(cookie) {
    if (typeof cookie !== 'string' || !/(?:^|;\s*)PHPSESSID=[^;\s]+/.test(cookie) || /[\r\n]/.test(cookie) || cookie.length > 16000) throw sessionError('Enter a valid Virtual Yard cookie.', 'VY_INVALID_COOKIE');
    const response = await this.request('/ajax/JSON/lookup.php?key=users&users=&categoryId=0', { cookie });
    let rows;
    try { rows = JSON.parse(response.text.trim()); } catch (_) { /* handled below */ }
    if (!Array.isArray(rows)) throw sessionError('That cookie did not authenticate with Virtual Yard.', 'VY_INVALID_COOKIE');
    this.persist(cookie);
    this.rotate(response.headers);
    this.connected = true;
    this.lastCheckedAt = new Date().toISOString();
    return this.status();
  }

  status() {
    return { configured: Boolean(this.readCookie()), connected: this.connected, lastCheckedAt: this.lastCheckedAt,
      renewal: 'keep_alive', message: 'Active sessions are kept alive and replacement cookies are saved. Expired or revoked sessions require reconnecting.' };
  }

  start() {
    if (this.timer) return;
    let checking = false;
    const tick = async () => {
      if (checking) return;
      checking = true;
      try { if (this.readCookie()) await this.check(); }
      catch (_) { this.connected = false; }
      finally { checking = false; }
    };
    tick();
    this.timer = setInterval(tick, 5 * 60 * 1000);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
}

module.exports = new VirtualyardSession();
module.exports.VirtualyardSession = VirtualyardSession;
