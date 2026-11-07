const { fail, siteKey } = require('./accountAccess');
const { sha, reference, and } = require('./salesFloorMobile');
const p = require('./salesFloorPolicy');
const validToken = value => /^(ExponentPushToken|ExpoPushToken)\[[\w-]+\]$/.test(String(value || ''));
const validProject = value => /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(String(value || ''));
const headers = () => ({ 'Content-Type': 'application/json', ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}) });
const publicDelivery = row => ({ id: row._id, state: row.state, ticketId: row.ticketId || null, error: row.error || null, submittedAt: row.submittedAt || null,
  providerAcceptedAt: row.providerAcceptedAt || null, receivedAt: row.receivedAt || null, openedAt: row.openedAt || null });

class FloorPush {
  constructor(panel, fetchImpl = fetch) { this.panel = panel; this.fetch = fetchImpl; }
  async register(input, user, site) {
    if (!validToken(input.token) || !validProject(input.projectId) || !['ios', 'android'].includes(input.platform)) fail(400, 'A valid Expo token, project ID and device platform are required.');
    const expected = process.env.EXPO_PROJECT_ID;
    if (expected && input.projectId !== expected) fail(400, 'This device belongs to a different Expo project. Install the configured app build.');
    await this.panel.collection('floor_push_tokens').updateOne({ _id: input.token }, { $set: { userId: user.id, site, projectId: input.projectId, platform: input.platform, enabled: true, updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date() }, $unset: { disabledReason: '' } }, { upsert: true });
    return { registered: true, userId: user.id };
  }
  async dispatch(notification, onlyToken) {
    const ownerId = String(notification.owner_user_id || '');
    const account = await this.panel.collection('users').findOne({ _id: reference(ownerId), active: { $ne: false }, deleted_at: null });
    if (!account || (Array.isArray(account.platform_access) && !account.platform_access.includes('sales_floor')) ||
      (!account.all_sites && !(account.allowed_sites?.length ? account.allowed_sites : [account.site]).some(site => siteKey(site) === siteKey(notification.site)))) return;
    if (Date.now() - new Date(notification.createdAt).getTime() > 86400000) {
      await this.panel.collection('floor_notifications').updateOne({ _id: notification._id }, { $set: { pushState: 'expired' } }); return;
    }
    const tokens = await this.panel.collection('floor_push_tokens').find({ userId: ownerId, enabled: true, ...(onlyToken ? { _id: onlyToken } : {}) }).toArray();
    const deliveries = this.panel.collection('floor_push_deliveries');
    for (const token of tokens.filter(row => validToken(row._id))) {
      // Registering a new device must not send a backlog of old customer alerts.
      if (!onlyToken && token.createdAt && new Date(token.createdAt) > new Date(notification.createdAt)) continue;
      const key = sha(`${notification._id}:${token._id}`);
      await deliveries.updateOne({ _id: key }, { $setOnInsert: { notificationId: notification._id, token: token._id, userId: ownerId,
        site: notification.site, state: 'pending', createdAt: new Date() } }, { upsert: true });
      const claim = await deliveries.updateOne({ _id: key, state: 'pending' }, { $set: { state: 'sending', startedAt: new Date() } });
      if (!claim.modifiedCount) continue;
      if (!await this.panel.collection('floor_push_tokens').findOne({ _id: token._id, userId: ownerId, enabled: true })) {
        await deliveries.updateOne({ _id: key }, { $set: { state: 'skipped', error: 'Device registration changed.' } }); continue;
      }
      try {
        const response = await this.fetch('https://exp.host/--/api/v2/push/send', { method: 'POST', headers: headers(), signal: AbortSignal.timeout(15000),
          body: JSON.stringify({ to: token._id, title: notification.title, body: notification.body, sound: 'default', channelId: 'sales-floor-alerts',
            data: { notificationId: notification._id, leadId: notification.leadId || null, site: notification.site } }) });
        const result = await response.json(), ticket = Array.isArray(result.data) ? result.data[0] : result.data;
        if (!response.ok || ticket?.status !== 'ok' || !ticket.id) {
          const code = ticket?.details?.error || `ExpoHTTP${response.status}`;
          await deliveries.updateOne({ _id: key }, { $set: { state: response.ok || response.status < 500 ? 'failed' : 'unknown', error: code, checkedAt: new Date() } });
          if (code === 'DeviceNotRegistered') await this.disable(token._id, code);
          continue;
        }
        // An Expo ticket is submission evidence, not device delivery evidence.
        await deliveries.updateOne({ _id: key, state: 'sending' }, { $set: { state: 'submitted', ticketId: ticket.id, submittedAt: new Date(), receiptDueAt: new Date(Date.now() + 15 * 60000) } });
      } catch (_) { await deliveries.updateOne({ _id: key, state: 'sending' }, { $set: { state: 'unknown', error: 'Submission interrupted; check the device before retrying.' } }); }
    }
    await this.summarize(notification._id);
  }
  async disable(token, reason) { await this.panel.collection('floor_push_tokens').updateOne({ _id: token }, { $set: { enabled: false, disabledReason: reason, updatedAt: new Date() } }); }
  async summarize(notificationId) {
    const rows = await this.panel.collection('floor_push_deliveries').find({ notificationId }).toArray();
    const states = rows.map(row => row.state);
    const state = states.includes('received') ? 'received' : states.includes('provider_accepted') ? 'provider_accepted' : states.includes('submitted') ? 'submitted' :
      states.includes('sending') ? 'sending' : states.includes('unknown') ? 'unknown' : states.length ? 'failed' : 'waiting_device';
    await this.panel.collection('floor_notifications').updateOne({ _id: notificationId }, { $set: { pushState: state } });
    return { notificationId, state, deliveries: rows.map(publicDelivery) };
  }
  async reconcile(notificationId) {
    const deliveries = this.panel.collection('floor_push_deliveries');
    const interrupted = await deliveries.find({ state: 'sending', startedAt: { $lt: new Date(Date.now() - 3 * 60000) }, ...(notificationId ? { notificationId } : {}) }).limit(100).toArray();
    for (const row of interrupted) {
      await deliveries.updateOne({ _id: row._id, state: 'sending' }, { $set: { state: 'unknown', error: 'Submission did not finish recording; check the device before retrying.' } });
      await this.summarize(row.notificationId);
    }
    const rows = await deliveries.find({ state: 'submitted', ...(notificationId ? { notificationId } : { receiptDueAt: { $lte: new Date() } }) }).limit(100).toArray();
    if (!rows.length) return;
    const response = await this.fetch('https://exp.host/--/api/v2/push/getReceipts', { method: 'POST', headers: headers(),
      body: JSON.stringify({ ids: rows.map(row => row.ticketId) }), signal: AbortSignal.timeout(15000) });
    const result = await response.json();
    if (!response.ok || !result.data || Array.isArray(result.data)) fail(502, 'Expo receipt lookup failed. Delivery is not confirmed.');
    for (const row of rows) {
      const receipt = result.data[row.ticketId];
      let patch;
      if (receipt?.status === 'ok') patch = { state: 'provider_accepted', providerAcceptedAt: new Date() };
      else if (receipt?.status === 'error') {
        patch = { state: 'failed', error: receipt.details?.error || 'Push provider rejected the notification.' };
        if (receipt.details?.error === 'DeviceNotRegistered') await this.disable(row.token, 'DeviceNotRegistered');
      } else patch = { ...(Date.now() - new Date(row.submittedAt).getTime() > 24 * 3600000 ? { state: 'receipt_missing', error: 'No receipt before Expo retention expired.' } : {}), receiptDueAt: new Date(Date.now() + 5 * 60000) };
      await deliveries.updateOne({ _id: row._id, state: 'submitted' }, { $set: { ...patch, checkedAt: new Date() } });
      await this.summarize(row.notificationId);
    }
  }
  async acknowledge(input, user) {
    if (!validToken(input.token) || !['received', 'opened'].includes(input.event)) fail(400, 'A device token and notification receipt event are required.');
    const token = await this.panel.collection('floor_push_tokens').findOne({ _id: input.token, userId: user.id, enabled: true });
    if (!token) fail(404, 'Device registration not found.');
    const delivery = await this.panel.collection('floor_push_deliveries').findOne({ _id: sha(`${input.notificationId}:${input.token}`), userId: user.id });
    if (!delivery) fail(404, 'Notification delivery not found.');
    await this.panel.collection('floor_push_deliveries').updateOne({ _id: delivery._id }, { $set: { state: 'received', receivedAt: delivery.receivedAt || new Date(), ...(input.event === 'opened' ? { openedAt: new Date() } : {}) } });
    return this.summarize(delivery.notificationId);
  }
  async test(input, user, site) {
    if (!validToken(input.token) || !/^[\w-]{8,100}$/.test(String(input.requestId || ''))) fail(400, 'Select this device and provide a stable test request ID.');
    if (!await this.panel.collection('floor_push_tokens').findOne({ _id: input.token, userId: user.id, enabled: true })) fail(409, 'Enable push on this device first.');
    const key = sha(`push-test:${user.id}:${input.requestId}`), notification = { _id: key, site, owner_user_id: user.id, owner_name: user.name,
      title: 'Sales Floor push test', body: 'Your BYD Sales Floor test notification. Open it to confirm device receipt.', type: 'test', read: false, pushState: 'pending', createdAt: new Date(), testTokenHash: sha(input.token) };
    const previous = await this.panel.collection('floor_notifications').findOne({ _id: key });
    if (previous && (previous.testTokenHash !== notification.testTokenHash || previous.site !== site)) fail(409, 'This test request ID has already been used.');
    await this.panel.collection('floor_notifications').updateOne({ _id: key }, { $setOnInsert: notification }, { upsert: true });
    await this.dispatch(previous || notification, input.token);
    return this.summarize(key);
  }
  async status(notificationId, user) {
    if (!await this.panel.collection('floor_notifications').findOne(and(p.scope(user, {}, ['site']), { _id: notificationId, owner_user_id: user.id }))) fail(404, 'Notification not found.');
    await this.reconcile(notificationId); return this.summarize(notificationId);
  }
}
module.exports = { FloorPush, validToken, validProject };
