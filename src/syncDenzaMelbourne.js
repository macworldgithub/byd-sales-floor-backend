require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Cloudinary images for Denza models
const MODEL_IMAGES = {
  'DENZA B5': 'https://res.cloudinary.com/total-dealer/image/upload/v1/production/szv2eg4zgrxvxqnizt1ex9rzjreb.png?_a=BACMTiGT',
  'DENZA B8': 'https://res.cloudinary.com/total-dealer/image/upload/v1/production/hfpheqd5iwino0xbi64935okb9ht.png?_a=BACMTiGT',
  'DENZA D9': 'https://d2s8i866417m9.cloudfront.net/photo/54551264/photo/thumb-3d405ef82b0a7b1a26f6013109f2c764.png',
};

function toIsoDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().split('T')[0];
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function calculateScore(lc) {
  const status = (lc.lead_status || '').toLowerCase();
  if (status.includes('delivered')) return 100;
  if (status.includes('contract') || status.includes('order')) return 95;
  if (lc.has_upcoming_appointment || (lc.event_counts && lc.event_counts.test_drive > 0)) return 90;
  if (status.includes('contact') || status.includes('appointed')) return 75;
  if (status.includes('lost') || status.includes('spam') || status.includes('cancel')) return 20;
  return 60;
}

function mapTag(lc) {
  const status = (lc.lead_status || '').toLowerCase();
  if (status.includes('delivered') || status.includes('contract') || status.includes('order')) return 'Commitment';
  if (status.includes('lost') || status.includes('spam') || status.includes('cancel')) return 'Opted Out';
  if (lc.user_name) return 'Human assisted';
  return 'Contact';
}

function mapStage(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('delivered')) return 'DELIVERED';
  if (s.includes('contract') || s.includes('order') || s.includes('test drive') || s.includes('appointed')) return 'TEST DRIVE BOOKED';
  if (s.includes('lost') || s.includes('cancel')) return 'LOST';
  if (s.includes('spam')) return 'OPTED OUT';
  if (s.includes('contact')) return 'AI QUALIFYING';
  return 'NEW ENQUIRIES';
}

function mapStatus(leadStatus) {
  const s = (leadStatus || '').toLowerCase();
  if (s.includes('delivered')) return 'sold';
  if (s.includes('contract') || s.includes('order')) return 'committed';
  if (s.includes('lost') || s.includes('cancel')) return 'lost';
  if (s.includes('spam')) return 'opted out';
  if (s.includes('contact') || s.includes('appointed')) return 'qualification';
  return 'new';
}

function mapColor(colourName) {
  const c = (colourName || '').toLowerCase();
  if (c === 'green') return 'green';
  if (c === 'yellow' || c === 'amber' || c === 'orange') return 'amber';
  if (c === 'red') return 'red';
  return 'blue';
}

