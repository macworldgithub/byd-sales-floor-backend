const { siteScope, dayStart, paging } = require("./crmBrowsing");
const { siteConditions } = require("./staffDirectory");
const { canonicalSite, siteKey, fail } = require("./accountAccess");
const esc = (value) =>
  String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exact = (value) => new RegExp(`^${esc(value)}$`, "i");
const scope = (query, user, fields = ["site", "location", "dealer"]) =>
  siteScope(query, user, fields);
const number = (value) =>
  value !== null &&
  value !== undefined &&
  value !== "" &&
  Number.isFinite(Number(value))
    ? Number(value)
    : null;
const dates = (value) =>
  value && Number.isFinite(new Date(value).getTime()) ? new Date(value) : null;
function periodBounds(period) {
  const current = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const p = Object.fromEntries(current.map((part) => [part.type, part.value]));
  const key = period || `${p.year}-${p.month}`;
  if (!/^\d{4}-\d{2}$/.test(key)) fail(400, "Choose a valid month.");
  const first = `${key}-01`,
    end = new Date(`${first}T12:00:00Z`);
  if (!Number.isFinite(end.getTime())) fail(400, "Choose a valid month.");
  end.setUTCMonth(end.getUTCMonth() + 1);
  return {
    period: key,
    from: dayStart(first),
    to: dayStart(end.toISOString().slice(0, 10)),
  };
}
const inPeriod = (value, bounds) => {
  const date = dates(value);
  return date && date >= bounds.from && date < bounds.to;
};

