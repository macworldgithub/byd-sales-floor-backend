const { fail } = require('./accountAccess');
const { sha, and } = require('./salesFloorMobile');
const p = require('./salesFloorPolicy');
const normalizeSender = value => String(value || '').replace(/^\+/, '');
const normalizeStatus = value => {
  const status = String(value || '').toLowerCase();
  if (!['pending', 'scheduled', 'queued', 'accepted', 'success', 'sent', 'delivered', 'failed', 'cancelled'].includes(status)) fail(502, 'Provider returned an unrecognized delivery status.');
  return status;
};
const { journeySteps } = require('./floorJourney');

class FloorCommunications {
  constructor(service, gateway = require('./mobileMessage')) { this.service = service; this.panel = service.panel; this.gateway = gateway; }
  async senders() {
    return this.gateway.getApprovedSenders();
  }
  async assertSender(sender) {
    if (!(await this.senders()).some(row => normalizeSender(row.sender) === normalizeSender(sender))) fail(409, 'Select an active, approved MobileMessage sender for this site.');
  }
  async readiness(site, user) {
    const config = await this.service.config(site), gateway = await this.gateway.getConfig();
    return { site, sms: { credentialsConfigured: Boolean(gateway.username && gateway.password), simulationMode: gateway.simulationMode === true,
      sender: config.smsSenderId, deploymentSender: gateway.senderId || '', senderConfigured: Boolean(config.smsSenderId), approvalRequired: true,
      videoLinksConfigured: config.videoUrls.length > 0, surveyConfigured: Boolean(config.surveyUrl) },
    push: { projectConfigured: Boolean(process.env.EXPO_PROJECT_ID), projectId: process.env.EXPO_PROJECT_ID || null,
      registeredDevices: await this.panel.collection('floor_push_tokens').countDocuments({ userId: user.id, enabled: true }) } };
  }
  async sendTest(input, user, site) {
    if (!p.isManager(user)) fail(403, 'Management access required.');
    const phone = this.gateway.normalizeAustralianPhone(input.phone);
    if (!/^\+614\d{8}$/.test(phone) || !/^[\w-]{8,100}$/.test(String(input.requestId || ''))) fail(400, 'Enter an Australian test mobile and a stable request ID.');
    const config = await this.service.config(site), step = journeySteps(config, { name: 'Test', vehicle: 'BYD test vehicle' }).find(row => row.key === (input.step || 'congratulations'));
    if (!step || !step.body || step.needsConfiguration) fail(409, 'Configure the selected journey message before testing.');
    if (!config.smsSenderId) fail(409, 'Configure this site’s verified SMS sender before testing.');
    const body = `[Sales Floor TEST] ${step.body}`, key = sha(`sms-test:${user.id}:${input.requestId}`), fingerprint = sha(`${site}:${phone}:${body}:${config.smsSenderId}`);
    const tests = this.panel.collection('floor_communication_tests'), existing = await tests.findOne({ _id: key });
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail(409, 'This test request ID has already been used.');
      if (existing.state === 'submitted') return this.publicTest(existing);
      fail(409, 'This test may already have been sent. Check its delivery before submitting a new test.');
    }
    await this.assertSender(config.smsSenderId);
    try { await tests.insertOne({ _id: key, fingerprint, site, owner_user_id: user.id, state: 'sending', phone, body, step: step.key, createdAt: new Date() }); }
    catch (error) { if (error.code === 11000) fail(409, 'This SMS test is already in progress.'); throw error; }
    try {
      const result = await this.gateway.sendSms({ to: phone, message: body, sender: config.smsSenderId, useSiteSender: true, requestedBy: user.id, idempotencyKey: key, customRef: `floor-test:${key}` });
      if (result.simulated || !result.messageId) fail(502, 'Live SMS submission was not confirmed.');
      const patch = { state: 'submitted', providerMessageId: result.messageId, deliveryStatus: normalizeStatus(result.status), submittedAt: new Date() };
      await tests.updateOne({ _id: key }, { $set: patch });
      return this.publicTest({ _id: key, ...patch });
    } catch (error) {
      await tests.updateOne({ _id: key, state: 'sending' }, { $set: { state: 'unknown', error: error.message } });
      return this.publicTest({ _id: key, state: 'unknown', error: error.message });
    }
  }
  publicTest(row) { return { id: row._id, state: row.state, providerMessageId: row.providerMessageId || null, deliveryStatus: row.deliveryStatus || 'unknown',
    verifiedDeliveredAt: row.verifiedDeliveredAt || null, lastCheckedAt: row.lastCheckedAt || null, error: row.error || null }; }
  async receipt(messageId) {
    const config = await this.gateway.getConfig();
    if (config.simulationMode || !config.username || !config.password) fail(503, 'Live SMS credentials are required for delivery verification.');
    const result = await this.gateway.lookupMessage(messageId);
    if (result.simulated || !Array.isArray(result.results)) fail(502, 'Provider did not return verified message history.');
    const row = result.results.find(row => row.message_id === messageId);
    if (!row) fail(502, 'The provider has not returned this message yet. Delivery is not confirmed.');
    const status = normalizeStatus(row.status);
    return { deliveryStatus: status, lastCheckedAt: new Date(), ...(status === 'delivered' ? { verifiedDeliveredAt: new Date() } : {}) };
  }
  async testReceipt(value, user) {
    const tests = this.panel.collection('floor_communication_tests'), test = await tests.findOne(and(p.scope(user, {}, ['site']), { _id: value, owner_user_id: user.id }));
    if (!test) fail(404, 'SMS test not found.');
    if (!test.providerMessageId) return this.publicTest(test);
    if (test.verifiedDeliveredAt) return this.publicTest(test);
    const patch = await this.receipt(test.providerMessageId);
    await tests.updateOne({ _id: value }, { $set: patch }); return this.publicTest({ ...test, ...patch });
  }
  async followupReceipt(value, user) {
    const queue = this.panel.collection('floor_followups'), draft = await queue.findOne(and(p.scope(user, {}, ['site']), { _id: value }));
    if (!draft) fail(404, 'Follow-up not found.');
    if (!draft.providerMessageId && ['sending', 'unknown'].includes(draft.status)) {
      const request = await this.panel.collection('floor_sms_requests').findOne({ _id: sha(`journey:${draft._id}:journey-${draft._id}`) });
      if (request?.state === 'sent' && request.result?.messageId) {
        Object.assign(draft, { status: 'sent', providerMessageId: request.result.messageId, deliveryStatus: request.result.status, sentAt: request.createdAt });
        await queue.updateOne({ _id: value }, { $set: { status: draft.status, providerMessageId: draft.providerMessageId, deliveryStatus: draft.deliveryStatus, sentAt: draft.sentAt } });
      }
    }
    if (!draft.providerMessageId) fail(409, 'Approve and submit the SMS before checking its delivery.');
    const patch = draft.verifiedDeliveredAt ? { deliveryStatus: 'delivered', verifiedDeliveredAt: draft.verifiedDeliveredAt } : await this.receipt(draft.providerMessageId);
    await queue.updateOne({ _id: value }, { $set: patch }); return { id: value, status: draft.status, ...patch };
  }
}
module.exports = { FloorCommunications, journeySteps, normalizeStatus };
