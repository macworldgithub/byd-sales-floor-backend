const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { ObjectId } = require("mongoose").mongo;
const { fail, siteKey, canonicalSite } = require("./accountAccess");
const p = require("./salesFloorPolicy");
const policy = require("./appraisalPolicy");
const { SalesFloorOperations } = require("./salesFloorOperations");
const vehicle = require("./vehicleChecks");
const media = require("./floorMedia");
const id = (value) => String(value?._id || value || "");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const directory = () =>
  path.resolve(
    process.env.APPRAISAL_MEDIA_DIR ||
      path.join(__dirname, "../../.runtime/appraisal-media"),
  );
const ref = (value) =>
  ObjectId.isValid(String(value)) && /^[a-f\d]{24}$/i.test(String(value))
    ? new ObjectId(String(value))
    : String(value);

class AppraisalCentre {
  constructor(lead, panel) {
    this.lead = lead;
    this.panel = panel;
    this.floor = new SalesFloorOperations(lead, panel);
  }
  scope(user, query = {}) {
    policy.access(user);
    return p.scope(user, query, ["site"]);
  }
  async record(value, user) {
    const row = await this.lead
      .collection("appraisals")
      .findOne({
        $and: [
          this.scope(user),
          { $or: [{ _id: ref(value) }, { appraisalId: String(value) }] },
        ],
      });
    if (!row) fail(404, "Appraisal not found.");
    return row;
  }
  async list(query, user) {
    const conditions = [this.scope(user, query)];
    for (const key of [
      "leadId",
      "customerId",
      "dealId",
      "deliveryId",
      "status",
    ])
      if (query[key])
        conditions.push({ [key]: String(query[key]).slice(0, 150) });
    if (query.q)
      conditions.push({
        $or: [
          "rego",
          "vin",
          "customerName",
          "make",
          "model",
          "appraisalId",
        ].map((key) => ({
          [key]: new RegExp(p.literal(String(query.q).slice(0, 100)), "i"),
        })),
      });
    const filter = { $and: conditions },
      page = Math.max(1, Math.floor(Number(query.page) || 1)),
      limit = Math.min(100, Math.max(1, Math.floor(Number(query.limit) || 25)));
    const collection = this.lead.collection("appraisals");
    const [rows, total] = await Promise.all([
      collection
        .find(filter)
        .sort({ updatedAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      collection.countDocuments(filter),
    ]);
    return {
      data: rows.map((row) => policy.view(row, user)),
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }
  async audit(row, user, action, body, extra = {}) {
    const event = {
      event_id: `APP-EVT-${crypto.randomUUID()}`,
      appraisalId: row.appraisalId,
      leadId: row.leadId,
      customer_id: row.customerId,
      opportunity_id: row.dealId,
      deliveryId: row.deliveryId,
      site: row.site,
      owner_user_id: row.consultantId,
      owner_name: row.consultantName,
      type: action,
      title: action,
      headline: action,
      body,
      content: body,
      author_name: user.name,
      occurred_at: new Date(),
      createdAt: new Date(),
      ...extra,
    };
    if (extra.eventKey)
      await this.panel
        .collection("timelineevents")
        .updateOne(
          { _id: hash(extra.eventKey) },
          { $setOnInsert: event },
          { upsert: true },
        );
    else await this.panel.collection("timelineevents").insertOne(event);
  }
  async create(input, user) {
    policy.access(user);
    if (!input.leadId)
      fail(400, "Select the customer before creating an appraisal.");
    const lead = await this.floor.record("leads", input.leadId, user);
    const site = this.floor.site(user, lead.dealer || lead.site);
    if (!/^[\w-]{8,100}$/.test(String(input.requestId || "")))
      fail(400, "A stable appraisal request ID is required.");
    const appraisalId = `APP-${hash(`${user.id}:${input.requestId}`).slice(0, 24).toUpperCase()}`;
    const previous = await this.lead
      .collection("appraisals")
      .findOne({ appraisalId });
    if (previous) {
      if (previous.leadId !== id(lead))
        fail(409, "This request ID was already used for another customer.");
      const saved = await this.record(appraisalId, user);
      await this.audit(
        saved,
        user,
        "Appraisal created",
        `${saved.appraisalId} · ${saved.rego || "Registration pending"}`,
        { eventKey: `appraisal-created:${appraisalId}` },
      );
      return policy.view(saved, user);
    }
    const patch = policy.details(input, user),
      now = new Date();
    const profile = await require("./customerDelivery").profile(
      this.panel,
      this.lead,
      id(lead),
      user,
      true,
    );
    const customerId =
      profile.customer?.customer_id ||
      lead.customerId ||
      lead.customer_id ||
      null;
    const row = {
      _id: new ObjectId(),
      appraisalId,
      leadId: id(lead),
      customerId,
      customerName: lead.name,
      customerPhone: lead.phone || "",
      customerEmail: lead.email || "",
      site,
      consultantId: lead.owner_user_id || user.id,
      consultantName:
        lead.allocatedPersonFullName || lead.owner_name || user.name,
      createdBy: user.id,
      status: "Draft",
      ppsrStatus: "Pending",
      media: [],
      condition: {},
      valuation: {},
      revision: 0,
      ...patch,
      createdAt: now,
      updatedAt: now,
    };
    await this.lead
      .collection("appraisals")
      .updateOne({ appraisalId }, { $setOnInsert: row }, { upsert: true });
    await this.audit(
      row,
      user,
      "Appraisal created",
      `${row.appraisalId} · ${row.rego || "Registration pending"}`,
      { eventKey: `appraisal-created:${appraisalId}` },
    );
    return policy.view(await this.record(appraisalId, user), user);
  }
  async update(row, patch, revision, user, action, body, extraFilter = {}) {
    if (
      !Number.isInteger(revision) ||
      revision < 0 ||
      revision !== (row.revision || 0)
    )
      fail(409, "This appraisal changed. Refresh before saving.");
    const version =
      revision === 0
        ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] }
        : { revision };
    const result = await this.lead
      .collection("appraisals")
      .updateOne(
        { $and: [{ _id: row._id }, version, extraFilter] },
        { $set: { ...patch, updatedAt: new Date() }, $inc: { revision: 1 } },
      );
    if (!result.modifiedCount)
      fail(409, "This appraisal changed. Refresh before saving.");
    await this.audit(row, user, action, body);
    return this.record(row.appraisalId, user);
  }
  async patch(value, input, user) {
    const row = await this.record(value, user);
    if (["Approved", "Traded", "Lost", "Declined"].includes(row.status))
      fail(409, "A manager must reopen this appraisal before editing.");
    const patch = policy.details(input, user);
    if (patch.condition)
      patch.condition = { ...row.condition, ...patch.condition };
    if (patch.valuation)
      patch.valuation = { ...row.valuation, ...patch.valuation };
    if (
      (patch.vin && patch.vin !== row.vin) ||
      (patch.rego && patch.rego !== row.rego) ||
      (patch.state && patch.state !== row.state)
    ) {
      patch.ppsrStatus = "Pending";
      patch.ppsrDetails = null;
      patch.vehicleVerification = null;
    }
    return policy.view(
      await this.update(
        row,
        patch,
        input.revision,
        user,
        "Appraisal updated",
        "Vehicle, condition or valuation details updated.",
      ),
      user,
    );
  }
  async status(value, input, user) {
    const row = await this.record(value, user),
      next = input.status;
    const transitions = {
      Draft: ["Pending Inspection"],
      "Pending Inspection": ["Draft", "Completed"],
      Completed: ["Pending Inspection", "Approved", "Declined"],
      Approved: ["Pending Inspection", "Traded", "Lost"],
      Declined: ["Pending Inspection"],
      Traded: [],
      Lost: ["Pending Inspection"],
    };
    if (!transitions[row.status || "Draft"]?.includes(next))
      fail(400, "Invalid appraisal status transition.");
    if (
      ["Approved", "Declined", "Traded", "Lost"].includes(next) ||
      ["Approved", "Declined", "Lost"].includes(row.status)
    )
      policy.manager(user);
    if (next === "Completed" && policy.completion(row).length)
      fail(400, `Complete: ${policy.completion(row).join(", ")}.`);
    if (row.activeDriveId || (row.loanCar?.isSigned && !row.loanCar.returnedAt))
      fail(409, "Finish the active drive and return the loan vehicle first.");
    if (
      next === "Approved" &&
      !Number.isFinite(row.valuation?.tradeInAllowance)
    )
      fail(400, "A manager must enter the trade allowance before approval.");
    if (next === "Traded" && !row.dealId && !row.opportunityId)
      fail(400, "Link the deal before marking this vehicle traded.");
    const patch = {
      status: next,
      statusNote: policy.text(input.notes),
      ...(next === "Approved"
        ? {
            approval: {
              userId: user.id,
              name: user.name,
              at: new Date(),
              notes: policy.text(input.notes),
            },
          }
        : {}),
    };
    const saved = await this.update(
      row,
      patch,
      input.revision,
      user,
      `Appraisal ${next.toLowerCase()}`,
      `${row.appraisalId} · ${policy.text(input.notes)}`,
    );
    if (next === "Approved" || next === "Traded") await this.propagate(saved);
    return policy.view(saved, user);
  }
  async propagate(row) {
    const trade = {
      appraisalId: row.appraisalId,
      rego: row.rego,
      vin: row.vin,
      make: row.make,
      model: row.model,
      year: row.year,
      allowance: row.valuation?.tradeInAllowance,
      ppsrStatus: row.ppsrDetails?.verified ? row.ppsrStatus : "Pending",
    };
    if (row.leadId)
      await this.lead
        .collection("leads")
        .updateOne(
          { _id: ref(row.leadId) },
          {
            $set: {
              "tradeIn.appraisalId": row.appraisalId,
              "tradeIn.rego": row.rego,
              "tradeIn.vin": row.vin,
              "tradeIn.status": row.status,
            },
          },
        );
    if (row.customerId)
      await this.panel
        .collection("customers")
        .updateOne(
          { customer_id: row.customerId },
          { $addToSet: { appraisalIds: row.appraisalId } },
        );
    if (row.dealId)
      await this.lead.collection("deals").updateOne(
        { _id: ref(row.dealId) },
        {
          $set: {
            appraisalId: row.appraisalId,
            ...Object.fromEntries(
              Object.entries(trade)
                .filter(([key]) => key !== "allowance")
                .map(([key, value]) => [`tradeIn.${key}`, value]),
            ),
          },
        },
      );
    if (row.deliveryId)
      await this.panel
        .collection("clients")
        .updateOne(
          { _id: ref(row.deliveryId) },
          { $addToSet: { appraisalIds: row.appraisalId } },
        );
  }
  async link(value, input, user) {
    const row = await this.record(value, user),
      patch = {};
    if (["Lost", "Declined", "Traded"].includes(row.status))
      fail(409, "A closed appraisal cannot be relinked.");
    if (input.dealId) {
      const deal = await this.floor.record("deals", input.dealId, user);
      if (
        id(deal.leadId) !== row.leadId ||
        siteKey(deal.site || deal.dealer) !== siteKey(row.site)
      )
        fail(400, "Choose a deal for this customer and site.");
      if (deal.appraisalId && deal.appraisalId !== row.appraisalId)
        fail(409, "The deal already has another appraisal.");
      if (row.dealId && row.dealId !== id(deal))
        fail(409, "This appraisal is already linked to a different deal.");
      patch.dealId = id(deal);
    }
    if (input.deliveryId) {
      const client = await this.floor.record("clients", input.deliveryId, user);
      if (
        !row.customerId ||
        (client.customer_id || client.crm_customer_id) !== row.customerId ||
        siteKey(client.site_location || client.site) !== siteKey(row.site)
      )
        fail(400, "Choose the delivery for this canonical customer and site.");
      if (row.deliveryId && row.deliveryId !== id(client))
        fail(409, "This appraisal is already linked to another delivery.");
      patch.deliveryId = id(client);
    }
    if (!Object.keys(patch).length)
      fail(400, "Choose a deal or delivery to link.");
    const saved = await this.update(
      row,
      patch,
      input.revision,
      user,
      "Appraisal linked",
      "Inspection linked to the customer deal or delivery.",
    );
    await this.propagate(saved);
    return policy.view(saved, user);
  }
  async check(value, type, input, user) {
    const row = await this.record(value, user);
    if (["Approved", "Traded", "Lost", "Declined"].includes(row.status))
      fail(409, "Reopen the appraisal before vehicle checks.");
    if (input.revision !== (row.revision || 0))
      fail(409, "Refresh the appraisal before checking.");
    // The existing vehicle service authorises linked customers before any paid request,
    // persists its stable request ID, and rejects fabricated/sandbox provider results.
    let result;
    try {
      result = await vehicle.run(
        this.floor,
        type,
        {
          requestId: input.requestId,
          leadId: row.leadId,
          dealId: row.dealId,
          site: row.site,
          rego: row.rego,
          state: row.state || "VIC",
          vin: row.vin,
        },
        user,
      );
    } catch (error) {
      if (type === "ppsr" && error.statusCode >= 500)
        await this.lead
          .collection("appraisals")
          .updateOne(
            { _id: row._id, revision: row.revision || 0 },
            {
              $set: {
                ppsrStatus: "Error",
                ppsrDetails: null,
                updatedAt: new Date(),
              },
              $inc: { revision: 1 },
            },
          );
      throw error;
    }
    const sameVehicle = result.vin === row.vin;
    const patch =
      type === "rego"
        ? {
            ...Object.fromEntries(
              ["rego", "state", "vin", "make", "model", "year", "colour"].map(
                (k) => [k, result[k]],
              ),
            ),
            ppsrStatus: sameVehicle ? row.ppsrStatus || "Pending" : "Pending",
            ppsrDetails: sameVehicle ? row.ppsrDetails || null : null,
            vehicleVerification: result,
          }
        : { ppsrStatus: result.status, ppsrDetails: result };
    return policy.view(
      await this.update(
        row,
        patch,
        input.revision,
        user,
        type === "rego" ? "Registration verified" : "PPSR checked",
        type === "rego" ? result.vin : result.status,
      ),
      user,
    );
  }
  async upload(value, input, bytes, contentType, user) {
    const row = await this.record(value, user);
    if (["Approved", "Traded", "Lost", "Declined"].includes(row.status))
      fail(409, "Reopen the appraisal before adding evidence.");
    const purpose = input.purpose || "inspection";
    if (
      !["inspection", "document", "licence", "signature", "contract"].includes(
        purpose,
      )
    )
      fail(400, "Invalid attachment purpose.");
    if (purpose === "contract") policy.manager(user);
    let metadata;
    if (
      contentType === "application/pdf" &&
      ["document", "contract"].includes(purpose)
    ) {
      if (
        bytes.length < 5 ||
        bytes.length > 20 * 1024 * 1024 ||
        bytes.toString("ascii", 0, 5) !== "%PDF-"
      )
        fail(400, "Upload a PDF smaller than 20 MB.");
      metadata = { kind: "document", extension: "pdf", contentType };
    } else metadata = media.inspect(bytes, contentType);
    if (purpose === "inspection" && !policy.SHOTS.includes(input.shot))
      fail(400, "Choose a guided inspection view.");
    if (["licence", "signature"].includes(purpose) && metadata.kind !== "image")
      fail(400, "Upload an image for the signature or licence.");
    if (
      purpose === "signature" &&
      (contentType !== "image/png" || bytes.length > 512 * 1024)
    )
      fail(400, "Use a drawn PNG signature smaller than 512 KB.");
    if ((row.media || []).length >= 100)
      fail(400, "This appraisal already has 100 attachments.");
    const _id = new ObjectId(),
      filename = `${_id}.${metadata.extension}`;
    await fs.mkdir(directory(), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(directory(), filename), bytes, {
      flag: "wx",
      mode: 0o600,
    });
    const record = {
      _id,
      ...metadata,
      purpose,
      shot: policy.text(input.shot, 80),
      appraisalId: row.appraisalId,
      site: row.site,
      filename,
      name: policy.text(input.name, 180) || filename,
      bytes: bytes.length,
      sha256: hash(bytes),
      createdAt: new Date(),
      owner_user_id: user.id,
    };
    await this.panel.collection("appraisal_media").insertOne(record);
    const summary = {
      id: id(_id),
      kind: record.kind,
      purpose,
      shot: record.shot,
      name: record.name,
      bytes: bytes.length,
      contentType,
      sha256: record.sha256,
      durationSeconds: record.durationSeconds,
      createdAt: record.createdAt,
    };
    const result = await this.lead
      .collection("appraisals")
      .updateOne(
        { _id: row._id, status: row.status },
        {
          $push: { media: summary },
          $inc: { revision: 1 },
          $set: { updatedAt: new Date() },
        },
      );
    if (!result.modifiedCount)
      fail(
        409,
        "The appraisal was closed while uploading. The evidence is retained; refresh and reopen it.",
      );
    await this.audit(
      row,
      user,
      "Appraisal attachment added",
      `${purpose} · ${record.shot || record.name}`,
    );
    return policy.view(await this.record(row.appraisalId, user), user);
  }
  async attachment(value, user) {
    const file = await this.panel
      .collection("appraisal_media")
      .findOne({ _id: ref(value) });
    if (!file) fail(404, "Attachment not found.");
    await this.record(file.appraisalId, user);
    return { ...file, path: path.join(directory(), file.filename) };
  }
  async drive(value, input, user, finish = false) {
    const row = await this.record(value, user);
    if (["Traded", "Lost", "Declined"].includes(row.status))
      fail(409, "This appraisal is closed.");
    const odometer = Number(input.odometer);
    if (!Number.isInteger(odometer) || odometer < 0 || odometer > 10000000)
      fail(400, "Enter a valid odometer reading.");
    const drives = [...(row.drives || [])];
    let patch;
    if (finish) {
      const at = drives.findIndex((d) => d.id === row.activeDriveId);
      if (at < 0) fail(409, "There is no active drive.");
      if (drives[at].driverId !== user.id && !p.isManager(user))
        fail(403, "Only the driver or a manager can end this drive.");
      if (odometer < drives[at].startOdometer)
        fail(400, "The return odometer cannot be lower than the start.");
      drives[at] = {
        ...drives[at],
        endOdometer: odometer,
        endedAt: new Date(),
        endNotes: policy.text(input.notes),
        distanceKm: odometer - drives[at].startOdometer,
      };
      patch = { drives, activeDriveId: null, odometer };
    } else {
      if (row.activeDriveId) fail(409, "A drive is already active.");
      if (!row.vin || !row.rego)
        fail(400, "Record the vehicle identity before a drive.");
      if (odometer < (row.odometer || 0))
        fail(
          400,
          "The start reading cannot be lower than the recorded odometer.",
        );
      const driveId = crypto.randomUUID();
      drives.push({
        id: driveId,
        driverId: user.id,
        driverName: user.name,
        startedAt: new Date(),
        startOdometer: odometer,
        notes: policy.text(input.notes),
      });
      patch = { drives, activeDriveId: driveId };
    }
    return policy.view(
      await this.update(
        row,
        patch,
        input.revision,
        user,
        finish ? "Inspection drive returned" : "Inspection drive started",
        `${odometer} km`,
      ),
      user,
    );
  }
  async signLoan(value, input, user) {
    const row = await this.record(value, user);
    if (["Approved", "Traded", "Lost", "Declined"].includes(row.status))
      fail(409, "Reopen this appraisal before signing a new loan agreement.");
    if (row.loanCar?.isSigned && !row.loanCar.returnedAt)
      fail(409, "Return the current loan vehicle first.");
    if (
      !policy.text(input.signatureName, 150) ||
      !policy.text(input.loanCarRego, 20) ||
      !policy.text(input.loanCarModel, 150) ||
      !policy.text(input.terms, 10000) ||
      input.consent !== true
    )
      fail(
        400,
        "Customer name, loan vehicle, displayed terms and consent are required.",
      );
    const signature = await this.attachment(input.signatureMediaId, user);
    if (
      signature.appraisalId !== row.appraisalId ||
      signature.purpose !== "signature"
    )
      fail(400, "Use a drawn signature attached to this appraisal.");
    if (
      [row.loanCar, ...(row.loanHistory || [])].some(
        (loan) => loan?.signatureMediaId === id(signature),
      )
    )
      fail(400, "Capture a new customer signature for this loan agreement.");
    const loanCar = {
      isRequired: true,
      isSigned: true,
      signedBy: policy.text(input.signatureName, 150),
      signedAt: new Date(),
      loanCarRego: policy.text(input.loanCarRego, 20).toUpperCase(),
      loanCarModel: policy.text(input.loanCarModel, 150),
      terms: policy.text(input.terms, 10000),
      termsHash: hash(policy.text(input.terms, 10000)),
      signatureMediaId: id(signature),
      notes: policy.text(input.notes),
      witnessedBy: user.name,
      witnessId: user.id,
    };
    return policy.view(
      await this.update(
        row,
        {
          loanCar,
          loanHistory: [
            ...(row.loanHistory || []),
            ...(row.loanCar?.isSigned ? [row.loanCar] : []),
          ],
        },
        input.revision,
        user,
        "Loan vehicle signed out",
        `${loanCar.loanCarRego} · ${loanCar.signedBy}`,
      ),
      user,
    );
  }
  async returnLoan(value, input, user) {
    const row = await this.record(value, user);
    if (!row.loanCar?.isSigned || row.loanCar.returnedAt)
      fail(409, "No loan vehicle is checked out.");
    return policy.view(
      await this.update(
        row,
        {
          loanCar: {
            ...row.loanCar,
            returnedAt: new Date(),
            returnedBy: user.name,
            returnNotes: policy.text(input.notes),
          },
        },
        input.revision,
        user,
        "Loan vehicle returned",
        row.loanCar.loanCarRego,
      ),
      user,
    );
  }
  async partners(query, user) {
    policy.access(user);
    const filter = this.scope(
      { ...user, role: p.isManager(user) ? user.role : "sales_manager" },
      query,
    );
    const conditions = [filter];
    if (query.q)
      conditions.push({
        $or: ["name", "company", "email", "phone"].map((key) => ({
          [key]: new RegExp(p.literal(String(query.q).slice(0, 100)), "i"),
        })),
      });
    const page = Math.max(1, Math.floor(Number(query.page) || 1)),
      limit = 50,
      scope = { $and: conditions };
    const [data, total] = await Promise.all([
      this.panel
        .collection("appraisal_partners")
        .find(scope)
        .sort({ company: 1, name: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      this.panel.collection("appraisal_partners").countDocuments(scope),
    ]);
    return {
      data,
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }
  async savePartner(input, user, value) {
    policy.manager(user);
    policy.access(user);
    const site = this.floor.site(user, input.site);
    if (
      !policy.text(input.name, 150) ||
      !["dealer", "wholesaler", "dealer_staff"].includes(input.kind)
    )
      fail(400, "Partner name and type are required.");
    const email = policy.text(input.email, 250).toLowerCase(),
      phone = policy.text(input.phone, 40);
    if (
      (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ||
      (!email && !phone)
    )
      fail(400, "Enter a valid email or phone.");
    if (value) {
      const existing = await this.panel
        .collection("appraisal_partners")
        .findOne({ $and: [this.scope(user), { _id: ref(value) }] });
      if (!existing || siteKey(existing.site) !== siteKey(site))
        fail(404, "Partner not found at this site.");
    }
    const _id = value ? ref(value) : new ObjectId();
    const patch = {
      name: policy.text(input.name, 150),
      kind: input.kind,
      company: policy.text(input.company, 200),
      email,
      phone,
      site,
      address: policy.text(input.address, 500),
      licence: policy.text(input.licence, 100),
      abn: policy.text(input.abn, 30),
      notes: policy.text(input.notes, 5000),
      active: input.active !== false,
      updatedAt: new Date(),
      updatedBy: user.id,
    };
    await this.panel
      .collection("appraisal_partners")
      .updateOne(
        { _id },
        {
          $set: patch,
          $setOnInsert: { createdAt: new Date(), createdBy: user.id },
        },
        { upsert: true },
      );
    return { _id, ...patch };
  }
  async invite(value, input, user) {
    policy.manager(user);
    const row = await this.record(value, user);
    if (!["Completed", "Approved"].includes(row.status))
      fail(409, "Complete the inspection before inviting valuations.");
    if (
      !Array.isArray(input.partnerIds) ||
      !input.partnerIds.length ||
      input.partnerIds.length > 50
    )
      fail(400, "Choose 1–50 partners.");
    const expiresAt = new Date(input.expiresAt);
    if (
      !Number.isFinite(+expiresAt) ||
      +expiresAt <= Date.now() ||
      +expiresAt > Date.now() + 30 * 86400000
    )
      fail(400, "Choose a bid deadline within 30 days.");
    const base = process.env.APPRAISAL_WEB_URL || process.env.FRONTEND_URL;
    if (!base || !/^https:\/\//.test(base))
      fail(
        503,
        "Configure APPRAISAL_WEB_URL with the Sales Floor HTTPS address.",
      );
    const partners = [];
    for (const partnerId of [...new Set(input.partnerIds.map(String))]) {
      const partner = await this.panel
        .collection("appraisal_partners")
        .findOne({ _id: ref(partnerId), active: true });
      if (
        !partner ||
        partner.kind === "dealer_staff" ||
        siteKey(partner.site) !== siteKey(row.site)
      )
        fail(400, "Choose active dealer/wholesaler contacts from this site.");
      partners.push(partner);
    }
    const invitations = [];
    for (const partner of partners) {
      const token = crypto.randomBytes(32).toString("base64url"),
        _id = new ObjectId();
      await this.panel
        .collection("appraisal_invitations")
        .insertOne({
          _id,
          appraisalId: row.appraisalId,
          site: row.site,
          partnerId: id(partner),
          partnerName: partner.name,
          company: partner.company,
          tokenHash: hash(token),
          expiresAt,
          status: "Open",
          createdAt: new Date(),
          createdBy: user.id,
          notes: policy.text(input.notes),
          revision: 0,
        });
      invitations.push({
        id: id(_id),
        partnerName: partner.name,
        url: `${base.replace(/\/$/, "")}/appraisal-offer/${_id}#${token}`,
        expiresAt,
      });
    }
    await this.audit(
      row,
      user,
      "Wholesale invitations prepared",
      `${partners.length} private valuation links created. Staff must share each link with its intended recipient.`,
    );
    return invitations;
  }
  async offers(value, user) {
    policy.manager(user);
    const row = await this.record(value, user);
    return (
      await this.panel
        .collection("appraisal_invitations")
        .find({ appraisalId: row.appraisalId })
        .sort({ createdAt: -1 })
        .toArray()
    ).map(({ tokenHash, ...offer }) => offer);
  }
  async invitation(value, token) {
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(String(token || "")))
      fail(404, "Valuation link not found.");
    const invite = await this.panel
      .collection("appraisal_invitations")
      .findOne({ _id: ref(value), tokenHash: hash(token) });
    if (
      !invite ||
      +new Date(invite.expiresAt) <= Date.now() ||
      invite.status === "Revoked"
    )
      fail(410, "This valuation link has expired or been revoked.");
    const row = await this.lead
      .collection("appraisals")
      .findOne({ appraisalId: invite.appraisalId, site: invite.site });
    if (!row || !["Completed", "Approved"].includes(row.status))
      fail(410, "This vehicle is no longer accepting valuations.");
    return { invite, row };
  }
  publicView(invite, row) {
    const {
      _id,
      partnerName,
      company,
      expiresAt,
      status,
      bid,
      revision,
      notes,
    } = invite;
    return {
      invitation: {
        id: id(_id),
        partnerName,
        company,
        expiresAt,
        status,
        bid,
        revision,
        notes,
      },
      vehicle: Object.fromEntries(
        [
          "rego",
          "state",
          "vin",
          "make",
          "model",
          "year",
          "odometer",
          "colour",
          "transmission",
          "fuelType",
          "variant",
          "serviceHistory",
          "keys",
        ].map((key) => [key, row[key]]),
      ),
      condition: row.condition
        ? {
            notes: row.condition.notes,
            exteriorRating: row.condition.exteriorRating,
            interiorRating: row.condition.interiorRating,
            tyresRating: row.condition.tyresRating,
            mechanicalRating: row.condition.mechanicalRating,
            damagePoints: (row.condition.damagePoints || [])
              .filter((f) => f.decision !== "dismissed")
              .map((f) => ({
                panel: f.panel,
                severity: f.severity,
                description: f.description,
              })),
          }
        : {},
      media: (row.media || [])
        .filter((m) => m.purpose === "inspection")
        .map((m) => ({
          id: m.id,
          kind: m.kind,
          shot: m.shot,
          contentType: m.contentType,
        })),
      selected: row.selectedOffer?.invitationId === id(_id),
      closed: !!row.selectedOffer,
    };
  }
  async bid(value, token, input) {
    const { invite, row } = await this.invitation(value, token);
    if (row.selectedOffer || invite.status !== "Open")
      fail(409, "Valuations are closed.");
    if (input.revision !== invite.revision)
      fail(409, "Your offer changed. Refresh before submitting.");
    const amount = policy.money(input.amount, "offer amount");
    if (amount <= 0) fail(400, "Enter an offer greater than zero.");
    const bid = {
      amount,
      notes: policy.text(input.notes),
      submittedAt: new Date(),
    };
    const result = await this.panel
      .collection("appraisal_invitations")
      .updateOne(
        {
          _id: invite._id,
          revision: input.revision,
          status: "Open",
          expiresAt: { $gt: new Date() },
        },
        { $set: { bid }, $inc: { revision: 1 }, $push: { history: bid } },
      );
    if (!result.modifiedCount)
      fail(409, "Your offer changed or the valuation closed.");
    return { ...bid, revision: input.revision + 1 };
  }
  async selectOffer(value, input, user) {
    policy.manager(user);
    const row = await this.record(value, user);
    if (!["Completed", "Approved"].includes(row.status))
      fail(
        409,
        "Complete the appraisal before selecting a wholesale valuation.",
      );
    if (row.selectedOffer) fail(409, "An offer has already been selected.");
    const offer = await this.panel
      .collection("appraisal_invitations")
      .findOne({
        _id: ref(input.invitationId),
        appraisalId: row.appraisalId,
        status: "Open",
      });
    if (!offer?.bid || +new Date(offer.expiresAt) <= Date.now())
      fail(400, "Choose a current received offer.");
    if (input.offerRevision !== offer.revision)
      fail(409, "The wholesale offer changed. Refresh before selecting it.");
    const frozen = await this.panel
      .collection("appraisal_invitations")
      .updateOne(
        { _id: offer._id, status: "Open", revision: input.offerRevision },
        { $set: { status: "Selected" } },
      );
    if (!frozen.modifiedCount)
      fail(409, "The wholesale offer changed. Refresh before selecting it.");
    const selectedOffer = {
      invitationId: id(offer),
      partnerId: offer.partnerId,
      partnerName: offer.partnerName,
      amount: offer.bid.amount,
      selectedAt: new Date(),
      selectedBy: user.id,
    };
    try {
      const saved = await this.update(
        row,
        {
          selectedOffer,
          valuation: { ...row.valuation, wholesaleValue: offer.bid.amount },
        },
        input.revision,
        user,
        "Wholesale valuation selected",
        `${offer.partnerName} · internal valuation recorded.`,
      );
      return policy.view(saved, user);
    } catch (error) {
      const latest = await this.lead
        .collection("appraisals")
        .findOne({ _id: row._id });
      if (latest?.selectedOffer?.invitationId !== id(offer))
        await this.panel
          .collection("appraisal_invitations")
          .updateOne(
            {
              _id: offer._id,
              status: "Selected",
              revision: input.offerRevision,
            },
            { $set: { status: "Open" } },
          );
      throw error;
    }
  }
  async revoke(value, invitationId, user) {
    policy.manager(user);
    const row = await this.record(value, user);
    if (row.selectedOffer?.invitationId === invitationId)
      fail(409, "The selected offer cannot be revoked.");
    const result = await this.panel
      .collection("appraisal_invitations")
      .updateOne(
        { _id: ref(invitationId), appraisalId: row.appraisalId },
        {
          $set: {
            status: "Revoked",
            revokedAt: new Date(),
            revokedBy: user.id,
          },
        },
      );
    if (!result.modifiedCount) fail(404, "Invitation not found.");
    return { revoked: true };
  }
  async report(query, user) {
    policy.manager(user);
    const scope = this.scope(user, query),
      collection = this.lead.collection("appraisals");
    const counts = await Promise.all(
      policy.STATUSES.map(async (status) => ({
        status,
        count: await collection.countDocuments({ $and: [scope, { status }] }),
      })),
    );
    const total = await collection.countDocuments(scope),
      traded = counts.find((c) => c.status === "Traded").count;
    return {
      total,
      statuses: counts,
      conversionRate: total ? Math.round((traded / total) * 1000) / 10 : null,
      updatedAt: new Date(),
    };
  }
  async archive(query, user) {
    policy.manager(user);
    const scope = this.scope(user, query);
    const groupAccess = user.all_sites && !user.locked_site && /^all(?:\s|$)/i.test(query.site || user.site || '');
    const conditions = [groupAccess ? { $or: [scope, { kind: 'dealer_staff', sourceAccount: 'BYD Melbourne', site: 'BYD Melbourne (source group)' }] } : scope];
    if (query.q)
      conditions.push({
        $or: ["rego", "vin", "customerName", "make", "model", "sourceId"].map(
          (key) => ({
            [key]: new RegExp(p.literal(String(query.q).slice(0, 100)), "i"),
          }),
        ),
      });
    const filter = { $and: conditions },
      page = Math.max(1, Math.floor(Number(query.page) || 1)),
      limit = 25;
    const [data, total] = await Promise.all([
      this.panel
        .collection("iappraise_archive")
        .find(filter)
        .sort({ sourceRow: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      this.panel.collection("iappraise_archive").countDocuments(filter),
    ]);
    return {
      data,
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }
  async archiveAttachment(archiveId, mediaId, user) {
    policy.manager(user);
    const record = await this.panel
      .collection("iappraise_archive")
      .findOne({ $and: [this.scope(user), { _id: String(archiveId) }] });
    const media = record?.media?.find((file) => file.id === String(mediaId));
    if (!media || !/^[a-f0-9]{64}$/.test(media.filename))
      fail(404, "Archived attachment not found.");
    if (!process.env.IAPPRAISE_ARCHIVE_DIR)
      fail(503, "Persistent source archive storage is not configured.");
    return {
      ...media,
      kind: "document",
      path: path.join(
        path.resolve(process.env.IAPPRAISE_ARCHIVE_DIR),
        media.filename,
      ),
    };
  }
}
module.exports = { AppraisalCentre, directory, hash, ref };
