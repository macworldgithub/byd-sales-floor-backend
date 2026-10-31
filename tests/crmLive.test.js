const test = require("node:test");
const assert = require("node:assert/strict");
const {
  metrics,
  bootstrap,
  updateTarget,
  periodBounds,
} = require("../src/services/crmLive");
const bounds = periodBounds("2026-10");

const cursor = (rows) => ({
  sort() {
    return this;
  },
  skip() {
    return this;
  },
  limit() {
    return this;
  },
  async toArray() {
    return rows;
  },
});

test("scoreboards read dated targets from the deployed legacy schema without reusing an old month", async () => {
  const { boards } = require("../src/services/crmLive");
  const db = {
    collection(name) {
      return {
        find() {
          return cursor(
            name === "targets"
              ? [
                  {
                    user_name: "Saved consultant",
                    site: "BYD Fairfield",
                    month: "2026-10",
                    unit_target: 0,
                  },
                  {
                    user_name: "Old target only",
                    site: "BYD Fairfield",
                    month: "2026-09",
                    unit_target: 99,
                  },
                ]
              : [],
          );
        },
      };
    },
  };
  const data = await boards(db, { period: "2026-10" }, {}, true);
  assert.equal(data.consultants.length, 1);
  assert.equal(data.consultants[0].name, "Saved consultant");
  assert.equal(data.consultants[0].target_units, 0);
});

test("audit reads native author/source fields and filters both supported schemas", async () => {
  const { audit } = require("../src/services/crmLive");
  let filter;
  const db = {
    collection() {
      return {
        async countDocuments(query) {
          filter = query;
          return 1;
        },
        find() {
          return cursor([
            {
              _id: "saved-event",
              author_name: "Saved author",
              source_system: "sms",
              title: "Actual event",
              body: "Actual body",
              occurred_at: "2026-10-10T01:00:00Z",
            },
          ]);
        },
        async distinct(field) {
          return field === "source_system" ? ["sms"] : ["crm"];
        },
      };
    },
  };
  const data = await audit(db, { source: "sms" }, {});
  assert.equal(data.data[0].actor, "Saved author");
  assert.equal(data.data[0].source, "sms");
  assert.deepEqual(data.meta.filters.sources, ["crm", "sms"]);
  assert.match(JSON.stringify(filter), /source_system/);
  assert.match(JSON.stringify(filter), /is_deleted/);
});

test("an empty scoreboard has zero activity and unconfigured targets and timings, without sample metrics", () => {
  const result = metrics(
    "Actual Staff",
    "BYD Fairfield",
    [],
    [],
    [],
    null,
    bounds,
  );
  assert.equal(result.written_units_mtd, 0);
  assert.equal(result.open_deals_count, 0);
  assert.equal(result.target_units, null);
  assert.equal(result.conversion_rate_pct, null);
  assert.equal(result.avg_first_touch_minutes, null);
  assert.equal(result.pace_pct, null);
});

test("metrics count a linked sale once, exclude other months and use recorded gross and first-touch times", () => {
  const opps = [
    {
      opportunity_id: "real-opp",
      owner_name: "Actual Staff",
      site: "BYD Fairfield",
      stage: "Written / Sold",
      sold_at: "2026-10-10T01:00:00Z",
      total_price: 80000,
    },
  ];
  const logs = [
    {
      crm_opportunity_id: "real-opp",
      consultant_name: "Actual Staff",
      site: "BYD Fairfield",
      deal_date: "2026-10-10",
      gross_margin: 1250,
    },
    {
      consultant_name: "Actual Staff",
      site: "BYD Fairfield",
      deal_date: "2026-09-10",
      gross_margin: 50000,
    },
  ];
  const result = metrics(
    "Actual Staff",
    "BYD Fairfield",
    opps,
    logs,
    [
      {
        assigned_to_name: "Actual Staff",
        allocated_at: "2026-10-10T01:00:00Z",
        accepted_at: "2026-10-10T01:12:00Z",
      },
    ],
    { targetUnits: 0 },
    bounds,
  );
  assert.equal(result.written_units_mtd, 1);
  assert.equal(result.written_gross_mtd, 1250);
  assert.equal(result.target_units, 0);
  assert.equal(result.avg_first_touch_minutes, 12);
  const unknown = metrics("Actual Staff", "", opps, [], [], null, bounds);
  assert.equal(
    unknown.written_gross_mtd,
    null,
    "vehicle value must not be reported as gross profit",
  );
});

test("an empty database produces no invented staff, vehicles, templates or locations in bootstrap", async () => {
  const db = {
    collection() {
      return {
        find() {
          return {
            sort() {
              return this;
            },
            async toArray() {
              return [];
            },
          };
        },
        async findOne() {
          return null;
        },
        async distinct() {
          return [];
        },
      };
    },
  };
  const data = await bootstrap({ lead: db, panel: db }, {}, {});
  for (const field of [
    "staff",
    "models",
    "smsTemplates",
    "sites",
    "consultants",
    "sources",
  ])
    assert.deepEqual(data[field], []);
  assert.equal(data.inventoryCount, 0);
  assert.equal(data.governance, null);
});

test("target saves use the selected consultant, yard and month, preserving a genuine zero", async () => {
  let write;
  const db = {
    collection() {
      return {
        async updateOne(filter, operation) {
          write = { filter, operation };
        },
      };
    },
  };
  const saved = await updateTarget(
    db,
    {
      consultant: "Actual Staff",
      targetUnits: 0,
      site: "BYD Fairfield",
      period: "2026-10",
    },
    { id: "user" },
  );
  assert.deepEqual(write.filter, {
    consultant: "Actual Staff",
    site: "BYD Fairfield",
    period: "2026-10",
  });
  assert.equal(saved.targetUnits, 0);
  await assert.rejects(
    updateTarget(db, { targetUnits: 10, period: "2026-10" }, {}),
    { statusCode: 400 },
  );
});

test("inventory reads preserve unknown prices, capacity and actual sold status instead of estimated defaults", async () => {
  const fs = require("node:fs"),
    path = require("node:path"),
    vm = require("node:vm");
  const rows = [
    {
      _id: "mongo-id",
      identifier: "source-stock-id",
      model: "Saved model",
      status: "Sold",
      priceData: {},
    },
  ];
  const cursor = (data) => ({
    sort() {
      return this;
    },
    skip() {
      return this;
    },
    limit() {
      return this;
    },
    async toArray() {
      return data;
    },
  });
  const inventory = {
    async countDocuments() {
      return 1;
    },
    find() {
      return cursor(rows);
    },
  };
  const db = {
    collection(name) {
      return name === "inventories"
        ? inventory
        : {
            find() {
              return cursor([]);
            },
          };
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(
      path.resolve(__dirname, "../src/services/crmService.js"),
      "utf8",
    ),
    {
      module,
      exports: module.exports,
      require(key) {
        if (key === "../db")
          return {
            leadConn: { db },
            deliveryConn: { db },
            async ensureDbConnected() {},
          };
        if (key === "./deliverySite") return {};
        return require(key);
      },
    },
  );
  const result = await module.exports.getVyStock();
  const stock = result.data[0];
  assert.equal(stock.stock_id, "source-stock-id");
  assert.equal(stock.status, "Sold");
  assert.equal(stock.retail_price, null);
  assert.equal(stock.wholesale_price, null);
  assert.equal(stock.battery_kwh, null);
  assert.equal(stock.colour, "");
});
