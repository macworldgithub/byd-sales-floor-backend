/**
 * provisionNunawadingStaff.js
 *
 * Provisions all 16 staff members from the BYD Australia Nunawading showroom staff list
 * into both:
 * 1. Delivery Centre & Sales CRM & Sales Floor database: byd-panel (DELIVERY_CENTER_MONGO_URI)
 * 2. Lead Centre database: byd-leads-new (LEAD_CENTER_MONGO_URI)
 *
 * Default password for all accounts: 123456
 */
require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const DEFAULT_PASSWORD = '123456';

const LEAD_URI =
  process.env.LEAD_CENTER_MONGO_URI ||
  'mongodb+srv://salman:4lanHyMRdCrtXDJ7@sign365.nglnioh.mongodb.net/byd-leads-new?retryWrites=true&w=majority';

const DELIVERY_URI =
  process.env.DELIVERY_CENTER_MONGO_URI ||
  'mongodb+srv://salman:4lanHyMRdCrtXDJ7@sign365.nglnioh.mongodb.net/byd-panel?retryWrites=true&w=majority';

// The 16 employees from the BYD Australia Nunawading showroom staff list
const nunawadingStaff = [
  {
    name: 'Tracey Arnott',
    email: 'tracey.arnott@bydnunawading.com.au',
    status: 'Employed',
    position: 'Sales Consultant',
    phone: '0408 872 239',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
  },
  {
    name: 'Gordon Shek',
    email: 'gordon.shek@bydnunawading.com.au',
    status: 'Employed',
    position: 'Delivery Coordinator',
    phone: '0451 221 186',
    role: 'agent',
    leadsRole: 'agent',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
  },
  {
    name: 'Jun Lin',
    email: 'rocky.lin@byddoncaster.com.au',
    status: 'Employed',
    position: 'Sales consultant',
    phone: '0455 736 669',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
  },
  {
    name: 'Marklin Wee',
    email: 'marklin.wee@bydnunawading.com.au',
    status: 'Employed',
    position: 'Sales consultant',
    phone: '0419 543 589',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
  },
  {
    name: 'Jinying (Messio) Wang',
    email: 'messio.wang@bydnunawading.com.au',
    status: 'Employed',
    position: 'Delivery coordinator',
    phone: '0434 005 022',
    role: 'agent',
    leadsRole: 'agent',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
  },
  {
    name: 'Hanjing Chen',
    email: 'hanjing.chen@bydnunawading.com.au',
    status: 'Employed',
    position: 'Sales Consultant(pt)',
    phone: '0452 637 767',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
  },
  {
    name: 'Eldhose Philip',
    email: 'eldhose.philip@bydnunawading.com.au',
    status: 'Employed',
    position: 'Sales Consultant',
    phone: '0451 166 506',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
  },
  {
    name: 'Joseph Pang',
    email: 'joseph.pang@byddoncaster.com.au',
    status: 'Employed',
    position: 'Sales Consultant',
    phone: '0426 914 705',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
  },
  {
    name: 'Yuan Zhang',
    email: 'yuan.zhang@byddoncaster.com.au',
    status: 'Employed',
    position: 'Sales Consultant',
    phone: '0450 218 520',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
  },
  {
    name: 'Angelo Giacomo Carmine La Sala',
    email: 'angelo.lasala@byddoncaster.com.au',
    status: 'Employed',
    position: 'Sales Consultant',
    phone: '0449 288 504',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
  },
  {
    name: 'Darcy Ian Nesbitt',
    email: 'darcy.nesbitt@bydnunawading.com.au',
    status: 'Employed',
    position: 'Sales Consultant',
    phone: '0487 096 277',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
  },
  {
    name: 'Kahlia Duncan',
    email: 'kahlia.duncan@bydnunawading.com.au',
    status: 'Employed',
    position: 'Fleet Sales',
    phone: '0425 329 335',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
  },
  {
    name: 'Peiqin Chen',
    email: 'aaron.chen@byddoncaster.com.au',
    status: 'Employed',
    position: 'Sales Consultant',
    phone: '0422 778 598',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
  },
  {
    name: 'Zhiyong Sun',
    email: 'ray.sun@byddoncaster.com.au',
    status: 'Employed',
    position: 'Assistant Sales Manager',
    phone: '0424 120 625',
    role: 'sales_manager',
    leadsRole: 'sales_manager',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: true,
  },
  {
    name: 'James Zhang',
    email: 'james.zhang@bydnunawading.com.au',
    status: 'Employed',
    position: 'Sales Manager',
    phone: '0433 508 847',
    role: 'sales_manager',
    leadsRole: 'sales_manager',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: true,
  },
  {
    name: 'Chaney Liu',
    email: 'chaney.liu@bydnunawading.com.au',
    status: 'Employed',
    position: 'Sales Consultant(pt)',
    phone: '0414 108 528',
    role: 'sales_consultant',
    leadsRole: 'sales_consultant',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
  },
];

