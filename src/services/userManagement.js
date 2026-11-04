const { ObjectId } = require('mongoose').mongo;
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { PLATFORMS, SITES, ROLES, OWNER_EMAIL, emailKey, canonicalSite, validateAccount, fail, canManageUsers } = require('./accountAccess');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const emailFilter = email => ({ email: { $regex: `^\\s*${escape(emailKey(email))}\\s*$`, $options: 'i' } });

function createUserManagement({ panelDb, leadDb, client, hashPassword = password => bcrypt.hash(password, 12) }) {
  const databases = { panel: panelDb, lead: leadDb };
  function summarize(panel, lead) {
    const user = panel || lead;
    const platform_access = Array.isArray(user.platform_access) ? user.platform_access : [...(panel ? ['crm', 'sales_floor', 'delivery_centre'] : []), ...(lead ? ['lead_centre'] : [])];
    const all_sites = user.all_sites ?? !user.locked_site;
    return { id: `${panel ? 'panel' : 'lead'}:${user._id}`, name: user.name || emailKey(user.email) || 'Unnamed user', email: emailKey(user.email), role: user.role,
      site: canonicalSite(user.site || user.active_site) || user.site || '', all_sites,
      allowed_sites: user.allowed_sites || (user.locked_site ? [canonicalSite(user.locked_site) || user.locked_site] : []),
      platform_access, network_lookup: !!user.network_lookup, active: user.active !== false, deleted: !!user.deleted_at,
      last_login_at: user.last_login_at || null, protected: emailKey(user.email) === OWNER_EMAIL };
  }
  async function byEmail(db, email, session) {
    const docs = await db.collection('users').find(emailFilter(email), { session }).toArray();
    if (docs.length > 1) fail(409, 'Duplicate accounts exist for this email. Resolve them before editing.');
    return docs[0] || null;
  }
  async function target(id, session) {
    const match = /^(panel|lead):([a-f\d]{24})$/i.exec(id);
    if (!match) fail(400, 'Invalid user ID.');
    const store = match[1].toLowerCase();
    const user = await databases[store].collection('users').findOne({ _id: new ObjectId(match[2]) }, { session });
    if (!user) fail(404, 'User not found.');
    return { user, panel: store === 'panel' ? user : await byEmail(panelDb, user.email, session), lead: store === 'lead' ? user : await byEmail(leadDb, user.email, session) };
  }
  async function list() {
    const panel = await panelDb.collection('users').find({}, { projection: { password_hash: 0, pushTokens: 0 } }).toArray();
    const leads = await leadDb.collection('users').find({}, { projection: { password_hash: 0, pushTokens: 0 } }).toArray();
    const seen = new Set();
    const data = panel.map(user => { seen.add(emailKey(user.email)); return summarize(user, leads.find(l => emailKey(l.email) === emailKey(user.email))); });
    for (const lead of leads) if (!seen.has(emailKey(lead.email))) data.push(summarize(null, lead));
    return { users: data.sort((a, b) => a.name.localeCompare(b.name)), sites: SITES, platforms: PLATFORMS, roles: ROLES };
  }
  async function mutate({ id, input, actor, ip, remove = false }) {
    if (!canManageUsers(actor)) fail(403, 'Owner super admin access is required.');
    const fields = remove ? null : validateAccount(input);
    if (!id && !input.password) fail(400, 'A password is required for a new account.');
    const passwordHash = input?.password ? await hashPassword(input.password) : null;
    const session = client.startSession();
    let result;
    try {
      await session.withTransaction(async () => {
        const current = id ? await target(id, session) : { panel: null, lead: null };
        if (id && (emailKey(current.user.email) === OWNER_EMAIL || String(current.panel?._id) === actor.id)) fail(400, 'The signed-in owner account is protected.');
        const oldEmail = current.user?.email;
        if (!remove) {
          for (const [key, db] of Object.entries(databases)) {
            const collision = await byEmail(db, fields.email, session);
            if (collision && String(collision._id) !== String(current[key]?._id)) fail(409, 'This email is already in use.');
          }
          if (fields.email === OWNER_EMAIL) fail(400, 'The owner email is reserved.');
        }
        const now = new Date();
        const version = Math.max(current.panel?.auth_version || 0, current.lead?.auth_version || 0) + 1;
        const primary = current.panel || current.lead;
        const sharedId = primary?.id || randomUUID();
        const changed = remove ? { active: false, deleted_at: now, platform_access: [], auth_version: version, updatedAt: now }
          : { ...fields, deleted_at: null, auth_version: version, updatedAt: now };
        const written = {};
        for (const [key, db] of Object.entries(databases)) {
          const original = current[key];
          if (remove && !original) continue;
          const set = { ...changed };
          if (original && !original.id) set.id = sharedId;
          if (passwordHash) { set.password_hash = passwordHash; set.must_change_password = false; }
          if (original) {
            await db.collection('users').updateOne({ _id: original._id }, { $set: set }, { session });
            written[key] = { ...original, ...set };
          } else {
            const doc = { _id: new ObjectId(), id: sharedId, ...set, createdAt: now, created_at: now.toISOString(), last_login_at: null,
              password_hash: passwordHash || primary?.password_hash, must_change_password: false, team: primary?.team || 'All Teams', contractor_skills: [], pushTokens: [] };
            if (!doc.password_hash) fail(400, 'Set a password to provision the missing platform account.');
            await db.collection('users').insertOne(doc, { session });
            written[key] = doc;
          }
          // Keep directory membership aligned; this collection does not grant sign-in access.
          if (oldEmail && emailKey(oldEmail) !== fields?.email) await db.collection('staff_site_memberships').deleteMany(emailFilter(oldEmail), { session });
          if (remove) await db.collection('staff_site_memberships').deleteMany(emailFilter(oldEmail), { session });
          else await db.collection('staff_site_memberships').updateOne({ email: fields.email }, { $set: { email: fields.email, sites: fields.all_sites ? SITES : fields.allowed_sites, source: 'crm-admin', updatedAt: now } }, { upsert: true, session });
        }
        const action = remove ? 'user.delete' : id ? 'user.update' : 'user.create';
        await panelDb.collection('auditevents').insertOne({ actor_id: actor.id, actor_email: actor.email, action, entity: 'User', entity_id: String(written.panel?._id || current.panel?._id || current.user?._id),
          meta: { email: fields?.email || emailKey(oldEmail), changed_fields: remove ? ['active', 'platform_access'] : Object.keys(fields), password_changed: !!passwordHash }, ip, createdAt: now, updatedAt: now }, { session });
        result = remove ? { deleted: true } : summarize(written.panel, written.lead);
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      return result;
    } finally { await session.endSession(); }
  }
  return { list, mutate };
}
function getUserManagement() {
  const { deliveryConn, leadConn } = require('../db');
  const client = deliveryConn.getClient();
  // Both configured databases belong to the same deployment; one client makes account changes atomic.
  return createUserManagement({ client, panelDb: client.db(deliveryConn.name), leadDb: client.db(leadConn.name) });
}
module.exports = { createUserManagement, getUserManagement };
