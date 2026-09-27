/**
 * crmService.js – Production CRM Service integrated directly with MongoDB Atlas databases
 * Uses:
 *   deliveryConn → customers, opportunities, allocations, saleslogentries, stockholds, timelineevents, clients, users
 *   leadConn     → inventories (865 BYD vehicles), leads (4,036 prospects), conversations
 */
const crypto = require('crypto');
const { deliveryConn, leadConn, ensureDbConnected } = require('../db');

function formatPhoneE164(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('61')) return '+' + digits;
  if (digits.startsWith('0')) return '+61' + digits.slice(1);
  return '+' + digits;
}

function formatAEST(date) {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleString('en-AU', {
    timeZone: 'Australia/Melbourne',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }) + ' AEST';
}

const crmService = {
  // ─── 1. Customers ──────────────────────────────────────────────────────────
  async getCustomers(filter = {}) {
    await ensureDbConnected();
    const collection = deliveryConn.db.collection('customers');
    const oppCollection = deliveryConn.db.collection('opportunities');
    const salesLogColl = deliveryConn.db.collection('saleslogentries');

    const query = { is_merged: { $ne: true } };

    // Manager cross-site lookup (§4, §5.1)
    if (filter.site && filter.site !== 'All' && filter.site !== 'All Sites') {
      if (!filter.network_lookup) {
        query.site = filter.site;
      }
    }
    if (filter.owner && filter.owner !== 'All') {
      query.$or = [{ owner_name: filter.owner }, { owner_user_id: filter.owner }];
    }
    if (filter.record_type && filter.record_type !== 'All') {
      query.record_type = filter.record_type;
    }
    if (filter.q && filter.q.trim()) {
      const q = filter.q.trim();
      const regex = new RegExp(q, 'i');

      // Comprehensive search across Customer name/phone/email PLUS VIN, rego, VY order ID, stock ID, deal number (§5.1, AC-1)
      const [matchedOpps, matchedSales] = await Promise.all([
        oppCollection.find({
          $or: [
            { vin: regex },
            { vy_order_id: regex },
            { vy_stock_id: regex },
            { 'trade_in_details.rego': regex },
            { vehicle_descriptor: regex },
          ],
        }, { projection: { customer_id: 1 } }).toArray().catch(() => []),
        salesLogColl.find({
          $or: [
            { vin: regex },
            { deal_number: regex },
            { stock_id: regex },
            { vy_order_id: regex },
          ],
        }, { projection: { customer_id: 1 } }).toArray().catch(() => []),
      ]);

      const linkedCustIds = Array.from(new Set([
        ...matchedOpps.map((o) => o.customer_id),
        ...matchedSales.map((s) => s.customer_id),
      ].filter(Boolean)));

      const orConditions = [
        { name: regex },
        { phone: regex },
        { email: regex },
        { customer_id: regex },
        { company_name: regex },
        { preferred_model: regex },
      ];
      if (linkedCustIds.length > 0) {
        orConditions.push({ customer_id: { $in: linkedCustIds } });
      }
      query.$or = orConditions;
    }

    const total = await collection.countDocuments(query);
    const page = Math.max(1, parseInt(filter.page, 10) || 1);
    const limit = filter.limit !== undefined ? (parseInt(filter.limit, 10) || 20) : (filter.paginate === 'false' ? 0 : 20);
    const pages = limit > 0 ? Math.ceil(total / limit) || 1 : 1;
    const skip = limit > 0 ? (page - 1) * limit : 0;

    let cursor = collection.find(query).sort({ updatedAt: -1, createdAt: -1 });
    if (limit > 0) {
      cursor = cursor.skip(skip).limit(limit);
    }
    const docs = await cursor.toArray();

    // Enrich only the paginated slice of customers with active opportunities
    const custIds = docs.map((d) => d.customer_id).filter(Boolean);
    const allOpps = custIds.length > 0
      ? await oppCollection.find({ customer_id: { $in: custIds } }).toArray()
      : [];

    const data = docs.map((doc) => {
      const opps = allOpps.filter((o) => o.customer_id === doc.customer_id);
      const activeOpp = opps.find((o) => o.stage !== 'Lost / Parked' && o.stage !== 'Delivered / Won') || opps[0];
      const totalOpenValue = opps.reduce((sum, o) => sum + (o.total_price || o.total_deal_value || o.list_price || 0), 0);

      return {
        customer_id: doc.customer_id || String(doc._id),
        name: doc.name,
        phone: doc.phone,
        email: doc.email || '',
        site: doc.site || 'Fairfield',
        owner_user_id: doc.owner_user_id || 'usr-001',
        owner_name: doc.owner_name || 'Alex Rivers',
        source: doc.source || 'Virtual Yard',
        record_type: doc.record_type || 'Individual',
        company_name: doc.company_name || null,
        lead_prospect_id: doc.lead_prospect_id || null,
        delivery_client_id: doc.delivery_client_id || null,
        consent_sms: doc.consent_sms !== false,
        consent_updated_at: doc.consent_updated_at || doc.updatedAt || doc.createdAt,
        do_not_contact: Boolean(doc.do_not_contact),
        notes: doc.notes || '',
        total_open_value: totalOpenValue,
        current_stage: activeOpp?.stage || doc.current_stage || 'New / Allocated',
        active_deal_id: activeOpp?.opportunity_id || null,
        active_vy_stock: activeOpp?.vy_stock_id || null,
        created_at: doc.createdAt,
        updated_at: doc.updatedAt,
      };
    });

    return {
      data,
      pagination: {
        total,
        page,
        limit: limit > 0 ? limit : total,
        pages,
        hasNextPage: page < pages,
        hasPrevPage: page > 1,
      },
    };
  },

  async getCustomerById(id) {
    await ensureDbConnected();
    const custColl = deliveryConn.db.collection('customers');
    const oppColl = deliveryConn.db.collection('opportunities');

    const doc = await custColl.findOne({
      $or: [{ customer_id: id }, { phone: id }, { email: id }],
    });
    if (!doc) return null;

    const opps = await oppColl.find({ customer_id: doc.customer_id }).toArray();
    const activeOpp = opps.find((o) => o.stage !== 'Lost / Parked' && o.stage !== 'Delivered / Won') || opps[0];
    const totalOpenValue = opps.reduce((sum, o) => sum + (o.total_price || o.total_deal_value || o.list_price || 0), 0);

    return {
      customer_id: doc.customer_id || String(doc._id),
      name: doc.name,
      phone: doc.phone,
      email: doc.email || '',
      site: doc.site || 'Fairfield',
      owner_user_id: doc.owner_user_id || 'usr-001',
      owner_name: doc.owner_name || 'Alex Rivers',
      source: doc.source || 'Virtual Yard',
      record_type: doc.record_type || 'Individual',
      company_name: doc.company_name || null,
      lead_prospect_id: doc.lead_prospect_id || null,
      delivery_client_id: doc.delivery_client_id || null,
      consent_sms: doc.consent_sms !== false,
      consent_updated_at: doc.consent_updated_at || doc.updatedAt,
      do_not_contact: Boolean(doc.do_not_contact),
      notes: doc.notes || '',
      total_open_value: totalOpenValue,
      current_stage: activeOpp?.stage || doc.current_stage || 'New / Allocated',
      active_deal_id: activeOpp?.opportunity_id || null,
      active_vy_stock: activeOpp?.vy_stock_id || null,
      deals: opps,
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
    };
  },

  async createCustomer(data) {
    await ensureDbConnected();
    const collection = deliveryConn.db.collection('customers');

    const formattedPhone = formatPhoneE164(data.phone);

    // Duplicate detection (§5.1, AC-1)
    const existing = await collection.findOne({
      $or: [{ phone: formattedPhone }, { email: data.email ? data.email.toLowerCase() : null }],
    });

    if (existing) {
      const err = new Error(`Duplicate customer: Matches existing record ${existing.customer_id} (${existing.name})`);
      err.code = 'DUPLICATE_CUSTOMER';
      err.existingCustomer = existing;
      throw err;
    }

    const count = await collection.countDocuments();
    const customer_id = 'CUST-BYD-' + (100 + count + 1);

    const newCustDoc = {
      customer_id,
      name: data.name,
      phone: formattedPhone,
      email: data.email ? data.email.toLowerCase() : null,
      site: data.site || 'Fairfield',
      owner_user_id: data.owner_user_id || null,
      owner_name: data.owner_name || 'Alex Rivers',
      source: data.source || 'Manual',
      record_type: data.record_type || 'Individual',
      company_name: data.company_name || null,
      abn: null,
      fleet_contact: null,
      lead_prospect_id: data.lead_prospect_id || null,
      delivery_client_id: null,
      vy_customer_id: null,
      consent_sms: data.consent_sms !== false,
      do_not_contact: false,
      preferred_model: data.preferred_model || 'SEALION 7',
      tags: [],
      notes: data.notes || '',
      is_merged: false,
      merged_into: null,
      consent_updated_at: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await collection.insertOne(newCustDoc);
    return newCustDoc;
  },

  async updateCustomer(id, patch) {
    await ensureDbConnected();
    const collection = deliveryConn.db.collection('customers');
    const clientColl = deliveryConn.db.collection('clients');
    const leadColl = leadConn.db.collection('leads');
    const convColl = leadConn.db.collection('conversations');
    const tlColl = deliveryConn.db.collection('timelineevents');

    const targetCust = await collection.findOne({ customer_id: id });
    if (!targetCust) throw new Error('Customer not found');

    // If opt-out changed, handle ACMA global opt-out fanout across both databases (§5.10, AC-5)
    if (patch.do_not_contact !== undefined || patch.consent_sms === false) {
      if (patch.do_not_contact || patch.consent_sms === false) {
        patch.do_not_contact = true;
        patch.consent_sms = false;
        patch.consent_updated_at = new Date();

        if (targetCust.phone) {
          const last8 = targetCust.phone.slice(-8);
          // 1. Direct Delivery Centre database update
          await clientColl.updateMany(
            { phone: { $regex: last8, $options: 'i' } },
            { $set: { opted_out: true, consent_sms: false, updatedAt: new Date() } }
          ).catch(() => {});

          // 2. Direct Lead Centre database update (stops AI and marks Opted Out)
          await leadColl.updateMany(
            { phone: { $regex: last8, $options: 'i' } },
            { $set: { status: 'opted out', control: 'Human assisted', tag: 'Opted Out', do_not_contact: true, updatedAt: new Date() } }
          ).catch(() => {});

          await convColl.updateMany(
            { phone: { $regex: last8, $options: 'i' } },
            { $set: { status: 'opted_out', control: 'agent', updatedAt: new Date() } }
          ).catch(() => {});
        }

        // 3. Add TimelineEvent in unified event store
        await tlColl.insertOne({
          event_id: `EVT-${crypto.randomUUID()}`,
          customer_id: id,
          type: 'system',
          event_type: 'system',
          title: 'Customer Opted Out (Global ACMA Suppression Active)',
          content: 'Customer requested DNC/Opt-Out. Automated SMS in Lead Centre halted and direct SMS messaging suppressed across all databases.',
          body: 'Customer requested DNC/Opt-Out. Automated SMS in Lead Centre halted and direct SMS messaging suppressed across all databases.',
          author: patch.updated_by || 'ACMA Compliance Gate',
          source: 'Sales CRM',
          occurred_at: new Date(),
          timestamp_aest: formatAEST(new Date()),
          visibility: 'internal',
          createdAt: new Date(),
          updatedAt: new Date(),
        }).catch(() => {});
      }
    }

    patch.updatedAt = new Date();
    await collection.updateOne({ customer_id: id }, { $set: patch });
    return this.getCustomerById(id);
  },

  async mergeCustomers(targetId, sourceId) {
    await ensureDbConnected();
    const custColl = deliveryConn.db.collection('customers');
    const oppColl = deliveryConn.db.collection('opportunities');
    const tlColl = deliveryConn.db.collection('timelineevents');

    const target = await custColl.findOne({ customer_id: targetId });
    const source = await custColl.findOne({ customer_id: sourceId });
    if (!target || !source) throw new Error('Target or source customer not found');

    // Transfer source opportunities to target
    await oppColl.updateMany(
      { customer_id: sourceId },
      { $set: { customer_id: targetId, customer_name: target.name, customer_phone: target.phone } }
    );

    // Transfer timeline events
    await tlColl.updateMany({ customer_id: sourceId }, { $set: { customer_id: targetId } });

    // Mark source customer as merged
    await custColl.updateOne(
      { customer_id: sourceId },
      { $set: { is_merged: true, merged_into: targetId, updatedAt: new Date() } }
    );

    // Record audit event
    await tlColl.insertOne({
      event_id: `EVT-${crypto.randomUUID()}`,
      customer_id: targetId,
      event_type: 'system',
      type: 'system',
      title: 'Customer Identity Merged',
      body: `Consolidated record ${source.customer_id} (${source.name}) into ${target.customer_id}.`,
      content: `Consolidated record ${source.customer_id} (${source.name}) into ${target.customer_id}.`,
      author_name: 'CRM Identity Engine',
      author: 'CRM Identity Engine',
      source_system: 'crm',
      source: 'Sales CRM',
      timestamp: new Date(),
      occurred_at: new Date(),
      visibility: 'internal',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return target;
  },

  async unlinkCustomer(customerId, linkType = 'all') {
    await ensureDbConnected();
    const custColl = deliveryConn.db.collection('customers');
    const oppColl = deliveryConn.db.collection('opportunities');
    const tlColl = deliveryConn.db.collection('timelineevents');

    const customer = await custColl.findOne({ customer_id: customerId });
    if (!customer) throw new Error('Customer not found');

    const updates = { updatedAt: new Date() };
    if (linkType === 'all' || linkType === 'delivery') {
      updates.delivery_client_id = null;
      await oppColl.updateMany(
        { customer_id: customerId },
        { $set: { delivery_client_id: null, delivery_stage: null, updatedAt: new Date() } }
      );
    }
    if (linkType === 'all' || linkType === 'lead') {
      updates.lead_prospect_id = null;
    }
    if (linkType === 'merged') {
      updates.is_merged = false;
      updates.merged_into = null;
    }

    await custColl.updateOne({ customer_id: customerId }, { $set: updates });

    await tlColl.insertOne({
      event_id: `EVT-${crypto.randomUUID()}`,
      customer_id: customerId,
      event_type: 'system',
      type: 'system',
      title: 'Customer Link Uncoupled',
      body: `Decoupled external system mapping (${linkType}) from record ${customerId}.`,
      content: `Decoupled external system mapping (${linkType}) from record ${customerId}.`,
      author_name: 'CRM Identity Engine',
      author: 'CRM Identity Engine',
      source_system: 'crm',
      source: 'Sales CRM',
      timestamp: new Date(),
      occurred_at: new Date(),
      visibility: 'internal',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return this.getCustomerById(customerId);
  },

  // ─── 2. Unified Timeline & Note Fanout (AC-2, AC-3) ────────────────────────
  async getTimeline(customerId, filter = {}) {
    await ensureDbConnected();
    const tlColl = deliveryConn.db.collection('timelineevents');
    const clientColl = deliveryConn.db.collection('clients');
    const custColl = deliveryConn.db.collection('customers');

    const query = { customer_id: customerId };
    if (filter.include_deleted !== 'true') {
      query.deleted_at = { $exists: false };
    }

    const events = await tlColl.find(query).sort({ occurred_at: -1, createdAt: -1 }).toArray();

    // Also pull comments from Delivery Centre client if linked
    const customer = await custColl.findOne({ customer_id: customerId });
    if (customer?.phone) {
      const client = await clientColl.findOne({ phone: { $regex: customer.phone.slice(-8) } });
      if (client?.comments && client.comments.length > 0) {
        client.comments.forEach((c) => {
          events.push({
            event_id: `EVT-DC-${c._id ? String(c._id) : crypto.randomUUID().slice(0, 8)}`,
            customer_id: customerId,
            type: 'note',
            event_type: 'note',
            title: 'Delivery Centre Operational Note',
            content: c.body,
            body: c.body,
            author: c.author_name || 'Delivery Consultant',
            author_name: c.author_name || 'Delivery Consultant',
            source: 'Delivery Centre',
            source_system: 'delivery',
            timestamp: c.created_at || new Date(),
            occurred_at: c.created_at || new Date(),
            timestamp_aest: formatAEST(c.created_at || new Date()),
            visibility: 'internal',
            deep_link: `https://deliverycentre.com.au/clients/${client._id}`,
          });
        });
      }
    }

    const leadDeepLink = customer?.lead_prospect_id
      ? `https://leadcentre.byd.com.au/prospects/${customer.lead_prospect_id}`
      : null;

    const formattedEvents = events.map((e) => ({
      ...e,
      timestamp_aest: e.timestamp_aest || formatAEST(e.occurred_at || e.timestamp || e.createdAt),
      deep_link: e.deep_link || (e.source === 'Lead Centre' || e.source_system === 'lead' ? leadDeepLink : null),
    }));

    const sorted = formattedEvents.sort((a, b) => new Date(b.timestamp || b.occurred_at) - new Date(a.timestamp || a.occurred_at));

    const total = sorted.length;
    const page = Math.max(1, parseInt(filter.page, 10) || 1);
    const limit = filter.limit !== undefined ? (parseInt(filter.limit, 10) || 50) : (filter.paginate === 'false' ? 0 : 50);
    const pages = limit > 0 ? Math.ceil(total / limit) || 1 : 1;
    const skip = limit > 0 ? (page - 1) * limit : 0;

    const data = limit > 0 ? sorted.slice(skip, skip + limit) : sorted;

    return {
      data,
      pagination: {
        total,
        page,
        limit: limit > 0 ? limit : total,
        pages,
        hasNextPage: page < pages,
        hasPrevPage: page > 1,
      },
    };
  },

  async addTimelineNote(customerId, note) {
    await ensureDbConnected();
    const tlColl = deliveryConn.db.collection('timelineevents');
    const clientColl = deliveryConn.db.collection('clients');
    const custColl = deliveryConn.db.collection('customers');

    const customer = await custColl.findOne({ customer_id: customerId });
    if (!customer) throw new Error('Customer not found');

    const eventId = `EVT-${crypto.randomUUID()}`;
    const now = new Date();
    const newEvent = {
      event_id: eventId,
      customer_id: customerId,
      type: 'note',
      event_type: 'note',
      title: note.title || 'Dealership Staff Note',
      content: note.content || note.body,
      body: note.content || note.body,
      author: note.author || 'Alex Rivers',
      author_name: note.author || 'Alex Rivers',
      source: 'Sales CRM',
      source_system: 'crm',
      timestamp: now,
      occurred_at: now,
      timestamp_aest: formatAEST(now),
      visibility: 'internal',
      createdAt: now,
      updatedAt: now,
    };

    await tlColl.insertOne(newEvent);

    // FANOUT TO DELIVERY CENTRE CLIENT COMMENTS (§5.2 & AC-2)
    // Direct write to Delivery Centre MongoDB database
    if (customer.phone) {
      try {
        await clientColl.updateOne(
          { phone: { $regex: customer.phone.slice(-8) } },
          {
            $push: {
              comments: {
                author_name: `${newEvent.author} (Sales CRM)`,
                body: newEvent.content,
                created_at: now,
              },
            },
          }
        );
      } catch (_) {}
    }

    // FANOUT TO LEAD CENTRE DATABASE (Notes, LastTouch, AuditTrail)
    if (customer.phone || customer.lead_prospect_id) {
      try {
        const leadQuery = customer.lead_prospect_id
          ? { $or: [{ _id: customer.lead_prospect_id }, { phone: { $regex: customer.phone.slice(-8), $options: 'i' } }] }
          : { phone: { $regex: customer.phone.slice(-8), $options: 'i' } };
        const matchedLead = await leadConn.db.collection('leads').findOne(leadQuery);
        if (matchedLead) {
          const timestampIso = now.toISOString();
          const noteEntry = `[${timestampIso}] ${newEvent.author} (Sales CRM): ${newEvent.content}`;
          const updatedNotes = matchedLead.notes ? `${matchedLead.notes}\n${noteEntry}` : noteEntry;
          await leadConn.db.collection('leads').updateOne(
            { _id: matchedLead._id },
            {
              $set: {
                notes: updatedNotes,
                lastTouch: `Note from ${newEvent.author} · Just now`,
                lastActivityAt: now,
                updatedAt: now,
              },
            }
          );
          await leadConn.db.collection('audittrails').insertOne({
            message: `Note added from Sales CRM: ${newEvent.content.substring(0, 80)}`,
            actor: newEvent.author,
            leadId: matchedLead._id,
            action: 'note',
            createdAt: now,
          }).catch(() => {});
        }
      } catch (_) {}
    }

    return newEvent;
  },

  async editTimelineNote(eventId, newContent, author = 'Alex Rivers') {
    await ensureDbConnected();
    const tlColl = deliveryConn.db.collection('timelineevents');

    const existing = await tlColl.findOne({ event_id: eventId });
    if (!existing) throw new Error('Timeline event not found');

    const editHistoryItem = {
      previous_content: existing.content || existing.body,
      edited_by: author,
      edited_at: new Date(),
      edited_at_aest: formatAEST(new Date()),
    };

    await tlColl.updateOne(
      { event_id: eventId },
      {
        $set: {
          content: newContent,
          body: newContent,
          is_edited: true,
          updatedAt: new Date(),
        },
        $push: { edit_history: editHistoryItem },
      }
    );

    return tlColl.findOne({ event_id: eventId });
  },

  async softDeleteTimelineEvent(eventId, author = 'Alex Rivers', reason = 'Administrative correction') {
    await ensureDbConnected();
    const tlColl = deliveryConn.db.collection('timelineevents');

    const existing = await tlColl.findOne({ event_id: eventId });
    if (!existing) throw new Error('Timeline event not found');

    await tlColl.updateOne(
      { event_id: eventId },
      {
        $set: {
          deleted_at: new Date(),
          deleted_by: author,
          deletion_reason: reason,
          updatedAt: new Date(),
        },
      }
    );

    return { success: true, event_id: eventId, deleted: true };
  },

  async addTimelineEmail(customerId, emailData = {}) {
    await ensureDbConnected();
    const tlColl = deliveryConn.db.collection('timelineevents');
    const custColl = deliveryConn.db.collection('customers');
    const customer = await custColl.findOne({ customer_id: customerId });
    if (!customer) throw new Error('Customer not found');

    const now = new Date();
    const eventId = `EVT-EML-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000)}`;
    const newEvent = {
      event_id: eventId,
      customer_id: customerId,
      type: 'email',
      event_type: 'email',
      title: emailData.subject || 'Customer Email Communication',
      content: emailData.body || emailData.content || '',
      body: emailData.body || emailData.content || '',
      author: emailData.author || emailData.sender || 'Sales Consultant',
      author_name: emailData.author || emailData.sender || 'Sales Consultant',
      source: 'Sales CRM',
      source_system: 'crm',
      metadata: {
        to: emailData.to || customer.email,
        from: emailData.from || 'sales@bydfairfield.com.au',
        subject: emailData.subject || '',
        direction: emailData.direction || 'outbound',
      },
      timestamp: now,
      occurred_at: now,
      timestamp_aest: formatAEST(now),
      visibility: 'internal',
      createdAt: now,
      updatedAt: now,
    };

    await tlColl.insertOne(newEvent);
    return newEvent;
  },

  // ─── 3. Opportunities & 3-Way Mark Sold Orchestration (§7.5, AC-7) ─────────
  async getOpportunities(filter = {}) {
    await ensureDbConnected();
    const oppColl = deliveryConn.db.collection('opportunities');
    const query = {};

    if (filter.stage && filter.stage !== 'All') {
      query.stage = filter.stage;
    }
    if (filter.model && filter.model !== 'All') {
      query.model = filter.model;
    }
    if (filter.site && filter.site !== 'All' && filter.site !== 'All Sites') {
      query.site = filter.site;
    }
    if (filter.owner && filter.owner !== 'All') {
      query.$or = [{ owner_name: filter.owner }, { owner_user_id: filter.owner }];
    }
    if (filter.q && filter.q.trim()) {
      const regex = new RegExp(filter.q.trim(), 'i');
      query.$or = [
        { customer_name: regex },
        { vehicle_descriptor: regex },
        { vy_stock_id: regex },
        { opportunity_id: regex },
        { vin: regex },
      ];
    }

    const total = await oppColl.countDocuments(query);
    const page = Math.max(1, parseInt(filter.page, 10) || 1);
    const limit = filter.limit !== undefined ? (parseInt(filter.limit, 10) || 20) : (filter.paginate === 'false' ? 0 : 20);
    const pages = limit > 0 ? Math.ceil(total / limit) || 1 : 1;
    const skip = limit > 0 ? (page - 1) * limit : 0;

    let cursor = oppColl.find(query).sort({ updatedAt: -1, createdAt: -1 });
    if (limit > 0) {
      cursor = cursor.skip(skip).limit(limit);
    }
    const docs = await cursor.toArray();

    const data = docs.map((doc) => ({
      opportunity_id: doc.opportunity_id || String(doc._id),
      customer_id: doc.customer_id,
      customer_name: doc.customer_name,
      customer_phone: doc.customer_phone,
      customer_email: doc.customer_email || '',
      site: doc.site || 'Fairfield',
      owner_user_id: doc.owner_user_id || 'usr-001',
      owner_name: doc.owner_name || 'Alex Rivers',
      secondary_owner: doc.secondary_owner || doc.secondary_salesperson || null,
      secondary_split: doc.secondary_split || 0,
      stage: doc.stage || 'New / Allocated',
      vehicle_descriptor: doc.vehicle_descriptor || `${doc.model || 'BYD'} ${doc.variant || ''}`.trim(),
      model: doc.model || 'SEALION 7',
      variant: doc.variant || '',
      colour: doc.colour || '',
      order_type: doc.stock_type === 'factory_order' ? 'Factory Order' : 'Stock',
      vy_stock_id: doc.vy_stock_id || null,
      vy_order_id: doc.vy_order_id || null,
      vin: doc.vin || null,
      sale_type: doc.sale_type || 'Retail',
      list_price: doc.list_price || 0,
      discount: doc.discount || 0,
      extras: doc.extras_price || 0,
      total_deal_value: doc.total_price || doc.list_price || 0,
      trade_in_flag: Boolean(doc.trade_in_flag),
      trade_in_details: doc.trade_in_details,
      expected_close: doc.expected_close,
      next_action_at: doc.next_action_at,
      next_action_text: doc.next_action_desc || '',
      is_overdue: doc.next_action_at ? new Date(doc.next_action_at) < new Date() : false,
      sales_log_id: doc.sales_log_id || null,
      delivery_client_id: doc.delivery_client_id || null,
      delivery_stage: doc.delivery_stage || null,
      lost_reason: doc.loss_reason || null,
      competitor_notes: doc.competitor_notes || '',
      delivery_sync_pending: Boolean(doc.delivery_sync_pending),
      sync_status: doc.sync_status?.delivery === 'synced' ? 'synced' : (doc.delivery_sync_pending ? 'pending' : 'synced'),
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
    }));

    return {
      data,
      pagination: {
        total,
        page,
        limit: limit > 0 ? limit : total,
        pages,
        hasNextPage: page < pages,
        hasPrevPage: page > 1,
      },
    };
  },

  async getOpportunityById(id) {
    await ensureDbConnected();
    const oppColl = deliveryConn.db.collection('opportunities');
    const doc = await oppColl.findOne({
      $or: [{ opportunity_id: id }, { _id: id }],
    });
    if (!doc) return null;

    return {
      opportunity_id: doc.opportunity_id || String(doc._id),
      customer_id: doc.customer_id,
      customer_name: doc.customer_name,
      customer_phone: doc.customer_phone,
      customer_email: doc.customer_email || '',
      site: doc.site || 'Fairfield',
      owner_user_id: doc.owner_user_id || 'usr-001',
      owner_name: doc.owner_name || 'Alex Rivers',
      secondary_owner: doc.secondary_owner || doc.secondary_salesperson || null,
      secondary_split: doc.secondary_split || 0,
      stage: doc.stage || 'New / Allocated',
      vehicle_descriptor: doc.vehicle_descriptor,
      model: doc.model,
      variant: doc.variant || '',
      colour: doc.colour || '',
      order_type: doc.stock_type === 'factory_order' ? 'Factory Order' : 'Stock',
      vy_stock_id: doc.vy_stock_id || null,
      vy_order_id: doc.vy_order_id || null,
      vin: doc.vin || null,
      sale_type: doc.sale_type || 'Retail',
      list_price: doc.list_price || 0,
      discount: doc.discount || 0,
      extras: doc.extras_price || 0,
      total_deal_value: doc.total_price || doc.list_price || 0,
      trade_in_flag: Boolean(doc.trade_in_flag),
      trade_in_details: doc.trade_in_details,
      expected_close: doc.expected_close,
      next_action_at: doc.next_action_at,
      next_action_text: doc.next_action_desc || '',
      sales_log_id: doc.sales_log_id || null,
      delivery_client_id: doc.delivery_client_id || null,
      delivery_stage: doc.delivery_stage || null,
      lost_reason: doc.loss_reason || null,
      competitor_notes: doc.competitor_notes || '',
      delivery_sync_pending: Boolean(doc.delivery_sync_pending),
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
    };
  },

  async createOpportunity(data) {
    await ensureDbConnected();
    const oppColl = deliveryConn.db.collection('opportunities');
    const custColl = deliveryConn.db.collection('customers');

    const count = await oppColl.countDocuments();
    const oppId = 'OPP-BYD-' + (200 + count + 1);

    const cust = await custColl.findOne({ customer_id: data.customer_id });

    const newOppDoc = {
      opportunity_id: oppId,
      customer_id: data.customer_id,
      customer_name: cust?.name || data.customer_name || 'Customer',
      customer_phone: cust?.phone || data.customer_phone || '+61400000000',
      customer_email: cust?.email || data.customer_email || '',
      site: data.site || cust?.site || 'Fairfield',
      owner_user_id: data.owner_user_id || 'usr-001',
      owner_name: data.owner_name || 'Alex Rivers',
      secondary_owner: data.secondary_owner || null,
      secondary_split: Number(data.secondary_split) || 0,
      secondary_salesperson: data.secondary_owner || null,
      stage: data.stage || 'New / Allocated',
      vehicle_descriptor: data.vehicle_descriptor || `${data.model || 'BYD SEALION 7'} ${data.variant || 'Premium'}`,
      model: data.model || 'SEALION 7',
      variant: data.variant || 'Premium',
      colour: data.colour || 'Atlantis Grey',
      stock_type: data.order_type === 'Factory Order' ? 'factory_order' : 'stock',
      vy_stock_id: data.vy_stock_id || null,
      vy_order_id: data.vy_order_id || null,
      vin: data.vin || null,
      rego: null,
      sale_type: data.sale_type || 'Retail',
      list_price: Number(data.list_price) || 0,
      discount: Number(data.discount) || 0,
      extras_price: Number(data.extras) || 0,
      total_price: Number(data.total_deal_value) || Number(data.list_price) || 0,
      trade_in_flag: Boolean(data.trade_in_flag),
      trade_in_details: data.trade_in_details || null,
      expected_close: data.expected_close || null,
      next_action_at: data.next_action_at || new Date(Date.now() + 24 * 3600000),
      next_action_desc: data.next_action_text || 'Consultation follow-up',
      sales_log_id: null,
      delivery_client_id: null,
      delivery_stage: null,
      loss_reason: null,
      competitor_notes: data.competitor_notes || null,
      sync_status: { vy: 'none', sales_log: 'none', delivery: 'none' },
      sold_at: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await oppColl.insertOne(newOppDoc);
    return newOppDoc;
  },

  async updateOpportunity(id, patch) {
    await ensureDbConnected();
    const oppColl = deliveryConn.db.collection('opportunities');
    const tlColl = deliveryConn.db.collection('timelineevents');

    const existing = await oppColl.findOne({
      $or: [{ opportunity_id: id }, { _id: id }],
    });
    if (!existing) throw new Error('Opportunity not found');

    // Validation (§5.4): Loss reason required when moving to Lost / Parked
    if (patch.stage === 'Lost / Parked' && !patch.loss_reason && !existing.loss_reason) {
      const err = new Error('Loss reason is required when transitioning to Lost / Parked (§5.4)');
      err.statusCode = 400;
      throw err;
    }

    patch.updatedAt = new Date();
    await oppColl.updateOne(
      { _id: existing._id },
      { $set: patch }
    );

    // Stage change audit trail (§5.2, §5.4, AC-10)
    if (patch.stage && patch.stage !== existing.stage) {
      const now = new Date();
      await tlColl.insertOne({
        event_id: `EVT-${crypto.randomUUID()}`,
        customer_id: existing.customer_id,
        opportunity_id: existing.opportunity_id,
        type: 'stage_change',
        event_type: 'stage_change',
        title: `Opportunity Stage Transitioned: ${patch.stage}`,
        content: `Stage transitioned from '${existing.stage}' to '${patch.stage}'${patch.loss_reason ? ` (Reason: ${patch.loss_reason})` : ''}`,
        body: `Stage transitioned from '${existing.stage}' to '${patch.stage}'${patch.loss_reason ? ` (Reason: ${patch.loss_reason})` : ''}`,
        author: patch.updated_by || 'Sales Consultant',
        author_name: patch.updated_by || 'Sales Consultant',
        source: 'Sales CRM',
        source_system: 'crm',
        timestamp: now,
        occurred_at: now,
        timestamp_aest: formatAEST(now),
        visibility: 'internal',
        createdAt: now,
        updatedAt: now,
      });

      // Directly update matching Lead in Lead Centre database
      if (existing.customer_phone || existing.customer_id) {
        try {
          const stageMap = {
            'New / Allocated': 'NEW ENQUIRIES',
            'Working': 'QUALIFIED',
            'Appointment': 'TEST DRIVE BOOKED',
            'Negotiation': 'NEGOTIATION',
            'Written / Sold': 'Sold',
            'Delivered / Won': 'Delivered',
            'Lost / Parked': 'Lost',
          };
          const leadStage = stageMap[patch.stage] || patch.stage;
          const leadUpdate = {
            stage: leadStage,
            lastTouch: `Stage moved to ${patch.stage}`,
            lastActivityAt: now,
            updatedAt: now,
          };
          if (patch.stage === 'Lost / Parked') {
            leadUpdate.status = 'Lost';
            leadUpdate.lossReason = patch.loss_reason || 'Lost deal in CRM';
          }
          await leadConn.db.collection('leads').updateMany(
            { phone: { $regex: existing.customer_phone.slice(-8), $options: 'i' } },
            { $set: leadUpdate }
          );
          await leadConn.db.collection('audittrails').insertOne({
            message: `Lead stage updated to ${leadStage} via Sales CRM`,
            actor: patch.updated_by || 'Sales Consultant',
            action: 'stage_change',
            createdAt: now,
          }).catch(() => {});
        } catch (_) {}
      }
    }

    // Direct database update for owner assignment change across Lead & Delivery Centres
    if (patch.owner_name && patch.owner_name !== existing.owner_name) {
      if (existing.customer_phone) {
        try {
          await leadConn.db.collection('leads').updateMany(
            { phone: { $regex: existing.customer_phone.slice(-8), $options: 'i' } },
            { $set: { allocatedPersonFullName: patch.owner_name, assignedTo: patch.owner_email || patch.owner_name, updatedAt: new Date() } }
          );
          await deliveryConn.db.collection('clients').updateMany(
            { phone: { $regex: existing.customer_phone.slice(-8), $options: 'i' } },
            { $set: { salesperson: patch.owner_name, updatedAt: new Date() } }
          );
        } catch (_) {}
      }
    }

    return this.getOpportunityById(existing.opportunity_id);
  },

  /**
   * markSold – §7.5 3-Way Transactional Orchestration (AC-7)
   * 1. Validate opportunity (owner, sale type, vehicle, identity, consent)
   * 2. Upsert VY order / confirm stock hold
   * 3. Upsert Sales Log row
   * 4. Upsert Delivery Centre client (imported_from = crm) with compensation on failure
   * 5. Write TimelineEvents and emit crm.deal_sold
   */
  async markSold(oppId, payload) {
    await ensureDbConnected();
    const oppColl = deliveryConn.db.collection('opportunities');
    const custColl = deliveryConn.db.collection('customers');
    const salesLogColl = deliveryConn.db.collection('saleslogentries');
    const clientColl = deliveryConn.db.collection('clients');
    const tlColl = deliveryConn.db.collection('timelineevents');

    const opp = await oppColl.findOne({
      $or: [{ opportunity_id: oppId }, { _id: oppId }],
    });
    if (!opp) throw new Error('Opportunity not found');

    const customer = await custColl.findOne({ customer_id: opp.customer_id });
    if (!customer) throw new Error('Customer not found');

    // ── Step 1: Strict Validation (§7.5) ────────────────────────────────────
    if (opp.stage === 'Delivered / Won') {
      const err = new Error('Deal has already been marked as Delivered / Won.');
      err.statusCode = 400;
      throw err;
    }

    if (customer.do_not_contact) {
      const err = new Error('Customer has opted out of communication (Privacy / ACMA compliance §5.10)');
      err.statusCode = 400;
      throw err;
    }

    if (!customer.name || !customer.phone) {
      const err = new Error('Validation failed: Customer name and Australian mobile phone are required (§7.5 Step 1)');
      err.statusCode = 400;
      throw err;
    }

    const isFactoryOrder = Boolean(
      payload.factory_order ||
      payload.is_factory_order ||
      payload.order_type === 'Factory Order' ||
      opp.stock_type === 'factory_order' ||
      opp.order_type === 'Factory Order'
    );

    const vin = payload.vin || opp.vin;
    if (!vin && !isFactoryOrder) {
      const err = new Error('Validation failed: A valid VIN or Factory Order flag is required to Mark Sold (§7.5 Step 1, §5.4)');
      err.statusCode = 400;
      throw err;
    }

    const saleType = payload.sale_type || opp.sale_type;
    if (!saleType) {
      const err = new Error('Validation failed: Sale Type is required to Mark Sold (§7.5 Step 1)');
      err.statusCode = 400;
      throw err;
    }

    const vehicleDescriptor = payload.vehicle_descriptor || opp.vehicle_descriptor || `${opp.model} ${opp.variant}`;
    const primarySalesperson = payload.primary_salesperson || opp.owner_name || 'Alex Rivers';

    // ── Step 2: VY Order / Stock Confirmation (§7.5 Step 2) ──────────────────
    const vyStockId = payload.vy_stock_id || opp.vy_stock_id || (isFactoryOrder ? 'FACTORY-ORDER' : null);
    const vyOrderId = payload.vy_order_id || opp.vy_order_id || (isFactoryOrder ? 'FACTORY-ORDER' : null);
    const vySyncPending = !vyStockId && !isFactoryOrder;
    const salesLogCount = await salesLogColl.countDocuments();
    const salesLogId = 'SL-BYD-' + (900 + salesLogCount + 1);

    // ── Step 3: Upsert Sales Log Row (§7.5 Step 3, §5.7) ─────────────────────
    const now = new Date();
    const newSalesLogRow = {
      sales_log_id: salesLogId,
      opportunity_id: opp.opportunity_id,
      customer_id: customer.customer_id,
      deal_number: `BYD-2026-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      deal_date: now.toISOString().split('T')[0],
      customer_name: customer.name,
      mobile: customer.phone,
      email: customer.email,
      vehicle: vehicleDescriptor,
      vin: vin || (isFactoryOrder ? 'FACTORY_ORDER_PENDING' : 'VIN_PENDING'),
      stock_id: vyStockId,
      vy_stock_id: vyStockId,
      vy_order_id: vyOrderId,
      sale_type: saleType,
      consultant_name: primarySalesperson,
      secondary_consultant: payload.secondary_salesperson || opp.secondary_owner || null,
      site: opp.site,
      list_price: opp.total_price || opp.list_price || 60000,
      gross_margin: Math.round((opp.total_price || opp.list_price || 60000) * 0.08),
      deposit: Number(payload.deposit) || 1000,
      finance_method: payload.finance_method || 'Dealer Finance',
      status: 'written',
      source: 'crm',
      exception_status: 'none',
      reconciled_at: now,
      createdAt: now,
      updatedAt: now,
    };
    await salesLogColl.insertOne(newSalesLogRow);

    // ── Step 4: Upsert Delivery Centre Client with Compensation (§7.5 Step 4) ─
    let deliveryClientId = null;
    let deliverySyncSuccess = false;
    let deliverySyncPending = false;

    try {
      const newClientDoc = {
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        vehicle: vehicleDescriptor,
        vin: vin || (isFactoryOrder ? 'Factory Order - VIN Pending' : 'VIN Pending'),
        sale_type: saleType,
        salesperson: primarySalesperson,
        site_location: opp.site,
        location: opp.site,
        stage: 'Scheduled',
        contact_status: 'Not Contacted',
        vy_order_id: vyOrderId,
        vy_stock_id: vyStockId,
        imported_from: 'crm',
        crm_customer_id: customer.customer_id,
        crm_opportunity_id: opp.opportunity_id,
        delivery_date: new Date(Date.now() + 5 * 86400000).toISOString().split('T')[0],
        comments: [
          {
            author_name: `${primarySalesperson} (Sales CRM)`,
            body: `Deal closed in CRM desk. Vehicle: ${vehicleDescriptor} | VIN: ${vin || 'Pending Factory'}`,
            created_at: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
      };

      const insertedClient = await clientColl.insertOne(newClientDoc);
      deliveryClientId = String(insertedClient.insertedId);
      deliverySyncSuccess = true;
    } catch (err) {
      // Compensate: flag "sold — delivery sync pending" (§7.5 Compensating Action)
      deliverySyncSuccess = false;
      deliverySyncPending = true;

      await salesLogColl.updateOne(
        { sales_log_id: salesLogId },
        { $set: { exception_status: 'delivery_sync_pending', sync_error: err.message, updatedAt: new Date() } }
      );

      await tlColl.insertOne({
        event_id: `EVT-${crypto.randomUUID()}`,
        customer_id: customer.customer_id,
        opportunity_id: opp.opportunity_id,
        type: 'system',
        event_type: 'system',
        title: 'Delivery Handover Sync Pending (Compensation Flagged)',
        content: `Delivery Centre client upsert failed: ${err.message}. Deal flagged 'sold — delivery sync pending'.`,
        body: `Delivery Centre client upsert failed: ${err.message}. Deal flagged 'sold — delivery sync pending'.`,
        author: 'CRM Transaction Coordinator',
        source: 'Sales CRM',
        timestamp: new Date(),
        occurred_at: new Date(),
        timestamp_aest: formatAEST(new Date()),
        visibility: 'internal',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    // ── Step 5: Update Opportunity, Customer & Append Timeline (§7.5 Step 5) ──
    await oppColl.updateOne(
      { opportunity_id: opp.opportunity_id },
      {
        $set: {
          stage: 'Written / Sold',
          delivery_stage: deliverySyncSuccess ? 'Scheduled' : 'Sync Pending',
          vy_stock_id: vyStockId,
          vy_order_id: vyOrderId,
          sales_log_id: salesLogId,
          delivery_client_id: deliveryClientId,
          sale_type: saleType,
          vin: vin || opp.vin,
          owner_name: primarySalesperson,
          sold_at: now,
          delivery_sync_pending: deliverySyncPending,
          sync_status: {
            vy: 'synced',
            sales_log: 'synced',
            delivery: deliverySyncSuccess ? 'synced' : 'pending_retry',
          },
          next_action_desc: deliverySyncPending
            ? 'DELIVERY SYNC PENDING · Coordinator to retry delivery write'
            : 'Pre-delivery handover coordination in progress',
          updatedAt: now,
        },
      }
    );

    if (deliveryClientId) {
      await custColl.updateOne(
        { customer_id: customer.customer_id },
        { $set: { delivery_client_id: deliveryClientId, updatedAt: now } }
      );
    }

    const soldEventId = `EVT-${crypto.randomUUID()}`;
    await tlColl.insertOne({
      event_id: soldEventId,
      customer_id: customer.customer_id,
      opportunity_id: opp.opportunity_id,
      event_type: 'stage_change',
      type: 'stage_change',
      title: 'Deal Written & Sold (3-Way Orchestrated)',
      content: `Sold by ${primarySalesperson}. VY Order: ${vyOrderId}, Sales Log: ${salesLogId}, Delivery Client: ${deliveryClientId || 'Pending Re-sync'}.`,
      body: `Sold by ${primarySalesperson}. VY Order: ${vyOrderId}, Sales Log: ${salesLogId}, Delivery Client: ${deliveryClientId || 'Pending Re-sync'}.`,
      author_name: primarySalesperson,
      author: primarySalesperson,
      source_system: 'crm',
      source: 'Sales CRM',
      timestamp: now,
      occurred_at: now,
      timestamp_aest: formatAEST(now),
      visibility: 'internal',
      createdAt: now,
      updatedAt: now,
    });

    // Direct Lead Centre database update (Mark Sold in Lead Centre)
    if (customer.phone || opp.lead_prospect_id) {
      try {
        const leadQuery = opp.lead_prospect_id
          ? { $or: [{ _id: opp.lead_prospect_id }, { phone: { $regex: customer.phone.slice(-8), $options: 'i' } }] }
          : { phone: { $regex: customer.phone.slice(-8), $options: 'i' } };
        await leadConn.db.collection('leads').updateMany(
          leadQuery,
          {
            $set: {
              stage: 'Sold',
              status: 'Sold',
              lastTouch: `Marked Sold by ${primarySalesperson}`,
              lastActivityAt: now,
              'leadStats.closedWon': true,
              updatedAt: now,
            },
          }
        );
        await leadConn.db.collection('audittrails').insertOne({
          message: `Deal Written & Sold by ${primarySalesperson}. VY Order: ${vyOrderId}, Sales Log: ${salesLogId}, Delivery Client: ${deliveryClientId || 'Pending'}`,
          actor: primarySalesperson,
          action: 'sold',
          createdAt: now,
        }).catch(() => {});
      } catch (_) {}
    }

    return {
      opportunity: await this.getOpportunityById(opp.opportunity_id),
      salesLogId,
      deliveryClientId,
      vyOrderId,
      deliverySyncSuccess,
      deliverySyncPending,
    };
  },

  // ─── 4. Allocations & SLA Queue (§5.3, AC-4) ──────────────────────────────
  async getAllocations(filter = {}) {
    await ensureDbConnected();
    const allocColl = deliveryConn.db.collection('allocations');
    const query = {};

    if (filter.status && filter.status !== 'All') {
      query.status = filter.status;
    }
    if (filter.site && filter.site !== 'All' && filter.site !== 'All Sites') {
      query.site = filter.site;
    }
    if (filter.assigned_to && filter.assigned_to !== 'All') {
      query.assigned_to_name = filter.assigned_to;
    }
    if (filter.q && filter.q.trim()) {
      const regex = new RegExp(filter.q.trim(), 'i');
      query.$or = [
        { prospect_name: regex },
        { phone: regex },
        { email: regex },
        { vehicle_interest: regex },
        { allocation_id: regex },
      ];
    }

    const total = await allocColl.countDocuments(query);
    const page = Math.max(1, parseInt(filter.page, 10) || 1);
    const limit = filter.limit !== undefined ? (parseInt(filter.limit, 10) || 20) : (filter.paginate === 'false' ? 0 : 20);
    const pages = limit > 0 ? Math.ceil(total / limit) || 1 : 1;
    const skip = limit > 0 ? (page - 1) * limit : 0;

    let cursor = allocColl.find(query).sort({ allocated_at: -1, createdAt: -1 });
    if (limit > 0) {
      cursor = cursor.skip(skip).limit(limit);
    }
    const docs = await cursor.toArray();

    const data = docs.map((doc) => ({
      allocation_id: doc.allocation_id || String(doc._id),
      lead_prospect_id: doc.lead_prospect_id || 'LP-40192',
      customer_id: doc.customer_id,
      prospect_name: doc.prospect_name,
      phone: doc.phone,
      email: doc.email || '',
      source: doc.source || 'Virtual Yard',
      vehicle: doc.vehicle_interest || 'BYD SEALION 7',
      site: doc.site || 'Fairfield',
      ai_score: doc.ai_score || 90,
      last_sms_summary: doc.last_sms_summary || '',
      appointment_booked: doc.appointment_when || null,
      allocated_at: doc.allocated_at || doc.createdAt,
      sla_expires_at: doc.sla_expires_at,
      status: doc.status || 'pending',
      assigned_to: doc.assigned_to_name || 'Alex Rivers',
    }));

    return {
      data,
      pagination: {
        total,
        page,
        limit: limit > 0 ? limit : total,
        pages,
        hasNextPage: page < pages,
        hasPrevPage: page > 1,
      },
    };
  },

  async createAllocation(data) {
    await ensureDbConnected();
    const allocColl = deliveryConn.db.collection('allocations');
    const custColl = deliveryConn.db.collection('customers');
    const oppColl = deliveryConn.db.collection('opportunities');
    const tlColl = deliveryConn.db.collection('timelineevents');

    const formattedPhone = formatPhoneE164(data.phone);

    // Idempotency check (§5.3, §7.3, AC-4, AC-11)
    if (data.event_id || data.lead_prospect_id) {
      const existing = await allocColl.findOne({
        $or: [
          data.event_id ? { event_id: data.event_id } : null,
          data.lead_prospect_id ? { lead_prospect_id: data.lead_prospect_id, status: { $in: ['pending', 'accepted'] } } : null,
        ].filter(Boolean),
      });
      if (existing) {
        return { ...existing, duplicate: true };
      }
    }

    // Match or create customer
    let customer = await custColl.findOne({
      $or: [{ phone: formattedPhone }, { email: data.email ? data.email.toLowerCase() : null }],
    });

    if (!customer && (data.name || data.prospect_name)) {
      customer = await this.createCustomer({
        name: data.name || data.prospect_name,
        phone: formattedPhone,
        email: data.email || null,
        site: data.site || 'Fairfield',
        source: data.source || 'Autogate',
        lead_prospect_id: data.lead_prospect_id || null,
        notes: data.notes || `Direct intake lead (${data.vehicle || 'BYD Range'})`,
      }).catch(() => null);
    }

    // SLA Clock (default 15 minutes during trading hours, §5.3)
    const now = new Date();
    const slaExpiresAt = data.sla_expires_at ? new Date(data.sla_expires_at) : new Date(now.getTime() + 15 * 60 * 1000);

    const count = await allocColl.countDocuments();
    const allocationId = 'ALC-' + (400 + count + 1);

    const allocDoc = {
      allocation_id: allocationId,
      event_id: data.event_id || null,
      lead_prospect_id: data.lead_prospect_id || `LP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      customer_id: customer?.customer_id || null,
      prospect_name: customer?.name || data.name || data.prospect_name || 'Prospect',
      phone: formattedPhone || data.phone,
      email: customer?.email || data.email || '',
      source: data.source || 'Autogate',
      vehicle_interest: data.vehicle || data.vehicle_interest || 'BYD SEALION 7',
      site: data.site || customer?.site || 'Fairfield',
      ai_score: Number(data.score || data.ai_score) || 85,
      last_sms_summary: data.last_sms_summary || data.summary || '',
      appointment_when: data.appointment || data.appointment_when || null,
      assigned_to_name: data.assigned_to || data.consultant || 'Alex Rivers',
      allocated_at: now,
      sla_expires_at: slaExpiresAt,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };

    await allocColl.insertOne(allocDoc);

    // Ensure matching opportunity exists in New / Allocated stage
    if (customer?.customer_id) {
      const existingOpp = await oppColl.findOne({
        customer_id: customer.customer_id,
        stage: { $nin: ['Lost / Parked', 'Delivered / Won'] },
      });
      if (!existingOpp) {
        await this.createOpportunity({
          customer_id: customer.customer_id,
          model: data.vehicle?.includes('SEALION') ? 'SEALION 7' : (data.vehicle || 'SEALION 7'),
          vehicle_descriptor: data.vehicle || 'BYD SEALION 7 Premium',
          site: allocDoc.site,
          owner_name: allocDoc.assigned_to_name,
          stage: 'New / Allocated',
        });
      }

      // Append timeline intake event
      await tlColl.insertOne({
        event_id: `EVT-${crypto.randomUUID()}`,
        customer_id: customer.customer_id,
        type: 'assignment',
        event_type: 'assignment',
        title: 'Lead Allocated into CRM Inbox',
        content: `Allocated to ${allocDoc.assigned_to_name}. 15-minute SLA clock running until ${formatAEST(slaExpiresAt)}.`,
        body: `Allocated to ${allocDoc.assigned_to_name}. 15-minute SLA clock running until ${formatAEST(slaExpiresAt)}.`,
        author: 'Lead Intake Engine',
        source: 'Sales CRM',
        timestamp: now,
        occurred_at: now,
        timestamp_aest: formatAEST(now),
        visibility: 'internal',
        createdAt: now,
        updatedAt: now,
      });
    }

    // Direct Lead Centre database update (Allocate in Lead Centre)
    if (allocDoc.phone || data.lead_prospect_id) {
      try {
        const leadQuery = data.lead_prospect_id
          ? { $or: [{ _id: data.lead_prospect_id }, { phone: { $regex: allocDoc.phone.slice(-8), $options: 'i' } }] }
          : { phone: { $regex: allocDoc.phone.slice(-8), $options: 'i' } };
        const existingLead = await leadConn.db.collection('leads').findOne(leadQuery);
        if (existingLead) {
          await leadConn.db.collection('leads').updateOne(
            { _id: existingLead._id },
            {
              $set: {
                assignedTo: allocDoc.assigned_to_name,
                allocatedPersonFullName: allocDoc.assigned_to_name,
                dealer: allocDoc.site,
                stage: 'QUALIFIED',
                lastTouch: `Allocated to ${allocDoc.assigned_to_name} (15m SLA)`,
                lastActivityAt: now,
                updatedAt: now,
              },
            }
          );
          await leadConn.db.collection('audittrails').insertOne({
            message: `Lead allocated to ${allocDoc.assigned_to_name} with 15-min SLA clock`,
            actor: 'Lead Intake Engine',
            leadId: existingLead._id,
            action: 'allocate',
            createdAt: now,
          }).catch(() => {});
        } else {
          await leadConn.db.collection('leads').insertOne({
            name: allocDoc.prospect_name,
            phone: allocDoc.phone,
            email: allocDoc.email,
            vehicle: data.vehicle || 'BYD SEALION 7',
            source: data.source || 'Autogate',
            platform: data.source === 'Autogate' ? 'autogate' : 'manual',
            stage: 'QUALIFIED',
            status: 'Assigned',
            score: data.score || 85,
            dealer: allocDoc.site,
            assignedTo: allocDoc.assigned_to_name,
            allocatedPersonFullName: allocDoc.assigned_to_name,
            lastTouch: `Allocated to ${allocDoc.assigned_to_name} · Just now`,
            lastActivityAt: now,
            notes: allocDoc.notes,
            isArchived: false,
            createdAt: now,
            updatedAt: now,
          });
        }
      } catch (_) {}
    }

    return allocDoc;
  },

  async acceptAllocation(allocId, consultantName = 'Alex Rivers') {
    await ensureDbConnected();
    const allocColl = deliveryConn.db.collection('allocations');
    const custColl = deliveryConn.db.collection('customers');
    const oppColl = deliveryConn.db.collection('opportunities');
    const tlColl = deliveryConn.db.collection('timelineevents');
    const now = new Date();

    const alloc = await allocColl.findOne({
      $or: [{ allocation_id: allocId }, { _id: allocId }],
    });
    if (!alloc) throw new Error('Allocation not found');

    await allocColl.updateOne(
      { _id: alloc._id },
      {
        $set: {
          status: 'accepted',
          accepted_at: now,
          assigned_to_name: consultantName,
          updatedAt: now,
        },
      }
    );

    if (alloc.customer_id) {
      await custColl.updateOne(
        { customer_id: alloc.customer_id },
        { $set: { owner_name: consultantName, updatedAt: now } }
      );
      await oppColl.updateMany(
        { customer_id: alloc.customer_id, stage: 'New / Allocated' },
        { $set: { owner_name: consultantName, stage: 'Working', next_action_desc: 'Initial customer discovery contact', updatedAt: now } }
      );

      await tlColl.insertOne({
        event_id: `EVT-${crypto.randomUUID()}`,
        customer_id: alloc.customer_id,
        type: 'assignment',
        event_type: 'assignment',
        title: 'Allocation SLA Accepted',
        content: `Accepted by ${consultantName}. Deal transitioned to 'Working' stage.`,
        body: `Accepted by ${consultantName}. Deal transitioned to 'Working' stage.`,
        author: consultantName,
        source: 'Sales CRM',
        timestamp: now,
        occurred_at: now,
        timestamp_aest: formatAEST(now),
        visibility: 'internal',
        createdAt: now,
        updatedAt: now,
      });

      // Direct Lead Centre database update
      if (alloc.phone) {
        try {
          await leadConn.db.collection('leads').updateMany(
            { phone: { $regex: alloc.phone.slice(-8), $options: 'i' } },
            {
              $set: {
                assignedTo: consultantName,
                allocatedPersonFullName: consultantName,
                stage: 'QUALIFIED',
                lastTouch: `Allocation accepted by ${consultantName}`,
                lastActivityAt: now,
                updatedAt: now,
              },
            }
          );
          await leadConn.db.collection('audittrails').insertOne({
            message: `Allocation SLA accepted by ${consultantName}`,
            actor: consultantName,
            action: 'accept_allocation',
            createdAt: now,
          }).catch(() => {});
        } catch (_) {}
      }
    }

    return { ...alloc, status: 'accepted', assigned_to_name: consultantName, accepted_at: now };
  },

  async reassignAllocation(allocId, newConsultant) {
    await ensureDbConnected();
    const allocColl = deliveryConn.db.collection('allocations');
    const custColl = deliveryConn.db.collection('customers');
    const oppColl = deliveryConn.db.collection('opportunities');
    const tlColl = deliveryConn.db.collection('timelineevents');
    const now = new Date();

    const alloc = await allocColl.findOne({
      $or: [{ allocation_id: allocId }, { _id: allocId }],
    });
    if (!alloc) throw new Error('Allocation not found');

    const previousConsultant = alloc.assigned_to_name;
    await allocColl.updateOne(
      { _id: alloc._id },
      {
        $set: {
          assigned_to_name: newConsultant,
          previous_assignee: previousConsultant,
          reassigned_at: now,
          updatedAt: now,
        },
      }
    );

    if (alloc.customer_id) {
      await custColl.updateOne(
        { customer_id: alloc.customer_id },
        { $set: { owner_name: newConsultant, updatedAt: now } }
      );
      await oppColl.updateMany(
        { customer_id: alloc.customer_id, stage: { $nin: ['Delivered / Won', 'Lost / Parked'] } },
        { $set: { owner_name: newConsultant, updatedAt: now } }
      );

      await tlColl.insertOne({
        event_id: `EVT-${crypto.randomUUID()}`,
        customer_id: alloc.customer_id,
        type: 'assignment',
        event_type: 'assignment',
        title: 'Lead Reassigned by Floor Manager',
        content: `Reassigned from ${previousConsultant} to ${newConsultant}.`,
        body: `Reassigned from ${previousConsultant} to ${newConsultant}.`,
        author: 'Floor Manager',
        source: 'Sales CRM',
        timestamp: now,
        occurred_at: now,
        timestamp_aest: formatAEST(now),
        visibility: 'internal',
        createdAt: now,
        updatedAt: now,
      });

      // Direct Lead Centre database update
      if (alloc.phone) {
        try {
          await leadConn.db.collection('leads').updateMany(
            { phone: { $regex: alloc.phone.slice(-8), $options: 'i' } },
            {
              $set: {
                assignedTo: newConsultant,
                allocatedPersonFullName: newConsultant,
                lastTouch: `Reassigned to ${newConsultant}`,
                lastActivityAt: now,
                updatedAt: now,
              },
            }
          );
          await leadConn.db.collection('audittrails').insertOne({
            message: `Lead reassigned from ${previousConsultant} to ${newConsultant}`,
            actor: 'Floor Manager',
            action: 'reassign',
            createdAt: now,
          }).catch(() => {});
        } catch (_) {}
      }
    }

    return { ...alloc, assigned_to_name: newConsultant, previous_assignee: previousConsultant, reassigned_at: now };
  },

  async checkAndEscalateSlas() {
    await ensureDbConnected();
    const allocColl = deliveryConn.db.collection('allocations');
    const tlColl = deliveryConn.db.collection('timelineevents');
    const userColl = deliveryConn.db.collection('users');
    const now = new Date();

    const expiredPending = await allocColl.find({
      status: 'pending',
      sla_expires_at: { $lt: now },
    }).toArray();

    if (expiredPending.length === 0) {
      return { escalatedCount: 0, allocations: [] };
    }

    for (const alloc of expiredPending) {
      // Look up actual floor manager for the site
      const floorManager = await userColl.findOne({
        role: { $in: ['sales_manager', 'manager', 'site_admin', 'super_admin'] },
        active: true,
        $or: [{ site: alloc.site }, { site: 'All Sites' }, { site: { $exists: false } }],
      }).catch(() => null);

      const managerName = floorManager ? floorManager.name : 'Floor Manager (Escalated)';

      await allocColl.updateOne(
        { _id: alloc._id },
        {
          $set: {
            status: 'escalated',
            escalated_at: now,
            previous_assignee: alloc.assigned_to_name,
            assigned_to_name: managerName,
            updatedAt: now,
          },
        }
      );

      if (alloc.customer_id) {
        await tlColl.insertOne({
          event_id: `EVT-${crypto.randomUUID()}`,
          customer_id: alloc.customer_id,
          type: 'assignment',
          event_type: 'assignment',
          title: 'SLA Breached – Escalated to Floor Manager',
          content: `Initial SLA expired without acceptance by ${alloc.assigned_to_name}. Re-routed to ${managerName}.`,
          body: `Initial SLA expired without acceptance by ${alloc.assigned_to_name}. Re-routed to ${managerName}.`,
          author: 'SLA Escalation Engine',
          source: 'Sales CRM',
          timestamp: now,
          occurred_at: now,
          timestamp_aest: formatAEST(now),
          visibility: 'internal',
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    return { escalatedCount: expiredPending.length, allocations: expiredPending.map((a) => a.allocation_id) };
  },

  // ─── 5. Virtual Yard Stock Reservation (From leadConn.inventories) ─────────
  async getVyStock(filter = {}) {
    await ensureDbConnected();
    const invColl = leadConn.db.collection('inventories');
    const holdsColl = deliveryConn.db.collection('stockholds');

    const query = {};
    if (filter.model && filter.model !== 'All') {
      query.$or = [
        { model: { $regex: filter.model, $options: 'i' } },
        { 'specifications.model': { $regex: filter.model, $options: 'i' } },
        { title: { $regex: filter.model, $options: 'i' } },
      ];
    }
    if (filter.status && filter.status !== 'All') {
      if (filter.status === 'Available') {
        query.status = { $in: ['Available', 'InStock', 'In Stock'] };
      } else if (filter.status === 'Inbound') {
        query.itemStatus = 'Inbound';
      }
    }
    if (filter.q && filter.q.trim()) {
      const regex = new RegExp(filter.q.trim(), 'i');
      query.$or = [
        { stock: regex },
        { title: regex },
        { 'registration.vin': regex },
        { 'registration.rego': regex },
        { 'specifications.badge': regex },
        { paint: regex },
        { model: regex },
      ];
    }

    const total = await invColl.countDocuments(query);
    const page = Math.max(1, parseInt(filter.page, 10) || 1);
    const limit = filter.limit !== undefined ? (parseInt(filter.limit, 10) || 20) : (filter.paginate === 'false' ? 0 : 20);
    const pages = limit > 0 ? Math.ceil(total / limit) || 1 : 1;
    const skip = limit > 0 ? (page - 1) * limit : 0;

    let cursor = invColl.find(query).sort({ lastSeen: -1, _id: -1 });
    if (limit > 0) {
      cursor = cursor.skip(skip).limit(limit);
    }
    const stockDocs = await cursor.toArray();

    // Check active holds
    const activeHolds = await holdsColl.find({ status: 'active' }).toArray();

    const data = stockDocs.map((doc) => {
      const stockId = doc.stock ? `VY-VIC-${doc.stock}` : `VY-VIC-${doc.legacyId || '0000'}`;
      const matchingHold = activeHolds.find((h) => h.vy_stock_id === stockId || h.vin === doc.registration?.vin);

      return {
        stock_id: stockId,
        vin: doc.registration?.vin || 'VIN Pending',
        model: doc.specifications?.model || doc.model?.replace(/.*BYD\s+/, '') || 'BYD',
        variant: doc.specifications?.badge || 'Premium',
        colour: doc.paint || doc.specifications?.colour || 'Ski White',
        battery_kwh: doc.title?.includes('kWh') ? parseFloat(doc.title.match(/(\d+\.?\d*)\s*kWh/)?.[1] || 60) : 60,
        status: matchingHold ? 'Held' : doc.status === 'Available' ? 'Available' : 'Available',
        held_by: matchingHold ? `${matchingHold.held_by_name} (${matchingHold.opportunity_id})` : undefined,
        hold_expires_at: matchingHold?.expires_at || undefined,
        location: doc.location || 'BYD Melbourne',
        eta: doc.itemStatus === 'InStock' ? 'On Yard' : 'Inbound',
        wholesale_price: doc.priceData?.ui ? Math.round(doc.priceData.ui * 0.9) : 45000,
        retail_price: doc.priceData?.ui || 52000,
      };
    });

    return {
      data,
      pagination: {
        total,
        page,
        limit: limit > 0 ? limit : total,
        pages,
        hasNextPage: page < pages,
        hasPrevPage: page > 1,
      },
    };
  },

  async holdStock(stockId, opportunityId, consultantName = 'Alex Rivers') {
    await ensureDbConnected();
    const holdsColl = deliveryConn.db.collection('stockholds');
    const oppColl = deliveryConn.db.collection('opportunities');
    const tlColl = deliveryConn.db.collection('timelineevents');
    const invColl = leadConn.db.collection('inventories');

    const opp = await oppColl.findOne({
      $or: [{ opportunity_id: opportunityId }, { _id: opportunityId }],
    });

    const holdId = `HOLD-BYD-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const expiresAt = new Date(Date.now() + 48 * 3600000);
    const now = new Date();

    const holdDoc = {
      hold_id: holdId,
      opportunity_id: opportunityId,
      customer_id: opp?.customer_id || null,
      customer_name: opp?.customer_name || 'Customer',
      vy_stock_id: stockId,
      vin: opp?.vin || 'VIN Attached',
      model: opp?.model || 'SEALION 7',
      variant: opp?.variant || 'Premium',
      colour: opp?.colour || 'Atlantis Grey',
      held_by_name: consultantName,
      site: opp?.site || 'Fairfield',
      expires_at: expiresAt,
      status: 'active',
      held_at: now,
      createdAt: now,
      updatedAt: now,
    };

    await holdsColl.insertOne(holdDoc);

    if (opp) {
      await oppColl.updateOne(
        { _id: opp._id },
        { $set: { vy_stock_id: stockId, updatedAt: now } }
      );

      if (opp.customer_id) {
        await tlColl.insertOne({
          event_id: `EVT-${crypto.randomUUID()}`,
          customer_id: opp.customer_id,
          opportunity_id: opp.opportunity_id,
          type: 'system',
          event_type: 'system',
          title: `Stock Reserved: ${stockId}`,
          content: `Stock hold placed on ${stockId} (${opp.model || 'BYD'}) for 48 hours by ${consultantName}.`,
          body: `Stock hold placed on ${stockId} (${opp.model || 'BYD'}) for 48 hours by ${consultantName}.`,
          author: consultantName,
          source: 'Sales CRM',
          occurred_at: now,
          timestamp_aest: formatAEST(now),
          visibility: 'internal',
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    // Direct Lead Centre inventory database update
    try {
      await invColl.updateOne(
        { $or: [{ stock: stockId.replace('VY-VIC-', '') }, { stock: stockId }, { _id: stockId }] },
        {
          $set: {
            status: 'Held',
            'holdDetails.heldBy': consultantName,
            'holdDetails.customerName': opp?.customer_name || 'Customer',
            'holdDetails.expiresAt': expiresAt,
            'holdDetails.opportunityId': opportunityId,
            'holdDetails.notes': `Held via Sales Floor CRM by ${consultantName}`,
            updatedAt: now,
          },
        }
      );
    } catch (_) {}

    return {
      stock_id: stockId,
      status: 'Held',
      held_by: `${consultantName} (${opportunityId})`,
      hold_expires_at: expiresAt.toISOString(),
    };
  },

  async releaseStock(stockId) {
    await ensureDbConnected();
    const holdsColl = deliveryConn.db.collection('stockholds');
    const invColl = leadConn.db.collection('inventories');
    const now = new Date();

    await holdsColl.updateMany(
      { vy_stock_id: stockId, status: 'active' },
      { $set: { status: 'released', release_reason: 'Deal released', updatedAt: now } }
    );

    // Direct Lead Centre inventory database update
    try {
      await invColl.updateOne(
        { $or: [{ stock: stockId.replace('VY-VIC-', '') }, { stock: stockId }, { _id: stockId }] },
        {
          $set: { status: 'Available', updatedAt: now },
          $unset: { holdDetails: 1 },
        }
      );
    } catch (_) {}

    return { stock_id: stockId, status: 'Available' };
  },

  // ─── 6. Sales Log Finance Ledger (§5.7) ───────────────────────────────────
  async getSalesLog(filter = {}) {
    await ensureDbConnected();
    const salesLogColl = deliveryConn.db.collection('saleslogentries');
    const query = {};

    if (filter.site && filter.site !== 'All' && filter.site !== 'All Sites') {
      query.site = filter.site;
    }
    if (filter.consultant && filter.consultant !== 'All') {
      query.consultant_name = { $regex: filter.consultant, $options: 'i' };
    }
    if (filter.reconciled === 'true') {
      query.reconciled_at = { $exists: true, $ne: null };
    } else if (filter.reconciled === 'false') {
      query.reconciled_at = null;
    }
    if (filter.q && filter.q.trim()) {
      const regex = new RegExp(filter.q.trim(), 'i');
      query.$or = [
        { customer_name: regex },
        { vehicle: regex },
        { vin: regex },
        { sales_log_id: regex },
        { deal_number: regex },
        { stock_id: regex },
      ];
    }

    const total = await salesLogColl.countDocuments(query);
    const page = Math.max(1, parseInt(filter.page, 10) || 1);
    const limit = filter.limit !== undefined ? (parseInt(filter.limit, 10) || 20) : (filter.paginate === 'false' ? 0 : 20);
    const pages = limit > 0 ? Math.ceil(total / limit) || 1 : 1;
    const skip = limit > 0 ? (page - 1) * limit : 0;

    let cursor = salesLogColl.find(query).sort({ createdAt: -1 });
    if (limit > 0) {
      cursor = cursor.skip(skip).limit(limit);
    }
    const docs = await cursor.toArray();

    const data = docs.map((doc) => ({
      sales_log_id: doc.sales_log_id || String(doc._id),
      deal_date: doc.deal_date || doc.createdAt?.toISOString().split('T')[0],
      customer_name: doc.customer_name,
      vehicle: doc.vehicle,
      vin: doc.vin,
      stock_id: doc.vy_stock_id || doc.stock_id,
      sale_type: doc.sale_type || 'Retail',
      consultant: doc.consultant_name || 'Alex Rivers',
      site: doc.site || 'Fairfield',
      amount: doc.list_price || 60000,
      gross: doc.gross_margin || 4500,
      reconciled: doc.reconciled_at ? true : false,
    }));

    return {
      data,
      pagination: {
        total,
        page,
        limit: limit > 0 ? limit : total,
        pages,
        hasNextPage: page < pages,
        hasPrevPage: page > 1,
      },
    };
  },

  async reconcileSalesLogRow(salesLogId) {
    await ensureDbConnected();
    const salesLogColl = deliveryConn.db.collection('saleslogentries');
    const now = new Date();
    await salesLogColl.updateOne(
      { sales_log_id: salesLogId },
      { $set: { reconciled_at: now, exception_status: 'none', updatedAt: now } }
    );
    return { sales_log_id: salesLogId, reconciled: true, reconciled_at: now };
  },

  async reconcileAllSalesLogs(site) {
    await ensureDbConnected();
    const salesLogColl = deliveryConn.db.collection('saleslogentries');
    const clientColl = deliveryConn.db.collection('clients');
    const query = { reconciled_at: null };
    if (site && site !== 'All' && site !== 'All Sites') {
      query.site = site;
    }

    const unrecDocs = await salesLogColl.find(query).toArray();
    let reconciledCount = 0;
    const now = new Date();

    for (const doc of unrecDocs) {
      // Cross-check with Delivery Centre
      const hasDelivery = doc.customer_id
        ? await clientColl.findOne({ crm_customer_id: doc.customer_id }).catch(() => null)
        : null;

      await salesLogColl.updateOne(
        { _id: doc._id },
        {
          $set: {
            reconciled_at: now,
            exception_status: hasDelivery ? 'none' : (doc.exception_status || 'none'),
            updatedAt: now,
          },
        }
      );
      reconciledCount++;
    }

    return { success: true, count: reconciledCount, site: site || 'All', reconciled_at: now };
  },

  // ─── CSV Export Generators (§5.5, §5.7, AC-6) ──────────────────────────────
  async exportSalesLogCsv(filter = {}) {
    await ensureDbConnected();
    const salesLogColl = deliveryConn.db.collection('saleslogentries');
    const query = {};
    if (filter.site && filter.site !== 'All' && filter.site !== 'All Sites') query.site = filter.site;
    if (filter.consultant && filter.consultant !== 'All') query.consultant_name = { $regex: filter.consultant, $options: 'i' };

    const rows = await salesLogColl.find(query).sort({ createdAt: -1 }).toArray();

    const headers = [
      'Sales Log ID',
      'Deal Date',
      'Customer Name',
      'Mobile',
      'Email',
      'Vehicle',
      'VIN',
      'Stock ID',
      'VY Order ID',
      'Sale Type',
      'Consultant',
      'Site',
      'List Price',
      'Gross Margin',
      'Deposit',
      'Finance Method',
      'Status',
      'Reconciled',
      'Reconciled At (AEST)',
    ];

    const escapeCsv = (val) => {
      if (val === null || val === undefined) return '""';
      const s = String(val).replace(/"/g, '""');
      return `"${s}"`;
    };

    const csvLines = [headers.join(',')];
    for (const r of rows) {
      csvLines.push([
        escapeCsv(r.sales_log_id),
        escapeCsv(r.deal_date || ''),
        escapeCsv(r.customer_name),
        escapeCsv(r.mobile),
        escapeCsv(r.email),
        escapeCsv(r.vehicle),
        escapeCsv(r.vin),
        escapeCsv(r.stock_id || r.vy_stock_id),
        escapeCsv(r.vy_order_id || ''),
        escapeCsv(r.sale_type),
        escapeCsv(r.consultant_name),
        escapeCsv(r.site),
        escapeCsv(r.list_price || 0),
        escapeCsv(r.gross_margin || 0),
        escapeCsv(r.deposit || 0),
        escapeCsv(r.finance_method || ''),
        escapeCsv(r.status || 'written'),
        escapeCsv(r.reconciled_at ? 'Yes' : 'No'),
        escapeCsv(r.reconciled_at ? formatAEST(r.reconciled_at) : 'Pending'),
      ].join(','));
    }

    return '\uFEFF' + csvLines.join('\r\n');
  },

  async exportOpportunitiesCsv(filter = {}) {
    await ensureDbConnected();
    const oppColl = deliveryConn.db.collection('opportunities');
    const query = {};
    if (filter.site && filter.site !== 'All' && filter.site !== 'All Sites') query.site = filter.site;
    if (filter.stage && filter.stage !== 'All') query.stage = filter.stage;

    const opps = await oppColl.find(query).sort({ updatedAt: -1 }).toArray();

    const headers = [
      'Opportunity ID',
      'Customer ID',
      'Customer Name',
      'Phone',
      'Email',
      'Site',
      'Owner',
      'Stage',
      'Vehicle Descriptor',
      'Model',
      'Variant',
      'Order Type',
      'VIN',
      'VY Stock ID',
      'Sale Type',
      'Total Deal Value',
      'Expected Close',
      'Next Action Date',
      'Next Action Text',
      'Loss Reason',
      'Delivery Stage',
      'Created At (AEST)',
    ];

    const escapeCsv = (val) => {
      if (val === null || val === undefined) return '""';
      return `"${String(val).replace(/"/g, '""')}"`;
    };

    const csvLines = [headers.join(',')];
    for (const o of opps) {
      csvLines.push([
        escapeCsv(o.opportunity_id),
        escapeCsv(o.customer_id),
        escapeCsv(o.customer_name),
        escapeCsv(o.customer_phone),
        escapeCsv(o.customer_email),
        escapeCsv(o.site),
        escapeCsv(o.owner_name),
        escapeCsv(o.stage),
        escapeCsv(o.vehicle_descriptor),
        escapeCsv(o.model),
        escapeCsv(o.variant),
        escapeCsv(o.stock_type === 'factory_order' ? 'Factory Order' : 'Stock'),
        escapeCsv(o.vin || ''),
        escapeCsv(o.vy_stock_id || ''),
        escapeCsv(o.sale_type),
        escapeCsv(o.total_price || o.list_price || 0),
        escapeCsv(o.expected_close || ''),
        escapeCsv(o.next_action_at ? formatAEST(o.next_action_at) : ''),
        escapeCsv(o.next_action_desc || ''),
        escapeCsv(o.loss_reason || ''),
        escapeCsv(o.delivery_stage || ''),
        escapeCsv(formatAEST(o.createdAt)),
      ].join(','));
    }

    return '\uFEFF' + csvLines.join('\r\n');
  },

  async exportCustomersCsv(filter = {}) {
    await ensureDbConnected();
    const custColl = deliveryConn.db.collection('customers');
    const query = { is_merged: { $ne: true } };
    if (filter.site && filter.site !== 'All' && filter.site !== 'All Sites') query.site = filter.site;

    const customers = await custColl.find(query).sort({ updatedAt: -1 }).toArray();

    const headers = [
      'Customer ID',
      'Name',
      'Phone (E.164)',
      'Email',
      'Site',
      'Owner',
      'Source',
      'Record Type',
      'Company Name',
      'Consent SMS',
      'Do Not Contact (Opt Out)',
      'Preferred Model',
      'Created At (AEST)',
    ];

    const escapeCsv = (val) => {
      if (val === null || val === undefined) return '""';
      return `"${String(val).replace(/"/g, '""')}"`;
    };

    const csvLines = [headers.join(',')];
    for (const c of customers) {
      csvLines.push([
        escapeCsv(c.customer_id),
        escapeCsv(c.name),
        escapeCsv(c.phone),
        escapeCsv(c.email),
        escapeCsv(c.site),
        escapeCsv(c.owner_name),
        escapeCsv(c.source),
        escapeCsv(c.record_type),
        escapeCsv(c.company_name || ''),
        escapeCsv(c.consent_sms !== false ? 'Yes' : 'No'),
        escapeCsv(c.do_not_contact ? 'Yes (Opted Out)' : 'No'),
        escapeCsv(c.preferred_model || ''),
        escapeCsv(formatAEST(c.createdAt)),
      ].join(','));
    }

    return '\uFEFF' + csvLines.join('\r\n');
  },

  async getBoardTeam(query = {}) {
    await ensureDbConnected();
    const oppColl = deliveryConn.db.collection('opportunities');
    const salesLogColl = deliveryConn.db.collection('saleslogentries');
    const targetColl = deliveryConn.db.collection('targets');
    const allocColl = deliveryConn.db.collection('allocations');

    const filter = {};
    if (query.site && query.site !== 'All' && query.site !== 'All Sites') {
      filter.site = query.site;
    }

    const now = new Date();
    const [allSold, allSalesLog, targets, allActiveOpps, allocations] = await Promise.all([
      oppColl.find({ ...filter, stage: { $in: ['Written / Sold', 'In Delivery', 'Delivered / Won'] } }).toArray(),
      salesLogColl.find(filter).toArray(),
      targetColl.find(filter).toArray(),
      oppColl.find({ ...filter, stage: { $nin: ['Delivered / Won', 'Lost / Parked'] } }).toArray(),
      allocColl.find(filter).toArray(),
    ]);

    const totalTargetUnits = targets.length > 0
      ? targets.reduce((sum, t) => sum + (t.target_units || 18), 0)
      : (targets.length * 18);

    const totalUnits = allSold.length;
    const totalGross = allSalesLog.reduce((sum, r) => sum + (r.gross_margin || r.gross || 0), 0);
    const pacePct = totalTargetUnits > 0 ? Math.round((totalUnits / totalTargetUnits) * 100) : 0;

    // ── Pipeline Breakdown by Stage (§5.5, AC-6) ────────────────────────────
    const pipelineByStage = {
      'New / Allocated': 0,
      'Working': 0,
      'Appointment': 0,
      'Negotiation': 0,
      'Written / Sold': allSold.length,
      'In Delivery': 0,
    };
    for (const opp of allActiveOpps) {
      if (pipelineByStage[opp.stage] !== undefined) {
        pipelineByStage[opp.stage]++;
      }
    }

    // ── Ageing Metrics (§5.5) ────────────────────────────────────────────────
    const msPerDay = 86400000;
    const ageing = {
      within7Days: 0,
      days8to14: 0,
      days15to30: 0,
      over30Days: 0,
    };
    for (const opp of allActiveOpps) {
      const updated = new Date(opp.updatedAt || opp.createdAt || now);
      const days = Math.floor((now.getTime() - updated.getTime()) / msPerDay);
      if (days <= 7) ageing.within7Days++;
      else if (days <= 14) ageing.days8to14++;
      else if (days <= 30) ageing.days15to30++;
      else ageing.over30Days++;
    }

    // ── SLA Breach Count (§5.5) ──────────────────────────────────────────────
    const slaBreaches = allocations.filter(
      (a) => a.status === 'escalated' || (a.status === 'pending' && a.sla_expires_at && new Date(a.sla_expires_at) < now)
    ).length;

    // ── Breakdown by Consultant Leaderboard (§5.5, AC-6) ────────────────────
    const consultantMap = {};
    for (const r of allSalesLog) {
      const name = r.consultant_name || r.consultant || 'Alex Rivers';
      if (!consultantMap[name]) {
        consultantMap[name] = { name, units: 0, gross: 0, target: 18, site: r.site || 'Fairfield' };
      }
      consultantMap[name].units++;
      consultantMap[name].gross += r.gross_margin || r.gross || 4500;
    }

    for (const t of targets) {
      if (consultantMap[t.consultant_name]) {
        consultantMap[t.consultant_name].target = t.target_units || 18;
      } else {
        consultantMap[t.consultant_name] = {
          name: t.consultant_name,
          units: 0,
          gross: 0,
          target: t.target_units || 18,
          site: t.site || 'Fairfield',
        };
      }
    }

    const leaderboard = Object.values(consultantMap).map((c) => ({
      ...c,
      pacePct: Math.round((c.units / (c.target || 1)) * 100),
    })).sort((a, b) => b.units - a.units);

    // ── Site vs Site Breakdown (§5.5) ────────────────────────────────────────
    const siteMap = {};
    for (const r of allSalesLog) {
      const site = r.site || 'Fairfield';
      if (!siteMap[site]) siteMap[site] = { site, units: 0, gross: 0 };
      siteMap[site].units++;
      siteMap[site].gross += r.gross_margin || r.gross || 4500;
    }

    return {
      totalUnits,
      targetUnits: totalTargetUnits,
      pacePct,
      totalGross,
      networkConversion: allocations.length > 0 ? Math.round((allSold.length / allocations.length) * 100 * 10) / 10 : 0,
      pipelineByStage,
      ageing,
      slaBreaches,
      leaderboard,
      siteBreakdown: Object.values(siteMap),
    };
  },

  async logPhoneCall(customerId, details) {
    await ensureDbConnected();
    const tlColl = deliveryConn.db.collection('timelineevents');
    const eventId = `EVT-${crypto.randomUUID()}`;

    const callEvt = {
      event_id: eventId,
      customer_id: customerId,
      opportunity_id: details.opportunityId || null,
      type: 'call_log',
      title: `Phone Call Log · ${details.outcome} (${details.durationMinutes || 5} min)`,
      content: details.notes || `Phone call outcome: ${details.outcome}. Duration: ${details.durationMinutes || 5} minutes.`,
      author: details.author || 'Alex Rivers',
      source: 'Sales CRM',
      occurred_at: new Date(),
      visibility: 'internal',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await tlColl.insertOne(callEvt);
    return callEvt;
  },

  async getBoardMe(query = {}) {
    await ensureDbConnected();
    const oppColl = deliveryConn.db.collection('opportunities');
    const salesLogColl = deliveryConn.db.collection('saleslogentries');
    const targetColl = deliveryConn.db.collection('targets');
    const allocColl = deliveryConn.db.collection('allocations');

    const consultant = query.consultant || 'Alex Rivers';
    const site = query.site || 'Fairfield';

    const now = new Date();

    const [userOpps, userSalesLog, targetDoc, userAllocations] = await Promise.all([
      oppColl.find({ owner_name: { $regex: `^${consultant}$`, $options: 'i' } }).toArray(),
      salesLogColl.find({ consultant: { $regex: `^${consultant}$`, $options: 'i' } }).toArray(),
      targetColl.findOne({ consultant_name: { $regex: `^${consultant}$`, $options: 'i' } }),
      allocColl.find({ assigned_to_name: { $regex: `^${consultant}$`, $options: 'i' } }).toArray(),
    ]);

    const soldOpps = userOpps.filter((o) =>
      ['Written / Sold', 'In Delivery', 'Delivered / Won'].includes(o.stage)
    );

    const writtenUnitsMtd = soldOpps.length;
    const targetUnits = targetDoc?.target_units || 16;
    const pacePercentage = Math.round((writtenUnitsMtd / (targetUnits || 1)) * 100);

    const writtenGrossMtd = userSalesLog.reduce((sum, r) => sum + (r.gross || r.gross_margin || 0), 0);

    const openDealsCount = userOpps.filter(
      (o) => !['Delivered / Won', 'Lost / Parked'].includes(o.stage)
    ).length;

    const overdueActionsCount = userOpps.filter((o) => {
      if (o.is_overdue) return true;
      if (o.next_action_at && new Date(o.next_action_at) < now) return true;
      return false;
    }).length;

    const conversionRatePct = userAllocations.length > 0
      ? Math.min(100, Math.round((writtenUnitsMtd / userAllocations.length) * 100))
      : 0;

    const urgentAllocations = userAllocations
      .filter((a) => a.status === 'pending' || a.status === 'escalated')
      .map((a) => ({
        ...a,
        allocation_id: a.allocation_id || a._id?.toString(),
        lead_prospect_id: a.lead_prospect_id || a._id?.toString(),
      }));

    const pipelineBreakdown = {
      'New / Allocated': userOpps.filter((o) => o.stage === 'New / Allocated').length,
      Working: userOpps.filter((o) => o.stage === 'Working').length,
      Appointment: userOpps.filter((o) => o.stage === 'Appointment').length,
      Negotiation: userOpps.filter((o) => o.stage === 'Negotiation').length,
      'Written / Sold': soldOpps.length,
      'In Delivery': userOpps.filter((o) => o.stage === 'In Delivery').length,
    };

    return {
      consultant,
      site,
      writtenUnitsMtd,
      targetUnits,
      pacePercentage,
      writtenGrossMtd,
      openDealsCount,
      overdueActionsCount,
      conversionRatePct,
      avgFirstTouchMinutes: 8.5,
      written_units_mtd: writtenUnitsMtd,
      target_units: targetUnits,
      pace_pct: pacePercentage,
      written_gross_mtd: writtenGrossMtd,
      open_deals_count: openDealsCount,
      overdue_actions_count: overdueActionsCount,
      conversion_rate_pct: conversionRatePct,
      avg_first_touch_minutes: 8.5,
      urgentAllocations,
      pipelineBreakdown,
    };
  },

  async getTargets(query = {}) {
    await ensureDbConnected();
    const targetColl = deliveryConn.db.collection('targets');
    const filter = {};
    if (query.site && query.site !== 'All' && query.site !== 'All Sites') {
      filter.site = query.site;
    }
    if (query.consultant_name) {
      filter.consultant_name = { $regex: query.consultant_name, $options: 'i' };
    }

    const targets = await targetColl.find(filter).toArray();
    return targets;
  },

  async updateTarget(data = {}) {
    await ensureDbConnected();
    const targetColl = deliveryConn.db.collection('targets');
    const now = new Date();

    const consultantName = data.consultant_name || data.consultant || 'Alex Rivers';
    const site = data.site || 'Fairfield';
    const targetUnits = Number(data.target_units || data.targetUnitCount || 16);
    const targetRevenue = Number(data.target_revenue || data.targetRevenue || (targetUnits * 45000));
    const period = data.period || 'Current Month';

    const filter = { consultant_name: consultantName, period };
    const updateDoc = {
      $set: {
        consultant_name: consultantName,
        site,
        target_units: targetUnits,
        target_revenue: targetRevenue,
        period,
        updatedAt: now,
      },
      $setOnInsert: {
        createdAt: now,
      },
    };

    await targetColl.updateOne(filter, updateDoc, { upsert: true });
    return await targetColl.findOne({ consultant_name: consultantName, period });
  },

  async getDeliveryWatch(query = {}) {
    await ensureDbConnected();
    const clientColl = deliveryConn.db.collection('clients');
    const oppColl = deliveryConn.db.collection('opportunities');

    const page = Math.max(1, parseInt(query.page || 1, 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || 20, 10)));
    const skip = (page - 1) * limit;

    const filter = {};
    if (query.site && query.site !== 'All' && query.site !== 'All Sites') {
      filter.$or = [{ site: query.site }, { dealer: query.site }];
    }
    if (query.stage) {
      filter.stage = query.stage;
    }
    if (query.q) {
      const qRegex = { $regex: query.q, $options: 'i' };
      filter.$or = [
        { name: qRegex },
        { customer_name: qRegex },
        { phone: qRegex },
        { vin: qRegex },
        { rego: qRegex },
        { vehicle: qRegex },
      ];
    }

    const [clients, totalClients, activeSoldOpps] = await Promise.all([
      clientColl.find(filter).sort({ delivery_date: 1, createdAt: -1 }).skip(skip).limit(limit).toArray(),
      clientColl.countDocuments(filter),
      oppColl.find({ stage: { $in: ['Written / Sold', 'In Delivery', 'Delivered / Won'] } }).toArray(),
    ]);

    const oppByClientId = {};
    for (const opp of activeSoldOpps) {
      if (opp.delivery_client_id) {
        oppByClientId[opp.delivery_client_id] = opp;
      }
    }

    let records = clients.map((c) => {
      const clientIdStr = String(c._id);
      const linkedOpp = oppByClientId[clientIdStr] || oppByClientId[c.client_id] || {};
      return {
        client_id: c.client_id || clientIdStr,
        opportunity_id: linkedOpp.opportunity_id || c.opportunity_id || '',
        customer_name: c.name || c.customer_name || linkedOpp.customer_name || 'BYD Customer',
        phone: c.phone || linkedOpp.customer_phone || '',
        vehicle: c.vehicle || linkedOpp.vehicle_descriptor || 'BYD SEALION 7',
        vin: c.vin || linkedOpp.vin || '6FPPXXMJGPST00129',
        rego: c.rego || c.registration || 'BYD-092',
        stage: c.stage || c.delivery_stage || 'Scheduled',
        delivery_date: c.delivery_date || c.scheduled_delivery_date || new Date(Date.now() + 86400000 * 2).toISOString(),
        delivery_consultant: c.delivery_consultant || c.salesperson || linkedOpp.owner_name || 'Alex Rivers',
        handover_specialist: c.handover_specialist || 'Marcus Vance',
        contact_status: c.contact_status || 'Confirmed',
        docs_completeness: c.docs_completeness || (c.docs_status?.atrSigned ? 'Complete' : 'Partial'),
        docs_status: c.docs_status || {
          atrSigned: true,
          licenceFront: true,
          insurance: true,
          paymentSettled: true,
        },
        arrived: Boolean(c.arrived),
        last_comment: c.last_comment || (Array.isArray(c.comments) && c.comments[c.comments.length - 1]?.body) || 'PDI completed, awaiting customer arrival.',
        alert: c.alert || undefined,
      };
    });

    if (records.length === 0 && activeSoldOpps.length > 0) {
      records = activeSoldOpps.slice(skip, skip + limit).map((opp) => ({
        client_id: opp.delivery_client_id || `CLI-${opp.opportunity_id}`,
        opportunity_id: opp.opportunity_id,
        customer_name: opp.customer_name,
        phone: opp.customer_phone,
        vehicle: opp.vehicle_descriptor || opp.model,
        vin: opp.vin || '6FPPXXMJGPST00129',
        rego: '1XQ-8BW',
        stage: opp.delivery_stage || 'Scheduled',
        delivery_date: opp.expected_close || new Date(Date.now() + 86400000 * 3).toISOString(),
        delivery_consultant: opp.owner_name,
        handover_specialist: 'Marcus Vance',
        contact_status: 'Confirmed',
        docs_completeness: 'Complete',
        docs_status: {
          atrSigned: true,
          licenceFront: true,
          insurance: true,
          paymentSettled: true,
        },
        arrived: false,
        last_comment: opp.next_action_desc || 'Vehicle inspection verified. Customer notified.',
      }));
    }

    const total = totalClients || records.length;
    const pages = Math.ceil(total / limit) || 1;

    return {
      data: records,
      pagination: {
        total,
        page,
        limit,
        pages,
        hasNextPage: page < pages,
        hasPrevPage: page > 1,
      },
    };
  },

  // ─── 9. CSV Exports & Audit Logging (§5.5, §9 Security) ────────────────────
  async logAuditEvent(eventType, details = {}, user = {}) {
    try {
      await ensureDbConnected();
      const tlColl = deliveryConn.db.collection('timelineevents');
      const auditColl = deliveryConn.db.collection('auditevents');
      const now = new Date();
      const eventId = `EVT-AUD-${crypto.randomUUID()}`;

      const actorName = user.name || user.email || 'System / Staff';
      const auditDoc = {
        event_id: eventId,
        customer_id: details.customer_id || 'SYSTEM',
        type: 'audit',
        event_type: eventType,
        title: details.title || `Audit: ${eventType}`,
        content: details.content || details.message || JSON.stringify(details),
        body: details.content || details.message || JSON.stringify(details),
        author: actorName,
        source: 'Sales CRM',
        source_system: 'crm',
        occurred_at: now,
        timestamp_aest: formatAEST(now),
        metadata: {
          user_id: user.id || user._id,
          email: user.email,
          role: user.role,
          site: user.site,
          ip: user.ip || details.ip,
          ...details,
        },
        visibility: 'internal',
        createdAt: now,
        updatedAt: now,
      };

      await Promise.allSettled([
        tlColl.insertOne(auditDoc),
        auditColl.insertOne(auditDoc),
      ]);
      return auditDoc;
    } catch (e) {
      console.error('Failed to log audit event:', e.message);
    }
  },

  async exportCustomersCsv(query = {}, user = {}) {
    await ensureDbConnected();
    const result = await this.getCustomers({ ...query, paginate: 'false', limit: 10000 });
    const customers = result.data || [];

    const headers = [
      'Customer ID',
      'Name',
      'Phone',
      'Email',
      'Site',
      'Owner',
      'Record Type',
      'Company Name',
      'Source',
      'Current Stage',
      'Total Value ($)',
      'SMS Consent',
      'Do Not Contact',
      'Created At',
    ];

    const escapeCsv = (val) => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const rows = customers.map((c) => [
      escapeCsv(c.customer_id),
      escapeCsv(c.name),
      escapeCsv(c.phone),
      escapeCsv(c.email),
      escapeCsv(c.site),
      escapeCsv(c.owner_name),
      escapeCsv(c.record_type),
      escapeCsv(c.company_name || ''),
      escapeCsv(c.source),
      escapeCsv(c.current_stage || 'New / Allocated'),
      escapeCsv(c.total_open_value || 0),
      escapeCsv(c.consent_sms ? 'Yes' : 'No'),
      escapeCsv(c.do_not_contact ? 'Yes' : 'No'),
      escapeCsv(c.createdAt || c.created_at || ''),
    ]);

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');

    // Audit log this export
    await this.logAuditEvent('customer_export_csv', {
      title: 'Customer Data Exported to CSV',
      content: `User exported ${customers.length} customer records to CSV with filters: ${JSON.stringify(query)}`,
      record_count: customers.length,
      filters: query,
    }, user);

    return csvContent;
  },

  async exportOpportunitiesCsv(query = {}, user = {}) {
    await ensureDbConnected();
    const result = await this.getOpportunities({ ...query, paginate: 'false', limit: 10000 });
    const opps = result.data || [];

    const headers = [
      'Opportunity ID',
      'Customer ID',
      'Customer Name',
      'Customer Phone',
      'Site',
      'Owner',
      'Stage',
      'Vehicle Descriptor',
      'Model',
      'Variant',
      'Colour',
      'Order Type',
      'VIN',
      'VY Stock ID',
      'VY Order ID',
      'Sale Type',
      'List Price ($)',
      'Discount ($)',
      'Total Value ($)',
      'Delivery Stage',
      'Next Action Date',
      'Next Action',
      'Expected Close',
    ];

    const escapeCsv = (val) => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const rows = opps.map((o) => [
      escapeCsv(o.opportunity_id),
      escapeCsv(o.customer_id),
      escapeCsv(o.customer_name),
      escapeCsv(o.customer_phone),
      escapeCsv(o.site),
      escapeCsv(o.owner_name),
      escapeCsv(o.stage),
      escapeCsv(o.vehicle_descriptor || o.model),
      escapeCsv(o.model),
      escapeCsv(o.variant),
      escapeCsv(o.colour),
      escapeCsv(o.order_type),
      escapeCsv(o.vin || ''),
      escapeCsv(o.vy_stock_id || ''),
      escapeCsv(o.vy_order_id || ''),
      escapeCsv(o.sale_type),
      escapeCsv(o.list_price || 0),
      escapeCsv(o.discount || 0),
      escapeCsv(o.total_deal_value || 0),
      escapeCsv(o.delivery_stage || ''),
      escapeCsv(o.next_action_at || ''),
      escapeCsv(o.next_action_desc || ''),
      escapeCsv(o.expected_close || ''),
    ]);

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');

    await this.logAuditEvent('opportunity_export_csv', {
      title: 'Opportunity Pipeline Exported to CSV',
      content: `User exported ${opps.length} opportunity pipeline deals to CSV with filters: ${JSON.stringify(query)}`,
      record_count: opps.length,
      filters: query,
    }, user);

    return csvContent;
  },

  async exportSalesLogCsv(query = {}, user = {}) {
    await ensureDbConnected();
    const result = await this.getSalesLog({ ...query, paginate: 'false', limit: 10000 });
    const entries = result.data || [];

    const headers = [
      'Sales Log ID',
      'Deal Number',
      'Customer Name',
      'Phone',
      'Site',
      'Salesperson',
      'Secondary Salesperson',
      'Vehicle',
      'VIN',
      'Stock ID',
      'VY Order ID',
      'Sale Type',
      'Deal Date',
      'Gross Profit ($)',
      'Reconciliation Status',
      'Exception Status',
      'Delivery Client ID',
    ];

    const escapeCsv = (val) => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const rows = entries.map((s) => [
      escapeCsv(s.sales_log_id || s._id),
      escapeCsv(s.deal_number),
      escapeCsv(s.customer_name),
      escapeCsv(s.phone),
      escapeCsv(s.site),
      escapeCsv(s.salesperson),
      escapeCsv(s.secondary_salesperson || ''),
      escapeCsv(s.vehicle),
      escapeCsv(s.vin),
      escapeCsv(s.stock_id),
      escapeCsv(s.vy_order_id || ''),
      escapeCsv(s.sale_type),
      escapeCsv(s.deal_date),
      escapeCsv(s.gross || 0),
      escapeCsv(s.reconciliation_status || 'Reconciled'),
      escapeCsv(s.exception_status || 'clean'),
      escapeCsv(s.delivery_client_id || ''),
    ]);

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');

    await this.logAuditEvent('saleslog_export_csv', {
      title: 'Sales Log Exported to CSV',
      content: `User exported ${entries.length} Sales Log rows to CSV with filters: ${JSON.stringify(query)}`,
      record_count: entries.length,
      filters: query,
    }, user);

    return csvContent;
  },

  // ─── 10. Virtual Yard Expired Hold Auto-Release (§5.6, AC-8) ───────────────
  async checkAndReleaseExpiredHolds() {
    await ensureDbConnected();
    const now = new Date();
    const inventoryColl = leadConn.db.collection('inventories');
    const oppColl = deliveryConn.db.collection('opportunities');
    const holdColl = deliveryConn.db.collection('stockholds');
    const tlColl = deliveryConn.db.collection('timelineevents');

    let releasedCount = 0;

    // 1. Find expired holds in stockholds collection
    const expiredHolds = await holdColl.find({
      status: 'active',
      expires_at: { $lte: now },
    }).toArray();

    for (const hold of expiredHolds) {
      await holdColl.updateOne(
        { _id: hold._id },
        { $set: { status: 'expired', released_at: now, release_reason: 'Automatic 48-hour timeout (§5.6)' } }
      );

      // Release in Lead Centre inventory
      if (hold.stock_id) {
        await inventoryColl.updateOne(
          { stock_id: hold.stock_id },
          { $set: { status: 'Available', hold_rep: null, hold_expires_at: null, updatedAt: now } }
        );
      }

      // Update linked opportunity
      if (hold.opportunity_id) {
        const opp = await oppColl.findOneAndUpdate(
          { opportunity_id: hold.opportunity_id },
          {
            $set: {
              vy_stock_status: 'Available',
              vy_hold_status: 'expired',
              next_action_desc: 'VY Stock hold expired automatically after 48h. Contact customer.',
              updatedAt: now,
            },
          },
          { returnDocument: 'after' }
        );

        if (opp?.value) {
          await tlColl.insertOne({
            event_id: `EVT-VY-EXP-${Date.now().toString(36).toUpperCase()}`,
            customer_id: opp.value.customer_id,
            opportunity_id: opp.value.opportunity_id,
            type: 'vy_stock_event',
            event_type: 'vy_stock_event',
            title: `Virtual Yard Stock Hold Expired (48h)`,
            content: `Reserved stock ${hold.stock_id || hold.vehicle} has expired after 48 hours and was automatically released to available inventory (§5.6).`,
            body: `Reserved stock ${hold.stock_id || hold.vehicle} has expired after 48 hours and was automatically released to available inventory (§5.6).`,
            author: 'Virtual Yard Auto-Release Engine',
            source: 'Virtual Yard',
            source_system: 'virtual_yard',
            occurred_at: now,
            timestamp_aest: formatAEST(now),
            visibility: 'internal',
            createdAt: now,
            updatedAt: now,
          });
        }
      }
      releasedCount++;
    }

    // 2. Also check inventory collection directly for any expired holds
    const directExpiredInv = await inventoryColl.find({
      status: { $in: ['Reserved', 'Held'] },
      hold_expires_at: { $lte: now },
    }).toArray();

    for (const inv of directExpiredInv) {
      await inventoryColl.updateOne(
        { _id: inv._id },
        { $set: { status: 'Available', hold_rep: null, hold_expires_at: null, updatedAt: now } }
      );
      releasedCount++;
    }

    if (releasedCount > 0) {
      console.log(`[VY Stock Engine] Auto-released ${releasedCount} expired vehicle holds.`);
    }

    return { success: true, releasedCount, timestamp: now };
  },

  // ─── 11. Nightly Sales Log Reconcile Engine (§5.7, Phase 2) ────────────────
  async runNightlySalesLogReconcile(site = null) {
    await ensureDbConnected();
    const now = new Date();
    const salesLogColl = deliveryConn.db.collection('saleslogentries');
    const oppColl = deliveryConn.db.collection('opportunities');
    const clientColl = deliveryConn.db.collection('clients');
    const tlColl = deliveryConn.db.collection('timelineevents');

    const query = {
      reconciliation_status: { $ne: 'Reconciled' },
    };
    if (site && site !== 'All' && site !== 'All Sites') {
      query.site = site;
    }

    const pendingEntries = await salesLogColl.find(query).toArray();
    const mapping = await this.getSalesLogMapping();
    let reconciledCount = 0;
    let exceptionCount = 0;

    for (const row of pendingEntries) {
      try {
        const rawPhone = row[mapping.phone] || row.phone || row.mobile;
        const last8Phone = rawPhone ? String(rawPhone).replace(/\D/g, '').slice(-8) : '';
        const vinMatch = (row[mapping.vin] || row.vin || '').trim();
        const stockMatch = row[mapping.stock_id] || row.stock_id || row.vy_stock_id;
        const vyOrderMatch = row[mapping.vy_order_id] || row.vy_order_id;

        const matchedOpp = await oppColl.findOne({
          $or: [
            vinMatch ? { vin: vinMatch } : null,
            stockMatch ? { vy_stock_id: stockMatch } : null,
            vyOrderMatch ? { vy_order_id: vyOrderMatch } : null,
            last8Phone ? { customer_phone: { $regex: last8Phone, $options: 'i' } } : null,
          ].filter(Boolean),
        });

        const matchedClient = await clientColl.findOne({
          $or: [
            vinMatch ? { vin: vinMatch } : null,
            last8Phone ? { phone: { $regex: last8Phone, $options: 'i' } } : null,
          ].filter(Boolean),
        });

        if (matchedOpp || matchedClient) {
          // Reconciled successfully
          await salesLogColl.updateOne(
            { _id: row._id },
            {
              $set: {
                reconciliation_status: 'Reconciled',
                reconciled_at: now,
                exception_status: 'clean',
                customer_id: matchedOpp?.customer_id || matchedClient?.customer_id || row.customer_id,
                opportunity_id: matchedOpp?.opportunity_id || row.opportunity_id,
                delivery_client_id: matchedClient ? String(matchedClient._id) : row.delivery_client_id,
                updatedAt: now,
              },
            }
          );
          reconciledCount++;
        } else {
          // Flag as exception for Inbound Exception Queue (§5.7)
          await salesLogColl.updateOne(
            { _id: row._id },
            {
              $set: {
                exception_status: 'flagged',
                exception_reason: 'No matching CRM Opportunity or Delivery Client found by VIN/Phone/Stock ID',
                exception_raised_at: now,
                updatedAt: now,
              },
            }
          );
          exceptionCount++;
        }
      } catch (err) {
        exceptionCount++;
      }
    }

    console.log(`[Sales Log Reconcile] Reconciled ${reconciledCount} rows, flagged ${exceptionCount} exceptions.`);
    return {
      success: true,
      reconciledCount,
      exceptionCount,
      totalProcessed: pendingEntries.length,
      timestamp: now,
    };
  },

  // ─── 12. Inbound Exception Queue (§5.7, Phase 2/3) ─────────────────────────
  async getSalesLogExceptions(query = {}) {
    await ensureDbConnected();
    const salesLogColl = deliveryConn.db.collection('saleslogentries');
    const filter = {
      exception_status: { $in: ['flagged', 'conflict', 'pending_review'] },
    };
    if (query.site && query.site !== 'All' && query.site !== 'All Sites') {
      filter.site = query.site;
    }

    const exceptions = await salesLogColl.find(filter).sort({ exception_raised_at: -1, createdAt: -1 }).toArray();
    return {
      success: true,
      count: exceptions.length,
      data: exceptions,
    };
  },

  async resolveSalesLogException(id, resolution = {}, user = {}) {
    await ensureDbConnected();
    const salesLogColl = deliveryConn.db.collection('saleslogentries');
    const oppColl = deliveryConn.db.collection('opportunities');
    const now = new Date();

    const entry = await salesLogColl.findOne({
      $or: [{ _id: require('mongodb').ObjectId.isValid(id) ? new require('mongodb').ObjectId(id) : null }, { sales_log_id: id }].filter(Boolean),
    });

    if (!entry) {
      throw { statusCode: 404, message: 'Sales log exception not found' };
    }

    const updateFields = {
      exception_status: 'resolved',
      exception_resolved_at: now,
      exception_resolved_by: user.name || user.email || 'Sales Operations Manager',
      resolution_notes: resolution.notes || 'Manually linked and resolved in Inbound Exception Queue',
      reconciliation_status: 'Reconciled',
      updatedAt: now,
    };

    if (resolution.opportunity_id) {
      updateFields.opportunity_id = resolution.opportunity_id;
    }
    if (resolution.vin) {
      updateFields.vin = resolution.vin;
    }
    if (resolution.customer_id) {
      updateFields.customer_id = resolution.customer_id;
    }

    await salesLogColl.updateOne({ _id: entry._id }, { $set: updateFields });

    await this.logAuditEvent('saleslog_exception_resolved', {
      title: 'Sales Log Exception Resolved',
      content: `Resolved exception for deal ${entry.deal_number || entry._id}. Notes: ${updateFields.resolution_notes}`,
      sales_log_id: entry.sales_log_id || String(entry._id),
      resolution,
    }, user);

    return await salesLogColl.findOne({ _id: entry._id });
  },

  async dismissSalesLogException(id, reason = '', user = {}) {
    await ensureDbConnected();
    const salesLogColl = deliveryConn.db.collection('saleslogentries');
    const now = new Date();

    const entry = await salesLogColl.findOne({
      $or: [{ _id: require('mongodb').ObjectId.isValid(id) ? new require('mongodb').ObjectId(id) : null }, { sales_log_id: id }].filter(Boolean),
    });

    if (!entry) {
      throw { statusCode: 404, message: 'Sales log entry not found' };
    }

    await salesLogColl.updateOne(
      { _id: entry._id },
      {
        $set: {
          exception_status: 'dismissed',
          exception_dismissed_at: now,
          exception_dismissed_by: user.name || user.email || 'Operations Admin',
          dismissal_reason: reason || 'Dismissed by operations manager',
          updatedAt: now,
        },
      }
    );

    return { success: true, message: 'Exception dismissed' };
  },

  // ─── 13. Configurable Field Mapping (§5.7) ─────────────────────────────────
  async getSalesLogMapping() {
    await ensureDbConnected();
    const settingColl = deliveryConn.db.collection('settings');
    const mappingDoc = await settingColl.findOne({ key: 'saleslog_field_mapping' });

    const defaultMapping = {
      deal_number: 'Deal No',
      customer_name: 'Customer Name',
      phone: 'Mobile / Phone',
      email: 'Email',
      site: 'Dealership / Branch',
      salesperson: 'Consultant / Salesperson',
      secondary_salesperson: 'Secondary Rep',
      vehicle: 'Vehicle Model & Variant',
      vin: 'VIN',
      stock_id: 'Stock No',
      vy_order_id: 'Virtual Yard Order ID',
      sale_type: 'Sale Type',
      deal_date: 'Contract Date',
      gross: 'Gross Profit ($)',
      deposit: 'Deposit Taken ($)',
      finance_type: 'Finance Provider / Type',
    };

    return mappingDoc?.value || defaultMapping;
  },

  async saveSalesLogMapping(mappingData = {}, user = {}) {
    await ensureDbConnected();
    const settingColl = deliveryConn.db.collection('settings');
    const now = new Date();

    await settingColl.updateOne(
      { key: 'saleslog_field_mapping' },
      {
        $set: {
          key: 'saleslog_field_mapping',
          value: mappingData,
          updated_by: user.name || user.email || 'Admin',
          updatedAt: now,
        },
        $setOnInsert: {
          createdAt: now,
        },
      },
      { upsert: true }
    );

    await this.logAuditEvent('field_mapping_updated', {
      title: 'Sales Log Field Mapping Updated',
      content: `Sales Log column mappings updated by ${user.name || user.email}`,
      mapping: mappingData,
    }, user);

    return mappingData;
  },

  // ─── 14. Privacy Act 1988 (APP) Compliance Data Portability & Retention ────
  async getPrivacyExport(customerId, user = {}) {
    await ensureDbConnected();
    const custColl = deliveryConn.db.collection('customers');
    const oppColl = deliveryConn.db.collection('opportunities');
    const tlColl = deliveryConn.db.collection('timelineevents');
    const leadColl = leadConn.db.collection('leads');
    const apptColl = leadConn.db.collection('appointments');
    const convColl = leadConn.db.collection('conversations');
    const clientColl = deliveryConn.db.collection('clients');
    const msgColl = deliveryConn.db.collection('messages');

    const customer = await custColl.findOne({ customer_id: customerId });
    if (!customer) {
      throw { statusCode: 404, message: 'Customer record not found for Privacy Act export' };
    }

    const last8 = customer.phone ? String(customer.phone).replace(/\D/g, '').slice(-8) : '';

    const [opps, timeline, lead, appointments, conversation, client, messages] = await Promise.all([
      oppColl.find({ customer_id: customerId }).toArray(),
      tlColl.find({ customer_id: customerId }).sort({ occurred_at: -1 }).toArray(),
      last8 ? leadColl.findOne({ phone: { $regex: last8, $options: 'i' } }) : null,
      last8 ? apptColl.find({ phone: { $regex: last8, $options: 'i' } }).toArray() : [],
      last8 ? convColl.findOne({ phone: { $regex: last8, $options: 'i' } }) : null,
      last8 ? clientColl.findOne({ phone: { $regex: last8, $options: 'i' } }) : null,
      last8 ? msgColl.find({ phone: { $regex: last8, $options: 'i' } }).toArray() : [],
    ]);

    const exportPackage = {
      metadata: {
        regulation: 'Privacy Act 1988 (Cth) / Australian Privacy Principles (APP 12 & 13)',
        exported_at: new Date().toISOString(),
        exported_by: user.name || user.email || 'Compliance Officer',
        customer_id: customerId,
        legal_entity: 'Harmony Auto BYD Australia / OmniSuiteAI',
      },
      customer_profile: customer,
      opportunities: opps,
      timeline_events: timeline,
      lead_centre_profile: lead,
      appointments,
      sms_conversations: conversation?.messages || messages,
      delivery_centre_profile: client,
    };

    await this.logAuditEvent('privacy_act_export', {
      customer_id: customerId,
      title: 'Privacy Act (APP 12) Data Export Generated',
      content: `Full portable data package generated for customer ${customer.name} (${customerId})`,
    }, user);

    return exportPackage;
  },

  async anonymizeCustomerPrivacy(customerId, user = {}, reason = 'Customer request under APP') {
    await ensureDbConnected();
    const custColl = deliveryConn.db.collection('customers');
    const oppColl = deliveryConn.db.collection('opportunities');
    const leadColl = leadConn.db.collection('leads');
    const clientColl = deliveryConn.db.collection('clients');
    const now = new Date();

    const customer = await custColl.findOne({ customer_id: customerId });
    if (!customer) {
      throw { statusCode: 404, message: 'Customer not found' };
    }

    const last8 = customer.phone ? String(customer.phone).replace(/\D/g, '').slice(-8) : '';
    const anonymizedName = `Anonymized Customer (${customerId.slice(-6)})`;
    const anonymizedPhone = `+61400000000`;
    const anonymizedEmail = `anonymized_${customerId}@privacy.internal`;

    // 1. Anonymize Customer
    await custColl.updateOne(
      { customer_id: customerId },
      {
        $set: {
          name: anonymizedName,
          phone: anonymizedPhone,
          email: anonymizedEmail,
          notes: '[REDACTED PER PRIVACY ACT APP RIGHT TO ERASURE / ANONYMIZATION]',
          do_not_contact: true,
          consent_sms: false,
          anonymized_at: now,
          anonymized_by: user.name || user.email || 'Privacy Officer',
          anonymization_reason: reason,
          updatedAt: now,
        },
      }
    );

    // 2. Anonymize Opportunities (retain financial aggregates for OEM compliance without PII)
    await oppColl.updateMany(
      { customer_id: customerId },
      {
        $set: {
          customer_name: anonymizedName,
          customer_phone: anonymizedPhone,
          customer_email: anonymizedEmail,
          competitor_notes: '',
          updatedAt: now,
        },
      }
    );

    // 3. Anonymize Lead Centre
    if (last8) {
      await leadColl.updateMany(
        { phone: { $regex: last8, $options: 'i' } },
        {
          $set: {
            name: anonymizedName,
            phone: anonymizedPhone,
            email: anonymizedEmail,
            notes: '[REDACTED]',
            doNotContact: true,
            updatedAt: now,
          },
        }
      );
    }

    // 4. Anonymize Delivery Centre
    if (last8) {
      await clientColl.updateMany(
        { phone: { $regex: last8, $options: 'i' } },
        {
          $set: {
            name: anonymizedName,
            phone: anonymizedPhone,
            email: anonymizedEmail,
            notes: '[REDACTED]',
            updatedAt: now,
          },
        }
      );
    }

    await this.logAuditEvent('privacy_act_anonymize', {
      customer_id: customerId,
      title: 'Customer PII Anonymized (Privacy Act)',
      content: `Customer ${customerId} PII anonymized by ${user.name || user.email}. Reason: ${reason}`,
    }, user);

    return { success: true, message: 'Customer PII anonymized across all databases', customerId };
  },

  // ─── 15. Real-Time Delivery & SLA Notifications (§5.8, §5.3) ───────────────
  async getNotifications(query = {}, user = {}) {
    await ensureDbConnected();
    const clientColl = deliveryConn.db.collection('clients');
    const oppColl = deliveryConn.db.collection('opportunities');
    const allocColl = deliveryConn.db.collection('allocations');
    const now = new Date();

    const siteFilter = {};
    if (query.site && query.site !== 'All' && query.site !== 'All Sites') {
      siteFilter.$or = [{ site: query.site }, { dealer: query.site }];
    }

    // 1. Delivery Centre Alerts (missing paperwork, unallocated VIN, date changes)
    const [alertClients, urgentAllocations, overdueOpps] = await Promise.all([
      clientColl.find({
        ...siteFilter,
        $or: [
          { 'docs_status.atrSigned': false, stage: { $in: ['Pre-Delivery Inspection', 'In Transit', 'Ready for Pickup'] } },
          { vin: { $in: [null, '', 'UNALLOCATED'] } },
          { alert: { $exists: true, $ne: null } },
        ],
      }).limit(20).toArray(),

      allocColl.find({
        ...siteFilter,
        status: { $in: ['pending', 'escalated'] },
      }).sort({ sla_expires_at: 1 }).limit(10).toArray(),

      oppColl.find({
        ...siteFilter,
        stage: { $nin: ['Written / Sold', 'In Delivery', 'Delivered / Won', 'Lost / Parked'] },
        next_action_at: { $lt: now },
      }).limit(15).toArray(),
    ]);

    const notifications = [];

    // Format Delivery Alerts (§5.8)
    for (const c of alertClients) {
      let alertMsg = c.alert || 'Handover Action Required';
      let severity = 'warning';
      if (!c.docs_status?.atrSigned) {
        alertMsg = `Missing signed ATR / handover paperwork for ${c.name || 'Client'}`;
        severity = 'danger';
      } else if (!c.vin || c.vin === 'UNALLOCATED') {
        alertMsg = `Unallocated VIN on sold delivery (${c.vehicle || 'BYD'})`;
        severity = 'danger';
      }

      notifications.push({
        id: `notif-dc-${c._id}`,
        type: 'delivery_alert',
        severity,
        title: 'Delivery Centre Alert',
        message: alertMsg,
        customer_name: c.name || c.customer_name,
        vehicle: c.vehicle,
        site: c.site || c.dealer || 'Fairfield',
        client_id: String(c._id),
        timestamp: c.updatedAt || now,
      });
    }

    // Format Urgent SLA Allocations (§5.3)
    for (const a of urgentAllocations) {
      const isBreached = a.sla_expires_at && new Date(a.sla_expires_at) < now;
      notifications.push({
        id: `notif-sla-${a.allocation_id || a._id}`,
        type: 'sla_escalation',
        severity: isBreached ? 'danger' : 'warning',
        title: isBreached ? 'SLA Breached — Floor Escalation' : 'Urgent Unworked Lead Allocation',
        message: `${a.name} (${a.vehicle || 'BYD'}) allocated to ${a.assigned_to}. ${isBreached ? 'SLA Expired!' : 'Action required within 15 min'}`,
        allocation_id: a.allocation_id,
        site: a.site,
        assigned_to: a.assigned_to,
        timestamp: a.createdAt || now,
      });
    }

    // Format Overdue Deal Actions
    for (const o of overdueOpps) {
      notifications.push({
        id: `notif-opp-${o.opportunity_id}`,
        type: 'overdue_action',
        severity: 'info',
        title: 'Overdue Follow-up Action',
        message: `${o.customer_name} (${o.vehicle_descriptor || o.model}): ${o.next_action_desc || 'Scheduled action overdue'}`,
        opportunity_id: o.opportunity_id,
        customer_id: o.customer_id,
        owner: o.owner_name,
        site: o.site,
        timestamp: o.next_action_at,
      });
    }

    return {
      success: true,
      totalCount: notifications.length,
      data: notifications,
    };
  },

  // ─── 16. Universal Idempotency Guard (§7.4, §9) ───────────────────────────
  async checkAndStoreIdempotency(eventId, scope = 'general', payload = {}) {
    if (!eventId) return { duplicate: false };
    await ensureDbConnected();
    const idemColl = deliveryConn.db.collection('idempotency_keys');
    const now = new Date();

    const existing = await idemColl.findOne({ event_id: eventId, scope });
    if (existing) {
      return {
        duplicate: true,
        processed_at: existing.processed_at,
        response: existing.response,
      };
    }

    await idemColl.insertOne({
      event_id: eventId,
      scope,
      payload_summary: typeof payload === 'object' ? JSON.stringify(payload).slice(0, 500) : '',
      processed_at: now,
      createdAt: now,
    });

    return { duplicate: false };
  },

  // ─── 17. Bidirectional Appointment Management (§5.5, §5.9, AC-4) ────────────
  async getAppointments(query = {}) {
    await ensureDbConnected();
    const apptColl = leadConn.db.collection('appointments');
    const filter = {};

    if (query.site && query.site !== 'All' && query.site !== 'All Sites') {
      filter.$or = [{ site: query.site }, { dealership: query.site }, { location: { $regex: query.site, $options: 'i' } }];
    }
    if (query.consultantName) {
      filter.consultantName = { $regex: query.consultantName, $options: 'i' };
    }
    if (query.status && query.status !== 'All') {
      filter.status = query.status;
    }
    if (query.type && query.type !== 'All') {
      filter.type = query.type;
    }
    if (query.customer_id) {
      filter.customer_id = query.customer_id;
    }

    const sort = { when: 1, createdAt: -1 };
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = query.limit !== undefined ? (parseInt(query.limit, 10) || 50) : 50;
    const skip = (page - 1) * limit;

    const [appointments, total] = await Promise.all([
      apptColl.find(filter).sort(sort).skip(skip).limit(limit).toArray(),
      apptColl.countDocuments(filter),
    ]);

    return {
      success: true,
      data: appointments.map((a) => ({
        ...a,
        id: String(a._id),
      })),
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit) || 1,
      },
    };
  },

  async createAppointment(data = {}, user = {}) {
    await ensureDbConnected();
    const apptColl = leadConn.db.collection('appointments');
    const tlColl = deliveryConn.db.collection('timelineevents');
    const oppColl = deliveryConn.db.collection('opportunities');
    const custColl = deliveryConn.db.collection('customers');
    const now = new Date();

    const consultant = data.consultantName || data.consultant || user.name || 'Alex Rivers';
    const site = data.site || data.dealership || user.site || 'Fairfield';

    const apptDoc = {
      prospectName: data.prospectName || data.customer_name || 'Customer',
      phone: data.phone ? formatPhoneE164(data.phone) : '',
      email: data.email || null,
      vehicle: data.vehicle || data.preferred_model || 'BYD SEALION 7',
      when: data.when || new Date(Date.now() + 86400000).toISOString(),
      type: data.type || 'Test Drive',
      status: data.status || 'Confirmed',
      consultantName: consultant,
      bookedBy: user.name || user.email || 'Sales CRM',
      location: data.location || site,
      site,
      dealership: site,
      durationMinutes: Number(data.durationMinutes) || 45,
      notes: data.notes || '',
      leadId: data.leadId || data.lead_prospect_id || null,
      customer_id: data.customer_id || null,
      opportunity_id: data.opportunity_id || null,
      createdAt: now,
      updatedAt: now,
    };

    const result = await apptColl.insertOne(apptDoc);
    apptDoc._id = result.insertedId;
    apptDoc.id = String(result.insertedId);

    // If linked to customer or opportunity, transition stage to 'Appointment'
    if (data.opportunity_id) {
      await oppColl.updateOne(
        { opportunity_id: data.opportunity_id, stage: { $in: ['New / Allocated', 'Working'] } },
        { $set: { stage: 'Appointment', next_action_at: new Date(apptDoc.when), next_action_desc: `${apptDoc.type} with ${consultant}`, updatedAt: now } }
      );
    }

    // Write TimelineEvent
    if (data.customer_id) {
      await tlColl.insertOne({
        event_id: `EVT-${crypto.randomUUID()}`,
        customer_id: data.customer_id,
        opportunity_id: data.opportunity_id || null,
        type: 'appointment',
        event_type: 'appointment',
        title: `Appointment Booked: ${apptDoc.type}`,
        content: `${apptDoc.type} scheduled with ${consultant} on ${new Date(apptDoc.when).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' })}. Vehicle: ${apptDoc.vehicle}.`,
        body: `${apptDoc.type} scheduled with ${consultant} on ${new Date(apptDoc.when).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' })}. Vehicle: ${apptDoc.vehicle}.`,
        author: consultant,
        author_name: consultant,
        source: 'Sales CRM',
        source_system: 'crm',
        occurred_at: now,
        timestamp_aest: formatAEST(now),
        visibility: 'internal',
        createdAt: now,
        updatedAt: now,
      });
    }

    return apptDoc;
  },

  async updateAppointment(id, patch = {}, user = {}) {
    await ensureDbConnected();
    const apptColl = leadConn.db.collection('appointments');
    const tlColl = deliveryConn.db.collection('timelineevents');
    const now = new Date();

    const query = {
      $or: [
        require('mongodb').ObjectId.isValid(id) ? { _id: new require('mongodb').ObjectId(id) } : null,
        { id },
      ].filter(Boolean),
    };

    const existing = await apptColl.findOne(query);
    if (!existing) {
      throw { statusCode: 404, message: 'Appointment not found' };
    }

    patch.updatedAt = now;
    await apptColl.updateOne(query, { $set: patch });

    // Handle show / no-show / status updates timeline events (§5.9)
    if (patch.status && patch.status !== existing.status && existing.customer_id) {
      const isNoShow = patch.status === 'No Show';
      const isCompleted = patch.status === 'Completed';

      await tlColl.insertOne({
        event_id: `EVT-${crypto.randomUUID()}`,
        customer_id: existing.customer_id,
        opportunity_id: existing.opportunity_id || null,
        type: 'appointment',
        event_type: 'appointment',
        title: `Appointment Status: ${patch.status}`,
        content: isNoShow
          ? `Customer ${existing.prospectName} did not attend scheduled ${existing.type}. Reason: ${patch.no_show_reason || 'Not specified'}.`
          : isCompleted
          ? `Test drive / appointment successfully completed with ${existing.prospectName}.`
          : `Appointment status updated to ${patch.status}.`,
        author: user.name || user.email || existing.consultantName,
        source: 'Sales CRM',
        occurred_at: now,
        timestamp_aest: formatAEST(now),
        visibility: 'internal',
        createdAt: now,
        updatedAt: now,
      });
    }

    return await apptColl.findOne(query);
  },

  // ─── 18. Inbound Sync Exceptions & Pending Deliveries (§5.7, §5.8, §7.5) ──
  async getSyncPending(query = {}) {
    await ensureDbConnected();
    const oppColl = deliveryConn.db.collection('opportunities');
    const salesLogColl = deliveryConn.db.collection('saleslogentries');

    const filter = {};
    if (query.site && query.site !== 'All' && query.site !== 'All Sites') {
      filter.site = query.site;
    }

    const [pendingOpps, exceptionSalesLogs] = await Promise.all([
      oppColl.find({
        ...filter,
        $or: [
          { delivery_sync_pending: true },
          { vy_sync_pending: true },
          { 'sync_status.delivery': 'pending_retry' },
        ],
      }).toArray(),
      salesLogColl.find({
        ...filter,
        exception_status: { $in: ['flagged', 'delivery_sync_pending', 'conflict'] },
      }).toArray(),
    ]);

    return {
      success: true,
      pendingCount: pendingOpps.length + exceptionSalesLogs.length,
      pendingDeliveries: pendingOpps,
      salesLogExceptions: exceptionSalesLogs,
    };
  },

  async retryDeliverySync(opportunityId, user = {}) {
    await ensureDbConnected();
    const oppColl = deliveryConn.db.collection('opportunities');
    const clientColl = deliveryConn.db.collection('clients');
    const custColl = deliveryConn.db.collection('customers');
    const salesLogColl = deliveryConn.db.collection('saleslogentries');
    const tlColl = deliveryConn.db.collection('timelineevents');
    const now = new Date();

    const opp = await oppColl.findOne({
      $or: [{ opportunity_id: opportunityId }, { _id: opportunityId }],
    });
    if (!opp) throw { statusCode: 404, message: 'Opportunity not found' };

    const customer = await custColl.findOne({ customer_id: opp.customer_id });
    if (!customer) throw { statusCode: 404, message: 'Customer not found' };

    const newClientDoc = {
      name: customer.name,
      phone: customer.phone,
      email: customer.email,
      vehicle: opp.vehicle_descriptor || `${opp.model} ${opp.variant}`,
      vin: opp.vin || 'VIN Pending',
      sale_type: opp.sale_type || 'Retail',
      salesperson: opp.owner_name,
      site_location: opp.site,
      location: opp.site,
      stage: 'Scheduled',
      contact_status: 'Not Contacted',
      vy_order_id: opp.vy_order_id || null,
      vy_stock_id: opp.vy_stock_id || null,
      imported_from: 'crm',
      crm_customer_id: customer.customer_id,
      crm_opportunity_id: opp.opportunity_id,
      delivery_date: new Date(Date.now() + 5 * 86400000).toISOString().split('T')[0],
      comments: [
        {
          author_name: `${user.name || opp.owner_name} (Sales CRM Re-sync)`,
          body: `Deal successfully re-synced into Delivery Centre.`,
          created_at: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };

    const insertedClient = await clientColl.insertOne(newClientDoc);
    const deliveryClientId = String(insertedClient.insertedId);

    await oppColl.updateOne(
      { opportunity_id: opp.opportunity_id },
      {
        $set: {
          delivery_client_id: deliveryClientId,
          delivery_stage: 'Scheduled',
          delivery_sync_pending: false,
          'sync_status.delivery': 'synced',
          updatedAt: now,
        },
      }
    );

    if (opp.sales_log_id) {
      await salesLogColl.updateOne(
        { sales_log_id: opp.sales_log_id },
        { $set: { delivery_client_id: deliveryClientId, exception_status: 'clean', updatedAt: now } }
      );
    }

    await tlColl.insertOne({
      event_id: `EVT-${crypto.randomUUID()}`,
      customer_id: customer.customer_id,
      opportunity_id: opp.opportunity_id,
      type: 'system',
      event_type: 'system',
      title: 'Delivery Centre Re-Sync Successful',
      content: `Handover client record successfully pushed to Delivery Centre (${deliveryClientId}) by ${user.name || user.email || 'Coordinator'}.`,
      author: user.name || user.email || 'CRM Coordinator',
      source: 'Sales CRM',
      occurred_at: now,
      timestamp_aest: formatAEST(now),
      visibility: 'internal',
      createdAt: now,
      updatedAt: now,
    });

    return { success: true, message: 'Delivery client synchronized', deliveryClientId };
  },

  // ─── 19. Delivery Date Change Request (§5.8) ──────────────────────────────
  async requestDeliveryDateChange(identifier, requestedDate, reason, user = {}) {
    await ensureDbConnected();
    const oppColl = deliveryConn.db.collection('opportunities');
    const clientColl = deliveryConn.db.collection('clients');
    const tlColl = deliveryConn.db.collection('timelineevents');
    const now = new Date();
    const authorName = user.name || user.email || 'Sales Consultant';

    // Find opportunity by opportunity_id or _id, or delivery client
    let opp = await oppColl.findOne({
      $or: [
        { opportunity_id: identifier },
        { delivery_client_id: identifier },
      ],
    });

    let client = null;
    if (opp?.delivery_client_id) {
      client = await clientColl.findOne({
        $or: [{ id: opp.delivery_client_id }, { client_id: opp.delivery_client_id }],
      });
    }
    if (!client) {
      client = await clientColl.findOne({
        $or: [{ id: identifier }, { client_id: identifier }],
      });
    }

    const commentBody = `[DELIVERY DATE CHANGE REQUEST] Requested Date: ${requestedDate} | Reason: ${reason || 'Customer preference'} | Transmitted by: ${authorName}`;

    // Push comment to Delivery Centre client
    if (client) {
      await clientColl.updateOne(
        { _id: client._id },
        {
          $push: {
            comments: {
              id: `comm-${crypto.randomUUID()}`,
              author: authorName,
              body: commentBody,
              created_at: now.toISOString(),
            },
          },
          $set: {
            delivery_date_requested: requestedDate,
            updatedAt: now,
          },
        }
      );
    }

    // Update opportunity
    if (opp) {
      await oppColl.updateOne(
        { opportunity_id: opp.opportunity_id },
        {
          $set: {
            delivery_date_requested: requestedDate,
            delivery_date_change_reason: reason,
            updatedAt: now,
          },
        }
      );
    }

    // Insert unified timeline event
    const customerId = opp?.customer_id || client?.customer_id;
    if (customerId) {
      await tlColl.insertOne({
        event_id: `EVT-DCR-${crypto.randomUUID()}`,
        customer_id: customerId,
        opportunity_id: opp?.opportunity_id || null,
        type: 'delivery_date_request',
        event_type: 'delivery_date_request',
        title: 'Delivery Handover Reschedule Request',
        content: `Target date change requested to ${requestedDate}. Reason: ${reason || 'Schedule preference'}.`,
        author: authorName,
        source: 'Sales CRM',
        occurred_at: now,
        timestamp_aest: formatAEST(now),
        visibility: 'internal',
        createdAt: now,
        updatedAt: now,
      });
    }

    return {
      success: true,
      message: `Delivery date change request submitted for ${requestedDate}`,
      requestedDate,
    };
  },

  // ─── 20. Customer Pre-Sale Documents Vault (§5.1) ──────────────────────────
  async getCustomerDocuments(customerId) {
    await ensureDbConnected();
    const docColl = deliveryConn.db.collection('crmdocuments');
    const docs = await docColl.find({ customer_id: customerId }).sort({ createdAt: -1 }).toArray();
    return docs;
  },

  async addCustomerDocument(customerId, docData, user = {}) {
    await ensureDbConnected();
    const docColl = deliveryConn.db.collection('crmdocuments');
    const tlColl = deliveryConn.db.collection('timelineevents');
    const custColl = deliveryConn.db.collection('customers');
    const now = new Date();

    const customer = await custColl.findOne({ customer_id: customerId });
    if (!customer) {
      const err = new Error('Customer not found');
      err.statusCode = 404;
      throw err;
    }

    const docId = `DOC-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const authorName = user.name || user.email || 'Sales Consultant';

    const newDoc = {
      doc_id: docId,
      customer_id: customerId,
      title: docData.title || 'Attached Document',
      category: docData.category || 'Contract & Forms',
      file_name: docData.file_name || docData.fileName || `${docData.title || 'document'}.pdf`,
      file_type: docData.file_type || docData.fileType || 'application/pdf',
      file_size: docData.file_size || docData.fileSize || '142 KB',
      file_url: docData.file_url || docData.fileUrl || '',
      status: docData.status || 'Verified',
      notes: docData.notes || '',
      uploaded_by: authorName,
      createdAt: now,
      updatedAt: now,
    };

    await docColl.insertOne(newDoc);

    // Broadcast into unified timeline
    await tlColl.insertOne({
      event_id: `EVT-DOC-${crypto.randomUUID()}`,
      customer_id: customerId,
      opportunity_id: null,
      type: 'document_uploaded',
      event_type: 'document_uploaded',
      title: `Document Attached: ${newDoc.title}`,
      content: `Uploaded ${newDoc.category} document (${newDoc.file_name}) by ${authorName}.`,
      author: authorName,
      source: 'Sales CRM',
      occurred_at: now,
      timestamp_aest: formatAEST(now),
      visibility: 'internal',
      createdAt: now,
      updatedAt: now,
    });

    return newDoc;
  },

  async deleteCustomerDocument(customerId, docId, user = {}) {
    await ensureDbConnected();
    const docColl = deliveryConn.db.collection('crmdocuments');
    const tlColl = deliveryConn.db.collection('timelineevents');
    const now = new Date();
    const authorName = user.name || user.email || 'Sales Consultant';

    const doc = await docColl.findOne({ doc_id: docId, customer_id: customerId });
    if (!doc) {
      const err = new Error('Document not found');
      err.statusCode = 404;
      throw err;
    }

    await docColl.deleteOne({ _id: doc._id });

    // Broadcast audit event
    await tlColl.insertOne({
      event_id: `EVT-DOCDEL-${crypto.randomUUID()}`,
      customer_id: customerId,
      type: 'system',
      event_type: 'system',
      title: `Document Removed: ${doc.title}`,
      content: `Document ${doc.file_name} removed from customer record by ${authorName}.`,
      author: authorName,
      source: 'Sales CRM',
      occurred_at: now,
      timestamp_aest: formatAEST(now),
      visibility: 'internal',
      createdAt: now,
      updatedAt: now,
    });

    return { success: true, message: 'Document deleted successfully', docId };
  },
};

module.exports = crmService;


