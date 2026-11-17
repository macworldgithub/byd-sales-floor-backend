const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ObjectId } = require("mongoose").mongo;
const { database } = require("./helpers/floorMemory");
const { AppraisalCentre } = require("../src/services/appraisalCentre");
const policy = require("../src/services/appraisalPolicy");
const user = {
  id: "staff-1",
  name: "Sales Person",
  email: "sales@example.invalid",
  role: "sales_consultant",
  site: "BYD Fairfield",
  locked_site: "BYD Fairfield",
  allowed_sites: ["BYD Fairfield"],
};
const manager = { ...user, id: "manager-1", role: "sales_manager" };
test('source-group staff archives require all-site management and never appear in a single-site silo', async () => {
  const {service,panel}=fixture();
  await panel.collection('iappraise_archive').insertOne({_id:'source-staff',kind:'dealer_staff',sourceAccount:'BYD Melbourne',site:'BYD Melbourne (source group)',customerName:'Source staff'});
  await panel.collection('iappraise_archive').insertOne({_id:'other-group',kind:'dealer_staff',sourceAccount:'Other group',site:'Other group (source group)'});
  assert.equal((await service.archive({},manager)).pagination.total,0);
  const global={...manager,all_sites:true,locked_site:'',site:'All Sites',allowed_sites:[]};
  assert.equal((await service.archive({site:'All Sites'},global)).pagination.total,1);
  await assert.rejects(service.archive({site:'All Sites'},{...global,role:'sales_consultant'}),/Management/);
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=",
  "base64",
);
function fixture() {
  const leadId = new ObjectId(),
    own = {
      _id: leadId,
      name: "Real Customer",
      phone: "+61400000000",
      email: "real@example.invalid",
      dealer: user.site,
      customerId: "CUS-1",
      owner_user_id: user.id,
      assignedTo: user.email,
    };
  const row = {
    _id: new ObjectId(),
    appraisalId: "APP-OWN",
    leadId: String(leadId),
    customerId: "CUS-1",
    customerName: own.name,
    site: user.site,
    consultantId: user.id,
    consultantName: user.name,
    status: "Draft",
    revision: 0,
    rego: "ABC123",
    state: "VIC",
    vin: "LGXCE4C88P0123456",
    make: "BYD",
    model: "ATTO 3",
    year: 2023,
    odometer: 1000,
    condition: {},
    valuation: { wholesaleValue: 25000, customerExpectation: 28000 },
    media: [],
  };
  const lead = database({
    leads: [own],
    appraisals: [
      row,
      {
        ...row,
        _id: new ObjectId(),
        appraisalId: "APP-OTHER-SITE",
        site: "BYD Nunawading",
      },
      {
        ...row,
        _id: new ObjectId(),
        appraisalId: "APP-OTHER-OWNER",
        consultantId: "staff-other",
        consultantName: "Other Person",
      },
    ],
  });
  const panel = database({
    customers: [
      {
        customer_id: "CUS-1",
        site: user.site,
        name: own.name,
        phone: own.phone,
      },
    ],
  });
  return { lead, panel, service: new AppraisalCentre(lead, panel), row, own };
}
async function mediaDirectory(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "byd-appraisal-test-"));
  const previous = process.env.APPRAISAL_MEDIA_DIR;
  process.env.APPRAISAL_MEDIA_DIR = dir;
  try {
    await run(dir);
  } finally {
    if (previous === undefined) delete process.env.APPRAISAL_MEDIA_DIR;
    else process.env.APPRAISAL_MEDIA_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}
