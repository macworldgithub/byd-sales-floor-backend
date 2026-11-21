const { ObjectId } = require('mongoose').mongo;
const crypto = require('node:crypto');
const { fail, siteKey, canonicalSite, hasPlatform } = require('./accountAccess');
const { siteRegex } = require('./staffDirectory');

const reference = value => /^[a-f\d]{24}$/i.test(String(value || '')) ? new ObjectId(String(value)) : value;
async function assignee(panel, input) {
  const site = canonicalSite(input.site);
  if (!site || /^all/i.test(site)) fail(400, 'Select a dealership before allocating a lead.');
  const directory = await panel.collection('users').find({ active: { $ne: false }, deleted_at: null }).toArray();
  const idMatch = input.assigned_to_user_id && directory.some(person => String(person._id) === input.assigned_to_user_id);
  // Older Lead Centre accounts can have different Mongo IDs in the two stores.
  // Resolve those through their unique account email, then save the floor ID.
  const selected = String(idMatch ? input.assigned_to_user_id : input.assigned_to || input.consultant || input.assigned_to_user_id || '').trim();
  if (!selected) fail(400, 'Select an active Sales Floor consultant.');
  const staff = directory;
  const matches = staff.filter(person => {
    const member = person.all_sites === true || [person.site, person.locked_site, ...(person.allowed_sites || [])].some(value => siteKey(value) === siteKey(site));
    return member && hasPlatform(person, 'sales_floor') && ['agent', 'consultant', 'sales_consultant', 'manager', 'sales_manager', 'site_admin', 'super_admin', 'admin', 'principal'].includes(person.role) &&
      [String(person._id), person.email, person.name].some(value => String(value || '').trim().toLowerCase() === selected.toLowerCase());
  });
  if (matches.length !== 1) fail(400, 'Choose one active Sales Floor consultant with access to this dealership.');
  return { site, person: matches[0] };
}