function generateDeterministicUUID(inputStr) {
  const hash = crypto.createHash('md5').update(inputStr).digest('hex');
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    '4' + hash.substring(13, 16),
    '8' + hash.substring(17, 20),
    hash.substring(20, 32),
  ].join('-');
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  console.log(`\n======================================================`);
  console.log(`🚀 SYNC DENZA MELBOURNE DATA [Mode: ${isDryRun ? 'DRY RUN' : 'LIVE EXECUTION'}]`);
  console.log(`======================================================\n`);

  const uriPanel = process.env.DELIVERY_CENTER_MONGO_URI;
  const uriLeads = process.env.LEAD_CENTER_MONGO_URI;

  if (!uriPanel || !uriLeads) {
    throw new Error('Missing database URIs in environment.');
  }

  const panelConn = await mongoose.createConnection(uriPanel, { serverSelectionTimeoutMS: 20000 }).asPromise();
  const leadsConn = await mongoose.createConnection(uriLeads, { serverSelectionTimeoutMS: 20000 }).asPromise();
  console.log('✅ Connected to MongoDB (byd-panel & byd-leads-new)\n');

  const apiDataDir = path.resolve(__dirname, '../../../api_data');
  if (!fs.existsSync(apiDataDir)) {
    throw new Error(`api_data folder not found at ${apiDataDir}`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PART 1: DELETE CURRENT DATA OF DENZA MELBOURNE OF SALESLOG FROM DATABASE
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('--- PART 1: DELETING SALESLOG DATA OF DENZA MELBOURNE ---');
  const clientColl = panelConn.db.collection('clients');
  const salesLogColl = panelConn.db.collection('saleslogentries');

  // Identify saleslog records in clients collection
  const denzaSaleslogClientsQuery = {
    $or: [
      { site_location: { $regex: 'denza', $options: 'i' }, imported_from: { $in: ['saleslogs-csv', 'saleslogs-json'] } },
      { site_location: 'Denza Melbourne', imported_from: { $regex: 'saleslog', $options: 'i' } }
    ]
  };

  const saleslogClientsCount = await clientColl.countDocuments(denzaSaleslogClientsQuery);
  console.log(`Found ${saleslogClientsCount} Denza Melbourne saleslog records in byd-panel.clients.`);

  const denzaSaleslogEntriesQuery = {
    $or: [
      { site: { $regex: 'denza', $options: 'i' } },
      { dealership: { $regex: 'denza', $options: 'i' } },
      { location: { $regex: 'denza', $options: 'i' } }
    ]
  };
  const saleslogEntriesCount = await salesLogColl.countDocuments(denzaSaleslogEntriesQuery);
  console.log(`Found ${saleslogEntriesCount} Denza Melbourne entries in byd-panel.saleslogentries.`);

  if (!isDryRun) {
    if (saleslogClientsCount > 0) {
      const delClientsResult = await clientColl.deleteMany(denzaSaleslogClientsQuery);
      console.log(`🗑️  Successfully deleted ${delClientsResult.deletedCount} saleslog client records from byd-panel.clients.`);
    }
    if (saleslogEntriesCount > 0) {
      const delSalesLogResult = await salesLogColl.deleteMany(denzaSaleslogEntriesQuery);
      console.log(`🗑️  Successfully deleted ${delSalesLogResult.deletedCount} records from byd-panel.saleslogentries.`);
    }
  } else {
    console.log(`[DRY RUN] Would delete ${saleslogClientsCount} clients and ${saleslogEntriesCount} saleslogentries.`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PART 2: EXTRACT DENZA MELBOURNE DATA FROM API_DATA AND INSERT INTO DATABASE
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- PART 2: EXTRACTING & INSERTING DENZA MELBOURNE DATA ---');

  // 2.1 INVENTORY (byd-leads-new.inventories)
  console.log('\n[2.1] Processing Denza Inventory...');
  const invColl = leadsConn.db.collection('inventories');
  const carsDetailedDir = path.join(apiDataDir, 'cars_detailed');
  const allCarsFile = path.join(apiDataDir, 'all_cars_inventory_13.json');

  let rawCars = [];
  if (fs.existsSync(carsDetailedDir)) {
    const files = fs.readdirSync(carsDetailedDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        const carData = JSON.parse(fs.readFileSync(path.join(carsDetailedDir, f), 'utf8'));
        rawCars.push(carData);
      } catch (err) {
        console.warn(`Could not read ${f}:`, err.message);
      }
    }
  }
  if (rawCars.length === 0 && fs.existsSync(allCarsFile)) {
    rawCars = JSON.parse(fs.readFileSync(allCarsFile, 'utf8'));
  }

  // Deduplicate cars by id
  const carsById = new Map();
  for (const car of rawCars) {
    carsById.set(car.id, car);
  }
  const uniqueCars = Array.from(carsById.values());
  console.log(`Loaded ${uniqueCars.length} unique Denza cars from api_data.`);

  const invOperations = uniqueCars.map(car => {
    const stockId = String(car.stocknum || car.id);
    const modelKey = `${car.make || 'DENZA'} ${car.model || 'B5'}`;
    const photoUrl = MODEL_IMAGES[modelKey] || MODEL_IMAGES['DENZA B5'];
    const priceNum = Number(car.price) || 0;
    const priceFormatted = priceNum > 0 ? `$${priceNum.toLocaleString()}` : 'TBA';

    const invDoc = {
      stock: stockId,
      model: car.name || `${car.year || 2025} ${car.make || 'DENZA'} ${car.model || 'B5'}`,
      paint: car.colour || 'Granite Grey',
      location: 'DENZA Melbourne',
      status: 'Available',
      price: priceFormatted,
      lastSeen: new Date(),
      platform: 'dealer_studio',
      identifier: String(car.id),
      networkId: car.regplate || stockId,
      legacyId: String(car.id),
      itemType: 'CAR',
      condition: car.car_type === 'demo' ? 'Demo' : 'New',
      itemStatus: 'InStock',
      title: car.name || `${car.year || 2025} ${car.make || 'DENZA'} ${car.model || 'B5'}`,
      firstPhotoUrl: photoUrl,
      priceData: {
        ui: priceNum,
        currency: 'AUD',
        label: car.price_type || 'DAP',
      },
      odometer: {
        value: Number(car.km || car.odometer_reading || 0),
        unit: 'Kilometres',
      },
      registration: {
        rego: car.regplate || null,
        vin: car.vin || null,
        hin: null,
      },
      specifications: {
        make: car.make || 'DENZA',
        model: car.model || 'B5',
        badge: car.badge || '',
        series: car.series || '',
        year: Number(car.year) || 2025,
        colour: car.colour || '',
        manufacturerColour: car.colour || '',
      },
      listingStats: {
        enquiryCount: Number(car.test_drives_count || 0),
        watchers: 12,
        retailSearchCount: Number(car.views || 0),
        retailViewCount: Number(car.views || 0),
        photoCount: 1,
        healthScore: 90,
      },
      lmStats: {
        averageDaysOnMarket: Number(car.days_old || 10),
        averageOdometer: Number(car.km || 0),
        marketPercentage: 100,
        averageDriveAwayPrice: priceNum,
        averageWatchers: 12,
        daysOnMarket: Number(car.days_old || 10),
        marketOnline: 1,
        priceRankDap: 1,
        lastUpdated: new Date(),
      },
      onCarsalesNetwork: true,
      sellerIdentifier: 'denza-melbourne',
    };

    return {
      updateOne: {
        filter: { identifier: String(car.id) },
        update: { $set: invDoc },
        upsert: true,
      },
    };
  });

  if (!isDryRun && invOperations.length > 0) {
    const invRes = await invColl.bulkWrite(invOperations);
    console.log(`✅ Upserted ${invOperations.length} cars into byd-leads-new.inventories (Matched: ${invRes.matchedCount}, Upserted: ${invRes.upsertedCount}, Modified: ${invRes.modifiedCount})`);
  } else {
    console.log(`[DRY RUN] Would upsert ${invOperations.length} cars into byd-leads-new.inventories.`);
  }

  // 2.2 DEALERSHIP (byd-leads-new.dealerships)
  console.log('\n[2.2] Upserting DENZA Melbourne in byd-leads-new.dealerships...');
  const dealerColl = leadsConn.db.collection('dealerships');
  const denzaDealerDoc = {
    name: 'DENZA Melbourne',
    legalEntity: 'DENZA Melbourne Pty Ltd',
    address: 'Kew',
    suburb: 'Kew',
    state: 'VIC',
    phone: '0458 666 000',
    email: 'austin.chang@denzakew.com.au',
    timezone: 'Australia/Melbourne',
    smsSenderId: '+61468104118',
    autogateId: '2606',
    weekdayHoursStart: '09:00',
    weekdayHoursEnd: '18:00',
    saturdayHoursStart: '09:00',
    saturdayHoursEnd: '17:00',
    updatedAt: new Date(),
  };

  if (!isDryRun) {
    await dealerColl.updateOne(
      { name: 'DENZA Melbourne' },
      { $set: denzaDealerDoc, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    console.log('✅ Upserted DENZA Melbourne dealership document.');
  }

  // 2.3 LEADS & APPOINTMENTS (byd-leads-new.leads & byd-leads-new.appointments)
  console.log('\n[2.3] Loading all lead clusters from all_lead_clusters_3313.json...');
  const allLeadsFile = path.join(apiDataDir, 'all_lead_clusters_3313.json');
  const leadsJson = JSON.parse(fs.readFileSync(allLeadsFile, 'utf8'));
  const leadClusters = leadsJson.lead_clusters || [];
  console.log(`Loaded ${leadClusters.length} lead clusters from api_data.`);

  const leadColl = leadsConn.db.collection('leads');
  const apptColl = leadsConn.db.collection('appointments');

  const leadOps = [];
  const apptOps = [];
  const dealsList = []; // Leads with orders / contracts / deliveries

  for (const lc of leadClusters) {
    const leadIdStr = String(lc.id);
    const vehicleDesc = lc.item
      ? `${lc.item.year || ''} ${lc.item.make || 'DENZA'} ${lc.item.model || ''} ${lc.item.model_variant || ''}`.trim()
      : (lc.category || 'DENZA Range');
    const statusVal = mapStatus(lc.lead_status);
    const stageVal = mapStage(lc.lead_status);
    const colorVal = mapColor(lc.lead_status_colour_name);
    const tagVal = mapTag(lc);
    const scoreVal = calculateScore(lc);
    const createdDate = new Date(lc.created_at || Date.now());
    const updatedDate = new Date(lc.last_activity || lc.last_lead_created_at || lc.created_at || Date.now());

    const hasTestDrive = lc.has_upcoming_appointment || (lc.event_counts && lc.event_counts.test_drive > 0);
    const leadDoc = {
      leadId: leadIdStr,
      virtualyardId: leadIdStr,
      autogateId: String(lc.contact_id || lc.id),
      autogateLeadId: leadIdStr,
      leadIdShort: leadIdStr.slice(-8),
      name: lc.name || 'DENZA Prospect',
      email: lc.email || '',
      phone: lc.phone || '',
      dealer: 'DENZA Melbourne',
      dealerName: 'DENZA Melbourne',
      vehicle: vehicleDesc,
      stockNum: lc.item?.stocknum || '',
      paintColor: lc.item?.colour || '',
      score: scoreVal,
      tag: tagVal,
      color: colorVal,
      stage: stageVal,
      status: statusVal,
      source: 'Dealer Studio',
      leadSource: 'Dealer Studio',
      notes: lc.category ? `Category: ${lc.category}` : '',
      enquiryDesc: lc.category || '',
      control: lc.user_name ? 'Human assisted' : 'AI active',
      assignedTo: lc.user_name || 'Not Assigned',
      allocatedPersonFullName: lc.user_name || '',
      platform: 'dealer_studio',
      leadCreatedDate: createdDate,
      createdAt: createdDate,
      updatedAt: updatedDate,
      receivedDaysAgo: Math.max(0, Math.floor((Date.now() - createdDate.getTime()) / 86400000)),
      multipleVehicleEnquiries: (lc.leads && lc.leads.length > 1) || false,
      isArchived: lc.archived || false,
      leadStage: lc.lead_status || 'New',
      leadType: lc.category || 'GENERAL',
      opportunity: statusVal === 'sold' || statusVal === 'committed' ? 'Buy' : 'Enquiry',
      tags: (lc.tags || []).map(t => ({ label: String(t), friendlyLabel: String(t) })),
      leadStats: {
        emailCount: lc.event_counts?.email || 0,
        smsCount: lc.event_counts?.sms || 0,
        phoneCallCount: lc.event_counts?.phone || 0,
        appointmentCount: lc.event_counts?.test_drive || 0,
      },
      testDrive: {
        testDriveDate: lc.next_upcoming_appointment_starts_at ? new Date(lc.next_upcoming_appointment_starts_at) : null,
        location: lc.location_name || 'DENZA Melbourne',
        status: hasTestDrive ? 'Confirmed' : '',
        confirmed: hasTestDrive,
      },
    };

    leadOps.push({
      updateOne: {
        filter: { autogateLeadId: leadIdStr },
        update: { $set: leadDoc },
        upsert: true,
      },
    });

    // Appointment / Test drive extraction
    if (hasTestDrive) {
      const apptId = `APT-DENZA-${leadIdStr}`;
      const apptWhen = lc.next_upcoming_appointment_starts_at
        ? new Date(lc.next_upcoming_appointment_starts_at).toLocaleString('en-AU', {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
          })
        : 'Confirmed Test Drive';

      const apptDoc = {
        appointmentId: apptId,
        leadId: leadIdStr,
        when: apptWhen,
        prospectName: lc.name || 'DENZA Prospect',
        phone: lc.phone || '',
        email: lc.email || '',
        type: 'Test Drive',
        vehicle: vehicleDesc,
        dealership: 'DENZA Melbourne',
        location: lc.location_name || 'DENZA Melbourne',
        bookedBy: lc.user_name ? 'Agent' : 'AI',
        status: 'Confirmed',
        testDriveDate: lc.next_upcoming_appointment_starts_at
          ? new Date(lc.next_upcoming_appointment_starts_at)
          : updatedDate,
        platform: 'dealer_studio',
        updatedAt: updatedDate,
      };

      apptOps.push({
        updateOne: {
          filter: { appointmentId: apptId },
          update: { $set: apptDoc, $setOnInsert: { createdAt: createdDate } },
          upsert: true,
        },
      });
    }

    // Deals / Orders / Deliveries check
    const isDeal =
      lc.order_at != null ||
      lc.lead_status === 'Delivered' ||
      lc.lead_status === 'Contract Signed' ||
      lc.lead_status === 'Vehicle Order';
    if (isDeal) {
      dealsList.push(lc);
    }
  }

  // Execute bulk operations for Leads in chunks of 500
  console.log(`\nUpserting ${leadOps.length} leads into byd-leads-new.leads in batches...`);
  if (!isDryRun) {
    const CHUNK_SIZE = 500;
    let totalMatched = 0;
    let totalUpserted = 0;
    let totalModified = 0;
    for (let i = 0; i < leadOps.length; i += CHUNK_SIZE) {
      const chunk = leadOps.slice(i, i + CHUNK_SIZE);
      const res = await leadColl.bulkWrite(chunk, { ordered: false });
      totalMatched += res.matchedCount;
      totalUpserted += res.upsertedCount;
      totalModified += res.modifiedCount;
      process.stdout.write(`  Processed ${Math.min(i + CHUNK_SIZE, leadOps.length)} / ${leadOps.length} leads...\r`);
    }
    console.log(`\n✅ Upserted ${leadOps.length} leads (Matched: ${totalMatched}, Upserted: ${totalUpserted}, Modified: ${totalModified})`);
  } else {
    console.log(`[DRY RUN] Would upsert ${leadOps.length} leads into byd-leads-new.leads.`);
  }

  // Execute bulk operations for Appointments
  console.log(`\nUpserting ${apptOps.length} appointments into byd-leads-new.appointments...`);
  if (!isDryRun && apptOps.length > 0) {
    const CHUNK_SIZE = 500;
    let totalAppts = 0;
    for (let i = 0; i < apptOps.length; i += CHUNK_SIZE) {
      const chunk = apptOps.slice(i, i + CHUNK_SIZE);
      const res = await apptColl.bulkWrite(chunk, { ordered: false });
      totalAppts += res.upsertedCount + res.modifiedCount + res.matchedCount;
    }
    console.log(`✅ Upserted ${apptOps.length} appointments into byd-leads-new.appointments.`);
  } else {
    console.log(`[DRY RUN] Would upsert ${apptOps.length} appointments into byd-leads-new.appointments.`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PART 2.4: DELIVERY CENTRE & SALES CRM (byd-panel: clients, saleslogentries, customers, opportunities)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log(`\n[2.4] Processing ${dealsList.length} deals/orders for Delivery Centre & Sales CRM (byd-panel)...`);

  const custColl = panelConn.db.collection('customers');
  const oppColl = panelConn.db.collection('opportunities');

  const clientOps = [];
  const salesLogOps = [];
  const custOps = [];
  const oppOps = [];

  for (const lc of dealsList) {
    const dealId = String(lc.id);
    const clientUuid = generateDeterministicUUID(`client-denza-${dealId}`);
    const custId = `CUST-DENZA-${dealId}`;
    const oppId = `OPP-DENZA-${dealId}`;
    const salesLogId = `SL-DENZA-${dealId}`;
    const dealNum = `D-DENZA-${dealId}`;

    const vehicleDesc = lc.item
      ? `${lc.item.year || ''} ${lc.item.make || 'DENZA'} ${lc.item.model || ''} ${lc.item.model_variant || ''}`.trim()
      : 'DENZA Vehicle';
    const isDelivered = lc.lead_status === 'Delivered';
    const isContractSigned = lc.lead_status === 'Contract Signed';
    const isVehicleOrder = lc.lead_status === 'Vehicle Order';

    const deliveryStage = isDelivered ? 'Delivered' : (isContractSigned ? 'Scheduled' : 'In Transit');
    const deliveryDate = lc.delivered_at
      ? toIsoDate(lc.delivered_at)
      : (lc.order_at ? toIsoDate(lc.order_at) : toIsoDate(lc.created_at));
    const dealDate = lc.order_at ? toIsoDate(lc.order_at) : toIsoDate(lc.created_at);

    const consultant = lc.user_name || 'Austin Chang';
    const listPrice = lc.item?.model === 'B8' ? 98700 : (lc.item?.price || 76680);
    const grossMargin = lc.item?.model === 'B8' ? 6200 : 4900;
    const isFinance = (lc.tags || []).some(t => String(t).toLowerCase().includes('finance'));
    const saleType = 'Retail';
    const dealType = isFinance ? 'Finance' : 'Retail';

    // 1. Client document (Delivery Centre / Deliveries view)
    const clientDoc = {
      id: clientUuid,
      name: lc.name || 'DENZA Customer',
      phone: lc.phone || '',
      email: lc.email || null,
      vehicle: vehicleDesc,
      rego: lc.item?.regplate || null,
      vin: lc.item?.stocknum?.startsWith('LC0') ? lc.item.stocknum : null,
      delivery_date: deliveryDate,
      stage: deliveryStage,
      salesperson: consultant,
      delivery_consultant: consultant,
      notes: null,
      address: null,
      location: lc.location_name || 'DENZA Melbourne, VIC',
      deal_type: dealType,
      sale_type: saleType,
      trade_in_flag: lc.has_trade_in_photos || false,
      trade_in_status: lc.has_trade_in_photos ? 'Settled' : 'Pending',
      vy_order_id: dealId,
      vy_stock_id: lc.item?.stocknum || null,
      stripe_customer_id: null,
      arrived: isDelivered,
      arrived_at: isDelivered ? new Date(lc.delivered_at || lc.last_activity || Date.now()) : null,
      contact_status: 'Contacted',
      last_contacted_at: new Date(lc.last_activity || Date.now()),
      assigned_agent_id: null,
      accessories: [],
      aftermarket_notes: null,
      addons: [],
      site_location: 'Denza Melbourne',
      imported_from: 'dealer_studio',
      platform: 'dealer_studio',
      imported_at: new Date(),
      comments: [],
      created_at: new Date(lc.order_at || lc.created_at || Date.now()),
      updated_at: new Date(),
    };

    clientOps.push({
      updateOne: {
        filter: { vy_order_id: dealId },
        update: { $set: clientDoc },
        upsert: true,
      },
    });

    // 2. Sales Log Entry (Sales Floor CRM Ledger)
    const salesLogEntryDoc = {
      sales_log_id: salesLogId,
      deal_number: dealNum,
      deal_date: dealDate,
      customer_name: lc.name || 'DENZA Customer',
      mobile: lc.phone || '',
      email: lc.email || '',
      vehicle: vehicleDesc,
      vin: lc.item?.stocknum?.startsWith('LC0') ? lc.item.stocknum : `LC0DD1C4${dealId}`,
      stock_id: lc.item?.stocknum || `VY-DENZA-${dealId}`,
      vy_stock_id: lc.item?.stocknum || `VY-DENZA-${dealId}`,
      vy_order_id: dealId,
      sale_type: saleType,
      consultant_name: consultant,
      salesperson: consultant,
      site: 'Denza Melbourne',
      list_price: listPrice,
      gross_margin: grossMargin,
      deposit: 2000,
      finance_method: isFinance ? 'DENZA Financial Services' : 'Cash / EFT',
      status: 'written',
      source: 'dealer_studio',
      platform: 'dealer_studio',
      exception_status: 'clean',
      exception_notes: null,
      reconciled_at: isDelivered ? new Date(lc.delivered_at || lc.last_activity || Date.now()) : null,
      reconciliation_status: isDelivered ? 'Reconciled' : 'Pending',
      delivery_client_id: clientUuid,
      opportunity_id: oppId,
      customer_id: custId,
      createdAt: new Date(lc.order_at || lc.created_at || Date.now()),
      updatedAt: new Date(),
    };

    salesLogOps.push({
      updateOne: {
        filter: { sales_log_id: salesLogId },
        update: { $set: salesLogEntryDoc },
        upsert: true,
      },
    });

    // 3. Customer document (Sales Floor CRM Customers)
    const customerDoc = {
      customer_id: custId,
      name: lc.name || 'DENZA Customer',
      phone: lc.phone || '',
      email: lc.email || '',
      site: 'Denza Melbourne',
      owner_name: consultant,
      source: 'Dealer Studio',
      platform: 'dealer_studio',
      record_type: 'individual',
      preferred_model: vehicleDesc,
      consent_sms: true,
      do_not_contact: false,
      total_spend: listPrice,
      active_deals_count: isDelivered ? 0 : 1,
      total_deals_count: 1,
      delivery_client_id: clientUuid,
      createdAt: new Date(lc.created_at || Date.now()),
      updatedAt: new Date(),
    };

    custOps.push({
      updateOne: {
        filter: { customer_id: custId },
        update: { $set: customerDoc },
        upsert: true,
      },
    });

    // 4. Opportunity document (Sales Floor CRM Pipeline)
    const oppDoc = {
      opportunity_id: oppId,
      customer_id: custId,
      customer_name: lc.name || 'DENZA Customer',
      customer_phone: lc.phone || '',
      customer_email: lc.email || '',
      site: 'Denza Melbourne',
      owner_name: consultant,
      stage: isDelivered ? 'Delivered / Won' : (isContractSigned ? 'Contract Signed' : 'In Delivery'),
      delivery_stage: deliveryStage,
      vehicle_descriptor: vehicleDesc,
      model: lc.item?.model || 'B5',
      variant: lc.item?.model_variant || 'Standard',
      colour: lc.item?.colour || 'Granite Grey',
      vin: lc.item?.stocknum?.startsWith('LC0') ? lc.item.stocknum : `LC0DD1C4${dealId}`,
      source: 'Dealer Studio',
      platform: 'dealer_studio',
      sale_type: saleType,
      list_price: listPrice,
      discount: 0,
      total_deal_value: listPrice,
      expected_close: deliveryDate,
      delivery_client_id: clientUuid,
      sales_log_id: salesLogId,
      createdAt: new Date(lc.order_at || lc.created_at || Date.now()),
      updatedAt: new Date(),
    };

    oppOps.push({
      updateOne: {
        filter: { opportunity_id: oppId },
        update: { $set: oppDoc },
        upsert: true,
      },
    });
  }

  if (!isDryRun) {
    if (clientOps.length > 0) {
      await clientColl.bulkWrite(clientOps, { ordered: false });
      console.log(`✅ Upserted ${clientOps.length} clients into byd-panel.clients.`);
    }
    if (salesLogOps.length > 0) {
      await salesLogColl.bulkWrite(salesLogOps, { ordered: false });
      console.log(`✅ Upserted ${salesLogOps.length} entries into byd-panel.saleslogentries.`);
    }
    if (custOps.length > 0) {
      await custColl.bulkWrite(custOps, { ordered: false });
      console.log(`✅ Upserted ${custOps.length} customers into byd-panel.customers.`);
    }
    if (oppOps.length > 0) {
      await oppColl.bulkWrite(oppOps, { ordered: false });
      console.log(`✅ Upserted ${oppOps.length} opportunities into byd-panel.opportunities.`);
    }
  } else {
    console.log(`[DRY RUN] Would upsert ${clientOps.length} clients, ${salesLogOps.length} saleslogentries, ${custOps.length} customers, ${oppOps.length} opportunities into byd-panel.`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // VERIFICATION SUMMARY
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n=== FINAL VERIFICATION STATS ===');
  const finalSaleslogClients = await clientColl.countDocuments({ site_location: 'Denza Melbourne', imported_from: 'api_data' });
  const oldSaleslogClients = await clientColl.countDocuments({ site_location: 'Denza Melbourne', imported_from: { $ne: 'api_data' } });
  const finalSalesLogEntries = await salesLogColl.countDocuments({ site: 'Denza Melbourne' });
  const finalLeads = await leadColl.countDocuments({ dealer: 'DENZA Melbourne' });
  const finalInv = await invColl.countDocuments({ location: 'DENZA Melbourne' });
  const finalAppts = await apptColl.countDocuments({ dealership: 'DENZA Melbourne' });
  const finalCust = await custColl.countDocuments({ site: 'Denza Melbourne' });
  const finalOpp = await oppColl.countDocuments({ site: 'Denza Melbourne' });

  console.log({
    byd_panel: {
      denza_clients_new: finalSaleslogClients,
      denza_clients_old_saleslog_remaining: oldSaleslogClients,
      denza_sales_log_entries: finalSalesLogEntries,
      denza_customers: finalCust,
      denza_opportunities: finalOpp,
    },
    byd_leads_new: {
      denza_leads: finalLeads,
      denza_inventories: finalInv,
      denza_appointments: finalAppts,
    },
  });

  await panelConn.close();
  await leadsConn.close();
  console.log('\n✨ All tasks finished successfully!\n');
}

main().catch(err => {
  console.error('Fatal error during sync:', err);
  process.exit(1);
});