test("appraisal queries and direct IDs enforce site, ownership and sales roles", async () => {
  const { service } = fixture();
  assert.equal((await service.list({}, user)).data.length, 1);
  assert.equal((await service.list({}, manager)).data.length, 2);
  await assert.rejects(service.record("APP-OTHER-SITE", manager), /not found/);
  await assert.rejects(service.record("APP-OTHER-OWNER", user), /not found/);
  await assert.rejects(
    service.list({}, { ...user, role: "contractor" }),
    /Sales appraisal access/,
  );
  assert.equal(
    (await service.list({ site: "BYD Nunawading" }, user)).data[0].site,
    user.site,
  );
});
test("creation resolves canonical customer details and request retries return one appraisal", async () => {
  const { service, own, panel } = fixture();
  const input = {
    leadId: String(own._id),
    requestId: "create-request-123",
    rego: " BYD007 ",
    state: "VIC",
    customerName: "Spoofed",
    site: "BYD Nunawading",
    status: "Approved",
    ppsrStatus: "Clear",
  };
  const first = await service.create(input, user),
    second = await service.create(input, user);
  assert.equal(first.appraisalId, second.appraisalId);
  assert.equal(first.customerName, "Real Customer");
  assert.equal(first.site, user.site);
  assert.equal(first.customerId, "CUS-1");
  assert.equal(first.status, "Draft");
  assert.equal(first.ppsrStatus, "Pending");
  assert.equal(
    panel
      .collection("timelineevents")
      .rows.filter((e) => e.appraisalId === first.appraisalId).length,
    1,
  );
  await assert.rejects(
    service.create({ ...input, leadId: String(new ObjectId()) }, user),
    /not found/,
  );
});
test("valuations are manager-only and unverified legacy clear statuses are never presented as verified", async () => {
  const { service } = fixture();
  const row = await service.record("APP-OWN", user);
  row.ppsrStatus = "Clear";
  const result = (await service.list({}, user)).data[0];
  assert.deepEqual(result.valuation, { customerExpectation: 28000 });
  assert.equal(result.ppsrStatus, "Pending");
  await assert.rejects(
    service.patch(
      "APP-OWN",
      { revision: 0, valuation: { wholesaleValue: 1 } },
      user,
    ),
    /Only managers/,
  );
  const saved = await service.patch(
    "APP-OWN",
    {
      revision: 0,
      valuation: { wholesaleValue: 24000, tradeInAllowance: 25000 },
    },
    manager,
  );
  assert.equal(saved.valuation.wholesaleValue, 24000);
  assert.equal(saved.valuation.customerExpectation, 28000);
});
test("stale edits fail and changing vehicle identity invalidates previous verification", async () => {
  const { service, row } = fixture();
  row.ppsrStatus = "Clear";
  row.ppsrDetails = { verified: true, certificateNumber: "old" };
  const saved = await service.patch(
    "APP-OWN",
    { revision: 0, rego: "NEW123" },
    user,
  );
  assert.equal(saved.ppsrStatus, "Pending");
  assert.equal(saved.ppsrDetails, null);
  await assert.rejects(
    service.patch("APP-OWN", { revision: 0, notes: "overwrite" }, user),
    /Refresh/,
  );
  assert.equal((await service.record("APP-OWN", user)).rego, "NEW123");
});
test("completion requires guided photos, identity and condition, and approval requires management", async () => {
  const { service, row } = fixture();
  await service.status(
    "APP-OWN",
    { revision: 0, status: "Pending Inspection" },
    user,
  );
  await assert.rejects(
    service.status("APP-OWN", { revision: 1, status: "Completed" }, user),
    /photo/,
  );
  row.condition = {
    exteriorRating: 4,
    interiorRating: 3,
    tyresRating: 4,
    mechanicalRating: 4,
  };
  row.media = policy.REQUIRED_SHOTS.map((shot, i) => ({
    id: String(i),
    shot,
    purpose: "inspection",
    kind: "image",
  }));
  const completed = await service.status(
    "APP-OWN",
    { revision: 1, status: "Completed" },
    user,
  );
  assert.equal(completed.status, "Completed");
  await assert.rejects(
    service.status("APP-OWN", { revision: 2, status: "Approved" }, user),
    /Management/,
  );
  await assert.rejects(
    service.status("APP-OWN", { revision: 2, status: "Approved" }, manager),
    /trade allowance/,
  );
  await service.patch(
    "APP-OWN",
    { revision: 2, valuation: { tradeInAllowance: 0 } },
    manager,
  );
  const approved = await service.status(
    "APP-OWN",
    { revision: 3, status: "Approved" },
    manager,
  );
  assert.equal(approved.status, "Approved");
  await assert.rejects(
    service.patch("APP-OWN", { revision: 4, notes: "edit approved" }, manager),
    /reopen/,
  );
});
test("private attachments preserve actual bytes, checksums and the owning appraisal", async () =>
  mediaDirectory(async (dir) => {
    const { service, panel } = fixture();
    const uploaded = await service.upload(
      "APP-OWN",
      { purpose: "inspection", shot: "Front", name: "../../photo.png" },
      png,
      "image/png",
      user,
    );
    assert.equal(uploaded.media.length, 1);
    assert.equal(uploaded.media[0].sha256.length, 64);
    const file = await service.attachment(uploaded.media[0].id, user);
    assert.deepEqual(await fs.readFile(file.path), png);
    assert.equal(path.dirname(file.path), dir);
    assert.equal(panel.collection("appraisal_media").rows.length, 1);
    await assert.rejects(
      service.upload(
        "APP-OWN",
        { purpose: "inspection", shot: "Front" },
        Buffer.from("<script>"),
        "image/png",
        user,
      ),
      /Select an image/,
    );
    await assert.rejects(
      service.upload(
        "APP-OWN",
        { purpose: "contract" },
        png,
        "image/png",
        user,
      ),
      /Management/,
    );
    await assert.rejects(
      service.attachment(file._id, {
        ...user,
        site: "BYD Nunawading",
        locked_site: "BYD Nunawading",
        allowed_sites: ["BYD Nunawading"],
      }),
      /not found/,
    );
  }));
