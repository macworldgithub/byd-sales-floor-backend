const { fail, siteKey } = require("./accountAccess");
const { id } = require("./salesFloorMobile");
async function forDeal(service, lead, input, user) {
  if (input.withoutAppraisal === true) return null;
  const { AppraisalCentre } = require("./appraisalCentre");
  let row;
  if (input.appraisalId)
    row = await new AppraisalCentre(service.lead, service.panel).record(
      input.appraisalId,
      user,
    );
  else {
    const candidates = await service.lead
      .collection("appraisals")
      .find({
        leadId: id(lead),
        status: { $nin: ["Declined", "Lost", "Traded"] },
      })
      .limit(2)
      .toArray();
    if (candidates.length > 1)
      fail(409, "Choose which trade appraisal belongs to this deal.");
    row = candidates[0];
  }
  if (!row) return null;
  if (
    row.leadId !== id(lead) ||
    siteKey(row.site) !== siteKey(lead.dealer || lead.site)
  )
    fail(400, "The appraisal must belong to this customer and site.");
  if (row.dealId) fail(409, "This appraisal already belongs to a deal.");
  return row;
}
async function attachHandoff(
  lead,
  panel,
  customer,
  opportunity,
  deliveryClientId,
  user,
) {
  const policy = require("./salesFloorPolicy");
  const rows = await lead
    .collection("appraisals")
    .find({
      $and: [
        policy.scope(user, { site: customer.site }, ["site"]),
        {
          customerId: customer.customer_id,
          status: { $in: ["Completed", "Approved"] },
        },
        {
          $or: [
            { opportunityId: { $exists: false } },
            { opportunityId: opportunity.opportunity_id },
          ],
        },
      ],
    })
    .toArray();
  const ids = [];
  for (const row of rows) {
    if (
      row.opportunityId === opportunity.opportunity_id &&
      (!deliveryClientId || row.deliveryId === String(deliveryClientId))
    ) {
      ids.push(row.appraisalId);
      continue;
    }
    const result = await lead
      .collection("appraisals")
      .updateOne(
        {
          _id: row._id,
          $or: [
            { opportunityId: { $exists: false } },
            { opportunityId: opportunity.opportunity_id },
          ],
        },
        {
          $set: {
            opportunityId: opportunity.opportunity_id,
            ...(deliveryClientId
              ? { deliveryId: String(deliveryClientId) }
              : {}),
            updatedAt: new Date(),
          },
          $inc: { revision: 1 },
        },
      );
    if (result.modifiedCount) ids.push(row.appraisalId);
  }
  if (ids.length) {
    await panel
      .collection("opportunities")
      .updateOne(
        { opportunity_id: opportunity.opportunity_id },
        { $addToSet: { appraisalIds: { $each: ids } } },
      );
    if (deliveryClientId) {
      const identity = require("./customerDelivery").identity(deliveryClientId);
      await panel
        .collection("clients")
        .updateOne(
          { $and: [identity, { crm_customer_id: customer.customer_id }] },
          { $addToSet: { appraisalIds: { $each: ids } } },
        );
    }
  }
  return ids;
}
module.exports = { forDeal, attachHandoff };
