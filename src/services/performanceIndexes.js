// The candidate predicates in siteScope can use these indexes while the
// authoritative-field expression remains the final access check.
async function ensurePerformanceIndexes(lead, panel) {
  const definitions = [
    [lead, 'leads', ['dealer', 'site', 'dealerName']],
    [lead, 'appointments', ['site', 'dealership', 'location']],
    [lead, 'inventories', ['location', 'yard', 'site']],
    [lead, 'deals', ['dealer', 'site', 'dealership']],
    [panel, 'clients', ['site_location', 'site', 'location', 'dealer']],
    [panel, 'opportunities', ['site', 'location', 'dealer']],
  ];
  const failures = [];
  // Avoid an index-build burst on the shared cluster.
  for (const [db, collection, fields] of definitions) {
    const existing = await db.collection(collection).listIndexes().toArray().catch(error => {
      if (error.code === 26) return [];
      throw error;
    });
    for (const field of fields) {
      if (existing.some(index => Object.keys(index.key).length === 1 && index.key[field] === 1)) continue;
      try { await db.collection(collection).createIndex({ [field]: 1 }); }
      catch (error) { failures.push({ collection, field, code: error.code }); }
    }
  }
  if (failures.length) console.warn('Performance indexes could not be created:', JSON.stringify(failures));
  return { failed: failures.length };
}
module.exports = { ensurePerformanceIndexes };