test("internal drives prevent duplicate checkout, decreasing readings and another drivers return", async () => {
  const { service } = fixture();
  const started = await service.drive(
    "APP-OWN",
    { revision: 0, odometer: 1001 },
    user,
  );
  assert.ok(started.activeDriveId);
  await assert.rejects(
    service.drive("APP-OWN", { revision: 1, odometer: 1001 }, user),
    /already active/,
  );
  await assert.rejects(
    service.drive("APP-OWN", { revision: 1, odometer: 900 }, user, true),
    /cannot be lower/,
  );
  const ended = await service.drive(
    "APP-OWN",
    { revision: 1, odometer: 1012 },
    user,
    true,
  );
  assert.equal(ended.activeDriveId, null);
  assert.equal(ended.drives[0].distanceKm, 11);
});
test("loan signatures require attached drawn evidence and consent; closed loans retain history", async () =>
  mediaDirectory(async () => {
    const { service } = fixture();
    const loan = {
      signatureName: "Real Customer",
      loanCarRego: "LOAN01",
      loanCarModel: "BYD Seal",
      terms: "Approved dealership terms.",
      consent: true,
      revision: 0,
    };
    await assert.rejects(
      service.signLoan("APP-OWN", loan, user),
      /Attachment not found/,
    );
    const uploaded = await service.upload(
      "APP-OWN",
      { purpose: "signature" },
      png,
      "image/png",
      user,
    );
    const signed = await service.signLoan(
      "APP-OWN",
      {
        ...loan,
        revision: uploaded.revision,
        signatureMediaId: uploaded.media[0].id,
      },
      user,
    );
    assert.equal(signed.loanCar.isSigned, true);
    assert.equal(signed.loanCar.termsHash.length, 64);
    await assert.rejects(
      service.signLoan(
        "APP-OWN",
        {
          ...loan,
          revision: signed.revision,
          signatureMediaId: uploaded.media[0].id,
        },
        user,
      ),
      /Return the current/,
    );
    const returned = await service.returnLoan(
      "APP-OWN",
      { revision: signed.revision, notes: "Returned inspected." },
      user,
    );
    assert.ok(returned.loanCar.returnedAt);
  }));
