const { siteRegex } = require('./staffDirectory');

// site_location is the Delivery Centre dealership. location can be a customer's
// suburb and department can retain the name of the original SalesLogs export.
function clientSiteFilter(site) {
  const regex = siteRegex(site);
  return {
    $or: [
      { site_location: regex },
      {
        $and: [
          { site_location: { $in: [null, ''] } },
          { $or: ['site', 'dealer', 'department', 'location', 'yard', 'vehicle.yard'].map(field => ({ [field]: regex })) },
        ],
      },
    ],
  };
}

module.exports = { clientSiteFilter };
