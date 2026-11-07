const { fail } = require('./accountAccess');
const { sha, id } = require('./salesFloorMobile');

const STEPS = [
  { key: 'congratulations', day: 0, template: 'Congratulations {firstName} on your new {vehicle}! Thank you for choosing BYD.' },
  { key: 'welcome', day: 1, template: 'Welcome {firstName}! Your BYD team is here to help you get to know your {vehicle}.' },
  { key: 'feature_videos', day: 3, template: 'Hi {firstName}, helpful videos for your {vehicle}: {videoLinks}' },
  { key: 'satisfaction_21_day', day: 21, template: 'Hi {firstName}, how are you enjoying your {vehicle}? {surveyUrl} {contact}' },
];
const TOKENS = ['firstName', 'name', 'vehicle', 'site', 'videoLinks', 'surveyUrl', 'contact'];
function httpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password; } catch { return false; }
}
function validateJourney(value) {
  if (value == null) return null; // Existing site settings retain the original four-step journey.
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['steps', 'modelVideos', 'contact'].includes(k))) fail(400, 'Invalid BYD journey configuration.');
  if (!Array.isArray(value.steps) || value.steps.length !== STEPS.length) fail(400, 'Configure all four BYD journey messages.');
  let previous = 0;
  const steps = STEPS.map((defaultStep, index) => {
    const step = value.steps[index];
    if (!step || step.key !== defaultStep.key || Object.keys(step).some(k => !['key', 'day', 'template'].includes(k))) fail(400, 'Use the four BYD journey steps in order.');
    if (!Number.isInteger(step.day) || step.day < previous || step.day > 21 || (index === 0 && step.day !== 0) || (index === 3 && step.day !== 21)) fail(400, 'Congratulations must be day 0, satisfaction day 21, with welcome and videos in between.');
    previous = step.day;
    if (typeof step.template !== 'string' || !step.template.trim() || step.template.length > 3000) fail(400, 'Journey templates must contain 1–3000 characters.');
    const remainder = step.template.replace(/\{([A-Za-z]+)\}/g, (_, token) => { if (!TOKENS.includes(token)) fail(400, `Unsupported journey variable: ${token}.`); return ''; });
    if (/[{}]/.test(remainder)) fail(400, 'Invalid journey template variable.');
    if (step.key === 'feature_videos' && !step.template.includes('{videoLinks}')) fail(400, 'The video message must include {videoLinks}.');
    if (step.key === 'satisfaction_21_day' && !/\{(?:surveyUrl|contact)\}/.test(step.template)) fail(400, 'The satisfaction message must include {surveyUrl} or {contact}.');
    return { key: step.key, day: step.day, template: step.template.trim() };
  });
  const modelVideos = value.modelVideos || [];
  if (!Array.isArray(modelVideos) || modelVideos.length > 50 || modelVideos.some(row => !row || Object.keys(row).some(k => !['model', 'urls'].includes(k)) || typeof row.model !== 'string' || !row.model.trim() || row.model.length > 100 || !Array.isArray(row.urls) || !row.urls.length || row.urls.length > 10 || row.urls.some(url => !httpsUrl(url)))) fail(400, 'Configure a model and valid HTTPS video links for each model video set.');
  if (new Set(modelVideos.map(row => row.model.trim().toLowerCase())).size !== modelVideos.length) fail(400, 'Each vehicle model must have only one video set.');
  const contact = value.contact === undefined ? 'Contact your BYD team with any questions or feedback.' : value.contact;
  if (typeof contact !== 'string' || contact.length > 500) fail(400, 'Journey contact details must be at most 500 characters.');
  return { steps, modelVideos: modelVideos.map(row => ({ model: row.model.trim(), urls: [...row.urls] })), contact: contact.trim() };
}
function journeySteps(config, client) {
  const journey = validateJourney(config.journey || { steps: STEPS.map(step => ({ ...step, ...(step.key === 'welcome' && config.welcomeText ? { template: config.welcomeText } : {}) })), modelVideos: [], contact: 'Contact your BYD team with any questions or feedback.' });
  const vehicle = String(client.vehicle || client.model || 'BYD'), name = String(client.name || '').trim();
  const normal = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const model = normal(client.model || vehicle);
  const match = journey.modelVideos.filter(row => ` ${model} `.includes(` ${normal(row.model)} `)).sort((a, b) => b.model.length - a.model.length)[0];
  const urls = match?.urls || config.videoUrls || [];
  const variables = { firstName: name.split(/\s+/)[0], name, vehicle, site: String(client.site_location || client.site || ''), videoLinks: urls.join(' '), surveyUrl: config.surveyUrl || '', contact: journey.contact };
  return journey.steps.map(step => {
    const issues = [];
    if (step.template.includes('{videoLinks}') && !urls.length) issues.push('Approved vehicle video links are missing.');
    if (step.template.includes('{surveyUrl}') && !variables.surveyUrl && (!step.template.includes('{contact}') || !variables.contact)) issues.push('A survey URL or contact details are required.');
    if (step.key === 'satisfaction_21_day' && !((step.template.includes('{contact}') && variables.contact) || (step.template.includes('{surveyUrl}') && variables.surveyUrl))) issues.push('A survey URL or contact details are required.');
    const body = step.template.replace(/\{([A-Za-z]+)\}/g, (_, token) => variables[token] ?? '').trim();
    if (!body || body.length > 4000) issues.push('Rendered message must contain 1–4000 characters.');
    return { ...step, body, needsConfiguration: issues.length > 0, configurationIssues: [...new Set(issues)] };
  });
}
function preview(config, client, deliveredAt = new Date()) {
  const at = new Date(deliveredAt);
  if (!Number.isFinite(at.getTime())) fail(400, 'Enter a valid handover date and time.');
  return journeySteps(config, client).map(step => ({ ...step, dueAt: new Date(at.getTime() + step.day * 86400000), approvalRequired: true }));
}
function reviewToken(draft) { return sha(JSON.stringify([String(draft._id), draft.body, draft.phone || '', new Date(draft.dueAt).toISOString()])); }
async function enroll(service, client, config) {
  for (const step of preview(config, client, client.deliveredAt)) {
    await service.panel.collection('floor_followups').updateOne({ _id: sha(`journey:${id(client)}:${step.key}`) }, { $setOnInsert: {
      ...step, clientId: id(client), customerId: client.crm_customer_id, site: client.site_location || client.site,
      owner_user_id: String(client.consultantId || ''), owner_name: client.salesperson, phone: client.phone,
      status: step.needsConfiguration ? 'needs_configuration' : 'awaiting_approval', createdAt: new Date(),
    } }, { upsert: true });
  }
}
async function refreshPending(service, site, config, user) {
  const p = require('./salesFloorPolicy');
  const rows = await service.panel.collection('floor_followups').find({ $and: [p.scope({ ...user, role: 'manager' }, { site }, ['site']), { status: { $in: ['needs_configuration', 'awaiting_approval'] } }] }).toArray();
  let updated = 0;
  for (const row of rows) {
    const client = await service.panel.collection('clients').findOne({ _id: require('./salesFloorMobile').reference(row.clientId) });
    if (!client?.deliveredAt) continue;
    const step = preview(config, client, client.deliveredAt).find(step => step.key === row.key);
    if (!step) continue;
    const result = await service.panel.collection('floor_followups').updateOne({ _id: row._id, status: { $in: ['needs_configuration', 'awaiting_approval'] } }, { $set: {
      ...step, status: step.needsConfiguration ? 'needs_configuration' : 'awaiting_approval', configurationUpdatedBy: user.id, configurationUpdatedAt: new Date(),
    } });
    updated += result.modifiedCount;
  }
  return updated;
}
module.exports = { STEPS, TOKENS, httpsUrl, validateJourney, journeySteps, preview, reviewToken, enroll, refreshPending };
