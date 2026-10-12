/**
 * Permission catalog. Permission keys are stored in the database (RolePermission.permission),
 * so keys are append-only: never rename a key, deprecate it instead.
 *
 * `privileged` permissions require an MFA-verified session.
 * `externalAllowed` permissions may be granted to EXTERNAL (customer) users; every other
 * permission is denied to external users regardless of their role assignments.
 */
export interface PermissionDefinition {
  readonly description: string;
  readonly privileged?: boolean;
  readonly externalAllowed?: boolean;
  /** Only meaningful at PLATFORM scope; never covered by a BUSINESS/STORE assignment. */
  readonly platformOnly?: boolean;
  /**
   * Sales & Marketing module: only the Sales roles (and the Super Admin) ever hold these.
   * Never part of business roles or custom roles.
   */
  readonly salesOnly?: boolean;
}

/** Keeps literal keys while typing every value as a full PermissionDefinition. */
function definePermissions<K extends string>(
  definitions: Record<K, PermissionDefinition>,
): Readonly<Record<K, PermissionDefinition>> {
  return definitions;
}

export const PERMISSIONS = definePermissions({
  'platform.config': {
    description: 'Manage platform-wide configuration and limits',
    privileged: true,
    platformOnly: true,
  },
  'platform.health.read': {
    description: 'View system health, queues and operational metrics',
    privileged: true,
    platformOnly: true,
  },
  'business.create': {
    description: 'Create businesses',
    privileged: true,
    platformOnly: true,
  },
  'business.read': { description: 'View business profile and settings' },
  'business.update': { description: 'Update business profile and settings', privileged: true },
  'business.suspend': {
    description: 'Suspend or reactivate a business',
    privileged: true,
    platformOnly: true,
  },
  'business.archive': {
    description: 'Archive a business',
    privileged: true,
    platformOnly: true,
  },
  'store.create': { description: 'Create stores', privileged: true },
  'store.read': { description: 'View stores' },
  'store.update': { description: 'Update stores and their memberships', privileged: true },
  'store.archive': { description: 'Archive stores', privileged: true },
  'department.manage': { description: 'Create and manage departments', privileged: true },
  'user.create': { description: 'Create users', privileged: true },
  'user.read': { description: 'View users in the directory' },
  'user.update': { description: 'Update user profiles and memberships', privileged: true },
  'user.deactivate': { description: 'Deactivate and reactivate users', privileged: true },
  'user.contact.read': {
    description: 'Read private contact details (email/phone). Every access is audited.',
    privileged: true,
  },
  'session.revoke': { description: "Revoke other users' sessions", privileged: true },
  'role.read': { description: 'View roles and assignments' },
  'role.manage': { description: 'Create and edit custom roles', privileged: true },
  'role.assign': { description: 'Assign and revoke roles', privileged: true },
  'group.create': { description: 'Create communication groups' },
  'group.manage': { description: 'Manage any group in scope (members, settings)' },
  'conversation.direct.create': { description: 'Start direct conversations with colleagues' },
  'message.send': {
    description: 'Send messages in conversations you belong to',
    externalAllowed: true,
  },
  'message.delete': { description: 'Delete any message in scope (moderation)' },
  'bulk_message.send': { description: 'Create and send bulk campaigns', privileged: true },
  'emergency.trigger': { description: 'Use the emergency help workflow' },
  'emergency_contact.manage': {
    description: 'Configure store emergency contacts and escalation policy',
    privileged: true,
  },
  'emergency_contact.access': { description: 'Be resolved as / reach emergency contacts' },
  'incident.read': { description: 'View emergency incidents in scope' },
  'incident.acknowledge': { description: 'Acknowledge and resolve incidents' },
  'media.upload': { description: 'Upload attachments', externalAllowed: true },
  'media.download': { description: 'Download attachments', externalAllowed: true },
  'audit.read': { description: 'Read audit logs', privileged: true },
  'report.export': { description: 'Export administrative reports', privileged: true },
  'customer.read': { description: "View the business's store customers" },
  'customer.manage': {
    description: 'Record store customers and their marketing consent; export for campaigns',
  },
  'sales.access': { description: 'Use the Sales & Marketing module', salesOnly: true },
  'sales.lead.manage': {
    description: 'Create leads and work on their own and unassigned leads',
    salesOnly: true,
  },
  'sales.lead.read_all': { description: 'See every lead and sales report', salesOnly: true },
  'sales.lead.assign': { description: 'Assign leads to sales people', salesOnly: true },
  'sales.lead.convert': {
    description: 'Turn a won lead into an SMA customer business',
    salesOnly: true,
  },
  'sales.team.manage': { description: 'Add and manage Sales & Marketing users', salesOnly: true },
});

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(value: string): value is Permission {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, value);
}

export function permissionDefinition(permission: Permission): PermissionDefinition {
  return PERMISSIONS[permission];
}

export type ScopeType = 'PLATFORM' | 'BUSINESS' | 'STORE';

export type SystemRoleKey =
  | 'SUPER_ADMIN'
  | 'SALES_MANAGER'
  | 'SALES_AGENT'
  | 'BUSINESS_OWNER'
  | 'BUSINESS_ADMIN'
  | 'BUSINESS_MANAGER'
  | 'STORE_MANAGER'
  | 'SECURITY'
  | 'EMPLOYEE'
  | 'CUSTOMER';

/** Most senior first; used to pick the role shown under a name and the dashboard to show. */
export const SYSTEM_ROLE_ORDER: readonly SystemRoleKey[] = [
  'SUPER_ADMIN',
  'SALES_MANAGER',
  'SALES_AGENT',
  'BUSINESS_OWNER',
  'BUSINESS_ADMIN',
  'BUSINESS_MANAGER',
  'STORE_MANAGER',
  'SECURITY',
  'EMPLOYEE',
  'CUSTOMER',
];

