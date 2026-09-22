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

module.exports = router;
