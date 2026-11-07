const test = require('node:test');
const assert = require('node:assert/strict');
const checks = require('../src/services/vehicleChecks');
const { SalesFloorOperations } = require('../src/services/salesFloorOperations');
const { database } = require('./helpers/floorMemory');
const user = { id: 'manager-1', name: 'Manager', role: 'sales_manager', site: 'BYD Fairfield', locked_site: 'BYD Fairfield' };
const vin = 'LGXCE4C88P0123456';
function fixture() {
  const lead = database({ leads: [{ _id: 'lead-1', dealer: user.site, customer_id: 'customer-1' }], deals: [{ _id: 'deal-1', dealId: 'DEAL-1', leadId: 'lead-1', dealer: user.site, tradeIn: { allowance: 1000 } }] });
  const panel = database({ customers: [{ customer_id: 'customer-1', site: user.site }] });
  return { lead, panel, service: new SalesFloorOperations(lead, panel) };
}
async function configured(work) {
  const names = ['NEVDIS_API_URL', 'NEVDIS_API_KEY', 'PPSR_API_URL', 'PPSR_API_KEY'], previous = names.map(name => process.env[name]);
  names.forEach(name => { process.env[name] = name.endsWith('URL') ? 'https://vehicle-provider.example.invalid/api' : 'fixture-secret'; });
  try { await work(); } finally { names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; }); }
}
const response = data => ({ ok: true, json: async () => ({ success: true, data }) });
test('vehicle providers are unavailable without an account and never generate a VIN or clearance', async () => {
  const original = process.env.NEVDIS_API_KEY; delete process.env.NEVDIS_API_KEY;
  try {
    assert.equal(checks.readiness().rego.configured, false);
    const f = fixture(); let calls = 0;
    await assert.rejects(checks.run(f.service, 'rego', { rego: 'ABC123', state: 'VIC', requestId: 'missing-provider' }, user, () => { calls++; }), error => error.statusCode === 503);
    assert.equal(calls, 0); assert.equal(f.panel.tables.get('floor_vehicle_checks'), undefined);
  } finally { if (original !== undefined) process.env.NEVDIS_API_KEY = original; }
});
test('customer/deal permission and linked VIN checks happen before a billed provider request', async () => configured(async () => {
  const f = fixture(); let calls = 0; const fetch = () => { calls++; };
  await assert.rejects(checks.run(f.service, 'ppsr', { vin, leadId: 'other-site', requestId: 'unauthorized-check' }, user, fetch), /not found/);
  f.lead.tables.get('leads')[0].tradeInVin = 'JTDKN3DU501882910';
  await assert.rejects(checks.run(f.service, 'ppsr', { vin, leadId: 'lead-1', requestId: 'wrong-vin-check' }, user, fetch), /differs/);
  await assert.rejects(checks.run(f.service, 'ppsr', { vin, leadId: 'lead-1' }, user, fetch), /stable/);
  assert.equal(calls, 0);
}));
test('live rego and PPSR results attach to customer and deal; replays never bill or reset clearance', async () => configured(async () => {
  const f = fixture(), calls = [];
  const fetch = async (url, options) => { calls.push({ url, options }); return response(options.method === 'GET' ? { vin, make: 'BYD', model: 'ATTO 3', year: 2023 } : { vin, status: 'Encumbered', certificateNumber: 'fixture-certificate' }); };
  const rego = { rego: 'abc 123', state: 'vic', leadId: 'lead-1', dealId: 'DEAL-1', requestId: 'rego-lookup-1' };
  await checks.run(f.service, 'rego', rego, user, fetch);
  assert.equal(calls[0].url.searchParams.get('rego'), 'ABC123'); assert.equal(calls[0].options.redirect, 'error');
  assert.equal(f.panel.tables.get('customers')[0].tradeInVin, vin);
  const result = await checks.run(f.service, 'ppsr', { vin, leadId: 'lead-1', dealId: 'DEAL-1', requestId: 'ppsr-search-1' }, user, fetch);
  assert.equal(result.status, 'Encumbered'); assert.equal(f.lead.tables.get('deals')[0].tradeIn.ppsrCertificate.certificateNumber, 'fixture-certificate');
  assert.equal(f.panel.tables.get('floor_vehicle_checks').length, 2); assert.equal(f.panel.tables.get('floor_vehicle_checks')[0].leadId, 'lead-1');
  await checks.run(f.service, 'rego', rego, user, fetch);
  assert.equal(calls.length, 2); assert.equal(f.lead.tables.get('leads')[0].ppsrStatus, 'Encumbered');
  assert.equal(f.panel.tables.get('customers')[0].ppsrStatus, 'Encumbered');
}));
test('sandbox results, mismatched VINs and incomplete PPSR certificates never verify a vehicle', async () => configured(async () => {
  await assert.rejects(checks.lookup('ABC123', 'VIC', async () => ({ ok: true, json: async () => ({ success: true, sandbox: true, vehicle: { vin, make: 'BYD', model: 'ATTO 3', year: 2023 } }) })), /Test results/);
  await assert.rejects(checks.ppsr(vin, async () => response({ status: 'Clear', certificateNumber: 'other-certificate', vin: 'JTDKN3DU501882910' })), /different VIN/);
  await assert.rejects(checks.ppsr(vin, async () => response({ status: 'Clear' })), /certificate reference/);
  await assert.rejects(checks.ppsr(vin, async () => response({ status: 'Unknown', certificateNumber: 'fixture-certificate' })), /recognised/);
}));
test('uncertain PPSR submissions are held without rebilling and expose Error on customer and deal', async () => configured(async () => {
  const f = fixture(); let calls = 0;
  const input = { vin, leadId: 'lead-1', dealId: 'DEAL-1', requestId: 'uncertain-ppsr-1' };
  const fetch = async () => { calls++; throw Error('connection lost'); };
  await assert.rejects(checks.run(f.service, 'ppsr', input, user, fetch), /did not confirm/);
  await assert.rejects(checks.run(f.service, 'ppsr', input, user, fetch), /already have been submitted/);
  assert.equal(calls, 1); assert.equal(f.lead.tables.get('leads')[0].ppsrStatus, 'Error');
  assert.equal(f.panel.tables.get('customers')[0].ppsrStatus, 'Error'); assert.equal(f.lead.tables.get('deals')[0].tradeIn.ppsrStatus, 'Error');
  assert.equal(f.panel.tables.get('floor_vehicle_checks'), undefined);
}));
test('a new verified rego removes the previous vehicle certificate; request IDs cannot change vehicle', async () => configured(async () => {
  const f = fixture(); f.lead.tables.get('leads')[0].ppsrCertificate = { certificateNumber: 'old' };
  const input = { rego: 'ABC123', state: 'VIC', leadId: 'lead-1', requestId: 'reused-rego-id' };
  await checks.run(f.service, 'rego', input, user, async () => response({ vin, make: 'BYD', model: 'ATTO 3', year: 2023 }));
  assert.equal(f.lead.tables.get('leads')[0].ppsrCertificate, undefined);
  await assert.rejects(checks.run(f.service, 'rego', { ...input, rego: 'XYZ987' }, user), /already been used/);
}));
test('a direct VIN check attaches to imported records with null trade-in data', async () => configured(async () => {
  const f = fixture(); f.lead.tables.get('leads')[0].tradeIn = null; f.lead.tables.get('deals')[0].tradeIn = null; f.panel.tables.get('customers')[0].tradeIn = null;
  await checks.run(f.service, 'ppsr', { vin, leadId: 'lead-1', dealId: 'DEAL-1', requestId: 'imported-vin-check' }, user, async () => response({ vin, status: 'Clear', certificateNumber: 'fixture-certificate' }));
  assert.equal(f.panel.tables.get('customers')[0].tradeIn.vin, vin);
  assert.equal(f.lead.tables.get('deals')[0].tradeIn.ppsrStatus, 'Clear');
}));
