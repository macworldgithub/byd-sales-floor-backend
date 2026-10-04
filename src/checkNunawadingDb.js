require('dotenv').config();
const { leadConn, deliveryConn, ensureDbConnected } = require('./db');

async function run() {
  await ensureDbConnected();
  console.log('--- Connected to DB ---');

  // Lead DB: appointments
  const apptColl = leadConn.db.collection('appointments');
  console.log('Appointments total:', await apptColl.countDocuments());
  console.log('Appointments dealerships:', await apptColl.distinct('dealership'));
  console.log('Appointments locations:', await apptColl.distinct('location'));
  console.log('Appointments for Nunawading:', await apptColl.countDocuments({
    $or: [
      { site: /nunawading/i },
      { dealership: /nunawading/i },
      { location: /nunawading/i },
      { yard: /nunawading/i },
      { 'vehicle.yard': /nunawading/i },
    ]
  }));

  // Lead DB: leads
  const leadColl = leadConn.db.collection('leads');
  console.log('Leads total:', await leadColl.countDocuments());
  console.log('Leads dealerships:', await leadColl.distinct('dealership'));
  console.log('Leads locations:', await leadColl.distinct('location'));
  console.log('Leads for Nunawading:', await leadColl.countDocuments({
    $or: [
      { dealership: /nunawading/i },
      { location: /nunawading/i },
      { yard: /nunawading/i },
      { site: /nunawading/i }
    ]
  }));

  // Delivery DB: customers
  const custColl = deliveryConn.db.collection('customers');
  console.log('Customers total:', await custColl.countDocuments());
  console.log('Customers sites:', await custColl.distinct('site'));
  console.log('Customers for Nunawading:', await custColl.countDocuments({
    $or: [
      { site: /nunawading/i },
      { yard: /nunawading/i },
      { dealership: /nunawading/i }
    ]
  }));

  // Delivery DB: opportunities
  const oppColl = deliveryConn.db.collection('opportunities');
  console.log('Opportunities total:', await oppColl.countDocuments());
  console.log('Opportunities sites:', await oppColl.distinct('site'));
  console.log('Opportunities for Nunawading:', await oppColl.countDocuments({
    $or: [
      { site: /nunawading/i },
      { yard: /nunawading/i },
      { dealership: /nunawading/i }
    ]
  }));

  // Delivery DB: deliveries/clients
  const clientColl = deliveryConn.db.collection('clients');
  console.log('Clients/Deliveries total:', await clientColl.countDocuments());
  console.log('Clients sites:', await clientColl.distinct('site'));
  console.log('Clients for Nunawading:', await clientColl.countDocuments({
    $or: [
      { site: /nunawading/i },
      { dealer: /nunawading/i },
      { location: /nunawading/i },
      { department: /nunawading/i }
    ]
  }));

  // Delivery DB: saleslogentries
  const salesColl = deliveryConn.db.collection('saleslogentries');
  console.log('Sales log total:', await salesColl.countDocuments());
  console.log('Sales log sites:', await salesColl.distinct('site'));
  console.log('Sales log for Nunawading:', await salesColl.countDocuments({
    $or: [
      { site: /nunawading/i },
      { dealer: /nunawading/i },
      { location: /nunawading/i }
    ]
  }));

  // Delivery DB: allocations
  const allocColl = deliveryConn.db.collection('allocations');
  console.log('Allocations total:', await allocColl.countDocuments());
  console.log('Allocations sites:', await allocColl.distinct('site'));
  console.log('Allocations for Nunawading:', await allocColl.countDocuments({
    $or: [
      { site: /nunawading/i },
      { yard: /nunawading/i }
    ]
  }));

  // Lead DB: inventory
  const invColl = leadConn.db.collection('inventories');
  console.log('Inventories total:', await invColl.countDocuments());
  console.log('Inventories yards:', await invColl.distinct('yard'));
  console.log('Inventories for Nunawading:', await invColl.countDocuments({
    $or: [
      { yard: /nunawading/i },
      { location: /nunawading/i }
    ]
  }));

  process.exit(0);
}
run().catch(console.error);
