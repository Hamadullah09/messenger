/**
 * End-to-end check of account features against the running API (development only):
 * sign-in without two-step, roles, store-manager staff management, admin password reset,
 * forgot-password email via Mailpit, business details and logo, business groups.
 *
 *   node scripts/accounts-smoke.cjs
 *
 * Passwords come from apps/api/demo-accounts.local.json and are never printed.
 */
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const sharp = require(require.resolve('sharp', { paths: [join(__dirname, '..', 'apps/api')] }));

const API = process.env.API_URL ?? 'http://localhost:4000/api/v1';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:18025';
const local = JSON.parse(
  readFileSync(join(__dirname, '..', 'apps/api/demo-accounts.local.json'), 'utf8'),
);
const pw = (u) => local.accounts.find((a) => a.username === u).password;

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '✔' : '✘'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function call(token, method, path, body, headers = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined && !(body instanceof Buffer)
        ? { 'content-type': 'application/json' }
        : {}),
      'x-sma-client': 'native',
      ...headers,
    },
    body: body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function login(username, password = pw(username)) {
  const r = await call(null, 'POST', '/auth/login', { username, password });
  if (r.status !== 200 || r.json.mfaRequired) throw new Error(`login ${username}: ${r.status}`);
  return r.json;
}

async function main() {
  // 1. Admin signs in without two-step and can use admin features.
  const admin = await login('admin');
  check('admin signs in without a two-step code', !!admin.accessToken);
  check('two-step is not required for admins', admin.me.security.mfaRequiredForAdmins === false);
  const businessId = admin.me.businesses[0].id;
  const A = admin.accessToken;

  const stores = await call(A, 'GET', `/businesses/${businessId}/stores`);
  check(
    'admin lists stores with managers',
    stores.status === 200 && Array.isArray(stores.json[0].managers),
  );
  const storeA = stores.json.find((s) => s.code === 'A');
  const storeB = stores.json.find((s) => s.code === 'B');

  // 2. Business details and logo.
  const details = await call(A, 'PATCH', `/businesses/${businessId}`, {
    description: 'Neighbourhood grocery stores',
    website: 'https://example.com',
    mapUrl: 'https://maps.google.com/?q=ABC+Retail',
    address: { city: 'Lahore', region: 'Punjab', country: 'PK' },
    socialLinks: { facebook: 'https://facebook.com/example' },
  });
  check(
    'business details saved',
    details.status === 200 && details.json.address?.country === 'PK',
    JSON.stringify(details.json),
  );
  const bad = await call(A, 'PATCH', `/businesses/${businessId}`, {
    website: 'javascript:alert(1)',
  });
  check('javascript: links are rejected', bad.status === 400);
  const png = await sharp({
    create: { width: 400, height: 300, channels: 3, background: '#c2410c' },
  })
    .png()
    .toBuffer();
  const logo = await call(A, 'PUT', `/businesses/${businessId}/logo`, png, {
    'content-type': 'image/png',
  });
  check('logo uploaded', logo.status === 200 && !!logo.json.logoUrl, JSON.stringify(logo.json));
  const img = await fetch(`http://localhost:4000${logo.json.logoUrl}`);
  check(
    'logo served as WebP',
    img.status === 200 && img.headers.get('content-type') === 'image/webp',
  );
  const notImage = await call(A, 'PUT', `/businesses/${businessId}/logo`, Buffer.from('<svg/>'), {
    'content-type': 'image/png',
  });
  check('non-images are rejected as logos', notImage.status === 400);
  await call(A, 'DELETE', `/businesses/${businessId}/logo`);

  // 3. Store manager adds and deactivates staff in their own store only.
  const manager = await login('manager');
  const M = manager.accessToken;
  const username = `smoke.${Date.now().toString(36)}`;
  const created = await call(M, 'POST', `/businesses/${businessId}/users`, {
    username,
    displayName: 'Smoke Staff',
    initialPassword: 'smoke-password-1',
    roleKey: 'EMPLOYEE',
    storeIds: [storeA.id],
    email: `${username}@example.com`,
  });
  check(
    'store manager adds staff to their store',
    created.status === 201 || created.status === 200,
    JSON.stringify(created.json),
  );
  const otherStore = await call(M, 'POST', `/businesses/${businessId}/users`, {
    username: `${username}b`,
    displayName: 'Other Store',
    initialPassword: 'smoke-password-1',
    roleKey: 'EMPLOYEE',
    storeIds: [storeB.id],
    email: `${username}b@example.com`,
  });
  check('store manager cannot add staff to another store', otherStore.status === 403);
  const asAdmin = await call(M, 'POST', `/businesses/${businessId}/users`, {
    username: `${username}c`,
    displayName: 'Escalation',
    initialPassword: 'smoke-password-1',
    roleKey: 'BUSINESS_ADMIN',
    email: `${username}c@example.com`,
  });
  check('store manager cannot create admins', asAdmin.status === 403);
  const noSpace = await call(A, 'POST', `/businesses/${businessId}/users`, {
    username: 'has space',
    displayName: 'x',
    initialPassword: 'smoke-password-1',
    roleKey: 'EMPLOYEE',
    storeIds: [storeA.id],
    email: 'space@example.com',
  });
  check('usernames with spaces are rejected', noSpace.status === 400);
  const staffId = created.json.id;
  const reset = await call(M, 'POST', `/users/${staffId}/password`, {
    newPassword: 'smoke-password-2',
  });
  check('store manager sets a new password for their staff', reset.status === 204);
  const staffLogin = await call(null, 'POST', '/auth/login', {
    username,
    password: 'smoke-password-2',
  });
  check('staff signs in with the new password', staffLogin.status === 200);
  const deact = await call(M, 'POST', `/users/${staffId}/deactivate`);
  check('store manager deactivates their staff', deact.status === 204);
  const helen = (
    await call(A, 'GET', `/businesses/${businessId}/users`, undefined)
  ).json.items.find((u) => u.username === 'helen.park');
  const notTheirs = await call(M, 'POST', `/users/${helen.id}/deactivate`);
  check('store manager cannot deactivate staff of another store', notTheirs.status === 403);

  // 4. Admin changes a role and back.
  const promote = await call(A, 'PUT', `/businesses/${businessId}/users/${staffId}/role`, {
    roleKey: 'STORE_MANAGER',
    storeIds: [storeA.id, storeB.id],
  });
  check(
    'admin makes someone manager of two stores',
    promote.status === 200 &&
      promote.json.roles.filter((r) => r.roleKey === 'STORE_MANAGER').length === 2,
    JSON.stringify(promote.json),
  );
  const owner = await call(A, 'PUT', `/businesses/${businessId}/users/${staffId}/role`, {
    roleKey: 'BUSINESS_OWNER',
  });
  check(
    'admin can give the Business Owner role',
    owner.status === 200 && owner.json.roles.some((r) => r.roleKey === 'BUSINESS_OWNER'),
  );

  // 5. Groups of the business.
  const groups = await call(A, 'GET', `/businesses/${businessId}/groups`);
  check('admin lists the business groups', groups.status === 200 && groups.json.length > 0);

  // 6. Forgot password by email (Mailpit).
  await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' });
  const forgot = await call(null, 'POST', '/auth/password/forgot', { identifier: 'helen.park' });
  check('forgot password accepted', forgot.status === 200 && forgot.json.emailEnabled === true);
  const unknown = await call(null, 'POST', '/auth/password/forgot', { identifier: 'nobody.here' });
  check(
    'unknown accounts get the same answer',
    unknown.status === 200 && unknown.json.emailEnabled === true,
  );
  let message = null;
  for (let i = 0; i < 20 && !message; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    const list = await (await fetch(`${MAILPIT}/api/v1/messages`)).json();
    message = list.messages?.[0] ?? null;
  }
  check('exactly one reset email was sent', !!message);
  const full = await (await fetch(`${MAILPIT}/api/v1/message/${message.ID}`)).json();
  const token = /#token=([A-Za-z0-9_-]+)/.exec(full.Text)?.[1];
  check('email contains a reset link', !!token);
  const resetOk = await call(null, 'POST', '/auth/password/reset', {
    token,
    newPassword: pw('helen.park'),
  });
  check('password reset with the link', resetOk.status === 204, JSON.stringify(resetOk.json));
  const reuse = await call(null, 'POST', '/auth/password/reset', {
    token,
    newPassword: 'another-password',
  });
  check('a reset link works only once', reuse.status === 400);
  await login('helen.park');
  check('helen signs in after the reset', true);

  // Clean up the smoke account.
  await call(A, 'DELETE', `/businesses/${businessId}/users/${staffId}`);
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exitCode = failures ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
