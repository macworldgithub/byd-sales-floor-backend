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

// ─── 3. Lead Centre Webhook (§7.3 & §7.4) ───────────────────────────────────
router.post('/lead-centre', async (req, res, next) => {
  try {
    const { event_id, event, source, customer_keys = {}, payload = {} } = req.body;
    const crmService = require('../services/crmService');

    if (event === 'lead.allocated') {
      // Inbound allocation from Lead Centre
      const customer = await crmService.getCustomers({ q: customer_keys.phone || payload.phone });
      let targetCust = customer[0];
      if (!targetCust && payload.name && (payload.phone || customer_keys.phone)) {
        targetCust = await crmService.createCustomer({
          name: payload.name,
          phone: customer_keys.phone || payload.phone,
          email: customer_keys.email || payload.email,
          site: payload.site || 'Fairfield',
          source: 'Autogate',
          lead_prospect_id: payload.prospect_id,
        }).catch(() => null);
      }
    } else if (event === 'lead.status_changed' && payload.status === 'opted out') {
      const customers = await crmService.getCustomers({ q: customer_keys.phone });
      if (customers[0]) {
        await crmService.updateCustomer(customers[0].customer_id, { do_not_contact: true });
      }
    }

    return res.status(200).json({ success: true, event_id, message: 'Lead Centre webhook processed' });
  } catch (err) {
    next(err);
  }
});

// ─── 4. Virtual Yard Webhook (§7.3 & §7.4) ──────────────────────────────────
router.post('/virtual-yard', async (req, res, next) => {
  try {
    const { event_id, event, payload = {} } = req.body;
    return res.status(200).json({ success: true, event_id, message: 'Virtual Yard webhook processed' });
  } catch (err) {
    next(err);
  }
});

// ─── 5. Sales Log Reconcile Webhook (§7.3 & §7.4) ───────────────────────────
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

// ─── 6. Delivery Centre Webhook (§7.3 & §7.4, AC-3, AC-9) ───────────────────
router.post('/delivery', async (req, res, next) => {
  try {
    const { event_id, event, client_id, payload = {} } = req.body;
    const crmService = require('../services/crmService');

    // If Delivery comment added or stage changed, project onto matching CRM opportunity
    if (event === 'delivery.stage_changed' && payload.new_stage) {
      const opps = await crmService.getOpportunities();
      const matchingOpp = opps.find((o) => o.delivery_client_id === client_id);
      if (matchingOpp) {
        await crmService.updateOpportunity(matchingOpp.opportunity_id, {
          delivery_stage: payload.new_stage,
        });
      }
    }

    return res.status(200).json({ success: true, event_id, message: 'Delivery Centre webhook processed' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
