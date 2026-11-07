#!/usr/bin/env node
// Explicit, single-recipient live test. Never starts the server or its workers.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
const { journeySteps } = require('../src/services/floorCommunications');
const { DEFAULTS } = require('../src/services/salesFloorPolicy');
const args = process.argv.slice(2), arg = name => args[args.indexOf(name) + 1];
const has = name => args.includes(name);
// Avoid initializing the production database merely to read env credentials.
const file = path.resolve(__dirname, '../src/services/mobileMessage.js'), localRequire = createRequire(file), gatewayModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module: gatewayModule, exports: gatewayModule.exports, process, Buffer, URL, AbortSignal, fetch, setTimeout, Date, Math, console,
  require: name => name === '../models/lead/Setting' ? { findOne: () => ({ lean: async () => null }) } : localRequire(name) }, { filename: file });
const gateway = gatewayModule.exports;
async function run() {
  const requestId = has('--request-id') ? arg('--request-id') : '';
  if (!/^[\w-]{8,100}$/.test(requestId)) throw Error('Supply --request-id with a stable identifier for this test.');
  const key = crypto.createHash('sha256').update(requestId).digest('hex'), journalPath = path.resolve(__dirname, `../.runtime/live-sms-${key}.json`);
  const save = record => { fs.mkdirSync(path.dirname(journalPath), { recursive: true, mode: 0o700 }); fs.writeFileSync(journalPath, JSON.stringify(record, null, 2), { mode: 0o600 }); };
  const previous = fs.existsSync(journalPath) ? JSON.parse(fs.readFileSync(journalPath, 'utf8')) : null;
  if (has('--receipt')) {
    if (!previous?.providerMessageId) throw Error('No confirmed provider message ID in this test journal. Do not blindly resend.');
    const result = await gateway.lookupMessage(previous.providerMessageId);
    const message = result.results?.find(row => row.message_id === previous.providerMessageId);
    if (result.simulated || !message) throw Error('No live provider receipt found.');
    const record = { ...previous, deliveryStatus: message.status, lastCheckedAt: new Date().toISOString(), ...(message.status === 'delivered' ? { verifiedDeliveredAt: new Date().toISOString() } : {}) };
    save(record); console.log(JSON.stringify(record)); return;
  }
  if (!has('--send-sms') || !has('--to')) throw Error('Sending requires --send-sms and --to with an explicitly approved test mobile.');
  if (previous) { console.log(JSON.stringify({ ...previous, replay: true, action: 'No SMS resent. Use --receipt to check delivery.' })); return; }
  const config = await gateway.getConfig(), to = gateway.normalizeAustralianPhone(arg('--to'));
  if (!/^\+614\d{8}$/.test(to)) throw Error('An Australian mobile is required.');
  if (config.simulationMode || !config.username || !config.password) throw Error('Live SMS credentials are required; simulation is not accepted.');
  const sender = has('--sender') ? arg('--sender') : config.senderId;
  if (!(await gateway.getApprovedSenders()).some(row => row.sender === sender)) throw Error('The selected sender is not active and approved.');
  const step = journeySteps(DEFAULTS, { name: 'Test', vehicle: 'BYD test vehicle' }).find(row => row.key === 'congratulations');
  const body = `[Sales Floor TEST] ${step.body}`;
  const record = { test: 'BYD post-delivery congratulations template', requestId, state: 'sending', recipientLast4: to.slice(-4), sender, createdAt: new Date().toISOString() };
  // Exclusive creation prevents concurrent invocations submitting the same test.
  fs.mkdirSync(path.dirname(journalPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(journalPath, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' });
  try {
    const result = await gateway.sendSms({ to, message: body, sender, useSiteSender: true, requestedBy: 'workspace-user-approved-live-test', idempotencyKey: key, customRef: `floor-test:${key}` });
    if (result.simulated || !result.messageId) throw Error('Provider did not confirm live submission.');
    const sent = { ...record, state: 'submitted', providerMessageId: result.messageId, deliveryStatus: result.status, submittedAt: new Date().toISOString() };
    save(sent); console.log(JSON.stringify(sent));
  } catch (error) { save({ ...record, state: 'unknown', error: error.message }); throw error; }
}
run().catch(error => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
