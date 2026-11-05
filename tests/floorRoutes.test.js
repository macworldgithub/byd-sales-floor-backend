const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const { calendarIcs } = require('../src/services/floorBrowsing');

test('Floor endpoints require the right platform, prevent shared caching and export every matching page', async () => {
  let account = { role: 'agent', platform: 'sales_floor', platform_access: ['sales_floor'], locked_site: 'BYD Nunawading' };
  const calls = [];
  const event = id => ({ id, date: '2026-11-05T23:00:00Z', endsAt: '2026-11-05T23:45:00Z', title: id });
  const service = { calendarIcs };
  for (const name of ['leads', 'today', 'calendar']) service[name] = async (db, query, user) => {
    calls.push({ name, query, user });
    return { success: true, data: query.page === 2 ? [event('last-event')] : [event('first-event')], pagination: { pages: 2, page: Number(query.page || 1) } };
  };
  const filename = path.resolve(__dirname, '../src/routes/floor.js');
  const fixture = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: fixture, require(key) {
    if (key === 'express') return express;
    if (key === '../db') return { leadConn: { db: {} }, deliveryConn: { db: {} } };
    if (key === '../services/floorBrowsing') return service;
    if (key === '../middleware/auth') return { authenticate(req, res, next) { if (!req.headers.authorization) return res.sendStatus(401); req.user = account; next(); } };
    throw Error(key);
  } });
  const app = express(); app.use('/api/floor', fixture.exports);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/floor`;
  const headers = { Authorization: 'Bearer fixture' };
  try {
    assert.equal((await fetch(base + '/leads')).status, 401);
    for (const route of ['leads', 'today', 'calendar']) {
      const response = await fetch(base + '/' + route + '?page=2', { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(calls.at(-1).user.locked_site, 'BYD Nunawading');
    }
    const response = await fetch(base + '/calendar.ics', { headers });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.ok(body.includes('first-event') && body.includes('last-event'));
    account = { ...account, platform: 'crm', platform_access: ['crm'] };
    assert.equal((await fetch(base + '/leads', { headers })).status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
