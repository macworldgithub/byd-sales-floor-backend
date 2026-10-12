/**
 * messages.js – Delivery Centre SMS Message routes
 */
const express = require('express');
const { body, validationResult } = require('express-validator');
const Message = require('../models/delivery/Message');
const Client = require('../models/delivery/Client');
const Lead = require('../models/lead/Lead');
const AuditEvent = require('../models/delivery/AuditEvent');
const { authenticate } = require('../middleware/auth');
const mobileMessageService = require('../services/mobileMessage');
const { getThreads, allowedSite, phoneKey, siteKey } = require('../services/threadHistory');
const { leadConn, deliveryConn } = require('../db');
const { phoneRegex } = require('../services/smsEvent');
async function recipient(user, phone, clientId, customerId, leadId, site) {
  const candidates = [
    ...(await deliveryConn.db.collection('clients').find({ phone: phoneRegex(phone) }).toArray()).map(c => ({ ...c, site: c.site_location || c.site })),
    ...(await deliveryConn.db.collection('customers').find({ phone: phoneRegex(phone) }).toArray()),
    ...(await leadConn.db.collection('leads').find({ phone: phoneRegex(phone) }).toArray()).map(l => ({ ...l, site: l.dealer || l.site })),
  ];
  const matches = candidates.filter(c => phoneKey(c.phone) === phoneKey(phone)
    && (!clientId || [c.id, String(c._id), c.delivery_client_id].includes(String(clientId)))
    && (!customerId || c.customer_id === customerId)
    && (!leadId || String(c._id) === String(leadId))
    && (!site || siteKey(c.site) === siteKey(site)));
  const target = matches.find(c => allowedSite(user, c.site));
  if (!target) throw Object.assign(new Error('Recipient not found or site access denied'), { statusCode: 403 });
  return target;
}

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const { client_id, phone, page = 1, limit = 50 } = req.query;
    let focusPhone = phone;
    if (client_id) {
      const client = await deliveryConn.db.collection('clients').findOne({ $or: [{ id: client_id }, { _id: require('mongoose').isValidObjectId(client_id) ? new (require('mongoose').Types.ObjectId)(client_id) : client_id }] });
      if (!client || !allowedSite(req.user, client.site_location || client.site)) return res.status(404).json({ success: false, message: 'Client not found' });
      focusPhone = client.phone;
    }
    const threads = await getThreads(leadConn.db, deliveryConn.db, req.user, req.query.site || req.query.site_location, { phone: focusPhone });
    let rows = threads.flatMap(t => t.messages.filter(m => m.sender !== 'system').map(m => ({
      id: m.id, _id: m.id, client_id: t.client_id, client_name: t.prospectName, phone: t.phone, site: t.dealer,
      body: m.text, direction: m.sender === 'user' ? 'inbound' : 'outbound', status: m.status, sent_at: m.createdAt,
    })));
    if (phone) rows = rows.filter(m => phoneKey(m.phone) === phoneKey(phone));
    rows.sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at));
    const total = rows.length;
    const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
    const messages = rows.slice(skip, skip + Math.min(1000, Math.max(1, Number(limit))));
    return res.json({
      success: true,
      data: messages,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/send',
  [
    body('phone').notEmpty().withMessage('Phone required'),
    body('body').notEmpty().withMessage('Message body required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { phone, body: msgBody, client_id, client_name, template_id, sender } = req.body;
      const normalizedPhone = mobileMessageService.normalizeAustralianPhone(phone);
      const target = await recipient(req.user, normalizedPhone, client_id, req.body.customerId, req.body.leadId, req.body.site);

      // Check opt-out suppression across Delivery Centre and Lead Centre (§5.7, AC-8)
      const last8 = normalizedPhone.slice(-8);
      const isOptedOutClient = await Client.findOne({
        phone: phoneRegex(normalizedPhone),
        $or: [{ opted_out: true }, { consent_sms: false }],
      });
      const isOptedOutLead = await Lead.findOne({
        phone: phoneRegex(normalizedPhone),
        $or: [{ status: 'opted out' }, { tag: 'Opted Out' }, { do_not_contact: true }],
      });

      if (isOptedOutClient || isOptedOutLead) {
        return res.status(403).json({
          success: false,
          message: 'ACMA Compliance: Recipient has opted out from SMS communications. Message dispatch suppressed.',
          opted_out: true,
        });
      }

      // Call MobileMessage service (live or simulated based on credentials/simulationMode)
      let sendResult;
      try {
        sendResult = await mobileMessageService.sendSms({
          requestedBy: req.user.id || req.user.email,
          to: normalizedPhone, message: msgBody, sender,
          customRef: client_id ? String(client_id) : undefined,
        });
      } catch (error) {
        const failed = await Message.create({
          client_id, client_name: client_name || target.name,
          phone: normalizedPhone, site: target.site, body: msgBody,
          direction: 'outbound', status: 'failed', sent_by_id: req.user.id,
          sent_by_name: req.user.name || req.user.email, sent_at: new Date(),
        });
        return res.status(502).json({ success: false, message: error.message || 'SMS dispatch failed', data: failed });
      }

      const message = await Message.create({
        client_id,
        client_name,
        phone: normalizedPhone,
        site: target.site,
        body: msgBody,
        direction: 'outbound',
        status: sendResult.simulated ? 'simulated' : sendResult.status === 'success' || sendResult.status === 'sent' ? 'sent' : sendResult.status,
        provider: 'mobilemessage',
        provider_message_id: sendResult.messageId || null,
        provider_response: sendResult.raw || null,
        sent_by_id: req.user.id,
        sent_by_name: req.user.name || req.user.email,
        template_id,
        sent_at: sendResult.sentAt || new Date(),
      });

      // Thread history reads this original message directly across all platforms.
      if (client_id) {
        await AuditEvent.create({
          actor_id: req.user.id,
          actor_email: req.user.email,
          action: 'message.send',
          entity: 'Client',
          entity_id: client_id,
          ip: req.ip,
        }).catch(() => {});

        // Update client's contact status
        await deliveryConn.db.collection('clients').updateOne(
          { $or: [{ id: client_id }, { _id: require('mongoose').isValidObjectId(client_id) ? new (require('mongoose').Types.ObjectId)(client_id) : client_id }] },
          { $set: { contact_status: 'Contacted', last_contacted_at: new Date() } }
        );
      }

      // Direct write to unified CRM timeline (§5.2, §5.7)
      try {
        const { deliveryConn } = require('../db');
        const custColl = deliveryConn.db.collection('customers');
        const tlColl = deliveryConn.db.collection('timelineevents');
        const last8 = normalizedPhone.slice(-8);

        const customers = await custColl.find({
          $or: [client_id ? { delivery_client_id: String(client_id) } : null, last8 ? { phone: { $regex: last8, $options: 'i' } } : null].filter(Boolean),
        }).toArray();
        const cust = customers.find(customer => siteKey(customer.site) === siteKey(target.site));

        const crypto = require('crypto');
        await tlColl.insertOne({
          event_id: `EVT-${crypto.randomUUID()}`,
          customer_id: cust?.customer_id || `CUST-SMS-${message._id}`,
          type: 'sms',
          event_type: 'sms',
          title: 'Outbound Customer SMS Sent',
          content: msgBody,
          body: msgBody,
          author: req.user.name || req.user.email,
          source: 'Sales Floor / MobileMessage',
          source_system: 'sms',
          occurred_at: new Date(),
          visibility: 'customer',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      } catch (_) {}

      return res.status(201).json({
        success: true,
        data: message,
        simulated: sendResult.simulated || false,
        messageId: sendResult.messageId,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/messages/bulk-send (§3.2 Bulk SMS Engine with Opt-out Suppression) ───
router.post('/bulk-send', async (req, res, next) => {
  try {
    const { recipients = [], template_id } = req.body;
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ success: false, message: 'Recipients array is required' });
    }

    const results = {
      total: recipients.length,
      sent: 0,
      suppressed: 0,
      failed: 0,
      details: [],
    };

    for (const item of recipients) {
      const rawPhone = item.phone || item.mobile;
      const msgBody = item.body || item.message;
      if (!rawPhone || !msgBody) {
        results.failed++;
        results.details.push({ phone: rawPhone, status: 'failed', reason: 'Missing phone or body' });
        continue;
      }

      const normalizedPhone = mobileMessageService.normalizeAustralianPhone(rawPhone);
      const last8 = normalizedPhone.slice(-8);

      // ACMA Opt-out Check
      const [isOptedOutClient, isOptedOutLead] = await Promise.all([
        Client.findOne({
          phone: phoneRegex(normalizedPhone),
          $or: [{ opted_out: true }, { consent_sms: false }],
        }),
        Lead.findOne({
          phone: phoneRegex(normalizedPhone),
          $or: [{ status: 'opted out' }, { tag: 'Opted Out' }, { do_not_contact: true }],
        }),
      ]);

      if (isOptedOutClient || isOptedOutLead) {
        results.suppressed++;
        results.details.push({ phone: normalizedPhone, status: 'suppressed', reason: 'ACMA Opted Out' });
        continue;
      }

      let target;
      try {
        target = await recipient(req.user, normalizedPhone, item.client_id, item.customerId, item.leadId, item.site);
        const sendResult = await mobileMessageService.sendSms({
          requestedBy: req.user.id || req.user.email,
          to: normalizedPhone,
          message: msgBody,
          sender: item.sender,
          customRef: item.client_id ? String(item.client_id) : undefined,
        });

        await Message.create({
          client_id: item.client_id || null,
          client_name: item.name || item.client_name || `Customer (${normalizedPhone})`,
          phone: normalizedPhone,
          site: target.site,
          body: msgBody,
          direction: 'outbound',
          status: sendResult.simulated ? 'simulated' : sendResult.status === 'success' ? 'sent' : sendResult.status,
          provider: 'mobilemessage',
          provider_message_id: sendResult.messageId || null,
          sent_by_id: req.user.id,
          sent_by_name: req.user.name || req.user.email,
          template_id,
          sent_at: new Date(),
        });

        results.sent++;
        results.details.push({ phone: normalizedPhone, status: 'sent', messageId: sendResult.messageId });
      } catch (err) {
        let failedMessage;
        if (target) failedMessage = await Message.create({
          client_id: item.client_id || null, client_name: item.name || item.client_name || target.name,
          phone: normalizedPhone, site: target.site, body: msgBody, direction: 'outbound', status: 'failed',
          sent_by_id: req.user.id, sent_by_name: req.user.name || req.user.email, template_id, sent_at: new Date(),
        });
        results.failed++;
        results.details.push({ phone: normalizedPhone, status: 'failed', reason: err.message, messageId: failedMessage ? String(failedMessage._id) : undefined });
      }
    }

    return res.json({
      success: true,
      message: `Bulk SMS complete: ${results.sent} sent, ${results.suppressed} suppressed (ACMA opt-out), ${results.failed} failed.`,
      data: results,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
