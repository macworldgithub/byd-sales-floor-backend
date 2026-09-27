/**
 * webhooks.js – MobileMessage.com.au Inbound SMS and Delivery Receipts (DLR)
 * Public webhook endpoints configured in the MobileMessage portal.
 */

const express = require('express');
const Message = require('../models/delivery/Message');
const Conversation = require('../models/lead/Conversation');
const Lead = require('../models/lead/Lead');
const Client = require('../models/delivery/Client');
const { normalizeAustralianPhone } = require('../services/mobileMessage');

const router = express.Router();

/**
 * POST /api/webhooks/mobilemessage/inbound
 * Ingests inbound SMS replies from customers.
 */
router.post('/mobilemessage/inbound', async (req, res, next) => {
  try {
    const rawFrom = req.body.from || req.body.sender || req.body.phone || req.body.from_number || req.body.mobile;
    const rawMessage = req.body.message || req.body.body || req.body.text || '';
    const messageId = req.body.message_id || req.body.MessageId || req.body.id || null;

    if (!rawFrom || !rawMessage) {
      return res.status(400).json({ success: false, message: 'Missing phone or message body' });
    }

    const phone = normalizeAustralianPhone(rawFrom);
    const text = String(rawMessage).trim();

    // 1. Try to find matching Lead or Client for name linking
    let prospectName = 'Prospect (' + phone + ')';
    let leadId = null;
    let clientId = null;

    const [matchedLead, matchedClient] = await Promise.all([
      Lead.findOne({ phone: { $regex: phone.slice(-8), $options: 'i' } }).lean().catch(() => null),
      Client.findOne({ phone: { $regex: phone.slice(-8), $options: 'i' } }).lean().catch(() => null),
    ]);

    if (matchedLead) {
      prospectName = matchedLead.name || prospectName;
      leadId = String(matchedLead._id);
    } else if (matchedClient) {
      prospectName = matchedClient.name || prospectName;
      clientId = String(matchedClient._id);
    }

    // 2. Record inbound message in Delivery Centre Message collection
    await Message.create({
      client_id: clientId,
      client_name: prospectName,
      phone,
      body: text,
      direction: 'inbound',
      status: 'received',
      provider: 'mobilemessage',
      provider_message_id: messageId,
      provider_response: req.body,
      sent_at: new Date(),
    });

    // 3. Update or create unified Conversation in Lead Centre
    let conversation = await Conversation.findOne({
      phone: { $regex: phone.slice(-8), $options: 'i' },
    });

    const inboundMsgObj = {
      id: messageId || (require('crypto').randomUUID ? require('crypto').randomUUID() : Date.now().toString(36)),
      sender: 'user',
      text,
      time: new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }),
      status: 'received',
      createdAt: new Date(),
    };

    if (conversation) {
      conversation.messages.push(inboundMsgObj);
      conversation.lastMessage = text;
      conversation.lastMessageAt = new Date();
      conversation.msgCount = (conversation.msgCount || 0) + 1;
      conversation.status = 'active';
      if (!conversation.prospectName || conversation.prospectName.startsWith('Prospect (')) {
        conversation.prospectName = prospectName;
      }
      await conversation.save();
    } else {
      conversation = await Conversation.create({
        leadId,
        prospectName,
        phone,
        dealer: matchedLead?.dealer || 'Melbourne CBD',
        status: 'active',
        control: 'agent',
        lastMessage: text,
        lastMessageAt: new Date(),
        msgCount: 1,
        messages: [inboundMsgObj],
      });
    }

    // 4. Update Lead / Client touch timestamps
    if (leadId) {
      await Lead.findByIdAndUpdate(leadId, {
        lastTouch: 'Inbound SMS · Just now',
        lastActivityAt: new Date(),
        $inc: { smsCount: 1 },
      }).catch(() => {});
    }
    if (clientId) {
      await Client.findByIdAndUpdate(clientId, {
        contact_status: 'Customer Replied',
        last_contacted_at: new Date(),
      }).catch(() => {});
    }

    // 5. Project Inbound SMS to CRM Customer Unified Timeline (§5.2, AC-3)
    try {
      const { deliveryConn } = require('../db');
      const custColl = deliveryConn.db.collection('customers');
      const targetCustomer = await custColl.findOne({
        phone: { $regex: phone.slice(-8) },
      });
      if (targetCustomer) {
        const tlColl = deliveryConn.db.collection('timelineevents');
        const crypto = require('crypto');
        const eventId = `EVT-SMS-IN-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000)}`;
        const now = new Date();
        await tlColl.insertOne({
          event_id: eventId,
          customer_id: targetCustomer.customer_id,
          type: 'sms_in',
          event_type: 'sms_in',
          title: `Inbound SMS from ${targetCustomer.name || phone}`,
          content: text,
          body: text,
          author: targetCustomer.name || phone,
          author_name: targetCustomer.name || phone,
          source: 'MobileMessage SMS',
          source_system: 'sms',
          metadata: {
            from: phone,
            message_id: messageId,
            direction: 'inbound',
          },
          timestamp: now,
          occurred_at: now,
          timestamp_aest: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' }) + ' AEST',
          visibility: 'internal',
          createdAt: now,
          updatedAt: now,
        });
      }
    } catch (_) {}

    return res.status(200).json({
      success: true,
      message: 'Inbound SMS processed and conversation updated',
      conversationId: conversation._id,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/webhooks/mobilemessage/status
 * Receives delivery receipts (DLR) from MobileMessage.
 */
router.post('/mobilemessage/status', async (req, res, next) => {
  try {
    const messageId = req.body.message_id || req.body.MessageId || req.body.id;
    const status = (req.body.status || req.body.Status || 'delivered').toLowerCase();

    if (messageId) {
      await Message.updateMany(
        { provider_message_id: messageId },
        {
          $set: {
            status,
            provider_response: req.body,
            delivered_at: status === 'delivered' ? new Date() : undefined,
          },
        }
      );
    }

    return res.status(200).json({ success: true, processed: true });
  } catch (err) {
    next(err);
  }
});

// ─── 3. Lead Centre Webhook (§7.3 & §7.4, AC-11 Zero Demo Bleed) ──────────────
router.post('/lead-centre', async (req, res, next) => {
  try {
    const { event_id, event, source, customer_keys = {}, payload = {}, isDemonstration, demo_mode } = req.body;
    const crmService = require('../services/crmService');

    // Universal Idempotency (§7.4, §9)
    if (event_id && event !== 'lead.allocated') {
      const idem = await crmService.checkAndStoreIdempotency(event_id, 'lead-centre', req.body);
      if (idem.duplicate) {
        return res.status(200).json({ success: true, duplicate: true, event_id, message: 'Event already processed' });
      }
    }

    // AC-11 Zero Demo Bleed: Quarantine demo-mode records from production CRM
    if (isDemonstration || demo_mode || source === 'demo_suite') {
      return res.status(200).json({
        success: true,
        quarantined: true,
        event_id,
        message: 'Lead Centre demo record quarantined from production CRM (§5.10, AC-11)',
      });
    }

    if (event === 'lead.allocated') {
      // Inbound allocation from Lead Centre with idempotency and SLA clock (§5.3, §7.3, AC-4)
      const alloc = await crmService.createAllocation({
        event_id,
        lead_prospect_id: payload.prospect_id || payload.lead_id,
        name: payload.name,
        phone: customer_keys.phone || payload.phone,
        email: customer_keys.email || payload.email,
        site: payload.site || 'Fairfield',
        source: payload.source || 'Autogate',
        vehicle: payload.vehicle || 'BYD SEALION 7',
        score: payload.score || 85,
        last_sms_summary: payload.last_sms_summary || payload.summary || '',
        appointment: payload.appointment || payload.appointment_when || null,
        assigned_to: payload.assigned_to || payload.consultant || 'Alex Rivers',
        sla_expires_at: payload.sla_expires_at || null,
        notes: payload.notes || `Allocated from Lead Centre (${payload.vehicle || 'BYD Range'})`,
      });

      return res.status(200).json({
        success: true,
        event_id,
        allocation_id: alloc.allocation_id,
        duplicate: Boolean(alloc.duplicate),
        message: alloc.duplicate ? 'Allocation already exists (Idempotent)' : 'Lead allocated and SLA clock initiated',
      });
    } else if (event === 'lead.thread_updated' || event === 'lead.note_added' || event === 'lead.human_takeover') {
      // Human takeover or conversation note from Lead Centre (§5.2, §7.3)
      const searchPhone = customer_keys.phone || payload.phone;
      const custResult = await crmService.getCustomers({ q: searchPhone });
      const targetCust = custResult.data?.[0];
      if (targetCust) {
        const { deliveryConn } = require('../db');
        const tlColl = deliveryConn.db.collection('timelineevents');
        const now = new Date();
        const eventId = `EVT-LC-${Date.now().toString(36).toUpperCase()}`;
        await tlColl.insertOne({
          event_id: eventId,
          customer_id: targetCust.customer_id,
          type: 'note',
          event_type: 'note',
          title: payload.title || (event === 'lead.human_takeover' ? 'Lead Centre Human Takeover' : 'Lead Centre Thread Activity'),
          content: payload.summary || payload.note || payload.message || payload.text || 'Customer conversation updated in Lead Centre.',
          body: payload.summary || payload.note || payload.message || payload.text || 'Customer conversation updated in Lead Centre.',
          author: payload.agent_name || payload.author || 'Lead Centre AI / BDC',
          source: 'Lead Centre',
          source_system: 'lead',
          timestamp: now,
          occurred_at: now,
          timestamp_aest: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' }) + ' AEST',
          deep_link: `https://leadcentre.byd.com.au/prospects/${targetCust.lead_prospect_id || payload.prospect_id || ''}`,
          visibility: 'internal',
          createdAt: now,
          updatedAt: now,
        });
      }
    } else if (event === 'lead.status_changed' && (payload.status === 'opted out' || payload.do_not_contact)) {
      const searchPhone = customer_keys.phone || payload.phone;
      const custResult = await crmService.getCustomers({ q: searchPhone });
      const customersList = custResult.data || [];
      if (customersList[0]) {
        await crmService.updateCustomer(customersList[0].customer_id, { do_not_contact: true, consent_sms: false });
      }
    }

    return res.status(200).json({ success: true, event_id, message: 'Lead Centre webhook processed' });
  } catch (err) {
    next(err);
  }
});

// ─── 4. Virtual Yard Webhook (§7.3 & §7.4, AC-8) ─────────────────────────────
router.post('/virtual-yard', async (req, res, next) => {
  try {
    const { event_id, event, payload = {} } = req.body;
    const crmService = require('../services/crmService');
    const { deliveryConn } = require('../db');

    if (event_id) {
      const idem = await crmService.checkAndStoreIdempotency(event_id, 'virtual-yard', req.body);
      if (idem.duplicate) {
        return res.status(200).json({ success: true, duplicate: true, event_id, message: 'Event already processed' });
      }
    }

    if (event === 'vy.stock_changed' && payload.stock_id) {
      // If stock was sold elsewhere, mark or warn matching open opportunities
      if (payload.status === 'Sold' || payload.status === 'withdrawn') {
        const oppColl = deliveryConn.db.collection('opportunities');
        await oppColl.updateMany(
          { vy_stock_id: payload.stock_id, stage: { $nin: ['Written / Sold', 'Delivered / Won'] } },
          { $set: { vy_stock_status: payload.status, next_action_desc: `VY Stock ${payload.status} warning - verify vehicle allocation`, updatedAt: new Date() } }
        );
      }
    } else if (event === 'vy.order_changed' && payload.vy_order_id) {
      const oppColl = deliveryConn.db.collection('opportunities');
      await oppColl.updateMany(
        { vy_order_id: payload.vy_order_id },
        { $set: { vy_order_status: payload.status, updatedAt: new Date() } }
      );
    }

    return res.status(200).json({ success: true, event_id, message: 'Virtual Yard webhook processed' });
  } catch (err) {
    next(err);
  }
});

// ─── 5. Sales Log Reconcile Webhook (§7.3 & §7.4) ────────────────────────────
router.post('/sales-log', async (req, res, next) => {
  try {
    const { event_id, payload = {} } = req.body;
    const crmService = require('../services/crmService');

    if (event_id) {
      const idem = await crmService.checkAndStoreIdempotency(event_id, 'sales-log', req.body);
      if (idem.duplicate) {
        return res.status(200).json({ success: true, duplicate: true, event_id, message: 'Event already processed' });
      }
    }

    if (payload.sales_log_id) {
      await crmService.reconcileSalesLogRow(payload.sales_log_id);
    }
    return res.status(200).json({ success: true, event_id, message: 'Sales Log reconcile processed' });
  } catch (err) {
    next(err);
  }
});

// ─── 6. Delivery Centre Webhook (§7.3 & §7.4, AC-3, AC-9) ────────────────────
router.post('/delivery', async (req, res, next) => {
  try {
    const { event_id, event, client_id, payload = {} } = req.body;
    const crmService = require('../services/crmService');
    const { deliveryConn } = require('../db');

    if (event_id) {
      const idem = await crmService.checkAndStoreIdempotency(event_id, 'delivery', req.body);
      if (idem.duplicate) {
        return res.status(200).json({ success: true, duplicate: true, event_id, message: 'Event already processed' });
      }
    }

    const oppColl = deliveryConn.db.collection('opportunities');
    const custColl = deliveryConn.db.collection('customers');
    const clientColl = deliveryConn.db.collection('clients');

    let matchingOpp = await oppColl.findOne({
      $or: [{ delivery_client_id: client_id }, { _id: client_id }],
    });

    let targetCustomerId = matchingOpp?.customer_id;

    if (!matchingOpp) {
      const matchingCustomer = await custColl.findOne({
        $or: [{ delivery_client_id: client_id }, { customer_id: payload.crm_customer_id }],
      });
      if (matchingCustomer) {
        targetCustomerId = matchingCustomer.customer_id;
        matchingOpp = await oppColl.findOne({ customer_id: targetCustomerId });
      } else {
        // Try looking up delivery client document directly to match by phone
        const dcDoc = await clientColl.findOne({ id: client_id });
        if (dcDoc?.phone) {
          const custByPhone = await custColl.findOne({ phone: { $regex: dcDoc.phone.slice(-8) } });
          if (custByPhone) {
            targetCustomerId = custByPhone.customer_id;
            matchingOpp = await oppColl.findOne({ customer_id: targetCustomerId });
          }
        }
      }
    }

    // If Delivery comment added, stage changed, or message sent, project onto matching CRM opportunity / customer
    if (event === 'delivery.stage_changed' && payload.new_stage) {
      if (matchingOpp) {
        await crmService.updateOpportunity(matchingOpp.opportunity_id, {
          delivery_stage: payload.new_stage,
        });
      }

      if (targetCustomerId) {
        // Broadcast timeline event into unified stream
        const tlColl = deliveryConn.db.collection('timelineevents');
        const crypto = require('crypto');
        await tlColl.insertOne({
          event_id: `EVT-${crypto.randomUUID()}`,
          customer_id: targetCustomerId,
          opportunity_id: matchingOpp?.opportunity_id || null,
          type: 'delivery_stage_change',
          title: `Delivery Stage Updated: ${payload.new_stage}`,
          content: `Vehicle handover stage transitioned to ${payload.new_stage} in Delivery Centre.`,
          author: 'Delivery Centre Handover Specialist',
          source: 'Delivery Centre',
          occurred_at: new Date(),
          timestamp_aest: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' }) + ' AEST',
          visibility: 'internal',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    } else if (event === 'delivery.comment_added' && (payload.comment || payload.body)) {
      const commentText = payload.comment || payload.body;
      if (targetCustomerId) {
        const tlColl = deliveryConn.db.collection('timelineevents');
        const crypto = require('crypto');
        await tlColl.insertOne({
          event_id: `EVT-${crypto.randomUUID()}`,
          customer_id: targetCustomerId,
          opportunity_id: matchingOpp?.opportunity_id || null,
          type: 'note',
          title: 'Delivery Handover Note',
          content: commentText,
          author: payload.author || payload.author_name || 'Delivery Centre',
          source: 'Delivery Centre',
          occurred_at: new Date(),
          timestamp_aest: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' }) + ' AEST',
          visibility: 'internal',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    } else if (event === 'delivery.message' && (payload.text || payload.body)) {
      if (matchingOpp) {
        const tlColl = deliveryConn.db.collection('timelineevents');
        const crypto = require('crypto');
        await tlColl.insertOne({
          event_id: `EVT-DCM-${crypto.randomUUID()}`,
          customer_id: matchingOpp.customer_id,
          opportunity_id: matchingOpp.opportunity_id,
          type: 'sms_out',
          title: 'Delivery Customer SMS',
          content: payload.text || payload.body,
          author: payload.author || 'Delivery Handover Specialist',
          source: 'Delivery Centre',
          occurred_at: new Date(),
          timestamp_aest: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' }) + ' AEST',
          visibility: 'internal',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    } else if (event === 'delivery.exception_raised' || event === 'delivery.exception' || event === 'delivery.alert') {
      const alertReason = payload.reason || payload.message || payload.details || payload.alert || 'Handover Action Required';
      const excType = payload.exception_type || payload.type || 'handover_exception';
      const alertTitle = payload.title || `Delivery Exception: ${excType.replace(/_/g, ' ').toUpperCase()}`;

      if (matchingOpp) {
        await crmService.updateOpportunity(matchingOpp.opportunity_id, {
          has_delivery_alert: true,
          delivery_alert: alertReason,
          delivery_exception_type: excType,
          delivery_exception_raised_at: new Date(),
        });
      }

      if (targetCustomerId) {
        const tlColl = deliveryConn.db.collection('timelineevents');
        const crypto = require('crypto');
        await tlColl.insertOne({
          event_id: `EVT-DCE-${crypto.randomUUID()}`,
          customer_id: targetCustomerId,
          opportunity_id: matchingOpp?.opportunity_id || null,
          type: 'alert',
          title: alertTitle,
          content: alertReason,
          author: payload.author || payload.author_name || 'Delivery Operations',
          source: 'Delivery Centre',
          occurred_at: new Date(),
          timestamp_aest: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' }) + ' AEST',
          visibility: 'internal',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      if (client_id) {
        await clientColl.updateOne(
          { $or: [{ id: client_id }, { client_id }] },
          { $set: { alert: alertReason, updatedAt: new Date() } }
        );
      }
    }

    return res.status(200).json({ success: true, event_id, message: 'Delivery Centre webhook processed' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