// Project the allocation onto the original enquiry. A failed projection must
// propagate to the caller; replaying a saved allocation repairs that projection.
async function project(lead, panel, allocation, input, person) {
  const leads = lead.collection('leads');
  const leadId = input.lead_prospect_id || allocation.lead_prospect_id;
  let record = leadId ? await leads.findOne({ _id: reference(leadId) }) : null;
  const generatedId = new ObjectId(crypto.createHash('sha256').update(`allocation-lead:${allocation.allocation_id}`).digest('hex').slice(0, 24));
  if (!record && !input.lead_prospect_id) record = await leads.findOne({ _id: generatedId });
  if (record && !siteRegex(allocation.site).test(record.dealer || record.site || record.dealerName || '')) fail(403, 'The enquiry belongs to another dealership.');
  if (record?.isArchived || record?.mergedInto) fail(409, 'This enquiry is archived or merged. It cannot be allocated.');
  // Never replace a missing explicit enquiry with a phone match or a new lead.
  if (input.lead_prospect_id && !record) fail(404, 'The original Lead Centre enquiry was not found. Refresh it before allocating again.');
  const now = new Date();
  const patch = { dealer: allocation.site, assignedTo: person.email, allocatedPersonFullName: person.name,
    owner_user_id: String(person._id), owner_name: person.name, allocation_id: allocation.allocation_id,
    customerId: allocation.customer_id, lastActivityAt: now, updatedAt: now };
  if (!record) {
    await leads.updateOne({ _id: generatedId }, { $setOnInsert: { ...patch, name: allocation.prospect_name, phone: allocation.phone || '', email: allocation.email || '',
      vehicle: allocation.vehicle_interest || '', source: allocation.source, platform: 'manual', stage: 'IN FOLLOW-UP', status: 'qualification',
      notes: input.notes || '', isArchived: false, createdAt: now } }, { upsert: true });
    record = { _id: generatedId };
  } else {
    // Preserve advanced pipeline stages, including already-booked test drives.
    if (['NEW ENQUIRIES', 'Imported', 'QUALIFIED', 'Qualified'].includes(record.stage)) patch.stage = 'IN FOLLOW-UP';
    if (['new', 'Assigned'].includes(record.status)) patch.status = 'qualification';
    await leads.updateOne({ _id: record._id }, { $set: patch });
  }
  const id = String(record._id);
  await panel.collection('allocations').updateOne({ allocation_id: allocation.allocation_id }, { $set: {
    lead_prospect_id: id, assigned_to_name: person.name, assigned_to_user_id: String(person._id), assigned_to_email: person.email,
    projection_state: 'pending', updatedAt: now } });
  if (allocation.customer_id) {
    await panel.collection('customers').updateOne({ customer_id: allocation.customer_id }, { $set: {
      lead_prospect_id: id, owner_user_id: String(person._id), owner_name: person.name, updatedAt: now } });
    await panel.collection('opportunities').updateMany({ customer_id: allocation.customer_id, stage: { $nin: ['Lost / Parked', 'Delivered / Won'] } },
      { $set: { lead_prospect_id: id, owner_user_id: String(person._id), owner_name: person.name, updatedAt: now } });
    const opportunities = panel.collection('opportunities');
    if (!await opportunities.findOne({ customer_id: allocation.customer_id, stage: { $nin: ['Lost / Parked', 'Delivered / Won'] } })) {
      await opportunities.updateOne({ _id: `allocation-opportunity:${allocation.allocation_id}` }, { $setOnInsert: {
        opportunity_id: `OPP-${allocation.allocation_id}`, customer_id: allocation.customer_id,
        customer_name: allocation.prospect_name, customer_phone: allocation.phone, customer_email: allocation.email,
        site: allocation.site, lead_prospect_id: id, owner_user_id: String(person._id), owner_name: person.name,
        stage: 'New / Allocated', model: allocation.vehicle_interest || '', vehicle_descriptor: allocation.vehicle_interest || '',
        source: allocation.source, total_price: null, list_price: null, createdAt: now, updatedAt: now,
      } }, { upsert: true });
    }
  }
  const eventId = `allocation:${allocation.allocation_id}:${person._id}`;
  await panel.collection('timelineevents').updateOne({ event_id: eventId }, { $setOnInsert: {
    event_id: eventId, customer_id: allocation.customer_id, leadId: id, site: allocation.site,
    owner_user_id: String(person._id), owner_name: person.name, type: 'assignment', title: 'Salesperson assigned',
    body: `Enquiry allocated to ${person.name}.`, occurred_at: now, createdAt: now,
  } }, { upsert: true });
  await panel.collection('floor_notifications').updateOne({ _id: eventId }, { $setOnInsert: {
    leadId: id, customerId: allocation.customer_id, site: allocation.site, assignedTo: person.email,
    owner_user_id: String(person._id), owner_name: person.name, type: 'assignment',
    title: `New enquiry: ${record.name || allocation.prospect_name}`, body: 'A lead has been assigned to you. Open the customer card to respond.',
    read: false, pushState: 'pending', createdAt: now,
  } }, { upsert: true });
  await panel.collection('allocations').updateOne({ allocation_id: allocation.allocation_id }, { $set: { projection_state: 'complete', updatedAt: new Date() } });
  return { ...allocation, lead_prospect_id: id, assigned_to_name: person.name, assigned_to_user_id: String(person._id), assigned_to_email: person.email, projection_state: 'complete' };
}
async function recover(lead, panel, query, user, apply = false) {
  const scope = require('./floorBrowsing').accountScope(user);
  const filter = { $and: [require('./crmBrowsing').siteScope(query, scope),
    { status: { $in: ['pending', 'accepted', 'escalated'] }, projection_state: { $ne: 'complete' } }] };
  const allocations = await panel.collection('allocations').find(filter).sort({ createdAt: -1 }).limit(100).toArray();
  const items = [];
  for (const allocation of allocations) {
    try {
      const { person } = await assignee(panel, { site: allocation.site, assigned_to: allocation.assigned_to_user_id || allocation.assigned_to_email || allocation.assigned_to_name });
      const enquiry = await lead.collection('leads').findOne({ _id: reference(allocation.lead_prospect_id) });
      if (!enquiry || enquiry.isArchived || enquiry.mergedInto) fail(409, 'Original enquiry is missing, archived or merged; review it manually.');
      if (!siteRegex(allocation.site).test(enquiry.dealer || enquiry.site || enquiry.dealerName || '')) fail(403, 'The enquiry belongs to another dealership.');
      if (enquiry.assignedTo && ![person.email, person.name, String(person._id)].includes(enquiry.assignedTo)) fail(409, 'A different salesperson now owns this enquiry; its assignment was preserved.');
      if (apply) await project(lead, panel, allocation, { lead_prospect_id: allocation.lead_prospect_id }, person);
      items.push({ allocation_id: allocation.allocation_id, name: allocation.prospect_name, salesperson: person.name, status: apply ? 'recovered' : 'ready' });
    } catch (error) { items.push({ allocation_id: allocation.allocation_id, name: allocation.prospect_name, status: 'review', message: error.message }); }
  }
  return { items, scanned: allocations.length, recovered: items.filter(item => item.status === 'recovered').length,
    ready: items.filter(item => item.status === 'ready').length, review: items.filter(item => item.status === 'review').length };
}
module.exports = { reference, assignee, project, recover };
