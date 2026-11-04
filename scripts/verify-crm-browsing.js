// Read-only smoke checks against configured databases; prints counts, never contacts.
const assert = require('node:assert/strict');
const path = require('node:path');
const { MongoClient } = require('mongoose').mongo;

async function main(browse = require('../src/services/crmBrowsing')) {
  const clients = [
    process.env.LEAD_CENTER_MONGO_URI,
    process.env.DELIVERY_CENTER_MONGO_URI,
  ].map((uri) => new MongoClient(uri, { serverSelectionTimeoutMS: 15000 }));
  try {
    await Promise.all(clients.map((client) => client.connect()));
    const lead = clients[0].db(),
      panel = clients[1].db();
    const report = {};
    for (const [name, run] of [
      ['leads', (query) => browse.leads(lead, query)],
      ['pipeline', (query) => browse.pipeline(panel, query)],
    ]) {
      const first = await run({ page: 1, limit: 10 });
      const second = await run({ page: 2, limit: 10 });
      assert.equal(first.pagination.total, second.pagination.total);
      if (first.pagination.pages > 1)
        assert.ok(
          !first.data.some((a) =>
            second.data.some((b) => String(a._id) === String(b._id))
          )
        );
      const last = await run({ page: 999999, limit: 10 });
      assert.equal(last.pagination.page, last.pagination.pages);
      report[name] = {
        total: first.pagination.total,
        page2: second.pagination.page,
        lastPage: last.pagination.page,
      };
    }
    const scoped = await browse.leads(
      lead,
      { site: 'Denza Melbourne', limit: 100 },
      { locked_site: 'BYD Fairfield' }
    );
    assert.ok(
      scoped.data.every((row) =>
        /^(BYD )?Fairfield$/i.test(row.dealer || row.site || '')
      )
    );
    const filtered = await browse.leads(lead, {
      platform: 'virtualyard',
      stage: 'NEW ENQUIRIES',
      q: '[',
      limit: 10,
    });
    assert.ok(
      filtered.data.every(
        (row) => row.platform === 'virtualyard' && row.stage === 'NEW ENQUIRIES'
      )
    );
    const query = { from: '2026-10-01', to: '2026-11-01', page: 1, limit: 10 };
    const events = await browse.calendar({ lead, panel }, query);
    const next = await browse.calendar({ lead, panel }, { ...query, page: 2 });
    if (events.pagination.pages > 1)
      assert.ok(!events.data.some((a) => next.data.some((b) => a.id === b.id)));
    assert.ok(
      events.data.every(
        (event) => event.dateStr >= query.from && event.dateStr < query.to
      )
    );
    const followups = await browse.calendar(
      { lead, panel },
      { ...query, category: 'followup' }
    );
    assert.ok(followups.data.every((event) => event.type === 'followup'));
    const empty = await browse.calendar(
      { lead, panel },
      { from: '2099-01-01', to: '2099-02-01' }
    );
    assert.equal(empty.pagination.total, 0);
    report.calendar = {
      total: events.pagination.total,
      page2: next.pagination.page,
      followups: followups.pagination.total,
    };
    console.log(JSON.stringify({ passed: true, report }));
    return report;
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
}
module.exports = { main };
if (require.main === module) {
  require('dotenv').config({
    path: path.resolve(__dirname, '../.env'),
    quiet: true,
  });
  main().catch((error) => {
    console.error(`${error.name}: ${error.message}`);
    process.exitCode = 1;
  });
}
