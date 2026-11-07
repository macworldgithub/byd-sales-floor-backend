const { SalesFloorMobile, and, id, reference, sha } = require('./salesFloorMobile');
const p = require('./salesFloorPolicy');
const { fail, siteKey } = require('./accountAccess');
const { ObjectId } = require('mongoose').mongo;
const timed = (row, from, to, key = 'createdAt') => row[key] && new Date(row[key]) >= from && new Date(row[key]) <= to;

class SalesFloorOperations extends SalesFloorMobile {
  async summary(query, user) {
    const bounds = p.period(query.period), site = user.locked_site || query.site || user.site;
    const [leads, appointments, deals, events, targets, tasks] = await Promise.all([
      this.lead.collection('leads').find(this.filter(user, query)).limit(1000).toArray(),
      this.lead.collection('appointments').find(this.filter(user, query, 'appointments')).limit(200).toArray(),
      this.lead.collection('deals').find(this.filter(user, query, 'deals')).limit(200).toArray(),
      this.panel.collection('timelineevents').find(and(p.scope(user, query, ['site']), { createdAt: { $gte: bounds.from, $lte: bounds.to } })).limit(200).toArray(),
      this.panel.collection('crmtargets').find(and(p.scope(user, query, ['site']), { period: bounds.month })).toArray(),
      this.panel.collection('floor_tasks').find(and(p.scope(user, query, ['site']), { status: 'open' })).limit(100).toArray(),
    ]);
    const inPeriod = row => timed(row, bounds.from, bounds.to);
    const config = await this.config(site);
    const created = leads.filter(inPeriod), sold = deals.filter(row => timed(row, bounds.from, bounds.to, 'contractSignedAt'));
    return { activeLeads: leads.filter(p.active).length, unactionedLeads: leads.filter(row => p.active(row) && !row.lastContactAt).length,
      appointmentsBooked: appointments.filter(row => inPeriod(row) && !['Cancelled', 'No Show'].includes(row.status)).length,
      overdueSla: tasks.filter(row => new Date(row.dueAt) < bounds.to).length + leads.filter(row => p.active(row) && row.createdAt && Date.now() - new Date(row.lastContactAt || row.createdAt) >= config.followupRedHours * 3600000).length,
      dealsCompleted: sold.length, conversionRate: created.length ? Math.round(created.filter(row => deals.some(d => String(d.leadId) === id(row) && d.contractSignedAt)).length / created.length * 1000) / 10 : null,
      videosSent: events.filter(row => inPeriod(row) && row.type === 'Video sent').length,
      monthlyTarget: targets.length ? targets.reduce((total, row) => total + Number(row.targetUnits || 0), 0) : null,
      period: query.period || 'today', site, updatedAt: new Date() };
  }
  async reports(query, user) {
    if (!p.isManager(user)) fail(403, 'Management access required.');
    const bounds = p.period(query.period || 'mtd');
    const [leads, deals, traffic, events] = await Promise.all([
      this.lead.collection('leads').find(this.filter(user, query)).toArray(), this.lead.collection('deals').find(this.filter(user, query, 'deals')).toArray(),
      this.panel.collection('floor_traffic').find(p.scope(user, query, ['site'])).toArray(), this.panel.collection('timelineevents').find(p.scope(user, query, ['site'])).toArray(),
    ]);
    const within = value => value && new Date(value) >= bounds.from && new Date(value) <= bounds.to;
    const created = leads.filter(row => within(row.createdAt)), sold = deals.filter(row => within(row.contractSignedAt)), visits = traffic.filter(row => within(row.createdAt));
    const sites = [...new Set([...leads.map(row => row.dealer), ...sold.map(row => row.site), ...visits.map(row => row.site)].filter(Boolean))];
    return { dailyLeads: created.length, walkIns: visits.length, videosSent: events.filter(row => within(row.createdAt) && row.type === 'Video sent').length,
      soldUnits: sold.length, captureRate: visits.length ? Math.round(visits.filter(row => row.captured).length / visits.length * 100) : null,
      conversionRate: created.length ? Math.round(created.filter(row => sold.some(deal => String(deal.leadId) === id(row))).length / created.length * 100) : null,
      modelMix: Object.entries(sold.reduce((acc, deal) => { const model = deal.vehicle?.model || 'Unknown'; acc[model] = (acc[model] || 0) + 1; return acc; }, {})).map(([model, units]) => ({ model, units })),
      sites: sites.map(site => ({ site, leads: created.filter(row => siteKey(row.dealer) === siteKey(site)).length, sold: sold.filter(row => siteKey(row.site) === siteKey(site)).length })) };
  }
  async pulse(query, user) {
    if (!p.isManager(user)) fail(403, 'Management access required.');
    const rows = await this.lead.collection('leads').find(this.filter(user, query)).toArray();
    const deals = await this.lead.collection('deals').find(this.filter(user, query, 'deals')).toArray();
    const config = await this.config(user.locked_site || query.site || user.site);
    const staff = new Map();
    for (const row of rows) {
      const name = row.allocatedPersonFullName || row.owner_name || row.assignedTo || 'Unassigned';
      const group = staff.get(name) || { name, email: row.assignedTo, activeLeads: 0, overdueSla: 0, sold: 0, total: 0, maxFollowupHours: 0, flaggedLeads: [] };
      group.total++;
      if (deals.some(deal => String(deal.leadId) === id(row) && deal.contractSignedAt)) group.sold++;
      if (p.active(row)) {
        group.activeLeads++;
        const age = Math.max(0, (Date.now() - new Date(row.lastContactAt || row.createdAt || new Date()).getTime()) / 3600000);
        group.maxFollowupHours = Math.max(group.maxFollowupHours, age);
        if (age >= config.followupAmberHours) { group.overdueSla++; group.flaggedLeads.push({ id: id(row), name: row.name, age: `${Math.floor(age)}h`, reason: 'Follow-up due' }); }
      }
      staff.set(name, group);
    }
    return { consultants: [...staff.values()].map(row => ({ ...row, conversionRate: row.total ? Math.round(row.sold / row.total * 1000) / 10 : null,
      trafficLight: row.maxFollowupHours >= config.followupRedHours || row.sold / row.total * 100 < config.conversionAmber ? 'red' :
        row.maxFollowupHours >= config.followupAmberHours || row.sold / row.total * 100 < config.conversionGreen ? 'amber' : 'green' })), config, updatedAt: new Date() };
  }
  async ingestMessage(lead, text, messageId, at = new Date()) {
    const config = await this.config(lead.dealer || lead.site);
    for (const type of p.classify(text).filter(type => config.alertTypes.includes(type))) {
      await this.notify(lead, type, `${type.replaceAll('_', ' ').toUpperCase()} · ${lead.name}`, String(text).slice(0, 500), `${type}:${messageId}`);
    }
    await this.lead.collection('leads').updateOne({ _id: lead._id }, { $max: { lastEngagementAt: at } });
  }
  async alerts(query, user) {
    return this.panel.collection('floor_notifications').find(p.scope(user, query, ['site'])).sort({ createdAt: -1 }).limit(100).toArray();
  }
  async readAlert(value, user) {
    await this.panel.collection('floor_notifications').updateOne(and(p.scope(user, {}, ['site']), { _id: String(value) }), { $set: { read: true, readAt: new Date() } });
  }
  async presence(input, user) {
    const lat = Number(input.latitude), lon = Number(input.longitude), site = this.site(user, input.site);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) fail(400, 'Valid device coordinates are required.');
    const config = await this.config(site), distance = p.geofence(lat, lon, config.geofence);
    if (distance === null) fail(409, 'A manager must configure the dealership geofence first.');
    const value = { userId: user.id, name: user.name, site, latitude: lat, longitude: lon, accuracy: Number(input.accuracy) || null,
      isInsideGeofence: distance <= config.geofence.radiusMeters, distanceMeters: distance, updatedAt: new Date() };
    await this.panel.collection('floor_presence').updateOne({ _id: user.id }, { $set: value }, { upsert: true });
    return value;
  }
  async saveDeal(input, user) {
    const requestId = String(input.bookingRequestId || '');
    if (!/^[\w-]{8,100}$/.test(requestId)) fail(400, 'A stable deal request ID is required.');
    const dealId = `DEAL-${sha(`${user.id}:${requestId}`).slice(0, 24)}`;
    const existing = await this.lead.collection('deals').findOne({ dealId });
    if (existing) return this.record('deals', existing._id, user);
    const lead = await this.record('leads', input.leadId, user), vehicle = await this.record('inventories', input.inventoryId, user);
    if (p.stockStatus(vehicle.status) !== 'In Stock') fail(409, 'This vehicle is unavailable or already has a pending deal.');
    const price = Number(input.salePrice), allowance = Number(input.tradeInValue || 0);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(allowance) || allowance < 0 || allowance > price) fail(400, 'Enter valid sale and trade-in amounts.');
    const claim = await this.lead.collection('inventories').updateOne({ _id: vehicle._id, status: vehicle.status, $or: [{ dealId: { $exists: false } }, { dealId: null }] }, { $set: { status: 'Deal Pending', dealId, updatedAt: new Date() } });
    if (!claim.modifiedCount) fail(409, 'Another deal has already reserved this vehicle.');
    const record = { _id: new ObjectId(), dealId, leadId: id(lead), customerId: lead.customerId, site: lead.dealer, buyerName: lead.name, buyerPhone: lead.phone, buyerEmail: lead.email,
      businessId: lead.businessId || null, businessName: lead.businessName || '', companyContacts: lead.companyContacts || [], consultantName: lead.allocatedPersonFullName || user.name, consultantId: lead.owner_user_id || user.id,
      inventoryId: id(vehicle), vehicle: { stockNumber: vehicle.stock || vehicle.identifier, model: vehicle.specifications?.model || vehicle.model,
        variant: vehicle.specifications?.badge, vin: vehicle.registration?.vin, year: vehicle.specifications?.year, driveAwayPrice: price },
      tradeIn: { ...lead.tradeIn, rego: lead.tradeInRego, vin: lead.tradeInVin, ppsrStatus: lead.ppsrStatus || 'Pending', allowance, ppsrCertificate: lead.ppsrCertificate },
      financials: { vehiclePrice: price, netSettlement: price - allowance, tradeInAllowance: allowance, paymentMethod: input.financeType || 'Cash' },
      status: 'Registered', virtualYard: { status: 'Pending Sync' }, createdAt: new Date(), updatedAt: new Date() };
    try { await this.lead.collection('deals').insertOne(record); }
    catch (error) { await this.lead.collection('inventories').updateOne({ _id: vehicle._id, dealId }, { $set: { status: vehicle.status }, $unset: { dealId: '' } }); throw error; }
    await this.lead.collection('leads').updateOne({ _id: lead._id }, { $set: { stage: 'COMMITTED', status: 'committed', dealId, updatedAt: new Date() } });
    await this.event(lead, user, 'Deal registered', `Deal ${dealId} registered. Awaiting Virtual Yard sync and signed contract.`, { dealId });
    return record;
  }
  async partner(kind, record) {
    const endpoint = process.env[`VIRTUALYARD_${kind.toUpperCase()}_API_URL`];
    if (!endpoint) fail(503, `Virtual Yard ${kind} integration is not configured. The local record is saved; no external success is claimed.`);
    if (new URL(endpoint).protocol !== 'https:') fail(503, 'Virtual Yard integration endpoints must use HTTPS.');
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.VIRTUALYARD_API_TOKEN || ''}`,
      'Idempotency-Key': record.dealId || record.event_id || String(record._id) }, body: JSON.stringify(record), signal: AbortSignal.timeout(20000) });
    const result = await response.json();
    if (!response.ok || result.success !== true || !result.externalId) fail(502, 'Virtual Yard did not confirm an external record ID.');
    return result;
  }
  async pushDeal(value, user) {
    const deal = await this.record('deals', value, user);
    if (deal.virtualYard?.status === 'Pushed') return deal;
    const claim = await this.lead.collection('deals').updateOne({ _id: deal._id, 'virtualYard.status': { $in: ['Pending Sync', 'Failed'] } }, { $set: { 'virtualYard.status': 'Sending' } });
    if (!claim.modifiedCount) fail(409, 'Sync is already in progress or awaiting confirmation.');
    try {
      const result = await this.partner('deal', deal);
      const virtualYard = { status: 'Pushed', virtualYardOrderId: String(result.externalId), pushedAt: new Date() };
      await this.lead.collection('deals').updateOne({ _id: deal._id }, { $set: { virtualYard, status: 'DMS Synced' } });
      return { ...deal, virtualYard, status: 'DMS Synced' };
    } catch (error) {
      // Provider idempotency key is stable; an uncertain result is never shown as success.
      await this.lead.collection('deals').updateOne({ _id: deal._id }, { $set: { 'virtualYard.status': 'Failed', 'virtualYard.syncMessage': error.message } });
      throw error;
    }
  }
  async call(value, input, user) {
    const lead = await this.record('leads', value, user);
    if (!String(input.outcome || '').trim()) fail(400, 'Call outcome is required.');
    const event = await this.event(lead, user, 'Phone call', String(input.notes || input.outcome), { outcome: input.outcome, direction: input.direction || 'Outbound' });
    await this.lead.collection('leads').updateOne({ _id: lead._id }, { $set: { lastContactAt: new Date(), aiPaused: true, humanTakeoverAt: new Date(), ...(/quote sent/i.test(input.outcome) ? { lastQuoteAt: new Date() } : {}) } });
    try {
      const synced = await this.partner('call', { ...event, vyCustomerId: lead.vyCustomerId });
      const virtualyardSync = { state: 'synced', externalId: synced.externalId };
      await this.panel.collection('timelineevents').updateOne({ event_id: event.event_id }, { $set: { virtualyardSync } });
      return { ...event, virtualyardSync };
    }
    catch (error) {
      await this.panel.collection('timelineevents').updateOne({ event_id: event.event_id }, { $set: { virtualyardSync: { state: 'failed', message: error.message } } });
      return { ...event, virtualyardSync: { state: 'failed', message: error.message } };
    }
  }
  async signedContract(input) {
    if (!input.eventId || !input.externalOrderId || !input.contractId || !input.signedAt || !Number.isFinite(Date.parse(input.signedAt))) fail(400, 'Signed contract event, order, contract ID and timestamp are required.');
    const deal = await this.lead.collection('deals').findOne({ 'virtualYard.virtualYardOrderId': String(input.externalOrderId) });
    if (!deal) fail(404, 'No registered deal matches this Virtual Yard order.');
    if (deal.contractId && deal.contractId !== String(input.contractId)) fail(409, 'A different signed contract is already attached to this order.');
    const clientId = new ObjectId(sha(`delivery:${input.externalOrderId}`).slice(0, 24));
    const client = { name: deal.buyerName, phone: deal.buyerPhone, email: deal.buyerEmail, vehicle: deal.vehicle.model, vin: deal.vehicle.vin,
      site_location: deal.site, site: deal.site, salesperson: deal.consultantName, consultantId: deal.consultantId, owner_user_id: deal.consultantId,
      vy_order_id: String(input.externalOrderId), contractId: String(input.contractId), contractSignedAt: new Date(input.signedAt),
      crm_customer_id: deal.customerId, dealId: deal.dealId, stage: 'Scheduled', status: 'Scheduled', accessories: [], pdiComplete: false, createdAt: new Date() };
    await this.panel.collection('clients').updateOne({ _id: clientId }, { $setOnInsert: client }, { upsert: true });
    await this.lead.collection('deals').updateOne({ _id: deal._id }, { $set: { contractSignedAt: new Date(input.signedAt), contractId: input.contractId,
      'virtualYard.status': 'Contract Signed', delivery: { deliveryClientId: String(clientId), status: 'Scheduled' } } });
    if (deal.customerId) await this.panel.collection('customers').updateOne({ customer_id: deal.customerId }, { $set: { delivery_client_id: String(clientId), current_stage: 'In Delivery' } });
    if (deal.leadId) await this.lead.collection('leads').updateOne({ _id: reference(deal.leadId) }, { $set: { stage: 'COMMITTED', status: 'sold', contractSignedAt: new Date(input.signedAt) } });
    await this.panel.collection('timelineevents').updateOne({ _id: sha(`contract:${input.eventId}`) }, { $setOnInsert: {
      event_id: `CONTRACT-${input.eventId}`, customer_id: deal.customerId, leadId: deal.leadId, dealId: deal.dealId, site: deal.site,
      owner_user_id: deal.consultantId, title: 'Virtual Yard contract signed', type: 'Contract signed', body: `Contract ${input.contractId} signed; delivery job created.`, occurred_at: new Date(input.signedAt), createdAt: new Date() } }, { upsert: true });
    return this.panel.collection('clients').findOne({ _id: clientId });
  }
  async deliveryUpdate(value, input, user) {
    const client = await this.record('clients', value, user);
    if (client.deliveredAt) fail(409, 'Completed delivery jobs cannot be changed.');
    const contractor = user.role === 'contractor';
    if (!p.isManager(user) && !['delivery', 'delivery_consultant', 'contractor'].includes(user.role)) fail(403, 'Delivery or management access required.');
    const permitted = ['delivery_date', 'pdiComplete', 'accessories', 'assigned_agent_id'];
    if (Object.keys(input).some(k => !permitted.includes(k))) fail(400, 'Unsupported delivery update.');
    if (contractor && Object.keys(input).some(k => k !== 'accessories')) fail(403, 'Contractors can only update their assigned accessory work.');
    if ('pdiComplete' in input && typeof input.pdiComplete !== 'boolean') fail(400, 'Invalid PDI status.');
    if ('delivery_date' in input && !Number.isFinite(Date.parse(input.delivery_date))) fail(400, 'Enter a valid delivery date/time.');
    if (input.accessories) {
      if (!Array.isArray(input.accessories) || input.accessories.length > 50) fail(400, 'Invalid accessory list.');
      const providedIds = input.accessories.map(row => row.id || row._id).filter(Boolean).map(String);
      if (new Set(providedIds).size !== providedIds.length) fail(400, 'Each accessory must have a distinct job ID.');
      for (const accessory of input.accessories) {
        const original = (client.accessories || []).find(row => String(row.id || row._id) === String(accessory.id || accessory._id));
        if (contractor && (!original || original.contractorId !== user.id) && JSON.stringify(accessory) !== JSON.stringify(original)) fail(403, 'Only assigned accessory work can be changed.');
        if (contractor && original?.contractorId === user.id && (accessory.contractorId !== user.id || accessory.name !== original.name)) fail(403, 'Contractors cannot rename or reassign jobs.');
        if (!accessory.id && !accessory._id) accessory.id = String(new ObjectId());
        if (!accessory.name || !['Pending Order', 'Ordered', 'On Hand', 'Fitted'].includes(accessory.status)) fail(400, 'Accessory name and valid status required.');
        if (accessory.proofId) {
          const proof = await this.panel.collection('floor_media').findOne({ _id: reference(accessory.proofId), clientId: id(client), accessoryId: String(accessory.id || accessory._id) });
          if (!proof || proof.kind !== 'image') fail(400, 'Upload a completion photo for this delivery.');
          if (contractor && original?.contractorId === user.id && proof.owner_user_id !== user.id) fail(403, 'Capture your own completion photo for the assigned job.');
        }
      }
      if (contractor && input.accessories.length !== (client.accessories || []).length) fail(403, 'Contractors cannot add or remove accessory jobs.');
      for (const accessory of input.accessories) {
        if (accessory.contractorId) {
          const person = await this.panel.collection('users').findOne({ _id: reference(accessory.contractorId), role: 'contractor', active: { $ne: false }, deleted_at: null });
          if (!person || siteKey(person.site) !== siteKey(client.site_location || client.site)) fail(400, 'Choose an active contractor at this site.');
        }
      }
      input = { ...input, contractorIds: [...new Set(input.accessories.map(row => row.contractorId).filter(Boolean))] };
    }
    await this.panel.collection('clients').updateOne({ _id: client._id }, { $set: { ...input, updatedAt: new Date() } });
    return { ...client, ...input };
  }
  async handover(value, user) {
    const client = await this.record('clients', value, user);
    if (!p.isManager(user) && !['delivery', 'delivery_consultant'].includes(user.role)) fail(403, 'Delivery or management access required.');
    if (!client.contractSignedAt || !client.pdiComplete || (client.accessories || []).some(a => a.status !== 'Fitted' || !a.proofId)) fail(409, 'Signed contract, PDI and fitted accessories with photo proof must be complete before handover.');
    for (const accessory of client.accessories || []) {
      if (!await this.panel.collection('floor_media').findOne({ _id: reference(accessory.proofId), clientId: id(client), accessoryId: String(accessory.id || accessory._id), kind: 'image' })) fail(409, 'Each accessory must have its own uploaded completion photo.');
    }
    await this.panel.collection('clients').updateOne({ _id: client._id, deliveredAt: { $in: [null] } }, { $set: { deliveredAt: new Date(), stage: 'Delivered', status: 'Delivered' } });
    const at = (await this.panel.collection('clients').findOne({ _id: client._id })).deliveredAt;
    const config = await this.config(client.site_location || client.site);
    await require('./floorJourney').enroll(this, { ...client, deliveredAt: at }, config);
    if (client.dealId) {
      const deal = await this.lead.collection('deals').findOne({ dealId: client.dealId });
      await this.lead.collection('deals').updateOne({ dealId: client.dealId }, { $set: { status: 'Won / Delivered', deliveredAt: at } });
      if (deal?.inventoryId) await this.lead.collection('inventories').updateOne({ _id: reference(deal.inventoryId), dealId: deal.dealId }, { $set: { status: 'Sold' } });
      if (deal?.leadId) await this.lead.collection('leads').updateOne({ _id: reference(deal.leadId) }, { $set: { stage: 'DELIVERED', status: 'sold', deliveredAt: at } });
    }
    return { ...client, stage: 'Delivered', deliveredAt: at, journey: 'Enrolled; messages require staff approval' };
  }

  async sendMessage(value, input, user, journeyId, expectedPhone) {
    const lead = await this.record('leads', value, user), site = lead.dealer || lead.site;
    if (expectedPhone && String(lead.phone || '').replace(/\D/g, '').slice(-9) !== String(expectedPhone).replace(/\D/g, '').slice(-9)) fail(409, 'The customer mobile changed. Refresh and review the recipient before approving.');
    const customerId = lead.customerId || lead.customer_id;
    const customer = customerId ? await this.panel.collection('customers').findOne({ customer_id: customerId }) : null;
    if (lead.do_not_contact || lead.consent_sms === false || lead.opted_out || lead.tag === 'Opted Out' || lead.stage === 'OPTED OUT' || customer?.do_not_contact || customer?.opted_out || customer?.consent_sms === false) fail(409, 'Customer has opted out of SMS.');
    let body = String(input.body || '').trim();
    if (!body || body.length > 4000) fail(400, 'Enter a message between 1 and 4000 characters.');
    if (input.aiDraft === true) p.assertAiReply(body);
    const config = await this.config(site), sms = require('./mobileMessage');
    if (!config.smsSenderId) fail(503, 'Configure a verified SMS sender for this site first.');
    const gateway = await sms.getConfig();
    if (gateway.simulationMode || !gateway.username || !gateway.password) fail(503, 'Live SMS credentials are required. Simulated sending is disabled for this workflow.');
    const media = [];
    for (const mediaId of input.mediaIds || []) {
      const item = await this.panel.collection('floor_media').findOne({ _id: reference(mediaId), leadId: id(lead) });
      if (!item) fail(404, 'Media attachment not found for this customer.');
      media.push(item); body += `\n${item.publicUrl}`;
    }
    if (!/^[\w-]{8,100}$/.test(String(input.requestId || ''))) fail(400, 'A stable message request ID is required.');
    // Journey IDs are selected internally after the draft is atomically claimed.
    // A different approving staff member must resolve the same provider submission.
    const key = sha(`${journeyId ? `journey:${journeyId}` : user.id}:${input.requestId}`), fingerprint = sha(`${id(lead)}:${body}`), requests = this.panel.collection('floor_sms_requests');
    const previous = await requests.findOne({ _id: key });
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail(409, 'This send request has already been used.');
      if (previous.state === 'sent') {
        await this.projectMessage(lead, user, body, media, previous.result, key, previous.createdAt);
        return previous.result;
      }
      fail(409, 'The message may already have been submitted. Check the conversation before sending again.');
    }
    await new (require('./floorCommunications').FloorCommunications)(this, sms).assertSender(config.smsSenderId);
    const sentAt = new Date();
    try { await requests.insertOne({ _id: key, fingerprint, state: 'sending', site, owner_user_id: user.id, createdAt: sentAt }); }
    catch (error) { if (error.code === 11000) fail(409, 'This message is already being submitted.'); throw error; }
    let result;
    try { result = await sms.sendSms({ to: lead.phone, message: body, sender: config.smsSenderId, useSiteSender: true, customRef: id(lead), idempotencyKey: key, requestedBy: user.id }); }
    catch (error) { await requests.updateOne({ _id: key }, { $set: { state: 'unknown', message: error.message } }); throw error; }
    if (result.simulated || !result.messageId) {
      await requests.updateOne({ _id: key }, { $set: { state: 'unknown', message: 'SMS provider did not confirm the message.' } });
      fail(502, 'SMS provider did not confirm the message.');
    }
    await requests.updateOne({ _id: key }, { $set: { state: 'sent', result } });
    await this.projectMessage(lead, user, body, media, result, key, sentAt);
    return result;
  }

  // A confirmed provider result is durable before updating local views. Replaying
  // the same request repairs interrupted projections without sending another SMS.
  async projectMessage(lead, user, body, media, result, key, sentAt) {
    const site = lead.dealer || lead.site, at = new Date(sentAt);
    await this.panel.collection('messages').updateOne({ _id: `floor-sms-${key}` }, { $setOnInsert: {
      client_name: lead.name, phone: lead.phone, site, body, direction: 'outbound', status: result.status,
      provider: 'mobilemessage', provider_message_id: result.messageId, sent_by_id: user.id, sent_by_name: user.name, sent_at: at,
    } }, { upsert: true });
    const conversationId = new ObjectId(sha(`${siteKey(site)}:${require('./threadHistory').phoneKey(lead.phone)}`).slice(0, 24));
    const conversations = this.lead.collection('conversations');
    await conversations.updateOne({ _id: conversationId }, { $setOnInsert: { leadId: id(lead), dealer: site, createdAt: at, messages: [], msgCount: 0 } }, { upsert: true });
    const message = { id: result.messageId, sender: 'agent', text: body, time: at.toISOString(), createdAt: at, status: result.status, mediaIds: media.map(id) };
    await conversations.updateOne({ _id: conversationId, 'messages.id': { $ne: result.messageId } }, { $push: { messages: message }, $inc: { msgCount: 1 },
      $set: { prospectName: lead.name, phone: lead.phone, control: 'Human' } });
    await conversations.updateOne({ _id: conversationId, $or: [{ lastMessageAt: { $exists: false } }, { lastMessageAt: { $lte: at } }] }, { $set: { lastMessage: body, lastMessageAt: at } });
    await this.lead.collection('leads').updateOne({ _id: lead._id }, { $max: { lastContactAt: at, humanTakeoverAt: at }, $set: { aiPaused: true } });
    const type = media.some(m => m.kind === 'video') ? 'Video sent' : 'SMS sent';
    await this.panel.collection('timelineevents').updateOne({ _id: `floor-sms-${key}` }, { $setOnInsert: {
      event_id: `SMS-${key}`, leadId: id(lead), customer_id: lead.customerId, site, owner_user_id: lead.owner_user_id || user.id,
      owner_name: lead.allocatedPersonFullName || user.name, author_name: user.name, type, title: type, body, content: body,
      occurred_at: at, createdAt: at, providerMessageId: result.messageId,
    } }, { upsert: true });
  }

  async approveFollowup(value, user, expectedReview) {
    const queue = this.panel.collection('floor_followups');
    const draft = await queue.findOne(and(p.scope(user, {}, ['site']), { _id: String(value) }));
    if (!draft) fail(404, 'Follow-up not found.');
    if (draft.status === 'sent') return draft;
    if (expectedReview && expectedReview !== require('./floorJourney').reviewToken(draft)) fail(409, 'This message or recipient changed. Refresh and review it before approving.');
    if (draft.status !== 'awaiting_approval' || new Date(draft.dueAt) > new Date()) fail(409, 'This follow-up is not ready to send.');
    const client = await this.record('clients', draft.clientId, user);
    if (client.opted_out || client.do_not_contact || client.consent_sms === false) fail(409, 'Customer has opted out of SMS.');
    if (client.deliveredAt && draft.key) {
      const config = await this.config(client.site_location || client.site);
      const current = require('./floorJourney').preview(config, client, client.deliveredAt).find(step => step.key === draft.key);
      if (!current || current.needsConfiguration || current.body !== draft.body || Number(new Date(current.dueAt)) !== Number(new Date(draft.dueAt))) fail(409, 'Journey configuration has changed. Save site settings and review the refreshed message before approving.');
    }
    if (!client.crm_customer_id) fail(409, 'Link this delivery to its customer lead before sending.');
    const lead = await this.lead.collection('leads').findOne(and(this.filter(user), { $or: [{ customerId: client.crm_customer_id }, { customer_id: client.crm_customer_id }] }));
    if (!lead) fail(409, 'Link this delivery to its customer lead before sending.');
    if (!lead.phone) fail(409, 'A customer mobile is required before approving a journey SMS.');
    if (!draft.phone || String(draft.phone).replace(/\D/g, '').slice(-9) !== String(lead.phone).replace(/\D/g, '').slice(-9)) {
      await queue.updateOne({ _id: draft._id, status: 'awaiting_approval' }, { $set: { phone: lead.phone, recipientUpdatedAt: new Date(), recipientUpdatedBy: user.id } });
      fail(409, 'The customer mobile changed. Refresh and review the updated recipient before approving.');
    }
    if (draft.needsConfiguration || !String(draft.body || '').trim()) fail(409, 'Complete the journey configuration before sending.');
    const claimed = await queue.updateOne({ _id: draft._id, status: 'awaiting_approval', body: draft.body, phone: draft.phone, dueAt: draft.dueAt }, { $set: { status: 'sending', approvedBy: user.id, approvedAt: new Date(), approvedReviewToken: require('./floorJourney').reviewToken(draft) } });
    if (!claimed.modifiedCount) fail(409, 'This follow-up changed or is already being sent. Refresh before approving.');
    try {
      const result = await this.sendMessage(id(lead), { body: draft.body, requestId: `journey-${draft._id}` }, user, draft._id, draft.phone);
      const patch = { status: 'sent', sentAt: new Date(), providerMessageId: result.messageId, deliveryStatus: result.status };
      await queue.updateOne({ _id: draft._id, status: 'sending' }, { $set: patch, $unset: { error: '' } });
      return { ...draft, ...patch };
    } catch (error) {
      const request = await this.panel.collection('floor_sms_requests').findOne({ _id: sha(`journey:${draft._id}:journey-${draft._id}`) });
      // Validation failures before submission can be corrected. An interrupted
      // submission is held for reconciliation, never offered as another send.
      if (request?.state === 'sent' && request.result?.messageId) {
        const patch = { status: 'sent', providerMessageId: request.result.messageId, deliveryStatus: request.result.status, sentAt: request.createdAt };
        await queue.updateOne({ _id: draft._id }, { $set: patch });
        return { ...draft, ...patch };
      }
      await queue.updateOne({ _id: draft._id, status: 'sending' }, { $set: { status: request ? 'unknown' : 'awaiting_approval', error: error.message } });
      throw error;
    }
  }
}

module.exports = { SalesFloorOperations };
