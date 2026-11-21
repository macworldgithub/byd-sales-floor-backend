const { siteKey, canonicalSite } = require('./accountAccess');
const p = require('./salesFloorPolicy');
const { dayStart } = require('./crmBrowsing');
const { ReadCache } = require('./readCache');
const caches = new WeakMap();
const text = value => value == null ? '' : String(value).trim();
const CANCELLED = /^(cancelled|canceled|lost|lost \/ parked|void|voided|refunded)$/i;
const SOLD = /^(written|written \/ sold|sold|signed|contract signed|in delivery|delivered|delivered \/ won|won \/ delivered|completed)$/i;
function date(value) {
  if (!value) return null;
  if(typeof value==='string')value=value.trim();
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    try { return dayStart(value); } catch { return null; }
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
function scope(user, query, fields) {
  const filter = p.scope(user, query, fields);
  if (!p.isManager(user)) filter.$and[1].$or.push(
    { consultant_name: p.exact(user.name) }, { user_name: p.exact(user.name) }, { user_id: user.id }, { consultant_id: user.id },
  );
  return filter;
}
const site = (row, source) => source === 'native' ? row.dealer || row.site || row.dealership || ''
  : source === 'delivery' ? row.site_location || row.site || row.location || row.dealer || '' : row.site || row.location || row.dealer || '';
function identity(row, source) {
  const prefix = siteKey(site(row,source)) + ':';
  const result = [];
  const add = (kind, value) => { if (text(value) && !/^(n\/?a|none|null|tba|pending|factory order|unknown|[-]+|0)$/i.test(text(value))) result.push(prefix + kind + ':' + text(value)); };
  add(source, row._id);
  for (const key of ['opportunity_id', 'crm_opportunity_id']) add('opportunity', row[key]);
  add('saleslog', row.sales_log_id);
  for (const key of ['delivery_client_id', 'deliveryClientId']) add('delivery', row[key]);
  add('delivery',row.delivery?.deliveryClientId);
  if (source === 'delivery') { add('delivery', row._id); add('delivery', row.id); }
  add('native', row.dealId); add('native', row.native_deal_id);
  // Dealer Studio imports historically reused vy_order_id for a different ID
  // namespace. Only explicit record links may join those to Virtual Yard orders.
  const order = row.vy_order_id || row.virtualYard?.virtualYardOrderId;
  if (row.dealerstudio_source_id) add('dealerstudio-order', row.dealerstudio_source_id);
  else add('vy-order', order);
  return [...new Set(result)];
}
function candidate(row, source) {
  const state = text(row.status || row.stage), cancelled = CANCELLED.test(state) || CANCELLED.test(text(row.stage));
  const firstDate = (...values) => values.map(date).find(Boolean) || null;
  const signed = firstDate(row.contractSignedAt, row.contract_signed_at), soldAt = firstDate(row.sold_at, row.written_at);
  const at = signed || soldAt || firstDate(row.deal_date, row.order_date);
  const confirmed = source === 'native' ? !!signed || SOLD.test(state)
    : source === 'opportunity' ? SOLD.test(text(row.stage))
    : source === 'saleslog' ? !state || SOLD.test(state)
    : !!at || SOLD.test(text(row.stage));
  if ((!confirmed && !cancelled) || !siteKey(site(row,source))) return null;
  return { row, keys: identity(row, source), site: siteKey(site(row,source)), cancelled, confirmed, at,
    siteName: canonicalSite(site(row,source)) || site(row,source), model: row.model || row.vehicle_model || (typeof row.vehicle === 'object' ? row.vehicle?.model : row.vehicle) || '',
    // Prefer actual signature/sold timestamps over legacy day-only order dates.
    priority: signed ? 0 : soldAt ? 1 : 2,
    leadIds: [row.leadId, row.lead_prospect_id].map(text).filter(Boolean), customerId: text(row.crm_customer_id || row.customer_id || row.customerId) };
}
function reconcile(sources, customers = []) {
  const customerLinks = new Map(customers.map(row => [siteKey(site(row)) + ':' + text(row.customer_id), text(row.lead_prospect_id)]));
  const records = sources.flatMap(([source, rows]) => rows.map(row => candidate(row, source)).filter(Boolean));
  const parents = records.map((_, index) => index), keys = new Map();
  const root = index => { while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; } return index; };
  records.forEach((record, index) => {
    const linked = customerLinks.get(record.site + ':' + record.customerId);
    if (linked) record.leadIds.push(linked);
    for (const key of record.keys) { if (keys.has(key)) parents[root(index)] = root(keys.get(key)); else keys.set(key, index); }
  });
  const groups = new Map();
  records.forEach((record, index) => { const key = root(index); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(record); });
  const sales = [], cancelledIds = new Set();
  for (const group of groups.values()) {
    const leadIds = [...new Set(group.flatMap(row => row.leadIds))];
    if (group.some(row => row.cancelled)) { leadIds.forEach(value => cancelledIds.add(value)); continue; }
    const eligible = group.filter(row => row.confirmed), dated = eligible.filter(row => row.at).sort((a,b) => a.priority - b.priority || a.at - b.at);
    if (!eligible.length) continue;
    sales.push({ confirmed: true, contractSignedAt: dated[0]?.at || null, leadIds, site: eligible[0].siteName,
      vehicle: { model: eligible.find(row => row.model)?.model || 'Unknown' } });
  }
  const soldIds = new Set(sales.flatMap(row => row.leadIds));
  return { sales, cancelledLeadIds: [...cancelledIds].filter(value => !soldIds.has(value)),
    quality: { undatedSales: sales.filter(row => !row.contractSignedAt).length, unlinkedSales: sales.filter(row => !row.leadIds.length).length } };
}
async function read(lead, panel, query, user, options = {}) {
  const filters = { native: scope(user, query, ['dealer','site','dealership']), crm: scope(user, query, ['site','location','dealer']), delivery: scope(user, query, ['site_location','site','location','dealer']) };
  let cache = caches.get(panel);
  if (!cache) { cache = new ReadCache({ ttl: 15000, maxEntries: 64, maxBytes: 2 * 1024 * 1024 }); caches.set(panel, cache); }
  const window = options.bounds ? { from: options.bounds.from.toISOString().slice(0,10), to: new Date(options.bounds.to.getTime()+86400000).toISOString().slice(0,10) } : null;
  const key = JSON.stringify({filters,window,linkedOnly:!!options.linkedOnly}, (_, value) => value instanceof RegExp ? { source: value.source, flags: value.flags } : value);
  return cache.read(key, async () => {
    const projection = Object.fromEntries(['_id','id','dealId','native_deal_id','site','dealer','site_location','location','dealership','status','stage','contractSignedAt','contract_signed_at',
      'sold_at','written_at','deal_date','order_date','leadId','lead_prospect_id','customer_id','customerId','crm_customer_id','opportunity_id','crm_opportunity_id','sales_log_id','delivery_client_id','deliveryClientId','delivery.deliveryClientId','vy_order_id','dealerstudio_source_id','virtualYard.virtualYardOrderId','model','vehicle_model','vehicle'].map(field => [field,1]));
    const [native, opportunities, logs] = await Promise.all([
      lead.collection('deals').find(filters.native,{projection}).toArray(), panel.collection('opportunities').find(filters.crm,{projection}).toArray(),
      panel.collection('saleslogentries').find(filters.crm,{projection}).toArray(),
    ]);
    const related = [...native,...opportunities,...logs];
    const references = (fields) => [...new Set(related.flatMap(row=>fields.map(field=>field==='virtualYardOrderId'?row.virtualYard?.virtualYardOrderId:field==='nestedDeliveryId'?row.delivery?.deliveryClientId:row[field])).map(text).filter(Boolean))];
    const populated = field => ({$and:[{[field]:{$exists:true}},{[field]:{$nin:[null,'']}}]});
    const links = ['leadId','lead_prospect_id','crm_customer_id','crm_opportunity_id','native_deal_id'].map(populated);
    const clientsIds=references(['delivery_client_id','deliveryClientId','nestedDeliveryId']);
    const orders=references(['vy_order_id','virtualYardOrderId']);
    if(clientsIds.length){
      const {ObjectId}=require('mongoose').mongo;
      links.push({id:{$in:clientsIds}}, {_id:{$in:[...clientsIds,...clientsIds.filter(value=>/^[a-f\d]{24}$/i.test(value)).map(value=>new ObjectId(value))]}});
    }
    if(orders.length)links.push({vy_order_id:{$in:orders}});
    let clientFilter=filters.delivery;
    if(window){
      const convert=field=>({$convert:{input:'$'+field,to:'date',onError:null,onNull:null}});
      const undated={$expr:{$and:[{$not:[{$ne:[convert('order_date'),null]}]},{$not:[{$ne:[convert('contractSignedAt'),null]}]}]}};
      clientFilter={$and:[clientFilter,{$or:[...links,
        {order_date:{$gte:window.from,$lt:window.to}},
        {order_date:{$gte:options.bounds.from,$lte:options.bounds.to}},
        {contractSignedAt:{$gte:options.bounds.from,$lte:options.bounds.to}},
        {$and:[{stage:{$in:['Delivered','Delivered / Won']}},undated]},
        {stage:{$in:['Cancelled','Canceled','Lost','Lost / Parked']}},
      ]}]};
    }else if(options.linkedOnly)clientFilter={$and:[clientFilter,{$or:links}]};
    const clients=await panel.collection('clients').find(clientFilter,{projection}).toArray();
    const ids = [...new Set([...native,...opportunities,...logs,...clients].map(row => text(row.crm_customer_id || row.customer_id || row.customerId)).filter(Boolean))];
    const customers = ids.length ? await panel.collection('customers').find({ $and: [filters.crm.$and[0], { customer_id: { $in: ids } }] },
      { projection: { customer_id:1, lead_prospect_id:1, site:1, dealer:1 } }).toArray() : [];
    return reconcile([['native',native],['opportunity',opportunities],['saleslog',logs],['delivery',clients]],customers);
  });
}
async function monthlyTarget(panel, query, user, month) {
  const filter = scope(user, query, ['site']);
  const [native, legacy] = await Promise.all([
    panel.collection('crmtargets').find({ $and: [filter, { period: month }] }).toArray(),
    panel.collection('targets').find({ $and: [filter, { $or: [{month}, {period: month}] }] }).toArray(),
  ]);
  const values = new Map();
  for (const row of [...native,...legacy]) {
    const raw = row.targetUnits ?? row.target_units ?? row.unit_target;
    if (raw === '' || raw == null || !Number.isFinite(Number(raw)) || Number(raw) < 0) continue;
    const key = siteKey(row.site) + ':' + text(row.consultant || row.consultant_name || row.user_name || row.user_id).toLowerCase();
    if (!values.has(key)) values.set(key,Number(raw));
  }
  return values.size ? [...values.values()].reduce((sum,value)=>sum+value,0) : null;
}
module.exports = { read, reconcile, date, scope, monthlyTarget };
