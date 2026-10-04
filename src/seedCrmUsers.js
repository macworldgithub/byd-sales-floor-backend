/**
 * seedCrmUsers.js - Ensures CRM users exist in the Delivery Centre MongoDB
 */
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const crmUsers = [
  {
    name: 'Alex Rivers',
    email: 'alex.rivers@bydsouthport.com.au',
    role: 'sales_consultant',
    site: 'Fairfield',
    password: 'BYD2026!Demo',
  },
  {
    name: 'Sarah Chen',
    email: 'sarah.chen@bydsouthport.com.au',
    role: 'sales_manager',
    site: 'Fairfield',
    password: 'BYD2026!Demo',
  },
  {
    name: 'Marcus Vance',
    email: 'marcus.vance@bydsouthport.com.au',
    role: 'bdc',
    site: 'Melbourne City',
    password: 'BYD2026!Demo',
  },
  {
    name: 'Elena Rostova',
    email: 'elena.rostova@bydsouthport.com.au',
    role: 'super_admin',
    site: '',
    password: 'BYD2026!Demo',
  },
];

async function runSeed() {
  await mongoose.connect(process.env.DELIVERY_CENTER_MONGO_URI);
  console.log('Connected to MongoDB');

  const User = mongoose.connection.collection('users');

  for (const u of crmUsers) {
    const existing = await User.findOne({ email: u.email });
    const hash = await bcrypt.hash(u.password, 12);
    if (!existing) {
      await User.insertOne({
        name: u.name,
        email: u.email,
        role: u.role,
        site: u.site,
        password_hash: hash,
        active: true,
        must_change_password: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      console.log(`Created CRM user: ${u.email}`);
    } else {
      await User.updateOne(
        { email: u.email },
        {
          $set: {
            name: u.name,
            role: u.role,
            site: u.site,
            password_hash: hash,
            active: true,
            updatedAt: new Date(),
          },
        }
      );
      console.log(`Updated CRM user: ${u.email}`);
    }
  }

  await mongoose.disconnect();
  console.log('Done seeding CRM users.');
}

runSeed().catch((err) => {
  console.error(err);
  process.exit(1);
});
