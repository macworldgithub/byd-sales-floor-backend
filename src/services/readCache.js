// Small, process-local caches for authenticated reads. Permissions are checked
// on every request before calling this module; mutations invalidate all entries.
let generation = 0;
const databases = new WeakMap();
const encode = value => JSON.stringify(value, (_, item) => item instanceof RegExp ? { regex: item.source, flags: item.flags } : item);
class ReadCache {
  constructor({ ttl = 5000, maxEntries = 128, maxBytes = 1024 * 1024, now = Date.now } = {}) {
    Object.assign(this, { ttl, maxEntries, maxBytes, now });
    this.entries = new Map();
  }
  async read(key, loader) {
    const current = this.entries.get(key);
    if (current && current.generation === generation && (current.pending || current.expires > this.now())) return current.promise;
    const entry = { generation, expires: this.now() + this.ttl, pending: true };
    // Insert the pending promise before invoking the loader to collapse bursts.
    entry.promise = Promise.resolve().then(loader).then(value => {
      entry.pending = false;
      if (entry.generation !== generation || Buffer.byteLength(JSON.stringify(value) || '') > this.maxBytes) {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      } else entry.expires = this.now() + this.ttl;
      return value;
    }).catch(error => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    });
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    this.entries.set(key, entry);
    return entry.promise;
  }
}
function cached(db, key, loader) {
  let cache = databases.get(db);
  if (!cache) { cache = new ReadCache(); databases.set(db, cache); }
  return cache.read(encode(key), loader);
}
function readRequest(db, req, loader) {
  const u = req.user;
  if (!u) return loader();
  return cached(db, { path: req.baseUrl + req.path, query: Object.fromEntries(Object.entries(req.query || {}).sort()), site: req.headers?.['x-site'],
    user: { id: u.id, role: u.role, email: u.email, name: u.name, auth_version: u.auth_version, platform: u.platform,
      site: u.site, locked_site: u.locked_site, allowed_sites: u.allowed_sites, all_sites: u.all_sites, network_lookup: u.network_lookup, platform_access: u.platform_access } }, loader);
}
const invalidateReads = () => { generation++; };
module.exports = { ReadCache, cached, readRequest, invalidateReads };
