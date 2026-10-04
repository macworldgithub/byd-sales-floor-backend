const mongoose = require('mongoose');
require('dotenv').config();

async function run() {
  const dConn = await mongoose.createConnection(process.env.DELIVERY_CENTER_MONGO_URI).asPromise();
  const lConn = await mongoose.createConnection(process.env.LEAD_CENTER_MONGO_URI).asPromise();
  const nRegex = /nunawading/i;

  console.log('=== LEAD DB: byd-leads-new ===');
  // Appointments
  const appColl = lConn.db.collection('appointments');
  const appSample = await appColl.findOne();
  console.log('Appointment sample keys:', Object.keys(appSample || {}));
  const appNunawading = await appColl.find({
    $or: [
      { dealership: nRegex },
      { location: nRegex },
      { site: nRegex },
      { yard: nRegex },
      { dealership_name: nRegex },
      { notes: nRegex }
    ]
  }).toArray();
  console.log('Appointments matching Nunawading count:', appNunawading.length);
  if (appNunawading.length > 0) {
    console.log('Sample appt for Nunawading:', JSON.stringify({
      id: appNunawading[0]._id,
      dealership: appNunawading[0].dealership,
      location: appNunawading[0].location,
      customer_name: appNunawading[0].customer_name,
      status: appNunawading[0].status,
      appointment_date: appNunawading[0].appointment_date || appNunawading[0].date
    }, null, 2));
  }
  console.log('Appointments distinct dealerships:', await appColl.distinct('dealership'));
  console.log('Appointments distinct locations:', await appColl.distinct('location'));

  // Leads
  const leadsColl = lConn.db.collection('leads');
  const leadNunawading = await leadsColl.countDocuments({
    $or: [
      { dealership: nRegex },
      { location: nRegex },
      { site: nRegex },
      { yard: nRegex }
    ]
  });
  console.log('Leads matching Nunawading count:', leadNunawading);
  console.log('Leads distinct dealerships:', await leadsColl.distinct('dealership'));

  // Inventories
  const invColl = lConn.db.collection('inventories');
  const invNunawading = await invColl.countDocuments({
    $or: [{ yard: nRegex }, { location: nRegex }, { site: nRegex }, { dealer: nRegex }]
  });
  console.log('Inventories matching Nunawading count:', invNunawading);
  console.log('Inventories distinct yards:', await invColl.distinct('yard'));

  console.log('\n=== DELIVERY DB: byd-panel ===');
  // Clients (used by Delivery Watch)
  const clientColl = dConn.db.collection('clients');
  const clientSample = await clientColl.findOne();
  console.log('Client sample keys:', Object.keys(clientSample || {}));
  const clientNunawading = await clientColl.find({
    $or: [
      { site: nRegex },
      { yard: nRegex },
      { location: nRegex },
      { dealer: nRegex },
      { department: nRegex },
      { 'vehicle.yard': nRegex }
    ]
  }).toArray();
  console.log('Clients (Delivery Watch) matching Nunawading count:', clientNunawading.length);
  if (clientNunawading.length > 0) {
    console.log('Sample client for Nunawading:', JSON.stringify({
      name: clientNunawading[0].name,
      site: clientNunawading[0].site,
      location: clientNunawading[0].location,
      department: clientNunawading[0].department,
      stage: clientNunawading[0].stage,
      vehicle: clientNunawading[0].vehicle
    }, null, 2));
  }
  console.log('Clients distinct site:', await clientColl.distinct('site'));
  console.log('Clients distinct department:', await clientColl.distinct('department'));
  console.log('Clients distinct location:', await clientColl.distinct('location'));
  console.log('Clients distinct dealer:', await clientColl.distinct('dealer'));
  console.log('Clients distinct vehicle.yard:', await clientColl.distinct('vehicle.yard'));

  // Customers
  const custColl = dConn.db.collection('customers');
  const custNunawading = await custColl.find({
    $or: [{ site: nRegex }, { location: nRegex }, { dealer: nRegex }]
  }).toArray();
  console.log('Customers matching Nunawading count:', custNunawading.length);
  if (custNunawading.length > 0) {
    console.log('Sample customer:', JSON.stringify(custNunawading[0], null, 2));
  }
  console.log('Customers distinct site:', await custColl.distinct('site'));

  // Opportunities
  const oppColl = dConn.db.collection('opportunities');
  const oppNunawading = await oppColl.find({
    $or: [{ site: nRegex }, { location: nRegex }, { dealer: nRegex }]
  }).toArray();
  console.log('Opportunities matching Nunawading count:', oppNunawading.length);
  console.log('Opportunities distinct site:', await oppColl.distinct('site'));

  // Sales log
  const salesColl = dConn.db.collection('saleslogentries');
  const salesNunawading = await salesColl.find({
    $or: [{ site: nRegex }, { location: nRegex }, { dealer: nRegex }]
  }).toArray();
  console.log('Sales log matching Nunawading count:', salesNunawading.length);
  console.log('Sales log distinct site:', await salesColl.distinct('site'));

  // Allocations
  const allocColl = dConn.db.collection('allocations');
  const allocNunawading = await allocColl.find({
    $or: [{ site: nRegex }, { location: nRegex }]
  }).toArray();
  console.log('Allocations matching Nunawading count:', allocNunawading.length);
  console.log('Allocations distinct site:', await allocColl.distinct('site'));

  // Stock holds
  const holdColl = dConn.db.collection('stockholds');
  const holdNunawading = await holdColl.find({
    $or: [{ site: nRegex }, { location: nRegex }, { yard: nRegex }]
  }).toArray();
  console.log('Stock holds matching Nunawading count:', holdNunawading.length);
  console.log('Stock holds distinct site:', await holdColl.distinct('site'));

  await dConn.close();
  await lConn.close();
}

run().catch(console.error);
