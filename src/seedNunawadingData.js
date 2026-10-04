require('dotenv').config();
const { deliveryConn, leadConn, ensureDbConnected } = require('./db');

async function seed() {
  await ensureDbConnected();
  console.log('--- Seeding Nunawading CRM records ---');

  const clientColl = deliveryConn.db.collection('clients');
  const custColl = deliveryConn.db.collection('customers');
  const oppColl = deliveryConn.db.collection('opportunities');
  const salesColl = deliveryConn.db.collection('saleslogentries');
  const allocColl = deliveryConn.db.collection('allocations');
  const apptColl = leadConn.db.collection('appointments');

  // 1. Fetch live Nunawading deliveries
  const nunDeliveries = await clientColl.find({
    $or: [
      { site: /nunawading/i },
      { dealer: /nunawading/i },
      { location: /nunawading/i },
      { department: /nunawading/i }
    ]
  }).toArray();

  console.log(`Found ${nunDeliveries.length} existing deliveries for Nunawading.`);

  // 2. Seed matching customers for these deliveries
  let seededCust = 0;
  let seededOpp = 0;
  let seededSales = 0;
  let seededAppt = 0;

  for (let i = 0; i < nunDeliveries.length; i++) {
    const d = nunDeliveries[i];
    const custId = `CUST-NUN-${String(i + 1).padStart(3, '0')}`;
    const oppId = `OPP-NUN-${String(i + 1).padStart(3, '0')}`;
    const salesId = `SL-NUN-${String(i + 1).padStart(3, '0')}`;

    const custName = d.name || d.customer_name || 'BYD Customer';
    const custPhone = d.phone || `+61491570${String(100 + i)}`;
    const custEmail = d.email || `${custName.toLowerCase().replace(/[^a-z]/g, '')}@example.com.au`;
    const consultant = d.salesperson || d.delivery_consultant || 'Aaron Chen';
    const vehicle = d.vehicle || 'BYD SEALION 7';
    const vin = d.vin || `6FPPXXMJGPST00${200 + i}`;
    const stage = d.stage || d.delivery_stage || 'In Transit';

    // Upsert Customer
    const existingCust = await custColl.findOne({ $or: [{ phone: custPhone }, { customer_id: custId }] });
    if (!existingCust) {
      await custColl.insertOne({
        customer_id: custId,
        name: custName,
        phone: custPhone,
        email: custEmail,
        site: 'BYD Nunawading',
        owner_name: consultant,
        source: 'Showroom Walkin',
        record_type: 'individual',
        preferred_model: vehicle,
        consent_sms: true,
        do_not_contact: false,
        total_spend: 54990,
        active_deals_count: 1,
        total_deals_count: 1,
        delivery_client_id: String(d._id),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      seededCust++;
    }

    // Upsert Opportunity
    const existingOpp = await oppColl.findOne({ $or: [{ vin: vin }, { opportunity_id: oppId }] });
    if (!existingOpp) {
      await oppColl.insertOne({
        opportunity_id: oppId,
        customer_id: custId,
        customer_name: custName,
        customer_phone: custPhone,
        customer_email: custEmail,
        site: 'BYD Nunawading',
        owner_name: consultant,
        stage: stage === 'Delivered' ? 'Delivered / Won' : 'In Delivery',
        delivery_stage: stage,
        vehicle_descriptor: vehicle,
        model: vehicle.split(' ')[1] || 'SEALION 7',
        variant: 'Premium',
        colour: 'Harbour Grey',
        vin: vin,
        sale_type: 'Retail',
        list_price: 54990,
        discount: 0,
        total_deal_value: 54990,
        expected_close: d.delivery_date || new Date().toISOString(),
        delivery_client_id: String(d._id),
        next_action_at: new Date(Date.now() + 86400000).toISOString(),
        next_action_desc: 'Review handover checklist & vehicle registration.',
        is_overdue: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      seededOpp++;
    }

    // Upsert Sales Log Entry
    const existingSales = await salesColl.findOne({ $or: [{ vin: vin }, { sales_log_id: salesId }] });
    if (!existingSales) {
      await salesColl.insertOne({
        sales_log_id: salesId,
        deal_number: `D-NUN-${1000 + i}`,
        customer_name: custName,
        mobile: custPhone,
        email: custEmail,
        vehicle: vehicle,
        vin: vin,
        stock_id: `VY-NUN-${8000 + i}`,
        sale_type: 'Retail',
        consultant_name: consultant,
        salesperson: consultant,
        site: 'BYD Nunawading',
        deal_date: new Date(Date.now() - 86400000 * (i + 1)).toISOString().split('T')[0],
        list_price: 54990,
        gross_margin: 4500,
        deposit: 2000,
        finance_method: 'BYD Financial Services',
        status: 'written',
        reconciled_at: stage === 'Delivered' ? new Date() : null,
        reconciliation_status: stage === 'Delivered' ? 'Reconciled' : 'Pending',
        exception_status: 'none',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      seededSales++;
    }
  }

  // 3. Seed realistic Appointments for Nunawading
  const apptSamples = [
    {
      appointmentId: 'APT-NUN-001',
      prospectName: 'Jingwen He',
      phone: '0412 345 601',
      email: 'jingwen.he@example.com',
      when: 'Tomorrow at 10:30 AM',
      type: 'Vehicle Delivery',
      vehicle: 'BYD Dolphin Essential',
      dealership: 'BYD Nunawading',
      location: 'BYD Nunawading',
      site: 'BYD Nunawading',
      yard: 'BYD Nunawading',
      bookedBy: 'Aaron Chen',
      consultantName: 'Aaron Chen',
      status: 'Confirmed',
      notes: 'New vehicle handover & app pairing session.',
      durationMinutes: 60,
      testDriveDate: new Date(Date.now() + 86400000).toISOString(),
    },
    {
      appointmentId: 'APT-NUN-002',
      prospectName: 'Liam O\'Connor',
      phone: '0412 998 123',
      email: 'liam.oc@example.com.au',
      when: 'Today at 02:00 PM',
      type: 'Test Drive',
      vehicle: 'BYD SEALION 7 Performance',
      dealership: 'BYD Nunawading',
      location: 'BYD Nunawading',
      site: 'BYD Nunawading',
      yard: 'BYD Nunawading',
      bookedBy: 'AI Booking Agent',
      consultantName: 'Sonia Lai',
      status: 'Confirmed',
      notes: 'Customer comparing against Tesla Model Y. Demo drive loop planned.',
      durationMinutes: 45,
      testDriveDate: new Date().toISOString(),
    },
    {
      appointmentId: 'APT-NUN-003',
      prospectName: 'Sarah Jenkins',
      phone: '0423 456 789',
      email: 'sjenkins@biztech.com.au',
      when: 'Friday at 11:00 AM',
      type: 'Showroom Visit',
      vehicle: 'BYD Shark 6 PHEV',
      dealership: 'BYD Nunawading',
      location: 'BYD Nunawading',
      site: 'BYD Nunawading',
      yard: 'BYD Nunawading',
      bookedBy: 'Michael Kadende',
      consultantName: 'Michael Kadende',
      status: 'Confirmed',
      notes: 'Commercial novated lease inquiry for dual-cab ute.',
      durationMinutes: 45,
      testDriveDate: new Date(Date.now() + 86400000 * 3).toISOString(),
    },
    {
      appointmentId: 'APT-NUN-004',
      prospectName: 'Chen Wei',
      phone: '0434 567 890',
      email: 'chen.wei@ausmail.com',
      when: 'Saturday at 09:30 AM',
      type: 'Test Drive',
      vehicle: 'BYD ATTO 3 Extended',
      dealership: 'BYD Nunawading',
      location: 'BYD Nunawading',
      site: 'BYD Nunawading',
      yard: 'BYD Nunawading',
      bookedBy: 'Aaron Chen',
      consultantName: 'Aaron Chen',
      status: 'Proposed',
      notes: 'Wife will accompany for booster seat fit check.',
      durationMinutes: 45,
      testDriveDate: new Date(Date.now() + 86400000 * 4).toISOString(),
    },
    {
      appointmentId: 'APT-NUN-005',
      prospectName: 'Jessica Taylor',
      phone: '0445 678 901',
      email: 'jtaylor@designstudio.com',
      when: 'Yesterday at 03:00 PM',
      type: 'Test Drive',
      vehicle: 'BYD SEAL Premium',
      dealership: 'BYD Nunawading',
      location: 'BYD Nunawading',
      site: 'BYD Nunawading',
      yard: 'BYD Nunawading',
      bookedBy: 'Sonia Lai',
      consultantName: 'Sonia Lai',
      status: 'Completed',
      notes: 'Drive completed. Sending formal drive-away quote.',
      durationMinutes: 45,
      testDriveDate: new Date(Date.now() - 86400000).toISOString(),
    }
  ];

  for (const appt of apptSamples) {
    const existing = await apptColl.findOne({ appointmentId: appt.appointmentId });
    if (!existing) {
      await apptColl.insertOne({
        ...appt,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      seededAppt++;
    }
  }

  // 4. Seed Allocations for Nunawading
  const allocSamples = [
    {
      allocation_id: 'ALC-NUN-001',
      customer_name: 'Liam O\'Connor',
      lead_phone: '0412 998 123',
      lead_email: 'liam.oc@example.com.au',
      vehicle_interest: 'BYD SEALION 7 Performance',
      source: 'Online Digital Lead',
      site: 'BYD Nunawading',
      assigned_to_name: 'Sonia Lai',
      status: 'active',
      created_at: new Date(),
      updatedAt: new Date(),
    },
    {
      allocation_id: 'ALC-NUN-002',
      customer_name: 'Sarah Jenkins',
      lead_phone: '0423 456 789',
      lead_email: 'sjenkins@biztech.com.au',
      vehicle_interest: 'BYD Shark 6 PHEV',
      source: 'Autogate / Carsales',
      site: 'BYD Nunawading',
      assigned_to_name: 'Michael Kadende',
      status: 'pending',
      created_at: new Date(),
      updatedAt: new Date(),
    }
  ];

  let seededAlloc = 0;
  for (const alc of allocSamples) {
    const existing = await allocColl.findOne({ allocation_id: alc.allocation_id });
    if (!existing) {
      await allocColl.insertOne({
        ...alc,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      seededAlloc++;
    }
  }

  console.log(`✅ Seeded: ${seededCust} Customers, ${seededOpp} Opportunities, ${seededSales} Sales Log entries, ${seededAppt} Appointments, ${seededAlloc} Allocations.`);
  process.exit(0);
}

seed().catch(console.error);
