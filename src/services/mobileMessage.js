/**
 * mobileMessage.js ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“ MobileMessage.com.au SMS Gateway Client
 * Handles HTTP Basic Auth, phone number normalization (E.164 Australian),
 * outbound message dispatch, idempotency, and diagnostics.
 */

const crypto = require('crypto');
const Setting = require('../models/lead/Setting');

const DEFAULT_BASE_URL = 'https://api.mobilemessage.com.au';

/**
 * Normalizes phone numbers to standard Australian international format (+614XXXXXXXX)
 * @param {string} phone
 * @returns {string} Normalized phone number
 */
function normalizeAustralianPhone(phone) {
  if (!phone) return '';
  // Strip spaces, dashes, parentheses
  let cleaned = String(phone).replace(/[^\d+]/g, '');

  // 04XX XXX XXX -> +614XXXXXXXX
  if (/^04\d{8}$/.test(cleaned)) {
    return '+61' + cleaned.substring(1);
  }

  if (/^4\d{8}$/.test(cleaned)) return '+61' + cleaned;

  // 614XXXXXXXX -> +614XXXXXXXX
  if (/^614\d{8}$/.test(cleaned)) {
    return '+' + cleaned;
  }

  // Already +614XXXXXXXX
  if (/^\+614\d{8}$/.test(cleaned)) {
    return cleaned;
  }

  // Fallback: if starts with +, keep it, otherwise add + if it looks international
  if (cleaned.startsWith('+')) {
    return cleaned;
  }

  return cleaned;
}

/**
 * Retrieves the active MobileMessage credentials and configuration.
 * Prioritizes environment variables, falls back to Lead Centre database settings.
 */
async function getConfig() {
  const envUsername = process.env.MOBILEMESSAGE_USERNAME || '';
  const envPassword = process.env.MOBILEMESSAGE_PASSWORD || process.env.MOBILEMESSAGE_API_KEY || '';
  const envSender = process.env.MOBILEMESSAGE_SENDER_ID || process.env.MOBILEMESSAGE_FROM || '+61468104118';
  const apiUrl = (process.env.MOBILEMESSAGE_API_URL || DEFAULT_BASE_URL).replace(/\/v1\/messages\/?$/, '').replace(/\/+$/, '');
  const envSimulation = process.env.MOBILEMESSAGE_SIMULATION_MODE;

  if (envUsername && envPassword) {
    return {
      username: envUsername,
      password: envPassword,
      senderId: envSender,
      apiUrl,
      simulationMode: envSimulation === 'true',
    };
  }

  try {
    const setting = await Setting.findOne({ key: 'sms_config' }).lean();
    if (setting) {
      return {
        username: setting.username || '',
        password: setting.apiKey || '',
        senderId: setting.senderId || envSender,
        apiUrl,
        simulationMode: envSimulation === undefined ? setting.simulationMode === true : envSimulation === 'true',
      };
    }
  } catch (err) {
    // If DB is unavailable, fall back to defaults
  }

  return {
    username: '',
    password: '',
    senderId: envSender,
    apiUrl,
    simulationMode: envSimulation === 'true',
  };
}

/**
 * Sends an SMS message via MobileMessage REST API
 * @param {Object} options
 * @param {string} options.to - Recipient phone number
 * @param {string} options.message - SMS text content
 * @param {string} [options.sender] - Alphanumeric Sender ID or virtual mobile number
 * @param {string} [options.customRef] - Reference tracking ID
 * @param {string} [options.idempotencyKey] - Optional UUID to prevent duplicates
 * @returns {Promise<Object>} Send result
 */
