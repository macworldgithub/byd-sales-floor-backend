// Helper: Calculate lead score
function calculateScore(lead, hasTestDrive) {
  const status = (lead.status || "").toUpperCase();
  const stage = (lead.stage || "").toLowerCase();
  if (/LOST|CANCEL/.test(status)) return 20;
  if (status.includes("ORDER") || status.includes("SIGNED") || status.includes("FINALISE") || stage === "complete" || stage === "deal") {
    return 95;
  }
  if (hasTestDrive) return 92;
  if (stage === "in_contact" || status.includes("BOOKING") || status.includes("VALUATION")) {
    return 78;
  }
  if (stage === "assigned") {
    return 65;
  }
  return 55;
}

// Helper: Map lead tag
function mapTag(lead, hasTestDrive) {
  const status = (lead.status || "").toUpperCase();
  const stage = (lead.stage || "").toLowerCase();
  if (/LOST|CANCEL/.test(status)) return "Contact";
  if (hasTestDrive) return "Commitment";
  if (status.includes("ORDER") || status.includes("SIGNED") || status.includes("FINALISE") || stage === "deal" || stage === "complete") {
    return "Commitment";
  }
  if (lead.assignedTo && lead.assignedTo !== "Not Assigned") return "Human assisted";
  return "Contact";
}

// Helper: Map lead color
function mapColor(lead, hasTestDrive) {
  const status = (lead.status || "").toUpperCase();
  const stage = (lead.stage || "").toLowerCase();
  if (/LOST|CANCEL/.test(status)) return "red";
  if (hasTestDrive) return "green";
  if (status.includes("ORDER") || status.includes("SIGNED") || status.includes("FINALISE") || stage === "deal" || stage === "complete") {
    return "green";
  }
  if (stage === "in_contact" || lead.tab === "follow_up") return "amber";
  return "blue";
}

// Helper: Map pipeline stage
function mapStage(lead, hasTestDrive) {
  const status = (lead.status || "").toUpperCase();
  const stage = (lead.stage || "").toLowerCase();
  if (/LOST|CANCEL/.test(status)) return "LOST";
  if (status.includes("ORDER") || status.includes("SIGNED") || status.includes("FINALISE") || stage === "complete") return "DELIVERED";
  if (hasTestDrive || status.includes("BOOKING") || status.includes("TEST DRIVE")) return "TEST DRIVE BOOKED";
  if (stage === "in_contact" || stage === "assigned") return "IN FOLLOW-UP";
  return "NEW ENQUIRIES";
}

// Helper: Map status
function mapStatus(lead, hasTestDrive) {
  const status = (lead.status || "").toUpperCase();
  const stage = (lead.stage || "").toLowerCase();
  if (/LOST|CANCEL/.test(status)) return "lost";
  if (status.includes("ORDER") || status.includes("SIGNED") || status.includes("FINALISE") || stage === "complete") return "sold";
  if (hasTestDrive) return "committed";
  if (stage === "in_contact" || stage === "assigned") return "qualification";
  return "new";
}

module.exports = { calculateScore, mapTag, mapColor, mapStage, mapStatus };
