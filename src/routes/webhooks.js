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
      // Inbound allocation from Lead Centre
      const searchPhone = customer_keys.phone || payload.phone;
      const custResult = await crmService.getCustomers({ q: searchPhone });
      const customersList = custResult.data || [];
      let targetCust = customersList[0];

      if (!targetCust && payload.name && searchPhone) {
        targetCust = await crmService.createCustomer({
          name: payload.name,
          phone: searchPhone,
          email: customer_keys.email || payload.email || '',
          site: payload.site || 'Fairfield',
          source: payload.source || 'Autogate',
          lead_prospect_id: payload.prospect_id || payload.lead_id,
          notes: payload.notes || `Allocated from Lead Centre (${payload.vehicle || 'BYD Range'})`,
        }).catch(() => null);
      }

      // Also create Allocation item in CRM inbox if assigned
      if (targetCust) {
        const { deliveryConn } = require('../db');
        const allocColl = deliveryConn.db.collection('allocations');
        await allocColl.insertOne({
          allocation_id: `ALC-${Date.now().toString().slice(-4)}`,
          customer_id: targetCust.customer_id,
          customer_name: targetCust.name,
          phone: targetCust.phone,
          email: targetCust.email || '',
          vehicle: payload.vehicle || 'BYD SEALION 7',
          source: payload.source || 'Autogate',
          site: targetCust.site || 'Fairfield',
          score: payload.score || 85,
          assigned_to: payload.assigned_to || payload.consultant || 'Alex Rivers',
          allocated_at: new Date(),
          status: 'pending',
          createdAt: new Date(),
          updatedAt: new Date(),
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

    // If Delivery comment added or stage changed, project onto matching CRM opportunity
    if (event === 'delivery.stage_changed' && payload.new_stage) {
      const oppResult = await crmService.getOpportunities({ limit: 1000 });
      const opps = oppResult.data || [];
      const matchingOpp = opps.find((o) => o.delivery_client_id === client_id);
      if (matchingOpp) {
        await crmService.updateOpportunity(matchingOpp.opportunity_id, {
          delivery_stage: payload.new_stage,
        });

        // Broadcast timeline event into unified stream
        const tlColl = deliveryConn.db.collection('timelineevents');
        await tlColl.insertOne({
          event_id: `EVT-${Date.now().toString().slice(-4)}`,
          customer_id: matchingOpp.customer_id,
          opportunity_id: matchingOpp.opportunity_id,
          type: 'delivery_stage_change',
          title: `Delivery Stage Updated: ${payload.new_stage}`,
          content: `Vehicle handover stage transitioned to ${payload.new_stage} in Delivery Centre.`,
          author: 'Delivery Centre Handover Specialist',
          source: 'Delivery Centre',
          occurred_at: new Date(),
          visibility: 'internal',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    } else if (event === 'delivery.comment_added' && payload.comment) {
      const oppResult = await crmService.getOpportunities({ limit: 1000 });
      const opps = oppResult.data || [];
      const matchingOpp = opps.find((o) => o.delivery_client_id === client_id);
      if (matchingOpp) {
        const tlColl = deliveryConn.db.collection('timelineevents');
        await tlColl.insertOne({
          event_id: `EVT-${Date.now().toString().slice(-4)}`,
          customer_id: matchingOpp.customer_id,
          opportunity_id: matchingOpp.opportunity_id,
          type: 'note',
          title: 'Delivery Handover Note',
          content: payload.comment,
          author: payload.author || 'Delivery Centre',
          source: 'Delivery Centre',
          occurred_at: new Date(),
          visibility: 'internal',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    }

    return res.status(200).json({ success: true, event_id, message: 'Delivery Centre webhook processed' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
