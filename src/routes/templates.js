/**
 * templates.js – Delivery Centre & Sales Floor Template routes
 */
const express = require('express');
const Template = require('../models/delivery/Template');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// Default 10 template packs from §5.7
const DEFAULT_TEMPLATES = [
  {
    name: 'New allocation — first touch',
    channel: 'sms',
    trigger: 'Lead assigned; unsent after 10 min',
    subject: 'Your enquiry with BYD {{site}}',
    body: 'Hi {{first_name}}, {{consultant}} here from BYD {{site}}. Thank you for your enquiry on the {{model}}. When would be a good time for a brief chat or a test drive? Reply STOP to opt out.',
    active: true,
  },
  {
    name: 'Walk-in thank you',
    channel: 'sms',
    trigger: 'Manual, from Add Prospect',
    subject: 'Thanks for visiting BYD {{site}}',
    body: 'Hi {{first_name}}, thanks for coming into BYD {{site}} today to look at the {{model}}. Here is my direct contact if any questions come up. {{consultant}} — {{consultant_mobile}}.',
    active: true,
  },
  {
    name: 'Test drive booked',
    channel: 'both',
    trigger: 'On appointment create',
    subject: 'BYD {{model}} Test Drive Confirmed',
    body: "Hi {{first_name}}, your BYD {{model}} test drive is confirmed for {{appointment_date}} at {{appointment_time}} at BYD {{site}}. Please bring your valid driver's licence. See you soon!",
    active: true,
  },
  {
    name: 'Test drive reminder',
    channel: 'sms',
    trigger: 'T-24h and T-2h before test drive',
    subject: 'Test Drive Reminder: BYD {{model}}',
    body: 'Hi {{first_name}}, quick reminder of your BYD {{model}} test drive at {{appointment_time}} (BYD {{site}}). Let us know if you need to adjust time: {{consultant_mobile}}.',
    active: true,
  },
  {
    name: 'No-show / reschedule',
    channel: 'sms',
    trigger: 'Consultant marks no-show',
    subject: 'Reschedule your BYD test drive',
    body: 'Hi {{first_name}}, sorry we missed you for your BYD {{model}} test drive today. Would you like to reschedule for later this week? Let me know what suits: {{consultant_mobile}}.',
    active: true,
  },
  {
    name: 'Needs analysis follow-up',
    channel: 'both',
    trigger: 'Manual or sequence day +2 / +5',
    subject: 'Following up on your BYD {{model}} enquiry',
    body: "Hi {{first_name}}, following up on our conversation regarding the {{model}} {{variant}}. Happy to assist with range specs, trade-in valuation, or finance options whenever you're ready.",
    active: true,
  },
  {
    name: 'Commitment / order received',
    channel: 'both',
    trigger: 'Stage > Committed',
    subject: 'Order Confirmed: BYD {{model}}',
    body: 'Hi {{first_name}}, congratulations on reserving your BYD {{model}}! We have logged your order and our delivery team will keep you updated as vehicle preparation advances.',
    active: true,
  },
  {
    name: 'Delivery date set',
    channel: 'sms',
    trigger: 'When Delivery Centre date lands',
    subject: 'Delivery Date Confirmed: BYD {{model}}',
    body: 'Hi {{first_name}}, great news! Handover for your BYD {{model}} (Rego: {{rego}}) is scheduled for {{delivery_date}} at BYD {{site}}. We look forward to welcoming you.',
    active: true,
  },
  {
    name: 'Delivery reminder',
    channel: 'sms',
    trigger: 'T-24h before handover',
    subject: 'Handover Tomorrow: BYD {{model}}',
    body: "Hi {{first_name}}, your BYD {{model}} handover is tomorrow at {{delivery_date}}. Please ensure your primary driver's licence and funds are ready. See you at {{site}}!",
    active: true,
  },
  {
    name: 'After handover referral ask',
    channel: 'sms',
    trigger: 'T+3 days post Delivered',
    subject: 'How is your new BYD {{model}}?',
    body: "Hi {{first_name}}, hope you are loving your new BYD {{model}}! If any family or friends are considering an EV, let us know — we'd love to look after them. Safe travels!",
    active: true,
  },
];

router.get('/', async (req, res, next) => {
  try {
    let templates = await Template.find({ active: true }).sort('name').lean();
    if (!templates || templates.length === 0) {
      // Return defaults if none in DB
      templates = DEFAULT_TEMPLATES;
    }
    return res.json({ success: true, data: templates });
  } catch (err) {
    // Return fallback defaults gracefully
    return res.json({ success: true, data: DEFAULT_TEMPLATES });
  }
});

router.post('/', requireRole('manager', 'admin', 'super_admin'), async (req, res, next) => {
  try {
    const template = await Template.create({ ...req.body, createdBy: req.user.email });
    return res.status(201).json({ success: true, data: template });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requireRole('manager', 'admin', 'super_admin'), async (req, res, next) => {
  try {
    delete req.body._id;
    const template = await Template.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
    if (!template) return res.status(404).json({ success: false, message: 'Template not found.' });
    return res.json({ success: true, data: template });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