test("wholesaler links reveal only vehicle evidence, preserve bid history and expire/revoke correctly", async () => {
  const { service, row, panel } = fixture();
  row.status = "Completed";
  row.media = [
    { id: "private-licence", purpose: "licence" },
    { id: "shared-front", purpose: "inspection" },
  ];
  const partner = await service.savePartner(
    {
      name: "Wholesale Buyer",
      kind: "wholesaler",
      company: "Wholesale",
      email: "buyer@example.invalid",
      site: user.site,
    },
    manager,
  );
  process.env.APPRAISAL_WEB_URL = "https://sales-floor.example.invalid";
  try {
    await assert.rejects(
      service.invite(
        "APP-OWN",
        {
          partnerIds: [String(partner._id)],
          expiresAt: new Date(Date.now() + 3600000),
        },
        user,
      ),
      /Management/,
    );
    const [link] = await service.invite(
      "APP-OWN",
      {
        partnerIds: [String(partner._id)],
        expiresAt: new Date(Date.now() + 3600000),
      },
      manager,
    );
    const token = new URL(link.url).hash.slice(1),
      { invite, row: vehicle } = await service.invitation(link.id, token);
    assert.equal(
      panel.collection("appraisal_invitations").rows[0].token,
      undefined,
    );
    const shared = service.publicView(invite, vehicle);
    const json = JSON.stringify(shared);
    for (const secret of [
      "Real Customer",
      "+61400000000",
      "private-licence",
      "wholesaleValue",
      "customerExpectation",
    ])
      assert.equal(json.includes(secret), false);
    assert.equal(shared.media.length, 1);
    await service.bid(link.id, token, {
      revision: 0,
      amount: 22000,
      notes: "Collection included.",
    });
    await assert.rejects(
      service.bid(link.id, token, { revision: 0, amount: 1 }),
      /Refresh/,
    );
    await service.bid(link.id, token, { revision: 1, amount: 23000 });
    assert.equal(invite.history.length, 2);
    const selected = await service.selectOffer(
      "APP-OWN",
      { revision: row.revision, invitationId: link.id, offerRevision: 2 },
      manager,
    );
    assert.equal(selected.selectedOffer.amount, 23000);
    await assert.rejects(
      service.bid(link.id, token, { revision: 2, amount: 24000 }),
      /closed/,
    );
    await assert.rejects(service.invitation(link.id, "wrong"), /not found/);
    invite.expiresAt = new Date(Date.now() - 1);
    await assert.rejects(service.invitation(link.id, token), /expired/);
  } finally {
    delete process.env.APPRAISAL_WEB_URL;
  }
});
test("linking refuses a different customer and persists canonical appraisal references", async () => {
  const { service, row, lead, panel } = fixture();
  const deal = { _id: new ObjectId(), leadId: row.leadId, site: row.site };
  await lead.collection("deals").insertOne(deal);
  await lead
    .collection("deals")
    .insertOne({ _id: new ObjectId(), leadId: "other", site: row.site });
  const other = lead.collection("deals").rows[1];
  await assert.rejects(
    service.link(
      "APP-OWN",
      { revision: 0, dealId: String(other._id) },
      manager,
    ),
    /this customer/,
  );
  const linked = await service.link(
    "APP-OWN",
    { revision: 0, dealId: String(deal._id) },
    manager,
  );
  assert.equal(linked.dealId, String(deal._id));
  assert.equal(lead.collection("deals").rows[0].appraisalId, row.appraisalId);
  assert.ok(
    panel
      .collection("customers")
      .rows[0].appraisalIds.includes(row.appraisalId),
  );
});
test("invalid inspection numbers, VINs and arbitrary monetary fields fail validation", () => {
  for (const input of [
    { vin: "SIMULATED123" },
    { odometer: -1 },
    { year: 2 },
    { state: "ZZ" },
    { condition: { mechanicalRating: 6 } },
    { valuation: { netTradeAllowance: 1 } },
  ])
    assert.throws(() => policy.details(input, manager));
  assert.deepEqual(
    policy.details(
      { status: "Approved", site: "other", consultantId: "spoof" },
      user,
    ),
    {},
  );
});
test("desktop Sold handoff attaches only the customers completed/approved appraisals and safely replays", async () => {
  const { lead, panel, row } = fixture();
  row.status = "Completed";
  const opportunity = {
      opportunity_id: "OPP-1",
      customer_id: "CUS-1",
      site: user.site,
    },
    client = { _id: new ObjectId(), crm_customer_id: "CUS-1", site: user.site };
  await panel.collection("opportunities").insertOne(opportunity);
  await panel.collection("clients").insertOne(client);
  const { attachHandoff } = require("../src/services/appraisalLinks");
  const ids = await attachHandoff(
    lead,
    panel,
    { customer_id: "CUS-1", site: user.site },
    opportunity,
    String(client._id),
    manager,
  );
  assert.deepEqual(ids, ["APP-OWN"]);
  assert.equal(row.opportunityId, "OPP-1");
  assert.equal(row.deliveryId, String(client._id));
  assert.ok(
    panel.collection("clients").rows[0].appraisalIds.includes("APP-OWN"),
  );
  const revision = row.revision;
  await attachHandoff(
    lead,
    panel,
    { customer_id: "CUS-1", site: user.site },
    opportunity,
    String(client._id),
    manager,
  );
  assert.equal(row.revision, revision);
});
test("appraisal propagation preserves the negotiated deal allowance", async () => {
  const { service, lead, row } = fixture();
  const deal = {
    _id: new ObjectId(),
    leadId: row.leadId,
    site: row.site,
    tradeIn: { allowance: 12345 },
    financials: { tradeInAllowance: 12345 },
  };
  await lead.collection("deals").insertOne(deal);
  await service.link(
    "APP-OWN",
    { revision: 0, dealId: String(deal._id) },
    manager,
  );
  assert.equal(lead.collection("deals").rows[0].tradeIn.allowance, 12345);
  assert.equal(
    lead.collection("deals").rows[0].financials.tradeInAllowance,
    12345,
  );
});
test("two simultaneous deals cannot claim the same appraisal", async () => {
  const { lead, panel, row, own } = fixture();
  const {
    SalesFloorOperations,
  } = require("../src/services/salesFloorOperations");
  const operations = new SalesFloorOperations(lead, panel);
  const vehicles = [new ObjectId(), new ObjectId()];
  for (const _id of vehicles)
    await lead
      .collection("inventories")
      .insertOne({
        _id,
        location: user.site,
        status: "In Stock",
        specifications: { model: "BYD Seal" },
        registration: { vin: "LGXCE4C88P0123456" },
      });
  const results = await Promise.allSettled(
    vehicles.map((vehicle, index) =>
      operations.saveDeal(
        {
          leadId: String(own._id),
          inventoryId: String(vehicle),
          bookingRequestId: `concurrent-deal-${index}`,
          salePrice: 60000,
          tradeInValue: 1000,
          appraisalId: row.appraisalId,
        },
        manager,
      ),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(lead.collection("deals").rows.length, 1);
  assert.equal(
    lead
      .collection("inventories")
      .rows.filter((vehicle) => vehicle.status === "Deal Pending").length,
    1,
  );
});