/** Roles held for a whole business (never tied to a store). */
export const BUSINESS_ROLE_KEYS: readonly SystemRoleKey[] = [
  'SALES_MANAGER',
  'SALES_AGENT',
  'BUSINESS_OWNER',
  'BUSINESS_ADMIN',
  'BUSINESS_MANAGER',
  'CUSTOMER',
];

/** Sales & Marketing roles: held only inside SMA's internal sales team. */
export const SALES_ROLE_KEYS: readonly SystemRoleKey[] = ['SALES_MANAGER', 'SALES_AGENT'];

/** Roles a store manager may give to people in their own stores. */
export const STORE_STAFF_ROLE_KEYS: readonly SystemRoleKey[] = ['EMPLOYEE', 'SECURITY'];

export interface SystemRoleDefinition {
  readonly key: SystemRoleKey;
  readonly name: string;
  readonly description: string;
  readonly allowedScopes: readonly ScopeType[];
  readonly permissions: readonly Permission[];
}

const STAFF_BASE: readonly Permission[] = [
  'store.read',
  'user.read',
  'conversation.direct.create',
  'message.send',
  'emergency.trigger',
  'media.upload',
  'media.download',
];

const BUSINESS_WIDE: readonly Permission[] = ALL_PERMISSIONS.filter(
  (p) => !PERMISSIONS[p].platformOnly && !PERMISSIONS[p].salesOnly,
);

const SALES_ALL: readonly Permission[] = ALL_PERMISSIONS.filter((p) => PERMISSIONS[p].salesOnly);

export const SYSTEM_ROLES: Record<SystemRoleKey, SystemRoleDefinition> = {
  SUPER_ADMIN: {
    key: 'SUPER_ADMIN',
    name: 'Super Admin',
    description: 'Controls the whole platform. Has no implicit access to message content.',
    allowedScopes: ['PLATFORM'],
    permissions: ALL_PERMISSIONS.filter((p) => p !== 'emergency.trigger'),
  },
  SALES_MANAGER: {
    key: 'SALES_MANAGER',
    name: 'Sales Manager',
    description:
      'Leads the Sales & Marketing team: every lead, assignments, reports, converting won leads into SMA customers, and the team. Chats only in the sales team groups.',
    allowedScopes: ['BUSINESS'],
    permissions: [
      ...SALES_ALL,
      'user.read',
      'user.create',
      'user.update',
      'user.deactivate',
      'role.read',
      'role.assign',
      'group.create',
      'group.manage',
      'message.send',
      'media.upload',
      'media.download',
    ],
  },
  SALES_AGENT: {
    key: 'SALES_AGENT',
    name: 'Sales Agent',
    description:
      'Works on their own and unassigned leads: calls, emails, meetings, notes and stages. Chats only in the sales team groups.',
    allowedScopes: ['BUSINESS'],
    permissions: [
      'sales.access',
      'sales.lead.manage',
      'message.send',
      'media.upload',
      'media.download',
    ],
  },
  BUSINESS_OWNER: {
    key: 'BUSINESS_OWNER',
    name: 'Business Owner',
    description:
      'Owns one business: its profile, stores, managers, people, groups, roles and campaigns.',
    allowedScopes: ['BUSINESS'],
    permissions: BUSINESS_WIDE,
  },
  BUSINESS_ADMIN: {
    key: 'BUSINESS_ADMIN',
    name: 'Business Admin',
    description: 'Manages one business: stores, users, groups, roles and campaigns.',
    allowedScopes: ['BUSINESS'],
    permissions: BUSINESS_WIDE,
  },
  BUSINESS_MANAGER: {
    key: 'BUSINESS_MANAGER',
    name: 'Business Manager',
    description:
      'Runs the stores of one business: adds stores, assigns managers, manages people and groups. Cannot change the business profile, custom roles or read the audit log.',
    allowedScopes: ['BUSINESS'],
    permissions: BUSINESS_WIDE.filter(
      (p) => !(['business.update', 'role.manage', 'audit.read'] as Permission[]).includes(p),
    ),
  },
  STORE_MANAGER: {
    key: 'STORE_MANAGER',
    name: 'Store Manager',
    description:
      'Runs one or more stores: adds and deactivates staff, team communication, groups, emergency response.',
    allowedScopes: ['STORE'],
    permissions: [
      ...STAFF_BASE,
      'user.create',
      'user.update',
      'user.deactivate',
      'customer.read',
      'customer.manage',
      'role.read',
      'role.assign',
      'group.create',
      'group.manage',
      'message.delete',
      'emergency_contact.access',
      'incident.read',
      'incident.acknowledge',
    ],
  },
  SECURITY: {
    key: 'SECURITY',
    name: 'Security / Surveillance',
    description: 'Receives security alerts and incident reports for assigned stores.',
    allowedScopes: ['STORE'],
    permissions: [
      ...STAFF_BASE,
      'emergency_contact.access',
      'incident.read',
      'incident.acknowledge',
    ],
  },
  EMPLOYEE: {
    key: 'EMPLOYEE',
    name: 'Employee',
    description: 'Standard staff member.',
    allowedScopes: ['STORE'],
    permissions: STAFF_BASE,
  },
  CUSTOMER: {
    key: 'CUSTOMER',
    name: 'Store Customer',
    description: 'External participant limited to conversations they are invited to.',
    allowedScopes: ['BUSINESS'],
    permissions: ['message.send', 'media.upload', 'media.download'],
  },
};
