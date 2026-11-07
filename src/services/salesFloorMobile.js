const crypto = require('node:crypto');
const { ObjectId } = require('mongoose').mongo;
const { fail, siteKey } = require('./accountAccess');
const p = require('./salesFloorPolicy');
const id = value => String(value?._id || value?.id || value || '');
const reference = value => /^[a-f\d]{24}$/i.test(String(value)) ? new ObjectId(String(value)) : String(value);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const and = (...values) => ({ $and: values });

class SalesFloorMobile {
  constructor(lead, panel) { this.lead = lead; this.panel = panel; }
  collection(name) { return (['leads', 'inventories', 'appointments', 'deals'].includes(name) ? this.lead : this.panel).collection(name); }
  site(user, requested) {
    const site = user.locked_site || requested || user.site;
    p.scope(user, { site });
    if (!site || /^all(?:\s|$)/i.test(site)) fail(400, 'Select a site for this action.');
    return site;
  }
  async config(site) { return { ...p.DEFAULTS, ...(await this.panel.collection('floor_site_settings').findOne({ _id: siteKey(site) }))?.value }; }
  async lockIdentity(site, phone) {
    const identityKey = sha(`${siteKey(site)}:${phone}`), identities = this.panel.collection('floor_identities'), now = new Date();
    await identities.updateOne({ _id: identityKey }, { $setOnInsert: { createdAt: now } }, { upsert: true });
    const lockOwner = crypto.randomUUID();
    const locked = await identities.updateOne({ _id: identityKey, $or: [{ lockedUntil: { $lt: now } }, { lockedUntil: { $exists: false } }] }, { $set: { lockOwner, lockedUntil: new Date(Date.now() + 30000) } });
    if (!locked.modifiedCount) fail(409, 'This customer is being saved. Retry in a moment.');
    return { identityKey, release: () => identities.updateOne({ _id: identityKey, lockOwner }, { $unset: { lockedUntil: '', lockOwner: '' } }) };
  }
  filter(user, query = {}, name = 'leads') {
    const fields = name === 'inventories' ? ['location', 'site', 'yard'] : name === 'clients' ? ['site_location', 'site'] : ['dealer', 'site', 'dealership'];
    const subject = name === 'inventories' ? { ...user, role: 'manager' } : user;
    return p.scope(subject, query, fields);
  }
  async record(name, value, user) {
    const record = await this.collection(name).findOne(and(this.filter(user, {}, name), { $or: [{ _id: reference(value) }, { dealId: String(value) }, { customer_id: String(value) }] }));
    if (!record) fail(404, 'Record not found.');
    return record;
  }
  async event(lead, user, type, body, extra = {}) {
    const event = { event_id: `EVT-${crypto.randomUUID()}`, leadId: id(lead), customer_id: lead.customerId || lead.customer_id,
      site: lead.dealer || lead.site, owner_user_id: lead.owner_user_id || lead.consultantId || user.id, owner_name: lead.allocatedPersonFullName || user.name,
      type, title: type, body, content: body, author: user.name, author_name: user.name, occurred_at: new Date(), createdAt: new Date(), ...extra };
    await this.panel.collection('timelineevents').insertOne(event);
    return event;
  }
  async list(name, query, user) {
    const conditions = [this.filter(user, query, name)];
    if (name === 'leads') conditions.push({ isArchived: { $ne: true } });
    if (query.q) conditions.push({ $or: ['name', 'phone', 'email', 'vehicle', 'stock', 'vin'].map(key => ({ [key]: new RegExp(p.literal(String(query.q).slice(0, 120)), 'i') })) });
    if (query.stage && query.stage !== 'All') conditions.push({ stage: p.stage(query.stage) });
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 50)), page = Math.max(1, Number(query.page) || 1);
    const filter = and(...conditions), collection = this.collection(name);
    const [data, total] = await Promise.all([collection.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).toArray(), collection.countDocuments(filter)]);
    return { data, pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } };
  }
  async saveLead(input, user) {
    const details = p.customer(input), site = this.site(user, input.site), now = new Date();
    // Serialize concurrent submissions by normalized mobile + site. Imported
    // identities are resolved before the deterministic insertion key is used.
    const { identityKey, release } = await this.lockIdentity(site, details.phone);
    try {
      const suffix = details.phone.slice(-9), mobile = new RegExp(`${suffix.split('').join('[\\s()-]*')}$`);
      const siteFilter = this.filter({ ...user, role: 'manager' }, { site });
      const existing = await this.lead.collection('leads').findOne(and(siteFilter, { phone: mobile, isArchived: { $ne: true } }));
      if (!existing && await this.lead.collection('leads').findOne(and(siteFilter, { email: p.exact(details.email), isArchived: { $ne: true } }))) fail(409, 'This email already exists with a different mobile at this site. Ask a manager to review and merge the records.');
      if (existing && !p.isManager(user) && existing.assignedTo !== user.email && existing.assignedTo !== user.id && existing.allocatedPersonFullName !== user.name) fail(409, 'This customer already belongs to another consultant at your site. Ask a manager to allocate it.');
      const leadId = existing?._id || new ObjectId(identityKey.slice(0, 24));
      const customerId = existing?.customerId || existing?.customer_id || `CUST-${identityKey.slice(0, 20)}`;
      const contacts = new Map([...(existing?.companyContacts || []), ...details.companyContacts].map(c => [`${c.name}:${c.phone || ''}:${c.email || ''}`, c]));
      const businessId = details.businessName ? `BUS-${sha(`${siteKey(site)}:${details.businessName.toLowerCase()}`).slice(0, 20)}` : existing?.businessId || null;
      const record = { ...details, companyContacts: [...contacts.values()], businessId, customerId,
        vehicle: String(input.model || input.vehicle || existing?.vehicle || ''), model: String(input.model || input.vehicle || existing?.vehicle || ''),
        source: String(input.source || existing?.source || 'Walk-in'), stage: p.stage(existing?.stage || input.stage),
        score: input.score === undefined ? existing?.score ?? 0 : Math.max(0, Math.min(100, Number(input.score) || 0)), dealer: site, site, brand: 'BYD',
        assignedTo: existing?.assignedTo || user.email, allocatedPersonFullName: existing?.allocatedPersonFullName || user.name,
        owner_user_id: existing?.owner_user_id || user.id, owner_name: existing?.owner_name || user.name,
        notes: [existing?.notes, String(input.notes || '').trim()].filter(Boolean).join('\n'), updatedAt: now };
      if (input.tradeInRego) record.tradeInRego = String(input.tradeInRego).trim().toUpperCase();
      if (!record.vehicle.trim()) fail(400, 'Vehicle interest is required.');
      if (input.vehicleCheckId) {
        const check = await this.panel.collection('floor_vehicle_checks').findOne({ _id: String(input.vehicleCheckId), owner_user_id: user.id, type: 'rego' });
        if (!check || !check.verified || siteKey(check.site) !== siteKey(site) || (check.leadId && check.leadId !== String(leadId))) fail(400, 'Vehicle lookup does not belong to this site/customer creation.');
        record.tradeInRego = check.rego; record.tradeInVin = check.vin; record.tradeIn = { vin: check.vin, make: check.make, model: check.model, year: check.year };
        record.ppsrStatus = existing?.tradeInVin === check.vin ? existing.ppsrStatus || 'Pending' : 'Pending';
      }
      // VIN/status only come from a provider result attached on the server.
      const resetPpsr = input.vehicleCheckId && existing?.tradeInVin !== record.tradeInVin ? { $unset: { ppsrCertificate: '' } } : {};
      await this.lead.collection('leads').updateOne({ _id: leadId }, { $set: record, $setOnInsert: { createdAt: now, platform: 'manual', isArchived: false }, ...resetPpsr }, { upsert: true });
      await this.panel.collection('customers').updateOne({ customer_id: customerId }, { $set: { ...details, companyContacts: record.companyContacts, businessId,
        ...(input.vehicleCheckId ? { tradeInRego: record.tradeInRego, tradeInVin: record.tradeInVin, tradeIn: record.tradeIn, ppsrStatus: record.ppsrStatus } : {}),
        company_name: details.businessName || null, record_type: businessId ? 'Company' : 'Individual', site,
        owner_user_id: record.owner_user_id, owner_name: record.owner_name, lead_prospect_id: String(leadId), updatedAt: now },
        $setOnInsert: { createdAt: now, consent_sms: true, do_not_contact: false }, ...resetPpsr }, { upsert: true });
      if (input.vehicleCheckId) await this.panel.collection('floor_vehicle_checks').updateOne({ _id: String(input.vehicleCheckId) }, { $set: { leadId: String(leadId), customerId } });
      if (businessId) await this.panel.collection('businesses').updateOne({ business_id: businessId }, { $set: { name: details.businessName, abn: details.abn, site, updatedAt: now },
        $addToSet: { customerIds: customerId, contacts: { $each: record.companyContacts } }, $setOnInsert: { createdAt: now } }, { upsert: true });
      const saved = { _id: leadId, ...record };
      if (!existing && record.source === 'Walk-in') await this.panel.collection('floor_traffic').insertOne({ site, owner_user_id: user.id, owner_name: user.name, captured: true, leadId: String(leadId), createdAt: now });
      await this.event(saved, user, existing ? 'Prospect merged' : 'Prospect created', existing ? 'Duplicate mobile matched within the current site; contact details and notes were merged.' : 'Prospect created.');
      return { ...saved, merged: Boolean(existing) };
    } finally { await release(); }
  }
  async updateLead(value, input, user) {
    const lead = await this.record('leads', value, user), patch = { updatedAt: new Date() };
    const permitted = ['name', 'phone', 'email', 'businessName', 'companyContacts', 'vehicle', 'stage', 'notes', 'assignedTo', 'allocatedPersonFullName', 'aiPaused', 'nextActionAt'];
    if (Object.keys(input).some(key => !permitted.includes(key))) fail(400, 'Unsupported customer update.');
    if ('stage' in input) patch.stage = p.stage(input.stage);
    if ('name' in input && !String(input.name).trim()) fail(400, 'Customer name cannot be blank.');
    if ('email' in input && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(input.email))) fail(400, 'A valid email is required.');
    for (const key of ['name', 'email', 'notes', 'nextActionAt']) if (key in input) patch[key] = String(input[key]).trim();
    if (patch.email) {
      patch.email = patch.email.toLowerCase();
      const duplicate = await this.lead.collection('leads').findOne(and(this.filter({ ...user, role: 'manager' }, { site: lead.dealer }), { _id: { $ne: lead._id }, email: p.exact(patch.email), isArchived: { $ne: true } }));
      if (duplicate) fail(409, 'This email belongs to another customer at this site. Ask a manager to review the duplicate.');
    }
    if ('nextActionAt' in patch && patch.nextActionAt && !Number.isFinite(Date.parse(patch.nextActionAt))) fail(400, 'Enter a valid next-action date/time.');
    if (['phone', 'businessName', 'companyContacts'].some(key => key in input)) {
      const details = p.customer({ ...lead, ...input });
      for (const key of ['phone', 'businessName', 'companyContacts']) patch[key] = details[key];
      patch.businessId = details.businessName ? `BUS-${sha(`${siteKey(lead.dealer)}:${details.businessName.toLowerCase()}`).slice(0, 20)}` : null;
    }
    if ('vehicle' in input) {
      if (!String(input.vehicle || '').trim()) fail(400, 'Vehicle interest is required.');
      patch.vehicle = String(input.vehicle).trim(); patch.model = patch.vehicle;
    }
    if ('assignedTo' in input) {
      if (!p.isManager(user)) fail(403, 'Only managers can allocate leads.');
      const staff = await this.panel.collection('users').findOne({ email: String(input.assignedTo).toLowerCase(), active: { $ne: false }, deleted_at: null });
      if (!staff || siteKey(staff.site) !== siteKey(lead.dealer)) fail(400, 'Choose an active consultant at this site.');
      Object.assign(patch, { assignedTo: staff.email, allocatedPersonFullName: staff.name, owner_user_id: id(staff), owner_name: staff.name });
    }
    if ('aiPaused' in input) { if (typeof input.aiPaused !== 'boolean') fail(400, 'Invalid AI control.'); patch.aiPaused = input.aiPaused; patch.humanTakeoverAt = new Date(); }
    const lock = patch.phone ? await this.lockIdentity(lead.dealer, patch.phone) : null;
    try {
      if (patch.phone) {
        const mobile = new RegExp(`${patch.phone.slice(-9).split('').join('[\\s()-]*')}$`);
        const duplicate = await this.lead.collection('leads').findOne(and(this.filter({ ...user, role: 'manager' }, { site: lead.dealer }), { _id: { $ne: lead._id }, phone: mobile, isArchived: { $ne: true } }));
        if (duplicate) fail(409, 'This mobile belongs to another customer at this site. Ask a manager to merge the records.');
      }
      await this.lead.collection('leads').updateOne({ _id: lead._id }, { $set: patch });
      const customerId = lead.customerId || lead.customer_id;
      if (customerId) await this.panel.collection('customers').updateOne({ customer_id: customerId }, { $set: { ...patch, notes: patch.notes ?? lead.notes,
        ...('businessName' in patch ? { company_name: patch.businessName || null, record_type: patch.businessId ? 'Company' : 'Individual' } : {}) } });
      if (patch.businessId && customerId) await this.panel.collection('businesses').updateOne({ business_id: patch.businessId }, { $set: { name: patch.businessName, site: lead.dealer, updatedAt: new Date() }, $addToSet: { customerIds: customerId, contacts: { $each: patch.companyContacts } } }, { upsert: true });
    } finally { if (lock) await lock.release(); }
    await this.event(lead, user, 'Customer updated', 'Customer details, stage or allocation updated.', { changes: patch });
    return { ...lead, ...patch };
  }
  async mergeLeads(targetId, sourceId, user) {
    if (!p.isManager(user)) fail(403, 'Only managers can merge customer records.');
    const target = await this.record('leads', targetId, user), source = await this.record('leads', sourceId, user);
    if (id(target) === id(source) || target.isArchived || siteKey(target.dealer) !== siteKey(source.dealer)) fail(400, 'Choose two active records within the same site.');
    if (source.mergedInto && source.mergedInto !== id(target)) fail(409, 'This record has already been merged into another customer.');
    if (String(target.phone || '').replace(/\D/g, '').slice(-9) !== String(source.phone || '').replace(/\D/g, '').slice(-9) && String(target.email || '').toLowerCase() !== String(source.email || '').toLowerCase()) fail(400, 'Records must share a mobile or email. Verify the customer details before merging.');
    if (target.businessName && source.businessName && target.businessName.toLowerCase() !== source.businessName.toLowerCase()) fail(409, 'Resolve the different company identities before merging.');
    const merges = this.panel.collection('floor_merges'), key = id(source), existing = await merges.findOne({ _id: key });
    if (existing?.targetId && existing.targetId !== id(target)) fail(409, 'A different merge is already in progress.');
    if (existing?.state === 'complete') return target;
    await merges.updateOne({ _id: key }, { $setOnInsert: { sourceId: id(source), targetId: id(target), sourceSnapshot: source, targetSnapshot: target, state: 'pending', createdAt: new Date() } }, { upsert: true });
    const claim = await merges.updateOne({ _id: key, targetId: id(target), state: { $in: ['pending', 'failed'] } }, { $set: { state: 'sending' } });
    if (!claim.modifiedCount) fail(409, 'This customer merge is already in progress.');
    try {
      const base = existing?.targetSnapshot || target;
      const contacts = [...new Map([...(base.companyContacts || []), ...(source.companyContacts || [])].map(contact => [`${contact.phone}:${contact.email}`, contact])).values()];
      const patch = { notes: [base.notes, source.notes].filter(Boolean).join('\n'), companyContacts: contacts, updatedAt: new Date(),
        ...(!base.businessName && source.businessName ? { businessName: source.businessName, businessId: source.businessId, abn: source.abn || '' } : {}) };
      await this.lead.collection('leads').updateOne({ _id: target._id }, { $set: patch });
      for (const name of ['appointments', 'deals']) await this.lead.collection(name).updateMany({ leadId: id(source) }, { $set: { leadId: id(target), ...(target.customerId ? { customerId: target.customerId } : {}) } });
      await this.panel.collection('timelineevents').updateMany({ leadId: id(source) }, { $set: { leadId: id(target), ...(target.customerId ? { customer_id: target.customerId } : {}) } });
      await this.panel.collection('floor_tasks').updateMany({ leadId: id(source) }, { $set: { leadId: id(target), ...(target.customerId ? { customerId: target.customerId } : {}) } });
      for (const name of ['floor_media', 'floor_licences', 'floor_vehicle_checks', 'floor_notifications']) await this.panel.collection(name).updateMany({ leadId: id(source) }, { $set: { leadId: id(target), ...(target.customerId ? { customerId: target.customerId } : {}) } });
      if (source.customerId && target.customerId && source.customerId !== target.customerId) {
        for (const name of ['timelineevents', 'opportunities']) await this.panel.collection(name).updateMany({ customer_id: source.customerId }, { $set: { customer_id: target.customerId } });
        await this.panel.collection('clients').updateMany({ crm_customer_id: source.customerId }, { $set: { crm_customer_id: target.customerId } });
        await this.panel.collection('floor_followups').updateMany({ customerId: source.customerId }, { $set: { customerId: target.customerId } });
        await this.panel.collection('customers').updateOne({ customer_id: source.customerId }, { $set: { is_merged: true, merged_into: target.customerId, updatedAt: new Date() } });
      }
      if (target.customerId) await this.panel.collection('customers').updateOne({ customer_id: target.customerId }, { $set: { ...patch, ...(patch.businessName ? { company_name: patch.businessName, record_type: 'Company' } : {}) } });
      await this.lead.collection('leads').updateOne({ _id: source._id }, { $set: { isArchived: true, mergedInto: id(target), updatedAt: new Date() } });
      await this.event(target, user, 'Duplicate merged', `Record ${id(source)} merged into this customer. Source snapshots retained.`, { sourceId: id(source) });
      await merges.updateOne({ _id: key }, { $set: { state: 'complete', completedAt: new Date() } });
      return { ...target, ...patch };
    } catch (error) { await merges.updateOne({ _id: key }, { $set: { state: 'failed', message: error.message } }); throw error; }
  }
  async timeline(value, user) {
    const lead = await this.record('leads', value, user);
    return this.panel.collection('timelineevents').find(and(p.scope({ ...user, role: 'manager' }, { site: lead.dealer }, ['site']),
      { $or: [{ leadId: id(lead) }, ...(lead.customerId ? [{ customer_id: lead.customerId }] : [])] })).sort({ createdAt: -1 }).limit(200).toArray();
  }
  async note(value, body, user) {
    const lead = await this.record('leads', value, user);
    if (!String(body || '').trim()) fail(400, 'Enter a note.');
    return this.event(lead, user, 'Internal note', String(body).trim());
  }
  async task(value, input, user) {
    if (!p.isManager(user)) fail(403, 'Managers assign tasks.');
    const lead = await this.record('leads', value, user), due = new Date(input.dueAt);
    if (!String(input.title || '').trim() || !Number.isFinite(due.getTime())) fail(400, 'Task title and due time are required.');
    const task = { _id: new ObjectId(), leadId: id(lead), customerId: lead.customerId, title: String(input.title), dueAt: due,
      site: lead.dealer, assignedTo: lead.assignedTo, owner_user_id: lead.owner_user_id, owner_name: lead.allocatedPersonFullName, status: 'open', createdBy: user.id, createdAt: new Date() };
    await this.panel.collection('floor_tasks').insertOne(task);
    await this.notify(lead, 'task', task.title, `Due ${due.toISOString()}`, `task:${task._id}`);
    await this.event(lead, user, 'Manager task', task.title);
    return task;
  }
  async notify(lead, type, title, body, key) {
    let ownerId = lead.owner_user_id || lead.consultantId;
    if (!ownerId && (lead.assignedTo || lead.allocatedPersonFullName || lead.consultantName)) {
      const owner = await this.panel.collection('users').findOne(and(p.scope({ role: 'manager', site: lead.dealer || lead.site }, {}, ['site']),
        { active: { $ne: false }, deleted_at: null, $or: [{ email: lead.assignedTo || '' }, { name: lead.allocatedPersonFullName || lead.consultantName || '' }] }));
      ownerId = owner ? id(owner) : null;
    }
    const document = { _id: sha(`${siteKey(lead.dealer || lead.site)}:${key}`), leadId: id(lead), customerId: lead.customerId, site: lead.dealer || lead.site,
      assignedTo: lead.assignedTo, owner_user_id: ownerId, owner_name: lead.allocatedPersonFullName || lead.consultantName,
      type, title, body, createdAt: new Date(), read: false, pushState: 'pending' };
    await this.panel.collection('floor_notifications').updateOne({ _id: document._id }, { $setOnInsert: document }, { upsert: true });
    return document;
  }
  async inventory(query, user) {
    const site = user.locked_site || query.site || user.site;
    const config = await this.config(site);
    if (query.group === 'true' && !p.isManager(user)) fail(403, 'Group inventory requires management access.');
    const filter = and(this.filter(user, { site }, 'inventories'), ...(query.group === 'true' ? [{ status: /^(Available|In Stock|InStock|On Hand)$/i }] : []));
    const rows = await this.lead.collection('inventories').find(filter).toArray();
    const normalized = rows.map(raw => {
      const value = raw.daysInStock ?? raw.lmStats?.daysOnMarket ?? raw.shirleyData?.daysOfInventory;
      const entered = raw.shirleyData?.inStockDate;
      const days = value !== undefined && value !== null ? Number(value) : entered && Number.isFinite(Date.parse(entered)) ? Math.max(0, Math.floor((Date.now() - Date.parse(entered)) / 86400000)) : null;
      const price = typeof raw.priceData?.ui === 'number' ? raw.priceData.ui : raw.price && Number.isFinite(Number(String(raw.price).replace(/[^\d.]/g, ''))) ? Number(String(raw.price).replace(/[^\d.]/g, '')) : null;
      return { id: id(raw), stockNumber: raw.stock || raw.identifier || '', vin: raw.registration?.vin || '', rego: raw.registration?.rego || '',
        make: raw.specifications?.make || 'BYD', model: raw.specifications?.model || raw.model || '', variant: raw.specifications?.badge || '',
        year: raw.specifications?.year || null, colour: raw.paint || raw.specifications?.colour || '', daysInStock: days,
        ageingBucket: p.ageBucket(days), status: p.stockStatus(raw.status), advertisedPrice: p.isManager(user) || config.salesSeePrice ? price : null,
        costPrice: p.isManager(user) || config.salesSeeCost ? raw.costPrice ?? raw.cost ?? null : null,
        site: raw.location || raw.site, isGroupStock: query.group === 'true', specs: raw.specs || null };
    });
    const eligible = normalized.filter(row => query.group !== 'true' || row.status === 'In Stock');
    const counts = Object.fromEntries(['0-30', '31-60', '61-89', '90+', 'Unknown'].map(bucket => [bucket, eligible.filter(r => r.ageingBucket === bucket).length]));
    const data = eligible.filter(row => (!query.ageingBucket || query.ageingBucket === 'All' || row.ageingBucket === query.ageingBucket) &&
      (!query.status || query.status === 'All' || row.status === query.status) && (!query.q || `${row.stockNumber} ${row.model} ${row.vin}`.toLowerCase().includes(String(query.q).toLowerCase())));
    return { data, counts, total: eligible.length };
  }
}

module.exports = { SalesFloorMobile, reference, id, and, sha };