async function bootstrap({ lead, panel }, query, user) {
  const selected = user.locked_site || query.site;
  const staffFilter = { active: { $ne: false }, deleted_at: null };
  if (selected && !/^all(?:\s|$)/i.test(selected))
    staffFilter.$or = await siteConditions(panel, selected);
  const [staff, inventory, templates, governance, dimensions] =
    await Promise.all([
      panel
        .collection("users")
        .find(staffFilter, {
          projection: { name: 1, email: 1, site: 1, role: 1, team: 1 },
        })
        .sort({ name: 1 })
        .toArray(),
      lead
        .collection("inventories")
        .find(scope(query, user, ["location", "yard", "site"]), {
          projection: { model: 1, specifications: 1, paint: 1, location: 1 },
        })
        .toArray(),
      panel
        .collection("templates")
        .find(
          {
            active: { $ne: false },
            $or: [
              { channel: { $in: ["sms", "both"] } },
              { channel: { $exists: false } },
            ],
          },
          { projection: { name: 1, body: 1, category: 1 } },
        )
        .sort({ name: 1 })
        .toArray(),
      panel.collection("crmsettings").findOne({ key: "governance" }),
      Promise.all([
        panel
          .collection("customers")
          .distinct("owner_name", scope(query, user)),
        panel
          .collection("opportunities")
          .distinct("owner_name", scope(query, user)),
        panel
          .collection("saleslogentries")
          .distinct("consultant_name", scope(query, user)),
        panel.collection("customers").distinct("source", scope(query, user)),
        lead
          .collection("leads")
          .distinct("source", scope(query, user, ["dealer", "site"])),
        panel.collection("allocations").distinct("source", scope(query, user)),
        panel.collection("opportunities").distinct("model", scope(query, user)),
      ]),
    ]);
  let sites;
  if (Array.isArray(user.allowed_sites) && !user.all_sites)
    sites = user.allowed_sites;
  else {
    const groups = await Promise.all([
      panel
        .collection("users")
        .distinct("site", { active: { $ne: false }, deleted_at: null }),
      panel.collection("customers").distinct("site"),
      panel.collection("opportunities").distinct("site"),
      lead.collection("leads").distinct("dealer"),
      lead.collection("inventories").distinct("location"),
      panel.collection("clients").distinct("site_location"),
    ]);
    sites = groups
      .flat()
      .filter(
        (value) =>
          typeof value === "string" &&
          value.trim() &&
          !/^all(?:\s|$)/i.test(value),
      );
  }
  const uniqueSites = new Map(
    sites.map((site) => [siteKey(site), canonicalSite(site) || site.trim()]),
  );
  const catalog = new Map();
  for (const row of inventory) {
    const name = row.specifications?.model || row.model;
    if (!name || typeof name !== "string") continue;
    const item = catalog.get(name) || {
      name,
      variants: new Set(),
      colours: new Set(),
    };
    if (row.specifications?.badge) item.variants.add(row.specifications.badge);
    if (row.paint || row.specifications?.colour)
      item.colours.add(row.paint || row.specifications.colour);
    catalog.set(name, item);
  }
  for (const name of dimensions[6])
    if (typeof name === "string" && name && !catalog.has(name))
      catalog.set(name, { name, variants: new Set(), colours: new Set() });
  const strings = (values) =>
    [
      ...new Set(
        values.filter((value) => typeof value === "string" && value.trim()),
      ),
    ].sort();
  return {
    sites: [...uniqueSites.values()].sort(),
    staff: staff.map((row) => ({
      id: String(row._id),
      name: row.name,
      email: row.email,
      site: row.site || "",
      role: row.role,
      team: row.team || "",
    })),
    links: {
      leadCentre: process.env.LEAD_CENTRE_URL || "",
      deliveryCentre: process.env.DELIVERY_CENTRE_URL || "",
    },
    consultants: strings([
      ...dimensions.slice(0, 3).flat(),
      ...staff.map((row) => row.name),
    ]),
    sources: strings(dimensions.slice(3, 6).flat()),
    models: [...catalog.values()]
      .map((item) => ({
        name: item.name,
        variants: [...item.variants].sort(),
        colours: [...item.colours].sort(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    smsTemplates: templates.map((template) => ({
      id: String(template._id),
      name: template.name,
      body: template.body,
      category: template.category || "",
    })),
    governance: governance?.value || null,
    inventoryCount: inventory.length,
  };
}

function metrics(name, site, opps, logs, allocations, target, bounds) {
  const owned = (rows) =>
    rows.filter(
      (row) =>
        exact(name).test(
          row.owner_name ||
            row.consultant_name ||
            row.consultant ||
            row.assigned_to_name ||
            row.assigned_to ||
            "",
        ) &&
        (!site || !row.site || siteKey(row.site) === siteKey(site)),
    );
  const allOpps = owned(opps),
    allLogs = owned(logs),
    allAllocations = owned(allocations);
  const monthLogs = allLogs.filter((row) =>
    inPeriod(row.deal_date || row.createdAt, bounds),
  );
  const monthSold = allOpps.filter(
    (row) =>
      ["Written / Sold", "In Delivery", "Delivered / Won"].includes(
        row.stage,
      ) && inPeriod(row.sold_at || row.written_at || row.createdAt, bounds),
  );
  const loggedOpps = new Set(
    monthLogs
      .map((row) => row.crm_opportunity_id || row.opportunity_id)
      .filter(Boolean),
  );
  const loggedIds = new Set(
    monthLogs
      .flatMap((row) => [row.sales_log_id, row._id && String(row._id)])
      .filter(Boolean),
  );
  const written = [
    ...monthLogs,
    ...monthSold.filter(
      (row) =>
        !loggedOpps.has(row.opportunity_id) && !loggedIds.has(row.sales_log_id),
    ),
  ];
  const units = written.length;
  const knownGross = written
    .map((row) => number(row.gross_margin ?? row.gross))
    .filter((value) => value !== null);
  const gross =
    knownGross.length !== units
      ? null
      : knownGross.reduce((sum, value) => sum + value, 0);
  const open = allOpps.filter(
    (row) => !["Delivered / Won", "Lost / Parked"].includes(row.stage),
  );
  const firstTouches = allAllocations
    .map((row) => {
      const start = dates(row.allocated_at || row.createdAt),
        end = dates(row.first_contact_at || row.accepted_at);
      return start && end && end >= start ? (end - start) / 60000 : null;
    })
    .filter((value) => value !== null);
  const targetUnits = number(target?.targetUnits ?? target?.target_units);
  return {
    name,
    site,
    written_units_mtd: units,
    target_units: targetUnits,
    written_gross_mtd: gross,
    open_deals_count: open.length,
    overdue_actions_count: open.filter(
      (row) =>
        dates(row.next_action_at) && new Date(row.next_action_at) < new Date(),
    ).length,
    conversion_rate_pct: allOpps.length
      ? Math.round(
          (allOpps.filter((row) =>
            ["Written / Sold", "In Delivery", "Delivered / Won"].includes(
              row.stage,
            ),
          ).length /
            allOpps.length) *
            100,
        )
      : null,
    avg_first_touch_minutes: firstTouches.length
      ? Math.round(
          (firstTouches.reduce((sum, n) => sum + n, 0) / firstTouches.length) *
            10,
        ) / 10
      : null,
    pace_pct: targetUnits > 0 ? Math.round((units / targetUnits) * 100) : null,
  };
}
async function boards(panel, query = {}, user = {}, team = false) {
  const bounds = periodBounds(query.period);
  const filter = scope(query, user);
  const [opps, logs, allocations, targets, legacyTargets, staff] =
    await Promise.all([
      panel.collection("opportunities").find(filter).toArray(),
      panel.collection("saleslogentries").find(filter).toArray(),
      panel.collection("allocations").find(filter).toArray(),
      panel.collection("crmtargets").find(filter).toArray(),
      panel.collection("targets").find(filter).toArray(),
      panel
        .collection("users")
        .find(
          {
            $and: [
              scope(query, user, ["site"]),
              { active: { $ne: false }, deleted_at: null },
            ],
          },
          { projection: { name: 1, site: 1, role: 1 } },
        )
        .toArray(),
    ]);
  const activeTargets = [
    ...targets,
    ...legacyTargets.map((row) => ({
      ...row,
      period: row.period || row.month,
      consultant: row.consultant || row.consultant_name || row.user_name,
      targetUnits: row.targetUnits ?? row.target_units ?? row.unit_target,
    })),
  ].filter((row) => row.period === bounds.period);
  const names = new Map();
  const add = (name, site) => {
    if (!name) return;
    const key = name.toLowerCase(),
      entry = names.get(key) || { name, sites: new Map() };
    if (site) entry.sites.set(siteKey(site), site);
    names.set(key, entry);
  };
  staff
    .filter((row) =>
      [
        "sales_consultant",
        "sales_manager",
        "consultant",
        "manager",
        "agent",
      ].includes(row.role),
    )
    .forEach((row) => add(row.name, row.site));
  opps.forEach((row) => add(row.owner_name, row.site));
  logs.forEach((row) => add(row.consultant_name || row.consultant, row.site));
  activeTargets.forEach((row) =>
    add(row.consultant || row.consultant_name, row.site),
  );
  const targetFor = (name, site) => {
    const matches = activeTargets.filter(
      (row) =>
        exact(name).test(row.consultant || row.consultant_name || "") &&
        (!site ||
          /^all(?:\s|$)/i.test(site) ||
          siteKey(site) === siteKey(row.site)),
    );
    const bySite = new Map();
    for (const row of matches) {
      const key = siteKey(row.site);
      if (!bySite.has(key)) bySite.set(key, row);
    }
    const values = [...bySite.values()]
      .map((row) => number(row.targetUnits ?? row.target_units))
      .filter((value) => value !== null);
    return values.length
      ? { targetUnits: values.reduce((sum, value) => sum + value, 0) }
      : null;
  };
  if (!team) {
    const name = query.consultant || user.name;
    if (!name) fail(400, "The authenticated consultant is required.");
    const row = metrics(
      name,
      user.locked_site ||
        (query.site && !/^all(?:\s|$)/i.test(query.site) && query.site) ||
        "",
      opps,
      logs,
      allocations,
      targetFor(name, user.locked_site || query.site),
      bounds,
    );
    return {
      ...row,
      period: bounds.period,
      consultant: name,
      writtenUnitsMtd: row.written_units_mtd,
      targetUnits: row.target_units,
      pacePercentage: row.pace_pct,
      writtenGrossMtd: row.written_gross_mtd,
      conversionRatePct: row.conversion_rate_pct,
      avgFirstTouchMinutes: row.avg_first_touch_minutes,
      openDealsCount: row.open_deals_count,
      overdueCount: row.overdue_actions_count,
    };
  }
  const consultants = [...names.values()].map(({ name, sites }) => ({
    ...metrics(name, "", opps, logs, allocations, targetFor(name), bounds),
    site: [...sites.values()].sort().join(", "),
  }));
  return {
    period: bounds.period,
    consultants,
    totalDepartmentUnits: consultants.reduce(
      (sum, row) => sum + row.written_units_mtd,
      0,
    ),
    totalDepartmentTarget: consultants.some((row) => row.target_units !== null)
      ? consultants.reduce((sum, row) => sum + (row.target_units || 0), 0)
      : null,
    totalDepartmentGross: consultants.some(
      (row) => row.written_gross_mtd === null,
    )
      ? null
      : consultants.reduce((sum, row) => sum + row.written_gross_mtd, 0),
    averageConversionRate: consultants.some(
      (row) => row.conversion_rate_pct !== null,
    )
      ? Math.round(
          consultants
            .filter((row) => row.conversion_rate_pct !== null)
            .reduce((sum, row) => sum + row.conversion_rate_pct, 0) /
            consultants.filter((row) => row.conversion_rate_pct !== null)
              .length,
        )
      : null,
  };
}
async function updateTarget(panel, data, user) {
  const consultant = String(
    data.consultant || data.consultant_name || "",
  ).trim();
  const targetUnits = number(
    data.targetUnits ?? data.target_units ?? data.targetUnitCount,
  );
  const period = periodBounds(data.period).period;
  const site = user.locked_site || String(data.site || "").trim();
  if (
    !consultant ||
    !site ||
    !Number.isSafeInteger(targetUnits) ||
    targetUnits < 0
  )
    fail(
      400,
      "Consultant, yard and a non-negative whole-number target are required.",
    );
  const value = {
    consultant,
    site,
    period,
    targetUnits,
    updatedAt: new Date(),
    updatedBy: user.id,
  };
  await panel
    .collection("crmtargets")
    .updateOne({ consultant, site, period }, { $set: value }, { upsert: true });
  return value;
}
async function audit(panel, query, user) {
  const direct = scope(query, user);
  const customerIds = Object.keys(direct).length
    ? await panel.collection("customers").distinct("customer_id", direct)
    : [];
  const filter = Object.keys(direct).length
    ? { $or: [direct, { customer_id: { $in: customerIds } }] }
    : {};
  const clauses = [filter, { is_deleted: { $ne: true } }];
  if (query.q)
    clauses.push({
      $or: [
        "actor",
        "author",
        "author_name",
        "body",
        "title",
        "content",
        "action",
        "customer_id",
        "opportunity_id",
      ].map((field) => ({ [field]: new RegExp(esc(query.q), "i") })),
    });
  if (query.source)
    clauses.push({
      $or: [{ source: query.source }, { source_system: query.source }],
    });
  if (query.customer_id)
    clauses.push({ customer_id: String(query.customer_id) });
  const match = { $and: clauses };
  const collection = panel.collection("timelineevents");
  const total = await collection.countDocuments(match),
    pagination = paging(query, total);
  const rows = await collection
    .find(match, { allowDiskUse: true })
    .sort({ createdAt: -1, _id: -1 })
    .skip((pagination.page - 1) * pagination.limit)
    .limit(pagination.limit)
    .toArray();
  return {
    data: rows.map((row) => ({
      audit_id: row.event_id || String(row._id),
      actor: row.author || row.author_name || row.actor || "",
      action: row.title || row.action || row.type || "",
      target_type: row.opportunity_id ? "Opportunity" : "Customer",
      target_id: row.opportunity_id || row.customer_id || "",
      details: row.content || row.body || "",
      source: row.source || row.source_system || "",
      timestamp: row.occurred_at || row.createdAt,
    })),
    pagination,
    meta: {
      filters: {
        sources: [
          ...new Set(
            (
              await Promise.all(
                ["source", "source_system"].map((field) =>
                  collection.distinct(field, filter),
                ),
              )
            ).flat(),
          ),
        ]
          .filter((value) => typeof value === "string" && value)
          .sort(),
      },
    },
  };
}
async function settings(panel) {
  const doc = await panel
    .collection("crmsettings")
    .findOne({ key: "governance" });
  return {
    saved: doc?.value || null,
    effective: {
      slaTimeoutMinutes: doc?.value?.slaTimeoutMinutes ?? 15,
      stockHoldHours: doc?.value?.stockHoldHours ?? 48,
    },
    updatedAt: doc?.updatedAt || null,
  };
}
async function saveSettings(panel, value, user) {
  for (const key of Object.keys(value))
    if (!["slaTimeoutMinutes", "stockHoldHours"].includes(key))
      fail(400, "Unsupported configuration field.");
  if (
    !Number.isInteger(value.slaTimeoutMinutes) ||
    value.slaTimeoutMinutes < 1 ||
    value.slaTimeoutMinutes > 1440 ||
    !Number.isInteger(value.stockHoldHours) ||
    value.stockHoldHours < 1 ||
    value.stockHoldHours > 720
  )
    fail(400, "Enter a valid SLA window and stock hold duration.");
  await panel
    .collection("crmsettings")
    .updateOne(
      { key: "governance" },
      { $set: { value, updatedAt: new Date(), updatedBy: user.id } },
      { upsert: true },
    );
  return settings(panel);
}
async function reports(panel, query, user) {
  const filter = scope(query, user);
  const [customers, opportunities, sales, optOuts] = await Promise.all([
    panel
      .collection("customers")
      .countDocuments({ $and: [filter, { is_merged: { $ne: true } }] }),
    panel.collection("opportunities").countDocuments(filter),
    panel
      .collection("saleslogentries")
      .find(filter, {
        projection: {
          gross_margin: 1,
          gross: 1,
          reconciled_at: 1,
          reconciled: 1,
        },
      })
      .toArray(),
    panel
      .collection("customers")
      .countDocuments({ $and: [filter, { do_not_contact: true }] }),
  ]);
  const values = sales.map((row) => number(row.gross_margin ?? row.gross));
  return {
    customers,
    opportunities,
    sales: sales.length,
    optOuts,
    gross: values.some((value) => value === null)
      ? null
      : values.reduce((sum, value) => sum + value, 0),
    reconciled: sales.filter(
      (row) => row.reconciled_at || row.reconciled === true,
    ).length,
  };
}
module.exports = {
  bootstrap,
  boards,
  updateTarget,
  audit,
  settings,
  saveSettings,
  reports,
  metrics,
  periodBounds,
};
