const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');

test('CRM browsing routes retain authentication, site scope, no-store and pagination; mark-sold exposes its confirmed result', async () => {
  const calls = [];
  const lead = {},
    panel = {};
  const user = { id: 'staff', locked_site: 'BYD Fairfield' };
  const response = {
    success: true,
    data: [{ id: 'page-two-record' }],
    pagination: { page: 2, limit: 25, total: 30, pages: 2 },
  };
  const confirmed = {
    opportunity: { opportunity_id: 'deal-on-page-two' },
    salesLogId: 'saved-log',
    deliverySyncSuccess: true,
  };
  const mocks = {
    '../middleware/auth': {
      authenticate(req, res, next) {
        if (!req.headers.authorization)
          return res.status(401).json({ success: false });
        req.user = user;
        next();
      },
      enforceSiteLock(req, res, next) {
        req.query.site = user.locked_site;
        next();
      },
      requireRole: () => (req, res, next) => next(),
    },
    '../services/crmService': {
      async markSold() {
        return confirmed;
      },
    },
    '../db': { leadConn: { db: lead }, deliveryConn: { db: panel } },
    '../services/crmBrowsing': Object.fromEntries(
      ['leads', 'pipeline', 'calendar'].map((name) => [
        name,
        async (db, query, account) => {
          calls.push({ name, db, query, account });
          return response;
        },
      ])
    ),
  };
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.resolve(__dirname, '../src/routes/crm.js'), 'utf8'),
    {
      module,
      exports: module.exports,
      require(key) {
        return Object.hasOwn(mocks, key) ? mocks[key] : require(key);
      },
    }
  );
  const app = express();
  app.use(express.json());
  app.use('/crm', module.exports);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const root = `http://127.0.0.1:${server.address().port}/crm`;
  try {
    assert.equal((await fetch(`${root}/leads`)).status, 401);
    for (const route of [
      '/leads?page=2',
      '/opportunities?browse=true&page=2',
      '/calendar?page=2&from=2026-10-01&to=2026-11-01',
    ]) {
      const result = await fetch(root + route, {
        headers: { authorization: 'test' },
      });
      assert.equal(result.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await result.json(), response);
    }
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.query.site, 'BYD Fairfield');
      assert.equal(call.query.page, '2');
      assert.equal(call.account, user);
    }
    assert.equal(calls[0].db, lead);
    assert.equal(calls[1].db, panel);
    const sold = await fetch(
      root + '/opportunities/deal-on-page-two/mark-sold',
      {
        method: 'POST',
        headers: { authorization: 'test', 'content-type': 'application/json' },
        body: '{}',
      }
    );
    const result = await sold.json();
    assert.equal(result.data.salesLogId, 'saved-log');
    assert.deepEqual(result.data.opportunity, confirmed.opportunity);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
