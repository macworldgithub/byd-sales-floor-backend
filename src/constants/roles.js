/**
 * roles.js – Canonical User Roles & Permissions for BYD Sales CRM & Delivery Centre
 * Aligned with BYD Sales CRM Layer Technical Scope §4 & §9.
 */

const ROLES = {
  SALES_CONSULTANT: 'sales_consultant',
  SALES_MANAGER: 'sales_manager',
  BDC: 'bdc',
  DELIVERY_CONSULTANT: 'delivery_consultant',
  SITE_ADMIN: 'site_admin',
  SUPER_ADMIN: 'super_admin',
};

// Role Groups
const ALL_ROLES = Object.values(ROLES);

const MANAGER_ROLES = [
  ROLES.SALES_MANAGER,
  ROLES.SITE_ADMIN,
  ROLES.SUPER_ADMIN,
];

const ADMIN_ROLES = [
  ROLES.SITE_ADMIN,
  ROLES.SUPER_ADMIN,
];

const LEAD_CONTROLLER_ROLES = [
  ROLES.BDC,
  ROLES.SALES_MANAGER,
  ROLES.SUPER_ADMIN,
];

const DELIVERY_ROLES = [
  ROLES.DELIVERY_CONSULTANT,
  ROLES.SITE_ADMIN,
  ROLES.SUPER_ADMIN,
];

const SELLING_ROLES = [
  ROLES.SALES_CONSULTANT,
  ROLES.SALES_MANAGER,
  ROLES.SUPER_ADMIN,
];

module.exports = {
  ROLES,
  ALL_ROLES,
  MANAGER_ROLES,
  ADMIN_ROLES,
  LEAD_CONTROLLER_ROLES,
  DELIVERY_ROLES,
  SELLING_ROLES,
};