async function main() {
  console.log('================================================================');
  console.log(' PROVISIONING BYD NUNAWADING STAFF ACCOUNTS');
  console.log(' Password: ' + DEFAULT_PASSWORD);
  console.log(' Total staff count: ' + nunawadingStaff.length);
  console.log('================================================================\n');

  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 12);

  // 1. Connect to Delivery Centre & CRM DB (byd-panel)
  console.log('Connecting to byd-panel (CRM, Sales Floor & Delivery Centre DB)...');
  const panelConn = await mongoose.createConnection(DELIVERY_URI).asPromise();
  const panelUserColl = panelConn.collection('users');
  console.log('Connected to byd-panel.\n');

  // 2. Connect to Lead Centre DB (byd-leads-new)
  console.log('Connecting to byd-leads-new (Lead Manager DB)...');
  const leadConn = await mongoose.createConnection(LEAD_URI).asPromise();
  const leadUserColl = leadConn.collection('users');
  console.log('Connected to byd-leads-new.\n');

  const results = [];

  for (const staff of nunawadingStaff) {
    const cleanEmail = staff.email.toLowerCase().trim();

    // ─────────────────────────────────────────────────────────────
    // Provision in byd-panel (CRM / Sales Floor / Delivery Centre)
    // ─────────────────────────────────────────────────────────────
    const existingPanel = await panelUserColl.findOne({ email: cleanEmail });
    if (existingPanel) {
      await panelUserColl.updateOne(
        { email: cleanEmail },
        {
          $set: {
            name: staff.name,
            role: staff.role,
            site: staff.site,
            active_site: staff.site,
            locked_site: staff.locked_site,
            network_lookup: staff.network_lookup,
            phone: staff.phone,
            contractor_phone: staff.phone,
            position: staff.position,
            employee_status: staff.status,
            password_hash: passwordHash,
            active: true,
            must_change_password: false,
            updatedAt: new Date(),
          },
        }
      );
      console.log(`[byd-panel: UPDATED] ${staff.name} <${cleanEmail}> (${staff.role})`);
    } else {
      await panelUserColl.insertOne({
        id: crypto.randomUUID(),
        email: cleanEmail,
        name: staff.name,
        role: staff.role,
        team: 'Sales Floor',
        site: staff.site,
        active_site: staff.site,
        locked_site: staff.locked_site,
        network_lookup: staff.network_lookup,
        phone: staff.phone,
        contractor_phone: staff.phone,
        position: staff.position,
        employee_status: staff.status,
        company_name: 'BYD Nunawading',
        contractor_skills: [],
        active: true,
        must_change_password: false,
        last_login_at: null,
        password_hash: passwordHash,
        pushTokens: [],
        created_at: new Date().toISOString(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      console.log(`[byd-panel: CREATED] ${staff.name} <${cleanEmail}> (${staff.role})`);
    }

    // ─────────────────────────────────────────────────────────────
    // Provision in byd-leads-new (Lead Manager / Leads CRM)
    // ─────────────────────────────────────────────────────────────
    const existingLead = await leadUserColl.findOne({ email: cleanEmail });
    if (existingLead) {
      await leadUserColl.updateOne(
        { email: cleanEmail },
        {
          $set: {
            name: staff.name,
            role: staff.leadsRole,
            site: staff.site,
            locked_site: staff.locked_site,
            phone: staff.phone,
            position: staff.position,
            employee_status: staff.status,
            password_hash: passwordHash,
            active: true,
            updatedAt: new Date(),
          },
        }
      );
      console.log(`[byd-leads: UPDATED] ${staff.name} <${cleanEmail}> (${staff.leadsRole})`);
    } else {
      await leadUserColl.insertOne({
        email: cleanEmail,
        name: staff.name,
        role: staff.leadsRole,
        site: staff.site,
        locked_site: staff.locked_site,
        phone: staff.phone,
        position: staff.position,
        employee_status: staff.status,
        password_hash: passwordHash,
        active: true,
        last_login_at: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      console.log(`[byd-leads: CREATED] ${staff.name} <${cleanEmail}> (${staff.leadsRole})`);
    }

    results.push({
      name: staff.name,
      email: cleanEmail,
      position: staff.position,
      role: staff.role,
      phone: staff.phone,
      site: staff.site,
    });
  }

  // Also sync password for legacy alias/fairfield accounts if they exist
  const legacyAliases = [
    'gordon.shek@bydfairfield.com.au',
    'kahlia.duncan@harmonyauto.com.au',
  ];
  for (const alias of legacyAliases) {
    const existing = await panelUserColl.findOne({ email: alias });
    if (existing) {
      await panelUserColl.updateOne(
        { email: alias },
        { $set: { password_hash: passwordHash, updatedAt: new Date() } }
      );
      console.log(`[byd-panel: ALIAS UPDATED] ${alias}`);
    }
  }

  await panelConn.close();
  await leadConn.close();

  console.log('\n================================================================');
  console.log(' ALL 16 ACCOUNTS SUCCESSFULLY PROVISIONED!');
  console.log(' Password for all accounts: ' + DEFAULT_PASSWORD);
  console.log('================================================================');
  console.table(results);
}

main().catch((err) => {
  console.error('❌ Error provisioning accounts:', err);
  process.exit(1);
});
