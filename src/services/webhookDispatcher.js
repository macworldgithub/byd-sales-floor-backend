/**
 * webhookDispatcher.js – Dispatches outbound CRM webhook events (§7.3 & §7.4)
 * Broadcasts events to Lead Centre, Delivery Centre, and partner endpoints:
 *   - crm.note_added
 *   - crm.stage_changed
 *   - crm.owner_changed
 *   - crm.deal_sold
 *   - crm.allocation_created
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

const LEAD_CENTRE_WEBHOOK_URL = process.env.LEAD_CENTRE_WEBHOOK_URL || '';
const DELIVERY_CENTRE_WEBHOOK_URL = process.env.DELIVERY_CENTRE_WEBHOOK_URL || '';

async function postJson(targetUrl, data, timeoutMs = 5000) {
  if (!targetUrl) return null;
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(targetUrl);
      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;

      const bodyStr = JSON.stringify(data);
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          'User-Agent': 'BYD-Sales-CRM/1.0',
        },
        timeout: timeoutMs,
      };

      const req = lib.request(options, (res) => {
        let resData = '';
        res.on('data', (chunk) => { resData += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, body: resData });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ error: 'Timeout', status: 408 });
      });

      req.on('error', (err) => {
        resolve({ error: err.message, status: 500 });
      });

      req.write(bodyStr);
      req.end();
    } catch (err) {
      resolve({ error: err.message });
    }
  });
}

const webhookDispatcher = {
  /**
   * Broadcasts an outbound CRM event
   * @param {string} event - e.g. 'crm.note_added', 'crm.deal_sold', 'crm.stage_changed'
   * @param {object} payload - event details
   * @param {object} [customerKeys] - { customer_id, phone, email, name }
   */
  async emit(event, payload = {}, customerKeys = {}) {
    const envelope = {
      event_id: `EVT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
      event,
      source: 'crm',
      timestamp: new Date().toISOString(),
      customer_keys: customerKeys,
      payload,
    };

    const targets = [];
    if (LEAD_CENTRE_WEBHOOK_URL) targets.push(LEAD_CENTRE_WEBHOOK_URL);
    if (DELIVERY_CENTRE_WEBHOOK_URL) targets.push(DELIVERY_CENTRE_WEBHOOK_URL);

    if (targets.length === 0) {
      if (process.env.NODE_ENV !== 'test') {
        console.log(`[CRM Webhook Dispatcher] Emitted '${event}' (Local / no remote URL set):`, envelope.event_id);
      }
      return { emitted: true, event_id: envelope.event_id, targetCount: 0 };
    }

    const dispatches = targets.map((url) => postJson(url, envelope));
    const results = await Promise.allSettled(dispatches);
    return {
      emitted: true,
      event_id: envelope.event_id,
      targetCount: targets.length,
      results,
    };
  },
};

module.exports = webhookDispatcher;
