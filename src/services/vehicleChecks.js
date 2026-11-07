const { fail } = require('./accountAccess');
const { sha } = require('./salesFloorMobile');
const VIN = /^[A-HJ-NPR-Z0-9]{17}$/i;
const tradeData = (existing, patch) => ({ ...(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}), ...patch });
function configuration(kind) {
  const prefix = kind === 'rego' ? 'NEVDIS' : 'PPSR';
  const base = process.env[`${prefix}_API_URL`], key = process.env[`${prefix}_API_KEY`];
  if (!base || !key) return { configured: false, reason: 'A vehicle-data provider account, API URL and server API key are required.' };
  try {
    const url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error();
    return { configured: true, url, key };
  } catch { return { configured: false, reason: 'Provider base URL must be HTTPS without embedded credentials, query or fragment.' }; }
}
function readiness() {
  return Object.fromEntries(['rego', 'ppsr'].map(kind => { const config = configuration(kind); return [kind, { configured: config.configured, reason: config.reason || null, liveValidated: false }]; }));
}
async function provider(kind, payload, fetchImpl = fetch) {
  const config = configuration(kind);
  if (!config.configured) fail(503, `${kind === 'rego' ? 'Rego-to-VIN' : 'PPSR'}: ${config.reason} No verified result is available.`);
  const { url, key } = config;
  if (kind === 'rego') { url.pathname = url.pathname.replace(/\/$/, '') + '/lookup'; url.search = new URLSearchParams(payload).toString(); }
  else url.pathname = url.pathname.replace(/\/$/, '') + '/search';
  let response;
  try { response = await fetchImpl(url, { method: kind === 'rego' ? 'GET' : 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, redirect: 'error',
    ...(kind === 'rego' ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(20000) }); }
  catch { fail(502, 'Vehicle provider did not confirm this request. Check its status before creating another paid search.'); }
  if (!response.ok) fail(502, 'Vehicle verification provider failed. Retry the check; no clearance has been assumed.');
  let json;
  try { json = await response.json(); } catch { fail(502, 'Vehicle provider returned an invalid response.'); }
  const result = json?.vehicle || json?.data || json;
  if (json?.success !== true || json.sandbox || json.simulated || result?.sandbox || result?.simulated || /simulat|sandbox|fixture/i.test(String(json.source || result?.source || ''))) fail(502, 'Live vehicle verification was not confirmed. Test results cannot verify a customer vehicle.');
  return result;
}
async function lookup(rego, state, fetchImpl) {
  const plate = String(rego || '').toUpperCase().replace(/\s/g, '');
  if (!/^[A-Z0-9]{2,10}$/.test(plate) || !['VIC', 'NSW', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT'].includes(state)) fail(400, 'Enter a valid registration plate and state.');
  const vehicle = await provider('rego', { rego: plate, state }, fetchImpl);
  if (typeof vehicle.vin !== 'string' || !VIN.test(vehicle.vin) || [vehicle.make, vehicle.model].some(text => typeof text !== 'string' || !text.trim() || text.length > 120) || !Number.isInteger(Number(vehicle.year)) || Number(vehicle.year) < 1886 || Number(vehicle.year) > new Date().getFullYear() + 2) fail(502, 'Provider did not return a complete vehicle identity.');
  if ((vehicle.rego && String(vehicle.rego).toUpperCase().replace(/\s/g, '') !== plate) || (vehicle.state && vehicle.state !== state)) fail(502, 'Vehicle provider returned a different registration or state.');
  return { rego: plate, state, vin: vehicle.vin.toUpperCase(), make: vehicle.make.trim(), model: vehicle.model.trim(), year: Number(vehicle.year), colour: typeof vehicle.colour === 'string' ? vehicle.colour.slice(0, 100) : '', ppsrStatus: 'Pending', verified: true, verifiedAt: new Date() };
}
async function ppsr(vin, fetchImpl) {
  if (!VIN.test(vin)) fail(400, 'Enter a valid 17-character VIN.');
  const result = await provider('ppsr', { vin: vin.toUpperCase() }, fetchImpl);
  if (!['Clear', 'Encumbered', 'Error'].includes(result.status)) fail(502, 'Provider did not return a recognised PPSR status.');
  if (result.status === 'Error') fail(502, result.message || 'PPSR check returned an error.');
  const certificate = result.certificateNumber || result.searchCertificateNumber;
  if (!['string', 'number'].includes(typeof certificate) || !/^[A-Za-z0-9_-]{1,100}$/.test(String(certificate))) fail(502, 'PPSR provider did not return a certificate reference.');
  if (result.vin && String(result.vin).toUpperCase() !== vin.toUpperCase()) fail(502, 'PPSR certificate belongs to a different VIN.');
  // Keep provider fields explicitly; never copy arbitrary keys into Mongo updates.
  return { status: result.status, certificateNumber: String(certificate),
    ...(result.certificateUrl && require('./floorJourney').httpsUrl(result.certificateUrl) ? { certificateUrl: result.certificateUrl } : {}),
    vin: vin.toUpperCase(), checkedAt: new Date(), verified: true };
}
async function store(service, result, type, input, user) {
  const site = service.site(user, input.site);
  const key = input.requestId ? sha(`vehicle:${user.id}:${input.requestId}`) : sha(`${user.id}:${type}:${result.vin}:${Date.now()}`);
  const check = { ...result, _id: key, type, site, owner_user_id: user.id, createdAt: new Date(), ...(input.leadId ? { leadId: String(input.leadId) } : {}), ...(input.dealId ? { dealId: String(input.dealId) } : {}) };
  let lead;
  if (input.leadId) lead = await service.record('leads', input.leadId, user);
  let deal;
  if (input.dealId) { deal = await service.record('deals', input.dealId, user); lead = await service.record('leads', deal.leadId, user); }
  await service.panel.collection('floor_vehicle_checks').updateOne({ _id: key }, { $setOnInsert: check }, { upsert: true });
  if (lead) {
    const patch = type === 'rego' ? { tradeInRego: result.rego, tradeInVin: result.vin, tradeIn: { ...result }, ppsrStatus: 'Pending' } : { tradeInVin: result.vin, tradeIn: tradeData(lead.tradeIn, { vin: result.vin, ppsrStatus: result.status }), ppsrStatus: result.status, ppsrCertificate: { ...result, checkId: key } };
    const update = { $set: patch, ...(type === 'rego' ? { $unset: { ppsrCertificate: '' } } : {}) };
    await service.lead.collection('leads').updateOne({ _id: lead._id }, update);
    const customerId = lead.customerId || lead.customer_id;
    if (customerId) {
      const customer = await service.panel.collection('customers').findOne({ customer_id: customerId });
      await service.panel.collection('customers').updateOne({ customer_id: customerId }, type === 'rego' ? update : { $set: { ...patch, tradeIn: tradeData(customer?.tradeIn || lead.tradeIn, { vin: result.vin, ppsrStatus: result.status }) } });
    }
    if (deal) await service.lead.collection('deals').updateOne({ _id: deal._id }, { $set: { tradeIn: type === 'rego' ? { allowance: deal.tradeIn?.allowance || 0, ...result } : tradeData(deal.tradeIn, { vin: result.vin, ppsrStatus: result.status, ppsrCertificate: { ...result, checkId: key } }) } });
    await service.event(lead, user, type === 'rego' ? 'Vehicle identified' : 'PPSR checked', type === 'rego' ? `${result.rego} → ${result.vin}` : `${result.status} · certificate ${result.certificateNumber || result.searchCertificateNumber}`);
  }
  return { ...result, checkId: key };
}
async function run(service, type, input, user, fetchImpl) {
  if (!/^[\w-]{8,100}$/.test(String(input.requestId || ''))) fail(400, 'A stable vehicle-check request ID is required.');
  let lead = input.leadId ? await service.record('leads', input.leadId, user) : null;
  const deal = input.dealId ? await service.record('deals', input.dealId, user) : null;
  if (deal) {
    const dealLead = await service.record('leads', deal.leadId, user);
    if (lead && String(lead._id) !== String(dealLead._id)) fail(409, 'Choose the customer attached to this deal.');
    lead = dealLead;
  }
  const site = service.site(user, lead?.dealer || lead?.site || input.site);
  const vin = String(input.vin || '').trim().toUpperCase(), rego = String(input.rego || '').toUpperCase().replace(/\s/g, ''), state = String(input.state || 'VIC').toUpperCase();
  if (type === 'ppsr' && !VIN.test(vin)) fail(400, 'Enter a valid 17-character VIN.');
  if (type === 'rego' && (!/^[A-Z0-9]{2,10}$/.test(rego) || !['VIC', 'NSW', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT'].includes(state))) fail(400, 'Enter a valid registration plate and state.');
  if (type === 'ppsr' && [deal?.tradeIn?.vin, lead?.tradeInVin].some(known => known && String(known).toUpperCase() !== vin)) fail(409, 'This VIN differs from the linked trade-in. Look up the correct registration first.');
  const key = sha(`vehicle:${user.id}:${input.requestId}`), fingerprint = sha(JSON.stringify({ type, vin: type === 'ppsr' ? vin : null, rego: type === 'rego' ? rego : null, state: type === 'rego' ? state : null, site, leadId: String(lead?._id || ''), dealId: String(deal?._id || '') }));
  const requests = service.panel.collection('floor_vehicle_requests'), previous = await requests.findOne({ _id: key });
  if (previous && previous.fingerprint !== fingerprint) fail(409, 'This vehicle-check request ID has already been used.');
  const canonical = { ...input, site, ...(lead ? { leadId: String(lead._id) } : {}) };
  if (previous?.state === 'completed') {
    if (previous.attached) return { ...previous.result, checkId: key };
    const saved = await store(service, previous.result, type, canonical, user);
    await requests.updateOne({ _id: key }, { $set: { attached: true } });
    return saved;
  }
  if (previous) fail(409, 'This vehicle check may already have been submitted. Review provider history before starting another paid check.');
  if (!configuration(type).configured) fail(503, configuration(type).reason);
  try { await requests.insertOne({ _id: key, fingerprint, type, site, owner_user_id: user.id, state: 'sending', createdAt: new Date() }); }
  catch (error) { if (error.code === 11000) fail(409, 'This vehicle check is already in progress.'); throw error; }
  let result;
  try {
    result = type === 'rego' ? await lookup(rego, state, fetchImpl) : await ppsr(vin, fetchImpl);
    await requests.updateOne({ _id: key }, { $set: { state: 'completed', result, completedAt: new Date() } });
  } catch (error) {
    await requests.updateOne({ _id: key }, { $set: { state: 'unknown', error: error.message } });
    if (lead && type === 'ppsr') {
      const patch = { ppsrStatus: 'Error' };
      await service.lead.collection('leads').updateOne({ _id: lead._id }, { $set: patch });
      if (lead.customerId || lead.customer_id) await service.panel.collection('customers').updateOne({ customer_id: lead.customerId || lead.customer_id }, { $set: patch });
      if (deal) await service.lead.collection('deals').updateOne({ _id: deal._id }, { $set: { tradeIn: tradeData(deal.tradeIn, { ppsrStatus: 'Error' }) } });
    }
    throw error;
  }
  const saved = await store(service, result, type, canonical, user);
  await requests.updateOne({ _id: key }, { $set: { attached: true } });
  return saved;
}
module.exports = { lookup, ppsr, store, run, readiness, VIN };
