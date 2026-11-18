const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const express = require("express");
const { ObjectId } = require("mongoose").mongo;
const { database } = require("./helpers/floorMemory");
async function fixture(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "byd-appraisal-http-"));
  process.env.APPRAISAL_MEDIA_DIR = dir;
  process.env.APPRAISAL_WEB_URL = "https://sales-floor.example.invalid";
  const user = {
    id: "staff-1",
    name: "Salesperson",
    email: "staff@example.invalid",
    role: "sales_consultant",
    site: "BYD Fairfield",
    locked_site: "BYD Fairfield",
    allowed_sites: ["BYD Fairfield"],
  };
  const manager = { ...user, id: "manager-1", role: "sales_manager" },
    globalManager = { ...manager, id: 'global-manager', all_sites: true, site: 'BYD Nunawading', locked_site: '', allowed_sites: [] },
    other = {
      ...user,
      site: "BYD Nunawading",
      locked_site: "BYD Nunawading",
      allowed_sites: ["BYD Nunawading"],
    },
    otherManager = { ...other, id:'other-manager', role:'sales_manager' },
    leadId = new ObjectId();
  const lead = database({
    leads: [
      {
        _id: leadId,
        name: "Private Customer",
        phone: "+61400000000",
        email: "private@example.invalid",
        dealer: user.site,
        owner_user_id: user.id,
        assignedTo: user.email,
        customerId: "CUS-1",
      },
    ],
  });
  const panel = database({
    customers: [
      {
        customer_id: "CUS-1",
        name: "Private Customer",
        phone: "+61400000000",
        site: user.site,
      },
    ],
  });
  const cache = {};
  function load(name) {
    if (cache[name]) return cache[name];
    const file = path.resolve(__dirname, `../src/routes/${name}.js`),
      localRequire = createRequire(file),
      module = { exports: {} };
    const mocks = {
      "../db": { leadConn: { db: lead }, deliveryConn: { db: panel } },
      "../middleware/auth": {
        authenticate(req, res, next) {
          const token = req.headers.authorization;
          const account =
            token === "Bearer manager"
              ? manager
              : token === 'Bearer global'
                ? globalManager
              : token === 'Bearer other-manager'
                ? otherManager
              : token === "Bearer user"
                ? user
                : token === "Bearer other"
                  ? other
                  : null;
          if (!account) return res.status(401).json({ success: false });
          req.user = account;
          next();
        },
      },
    };
    vm.runInNewContext(fs.readFileSync(file, "utf8"), {
      module,
      require: (key) =>
        key === "./appraisals"
          ? load("appraisals")
          : Object.hasOwn(mocks, key)
            ? mocks[key]
            : localRequire(key),
      process,
      Buffer,
      console,
    });
    cache[name] = module.exports;
    return module.exports;
  }
  const app = express();
  app.use(express.json());
  app.use("/api/appraisals", load("appraisals"));
  app.use("/api/appraisal-bids", load("appraisalBids"));
  app.use((error, req, res, next) =>
    res
      .status(error.statusCode || 500)
      .json({ success: false, message: error.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  async function request(
    route,
    { method = "GET", body, token = "user", headers = {} } = {},
  ) {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api${route}`,
      {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body && !Buffer.isBuffer(body)
            ? { "Content-Type": "application/json" }
            : {}),
          ...headers,
        },
        ...(body
          ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }
          : {}),
      },
    );
    return {
      status: response.status,
      headers: response.headers,
      body: response.headers.get("content-type")?.includes("application/json")
        ? await response.json()
        : Buffer.from(await response.arrayBuffer()),
    };
  }
  try {
    await run({ request, lead, panel, leadId: String(leadId) });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.APPRAISAL_MEDIA_DIR;
    delete process.env.APPRAISAL_WEB_URL;
    delete process.env.IAPPRAISE_ARCHIVE_DIR;
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
test('all-site appraisal requests honour the selected site for creation, details and historical attachments without widening account locks', async () =>
  fixture(async ({ request, leadId, panel, lead }) => {
    const selected = { 'X-Site': 'BYD Fairfield' };
    const created = await request('/appraisals', { method:'POST',token:'global',headers:selected,body:{leadId,requestId:'global-selected-site'} });
    assert.equal(created.status,200);assert.equal(created.body.data.site,'BYD Fairfield');
    const route='/appraisals/'+created.body.data.appraisalId;
    await lead.collection('appraisals').insertOne({...created.body.data,_id:new ObjectId(),appraisalId:'APP-OTHER-SITE',site:'BYD Nunawading'});
    assert.equal((await request(route,{token:'global',headers:selected})).status,200);
    assert.equal((await request(route,{token:'global',headers:{'X-Site':'BYD Nunawading'}})).status,404);
    assert.equal((await request(route,{token:'global',headers:{'X-Site':'All Sites'}})).status,200);
    assert.equal((await request(route,{token:'manager',headers:{'X-Site':'All Sites'}})).status,200);
    const otherRoute='/appraisals?site=BYD%20Nunawading';
    const lockedList=(await request(otherRoute,{token:'manager',headers:{'X-Site':'BYD Nunawading'}})).body;
    assert.equal(lockedList.pagination.total,1);assert.equal(lockedList.data[0].site,'BYD Fairfield');
    assert.equal((await request('/appraisals/APP-OTHER-SITE',{token:'manager',headers:{'X-Site':'BYD Nunawading'}})).status,404);
    assert.equal((await request(route,{token:'global',headers:{'X-Site':'unknown'}})).status,400);
    const bytes=Buffer.from('preserved source bytes'),filename=require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    process.env.IAPPRAISE_ARCHIVE_DIR=process.env.APPRAISAL_MEDIA_DIR;
    await fsp.writeFile(path.join(process.env.IAPPRAISE_ARCHIVE_DIR,filename),bytes);
    await panel.collection('iappraise_archive').insertOne({_id:'archived-fairfield',kind:'appraisal',site:'BYD Fairfield',media:[{id:'source-photo',filename,bytes:bytes.length,contentType:'application/octet-stream'}]});
    const media='/appraisals/archive/archived-fairfield/media/source-photo';
    assert.deepEqual((await request(media,{token:'global',headers:selected})).body,bytes);
    assert.equal((await request(media,{token:'global',headers:{'X-Site':'BYD Nunawading'}})).status,404);
    assert.equal((await request(media,{token:'global',headers:{'X-Site':'All Sites'}})).status,200);
    assert.equal((await request(media,{token:'other-manager',headers:{'X-Site':'BYD Fairfield'}})).status,404);
  }));
test("appraisal HTTP routes authenticate all workspace reads and persist raw private evidence with scoped range downloads", async () =>
  fixture(async ({ request, leadId }) => {
    for (const route of [
      "/appraisals",
      "/appraisals/metadata",
      "/appraisals/partners",
      "/appraisals/media/123",
    ])
      assert.equal((await request(route, { token: null })).status, 401);
    const created = await request("/appraisals", {
      method: "POST",
      body: {
        leadId,
        requestId: "http-create-request",
        customerName: "Forged",
        site: "BYD Nunawading",
      },
    });
    assert.equal(created.status, 200);
    const row = created.body.data;
    assert.equal(row.customerName, "Private Customer");
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=",
      "base64",
    );
    const upload = await request(
      `/appraisals/${row.appraisalId}/media?purpose=inspection&shot=Front&name=front.png`,
      { method: "POST", body: bytes, headers: { "Content-Type": "image/png" } },
    );
    assert.equal(upload.status, 200);
    const mediaId = upload.body.data.media[0].id;
    const file = await request(`/appraisals/media/${mediaId}`);
    assert.equal(file.status, 200);
    assert.deepEqual(file.body, bytes);
    assert.equal(file.headers.get("cache-control"), "private, no-store");
    const range = await request(`/appraisals/media/${mediaId}`, {
      headers: { Range: "bytes=0-7" },
    });
    assert.equal(range.status, 206);
    assert.deepEqual(range.body, bytes.subarray(0, 8));
    assert.equal(
      (await request(`/appraisals/media/${mediaId}`, { token: "other" }))
        .status,
      404,
    );
    assert.equal(
      (
        await request(`/appraisals/${row.appraisalId}`, {
          method: "PATCH",
          body: { revision: 0, notes: "stale" },
        })
      ).status,
      409,
    );
  }));
test("external valuation HTTP endpoints use recipient tokens and cannot retrieve customer identity or private documents", async () =>
  fixture(async ({ request, leadId, lead, panel }) => {
    const created = await request("/appraisals", {
        method: "POST",
        body: { leadId, requestId: "http-wholesale-request" },
      }),
      row = created.body.data;
    lead.collection("appraisals").rows[0].status = "Completed";
    lead.collection("appraisals").rows[0].media = [
      { id: "private-licence", purpose: "licence" },
    ];
    const contact = await request("/appraisals/partners", {
      method: "POST",
      token: "manager",
      body: {
        name: "Buyer",
        email: "buyer@example.invalid",
        site: "BYD Fairfield",
        kind: "wholesaler",
      },
    });
    assert.equal(contact.status, 200);
    const invitation = await request(
      `/appraisals/${row.appraisalId}/invitations`,
      {
        method: "POST",
        token: "manager",
        body: {
          partnerIds: [contact.body.data._id],
          expiresAt: new Date(Date.now() + 3600000),
        },
      },
    );
    assert.equal(invitation.status, 200);
    const link = invitation.body.data[0],
      secret = new URL(link.url).hash.slice(1),
      headers = { "X-Appraisal-Token": secret };
    assert.equal(
      (await request(`/appraisal-bids/${link.id}`, { token: null })).status,
      404,
    );
    const shared = await request(`/appraisal-bids/${link.id}`, {
      token: null,
      headers,
    });
    assert.equal(shared.status, 200);
    assert.equal(
      JSON.stringify(shared.body).includes("Private Customer"),
      false,
    );
    assert.equal(
      JSON.stringify(shared.body).includes("private-licence"),
      false,
    );
    assert.equal(
      (
        await request(`/appraisal-bids/${link.id}/media/private-licence`, {
          token: null,
          headers,
        })
      ).status,
      404,
    );
    const bid = await request(`/appraisal-bids/${link.id}`, {
      method: "POST",
      token: null,
      headers,
      body: { revision: 0, amount: 25000, notes: "Offer" },
    });
    assert.equal(bid.status, 200);
    const selected = await request(
      `/appraisals/${row.appraisalId}/select-offer`,
      {
        method: "POST",
        token: "manager",
        body: { revision: 0, invitationId: link.id, offerRevision: 1 },
      },
    );
    assert.equal(selected.status, 200);
    assert.equal(
      (
        await request(`/appraisal-bids/${link.id}`, {
          method: "POST",
          token: null,
          headers,
          body: { revision: 1, amount: 26000 },
        })
      ).status,
      409,
    );
    assert.equal(
      panel.collection("appraisal_invitations").rows[0].token,
      undefined,
    );
  }));