async function sendSms({ to, message, sender, customRef, idempotencyKey, requestedBy }) {
  if (typeof requestedBy !== 'string' || !requestedBy.trim()) {
    throw new Error('SMS must be sent manually by an authenticated staff member');
  }
  const normalizedPhone = normalizeAustralianPhone(to);
  if (!normalizedPhone) {
    throw new Error('Valid recipient phone number is required');
  }
  if (!message || !message.trim()) {
    throw new Error('Message content is required');
  }

  const config = await getConfig();
  const effectiveSender = sender || config.senderId || '+61468104118';
  const key = idempotencyKey || (crypto.randomUUID ? crypto.randomUUID() : `byd-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`);

  // Simulation must be explicitly enabled; missing credentials are a send failure.
  if (!config.simulationMode && (!config.username || !config.password)) throw new Error('SMS provider not configured');
  if (config.simulationMode) {
    const simulatedId = `sim-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    return {
      success: true,
      simulated: true,
      messageId: simulatedId,
      to: normalizedPhone,
      sender: effectiveSender,
      cost: 1,
      status: 'simulated',
      sentAt: new Date(),
    };
  }

  // Production live dispatch to MobileMessage REST API
  const authHeader = 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64');
  const payload = {
    enable_unicode: true,
    messages: [
      {
        to: normalizedPhone,
        message: message.trim(),
        sender: effectiveSender,
        custom_ref: customRef || undefined,
      },
    ],
  };

  const executeSend = async () => {
    const res = await fetch(`${config.apiUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
        'Idempotency-Key': key,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));

    if (res.status === 429) {
      // Concurrency limit reached (max 5 in flight). Wait 600ms and retry once.
      await new Promise((resolve) => setTimeout(resolve, 600));
      const retryRes = await fetch(`${config.apiUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
          'Idempotency-Key': key,
        },
        body: JSON.stringify(payload),
      });
      const retryData = await retryRes.json().catch(() => ({}));
      if (!retryRes.ok) {
        throw new Error(retryData.error || `MobileMessage Error: HTTP ${retryRes.status}`);
      }
      return retryData;
    }

    if (!res.ok) {
      throw new Error(data.error || `MobileMessage Error: HTTP ${res.status}`);
    }

    return data;
  };

  const responseData = await executeSend();

  const firstResult = responseData.results && responseData.results[0];
  if (!firstResult) {
    throw new Error('MobileMessage API returned an empty result batch');
  }

  const resultStatus = String(firstResult.status || '').toLowerCase();
  if (!['success', 'queued', 'sent', 'accepted'].includes(resultStatus) || !firstResult.message_id) {
    throw new Error(firstResult.error || firstResult.message || `Message dispatch rejected: ${firstResult.status || 'missing status or ID'}`);
  }

  return {
    success: true,
    simulated: false,
    messageId: firstResult.message_id,
    sendId: responseData.send_id,
    cost: firstResult.cost,
    status: resultStatus,
    to: firstResult.to,
    sender: firstResult.sender,
    sentAt: new Date(),
    raw: responseData,
  };
}

/**
 * Tests connection to MobileMessage and retrieves account balance + approved senders.
 * @param {Object} [overrideCredentials] - Optional username & password to test
 */
async function testConnection(overrideCredentials) {
  const config = overrideCredentials || (await getConfig());
  const apiUrl = (config.apiUrl || process.env.MOBILEMESSAGE_API_URL || DEFAULT_BASE_URL).replace(/\/v1\/messages\/?$/, '').replace(/\/+$/, '');
  const username = config.username;
  const password = config.password || config.apiKey;

  if (!username || !password) {
    return {
      success: false,
      error: 'Username and API key / password must be provided',
    };
  }

  const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

  try {
    const [accountRes, sendersRes] = await Promise.all([
      fetch(`${apiUrl}/v1/account`, {
        headers: { Authorization: authHeader },
      }),
      fetch(`${apiUrl}/v1/senders`, {
        headers: { Authorization: authHeader },
      }),
    ]);

    const accountData = await accountRes.json().catch(() => ({}));
    const sendersData = await sendersRes.json().catch(() => ({}));

    if (!accountRes.ok) {
      return {
        success: false,
        error: accountData.error || `Account check failed with HTTP ${accountRes.status}`,
      };
    }

    return {
      success: true,
      account: accountData,
      senders: sendersData,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message || 'Connection failed',
    };
  }
}

/**
 * Looks up message delivery status by MobileMessage message_id UUID
 * @param {string} messageId
 */
async function lookupMessage(messageId) {
  const config = await getConfig();
  if (!config.simulationMode && (!config.username || !config.password)) throw new Error("SMS provider not configured");
  if (config.simulationMode) {
    return {
      message_id: messageId,
      status: 'delivered',
      simulated: true,
    };
  }

  const authHeader = 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64');
  const res = await fetch(`${config.apiUrl}/v1/messages?message_id=${encodeURIComponent(messageId)}`, {
    headers: { Authorization: authHeader },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Lookup failed with HTTP ${res.status}`);
  }

  return data;
}

module.exports = {
  normalizeAustralianPhone,
  getConfig,
  sendSms,
  testConnection,
  lookupMessage,
};
