/**
 * createPlatformAccounts.js
 *
 * Provision accounts across BYD Harmony platforms based on BYD_Platform_Access_List.md:
 * - Lead Manager (MongoDB database: byd-leads-new)
 * - Delivery Centre & Sales CRM (MongoDB database: byd-panel)
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

const LEAD_URI = process.env.LEAD_CENTER_MONGO_URI ||
  'mongodb+srv://salman:4lanHyMRdCrtXDJ7@sign365.nglnioh.mongodb.net/byd-leads-new?retryWrites=true&w=majority';

const DELIVERY_URI = process.env.DELIVERY_CENTER_MONGO_URI ||
  'mongodb+srv://salman:4lanHyMRdCrtXDJ7@sign365.nglnioh.mongodb.net/byd-panel?retryWrites=true&w=majority';

// ─── 1. LEAD MANAGER ACCOUNTS (byd-leads-new) ─────────────────────────────────
const leadManagerUsers = [
  {
    name: 'Tracey Arnott',
    email: 'tracey.arnott@bydnunawading.com.au',
    role: 'sales_consultant',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    phone: '0408 872 239',
    position: 'Sales Consultant',
  },
  {
    name: 'Gordon Shek',
    email: 'gordon.shek@bydnunawading.com.au',
    role: 'agent',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    phone: '0451 221 186',
    position: 'Delivery Coordinator',
  },
  {
    name: 'Jun Lin',
    email: 'rocky.lin@byddoncaster.com.au',
    role: 'sales_consultant',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    phone: '0455 736 669',
    position: 'Sales consultant',
  },
  {
    name: 'Marklin Wee',
    email: 'marklin.wee@bydnunawading.com.au',
    role: 'sales_consultant',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    phone: '0419 543 589',
    position: 'Sales consultant',
  },
  {
    name: 'Jinying (Messio) Wang',
    email: 'messio.wang@bydnunawading.com.au',
    role: 'agent',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    phone: '0434 005 022',
    position: 'Delivery coordinator',
  },
  {
    name: 'Hanjing Chen',
    email: 'hanjing.chen@bydnunawading.com.au',
    role: 'sales_consultant',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    phone: '0452 637 767',
    position: 'Sales Consultant(pt)',
  },
  {
    name: 'Eldhose Philip',
    email: 'eldhose.philip@bydnunawading.com.au',
    role: 'sales_consultant',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    phone: '0451 166 506',
    position: 'Sales Consultant',
  },
  {
    name: 'Joseph Pang',
    email: 'joseph.pang@byddoncaster.com.au',
    role: 'sales_consultant',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    phone: '0426 914 705',
    position: 'Sales Consultant',
  },
  {
    name: 'Yuan Zhang',
    email: 'yuan.zhang@byddoncaster.com.au',
    role: 'sales_consultant',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    phone: '0450 218 520',
    position: 'Sales Consultant',
  },
  {
    name: 'Angelo Giacomo Carmine La Sala',
    email: 'angelo.lasala@byddoncaster.com.au',
    role: 'sales_consultant',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    phone: '0449 288 504',
    position: 'Sales Consultant',
  },
  {
    name: 'Darcy Ian Nesbitt',
    email: 'darcy.nesbitt@bydnunawading.com.au',
    role: 'sales_consultant',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    phone: '0487 096 277',
    position: 'Sales Consultant',
  },
  {
    name: 'Kahlia Duncan',
    email: 'kahlia.duncan@bydnunawading.com.au',
    role: 'sales_consultant',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    phone: '0425 329 335',
    position: 'Fleet Sales',
  },
  {
    name: 'Peiqin Chen',
    email: 'aaron.chen@byddoncaster.com.au',
    role: 'sales_consultant',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    phone: '0422 778 598',
    position: 'Sales Consultant',
  },
  {
    name: 'Zhiyong Sun',
    email: 'ray.sun@byddoncaster.com.au',
    role: 'sales_manager',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    phone: '0424 120 625',
    position: 'Assistant Sales Manager',
  },
  {
    name: 'James Zhang',
    email: 'james.zhang@bydnunawading.com.au',
    role: 'sales_manager',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    phone: '0433 508 847',
    position: 'Sales Manager',
  },
  {
    name: 'Chaney Liu',
    email: 'chaney.liu@bydnunawading.com.au',
    role: 'sales_consultant',
    site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    phone: '0414 108 528',
    position: 'Sales Consultant(pt)',
  },
];

// ─── 2. DELIVERY CENTRE & SALES CRM ACCOUNTS (byd-panel) ───────────────────────
const deliveryCentreUsers = [
  // Nunawading Showroom Staff (Sales Floor & CRM & Delivery Centre)
  {
    name: 'Tracey Arnott',
    email: 'tracey.arnott@bydnunawading.com.au',
    role: 'sales_consultant',
    site: 'BYD Nunawading',
    active_site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
    phone: '0408 872 239',
    position: 'Sales Consultant',
  },
  {
    name: 'Gordon Shek',
    email: 'gordon.shek@bydnunawading.com.au',
    role: 'agent',
    site: 'BYD Nunawading',
    active_site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
    phone: '0451 221 186',
    position: 'Delivery Coordinator',
  },
  {
    name: 'Jun Lin',
    email: 'rocky.lin@byddoncaster.com.au',
    role: 'sales_consultant',
    site: 'BYD Nunawading',
    active_site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
    phone: '0455 736 669',
    position: 'Sales consultant',
  },
  {
    name: 'Marklin Wee',
    email: 'marklin.wee@bydnunawading.com.au',
    role: 'sales_consultant',
    site: 'BYD Nunawading',
    active_site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
    phone: '0419 543 589',
    position: 'Sales consultant',
  },
  {
    name: 'Jinying (Messio) Wang',
    email: 'messio.wang@bydnunawading.com.au',
    role: 'agent',
    site: 'BYD Nunawading',
    active_site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
    phone: '0434 005 022',
    position: 'Delivery coordinator',
  },
  {
    name: 'Hanjing Chen',
    email: 'hanjing.chen@bydnunawading.com.au',
    role: 'sales_consultant',
    site: 'BYD Nunawading',
    active_site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
    phone: '0452 637 767',
    position: 'Sales Consultant(pt)',
  },
  {
    name: 'Eldhose Philip',
    email: 'eldhose.philip@bydnunawading.com.au',
    role: 'sales_consultant',
    site: 'BYD Nunawading',
    active_site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
    phone: '0451 166 506',
    position: 'Sales Consultant',
  },
  {
    name: 'Joseph Pang',
    email: 'joseph.pang@byddoncaster.com.au',
    role: 'sales_consultant',
    site: 'BYD Nunawading',
    active_site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
    phone: '0426 914 705',
    position: 'Sales Consultant',
  },
  {
    name: 'Yuan Zhang',
    email: 'yuan.zhang@byddoncaster.com.au',
    role: 'sales_consultant',
    site: 'BYD Nunawading',
    active_site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
    phone: '0450 218 520',
    position: 'Sales Consultant',
  },
  {
    name: 'Angelo Giacomo Carmine La Sala',
    email: 'angelo.lasala@byddoncaster.com.au',
    role: 'sales_consultant',
    site: 'BYD Nunawading',
    active_site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
    phone: '0449 288 504',
    position: 'Sales Consultant',
  },
  {
    name: 'Darcy Ian Nesbitt',
    email: 'darcy.nesbitt@bydnunawading.com.au',
    role: 'sales_consultant',
    site: 'BYD Nunawading',
    active_site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
    phone: '0487 096 277',
    position: 'Sales Consultant',
  },
  {
    name: 'Kahlia Duncan',
    email: 'kahlia.duncan@bydnunawading.com.au',
    role: 'sales_consultant',
    site: 'BYD Nunawading',
    active_site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
    phone: '0425 329 335',
    position: 'Fleet Sales',
  },
  {
    name: 'Peiqin Chen',
    email: 'aaron.chen@byddoncaster.com.au',
    role: 'sales_consultant',
    site: 'BYD Nunawading',
    active_site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
    phone: '0422 778 598',
    position: 'Sales Consultant',
  },
  {
    name: 'Zhiyong Sun',
    email: 'ray.sun@byddoncaster.com.au',
    role: 'sales_manager',
    site: 'BYD Nunawading',
    active_site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: true,
    phone: '0424 120 625',
    position: 'Assistant Sales Manager',
  },
  {
    name: 'James Zhang',
    email: 'james.zhang@bydnunawading.com.au',
    role: 'sales_manager',
    site: 'BYD Nunawading',
    active_site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: true,
    phone: '0433 508 847',
    position: 'Sales Manager',
  },
  {
    name: 'Chaney Liu',
    email: 'chaney.liu@bydnunawading.com.au',
    role: 'sales_consultant',
    site: 'BYD Nunawading',
    active_site: 'BYD Nunawading',
    locked_site: 'BYD Nunawading',
    network_lookup: false,
    phone: '0414 108 528',
    position: 'Sales Consultant(pt)',
  },

  // Section 3: Clayton South Operations Group — invited to Delivery Centre for ALL BYD SITES
  {
    name: 'Krupesh S Patel',
    email: 'krupesh.patel@bydclayton.com.au',
    role: 'agent',
    site: 'Clayton South',
    active_site: 'Fairfield',
    locked_site: null, // all BYD sites access
    network_lookup: true,
    phone: '0430 816 701',
    position: 'Warehouse Controller',
  },
  {
    name: 'Krupesh S Patel (Alias)',
    email: 'krupesh.patel@bydclaton.com.au', // typo fallback from sheet
    role: 'agent',
    site: 'Clayton South',
    active_site: 'Fairfield',
    locked_site: null,
    network_lookup: true,
    phone: '0430 816 701',
    position: 'Warehouse Controller',
  },
  {
    name: 'Angela Marie Diretto',
    email: 'angela.diretto@bydclayton.com.au',
    role: 'agent',
    site: 'Clayton South',
    active_site: 'Fairfield',
    locked_site: null, // all BYD sites access
    network_lookup: true,
    phone: '0427 853 056',
    position: 'Vehicle Delivery Booking Coordinator',
  },
  {
    name: 'Angela Marie Diretto (Alias)',
    email: 'angela.diretto@bydclaton.com.au', // typo fallback from sheet
    role: 'agent',
    site: 'Clayton South',
    active_site: 'Fairfield',
    locked_site: null,
    network_lookup: true,
    phone: '0427 853 056',
    position: 'Vehicle Delivery Booking Coordinator',
  },
  {
    name: 'Tianyu Chen',
    email: 'terry.chen@bydmelbourne.com.au',
    role: 'agent',
    site: 'Clayton South',
    active_site: 'Fairfield',
    locked_site: null, // all BYD sites access
    network_lookup: true,
    phone: '0481 226 201',
    position: 'Stock Controller',
  },
  {
    name: 'Yifei Wang',
    email: 'andy.wang@bydmelbourne.com.au',
    role: 'agent',
    site: 'Clayton South',
    active_site: 'Fairfield',
    locked_site: null, // all BYD sites access
    network_lookup: true,
    phone: '0414 540 622',
    position: 'Stock Controller',
  },
  {
    name: 'Austin Chang',
    email: 'austin.chang@denzakew.com.au',
    role: 'agent',
    site: 'Clayton South',
    active_site: 'Fairfield',
    locked_site: null, // all BYD sites access
    network_lookup: true,
    phone: '0458 666 000',
    position: 'Stock Controller',
  },
  {
    name: 'Shirley Wu',
    email: 'shirley.wu@bydmelbourne.com.au',
    role: 'agent',
    site: 'Group / Melbourne',
    active_site: 'Fairfield',
    locked_site: null, // all BYD sites access
    network_lookup: true,
    phone: '0434 324 110',
    position: 'Group Stock Controller and Registration Lead',
  },
];

async function main() {
  console.log('🚀 Starting account creation for BYD Harmony platforms...\n');
  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 12);

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. LEAD MANAGER ACCOUNTS (byd-leads-new)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('Connecting to Lead Centre DB (byd-leads-new)...');
  const leadConn = await mongoose.createConnection(LEAD_URI).asPromise();
  const leadUserColl = leadConn.collection('users');
  console.log('Connected to byd-leads-new.\n');

  console.log('=== Provisioning Lead Manager Accounts ===');
  for (const u of leadManagerUsers) {
    const cleanEmail = u.email.toLowerCase().trim();
    const existing = await leadUserColl.findOne({ email: cleanEmail });

    if (existing) {
      await leadUserColl.updateOne(
        { email: cleanEmail },
        {
          $set: {
            name: u.name,
            role: u.role,
            site: u.site,
            locked_site: u.locked_site,
            password_hash: passwordHash,
            active: true,
            updatedAt: new Date(),
          },
        }
      );
      console.log(`  [UPDATE] Lead Manager: ${u.name} <${cleanEmail}> (Role: ${u.role}, Site: ${u.site})`);
    } else {
      await leadUserColl.insertOne({
        email: cleanEmail,
        name: u.name,
        role: u.role,
        site: u.site,
        locked_site: u.locked_site,
        password_hash: passwordHash,
        active: true,
        last_login_at: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      console.log(`  [CREATE] Lead Manager: ${u.name} <${cleanEmail}> (Role: ${u.role}, Site: ${u.site})`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. DELIVERY CENTRE & SALES CRM ACCOUNTS (byd-panel)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\nConnecting to Delivery Centre DB (byd-panel)...');
  const delivConn = await mongoose.createConnection(DELIVERY_URI).asPromise();
  const delivUserColl = delivConn.collection('users');
  console.log('Connected to byd-panel.\n');

  console.log('=== Provisioning Delivery Centre & CRM Accounts ===');
  for (const u of deliveryCentreUsers) {
    const cleanEmail = u.email.toLowerCase().trim();
    const existing = await delivUserColl.findOne({ email: cleanEmail });

    if (existing) {
      const updateDoc = {
        name: u.name,
        role: u.role,
        site: u.site,
        active_site: u.active_site,
        locked_site: u.locked_site,
        network_lookup: u.network_lookup,
        password_hash: passwordHash,
        active: true,
        must_change_password: false,
        updatedAt: new Date(),
      };
      if (u.phone) updateDoc.contractor_phone = u.phone;
      if (!existing.id) updateDoc.id = crypto.randomUUID();

      await delivUserColl.updateOne({ email: cleanEmail }, { $set: updateDoc });
      console.log(
        `  [UPDATE] Delivery Centre: ${u.name} <${cleanEmail}> (Role: ${u.role}, Site: ${u.site}, Locked: ${u.locked_site ?? 'None (All BYD Sites)'})`
      );
    } else {
      const newDoc = {
        id: crypto.randomUUID(),
        email: cleanEmail,
        name: u.name,
        role: u.role,
        team: 'All Teams',
        site: u.site,
        active_site: u.active_site,
        locked_site: u.locked_site,
        network_lookup: u.network_lookup,
        company_name: null,
        contractor_phone: u.phone || null,
        contractor_skills: [],
        active: true,
        must_change_password: false,
        last_login_at: null,
        password_hash: passwordHash,
        pushTokens: [],
        created_at: new Date().toISOString(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await delivUserColl.insertOne(newDoc);
      console.log(
        `  [CREATE] Delivery Centre: ${u.name} <${cleanEmail}> (Role: ${u.role}, Site: ${u.site}, Locked: ${u.locked_site ?? 'None (All BYD Sites)'})`
      );
    }
  }

  // Also verify existing Gordon Shek @bydfairfield.com.au if present
  const gordonFairfield = await delivUserColl.findOne({ email: 'gordon.shek@bydfairfield.com.au' });
  if (gordonFairfield) {
    await delivUserColl.updateOne(
      { email: 'gordon.shek@bydfairfield.com.au' },
      { $set: { password_hash: passwordHash, updatedAt: new Date() } }
    );
    console.log('  [UPDATE] Synced password for legacy gordon.shek@bydfairfield.com.au');
  }

  await leadConn.close();
  await delivConn.close();

  console.log('\n✅ All accounts have been successfully provisioned with password: ' + DEFAULT_PASSWORD);
}

main().catch((err) => {
  console.error('❌ Error provisioning accounts:', err);
  process.exit(1);
});
