/**
 * messages.js – Delivery Centre SMS Message routes
 */
const express = require('express');
const { body, validationResult } = require('express-validator');
const Message = require('../models/delivery/Message');
const Client = require('../models/delivery/Client');
const Lead = require('../models/lead/Lead');
const Conversation = require('../models/lead/Conversation');
const AuditEvent = require('../models/delivery/AuditEvent');
const { authenticate } = require('../middleware/auth');
const mobileMessageService = require('../services/mobileMessage');

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const { client_id, phone, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (client_id) filter.client_id = client_id;
    if (phone) filter.phone = phone;

    const skip = (Number(page) - 1) * Number(limit);
    const [messages, total] = await Promise.all([
      Message.find(filter).sort('-sent_at').skip(skip).limit(Number(limit)).lean(),
      Message.countDocuments(filter),
    ]);
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

      // Check opt-out suppression across Delivery Centre and Lead Centre (§5.7, AC-8)
      const last8 = normalizedPhone.slice(-8);
      const isOptedOutClient = await Client.findOne({
        phone: { $regex: last8, $options: 'i' },
        $or: [{ opted_out: true }, { consent_sms: false }],
      });
      const isOptedOutLead = await Lead.findOne({
        phone: { $regex: last8, $options: 'i' },
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
      const sendResult = await mobileMessageService.sendSms({
        to: normalizedPhone,
        message: msgBody,
        sender,
        customRef: client_id ? String(client_id) : undefined,
      });

      const message = await Message.create({
        client_id,
        client_name,
        phone: normalizedPhone,
        body: msgBody,
        direction: 'outbound',
        status: sendResult.status === 'success' || sendResult.status === 'sent' ? 'sent' : sendResult.status,
        provider: 'mobilemessage',
        provider_message_id: sendResult.messageId || null,
        provider_response: sendResult.raw || null,
        sent_by_id: req.user.id,
        sent_by_name: req.user.name || req.user.email,
        template_id,
        sent_at: sendResult.sentAt || new Date(),
      });

      // Synchronize into Lead Centre Conversation thread for this phone
      const outboundMsgObj = {
        id: sendResult.messageId || (require('crypto').randomUUID ? require('crypto').randomUUID() : Date.now().toString(36)),
        sender: 'agent',
        text: msgBody,
        time: new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }),
        status: 'sent',
        createdAt: new Date(),
      };

      try {
        let conversation = await Conversation.findOne({
          phone: { $regex: normalizedPhone.slice(-8), $options: 'i' },
        });

        if (conversation) {
          conversation.messages.push(outboundMsgObj);
          conversation.lastMessage = msgBody;
          conversation.lastMessageAt = new Date();
          conversation.msgCount = (conversation.msgCount || 0) + 1;
          await conversation.save();
        } else {
          await Conversation.create({
            leadId: client_id || null,
            prospectName: client_name || `Customer (${normalizedPhone})`,
            phone: normalizedPhone,
            dealer: 'Melbourne CBD',
            status: 'active',
            control: 'agent',
            lastMessage: msgBody,
            lastMessageAt: new Date(),
            msgCount: 1,
            messages: [outboundMsgObj],
          });
        }
      } catch (convErr) {
        // Log error but don't fail the message send
        console.error('Conversation sync error:', convErr.message);
      }

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
        await Client.findByIdAndUpdate(client_id, {
          contact_status: 'Contacted',
          last_contacted_at: new Date(),
        });
      }

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
          phone: { $regex: last8, $options: 'i' },
          $or: [{ opted_out: true }, { consent_sms: false }],
        }),
        Lead.findOne({
          phone: { $regex: last8, $options: 'i' },
          $or: [{ status: 'opted out' }, { tag: 'Opted Out' }, { do_not_contact: true }],
        }),
      ]);

      if (isOptedOutClient || isOptedOutLead) {
        results.suppressed++;
        results.details.push({ phone: normalizedPhone, status: 'suppressed', reason: 'ACMA Opted Out' });
        continue;
      }

      try {
        const sendResult = await mobileMessageService.sendSms({
          to: normalizedPhone,
          message: msgBody,
          sender: item.sender,
          customRef: item.client_id ? String(item.client_id) : undefined,
        });

        await Message.create({
          client_id: item.client_id || null,
          client_name: item.name || item.client_name || `Customer (${normalizedPhone})`,
          phone: normalizedPhone,
          body: msgBody,
          direction: 'outbound',
          status: 'sent',
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
        results.failed++;
        results.details.push({ phone: normalizedPhone, status: 'failed', reason: err.message });
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
