'use client';

import {
  BUSINESS_ROLE_KEYS,
  EXPORT_ROLE_KEY,
  PASSWORD_MIN_LENGTH,
  STORE_STAFF_ROLE_KEYS,
  SYSTEM_ROLES,
  type AdminUserDto,
  type MeDto,
  type StoreDto,
  type SystemRoleKey,
  type UserContactDto,
} from '@storeline/shared';
import { useMutation } from '@tanstack/react-query';
import { KeyRound, LogOut, ShieldOff, Trash2, UserCheck, UserX } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api, ApiRequestError, errorMessage } from '@/lib/api';
import { hasPermission, useAuth } from '@/lib/auth-store';
import { Alert, Button, ConfirmDialog, Dialog, SelectField, TextField } from '../ui';

export const ROLE_LABELS: Record<SystemRoleKey, string> = {
  SUPER_ADMIN: 'Super Admin',
  SALES_MANAGER: 'Sales Manager',
  SALES_AGENT: 'Sales Agent',
  ACCOUNTANT: 'Accountant',
  BUSINESS_OWNER: 'Business Owner',
  BUSINESS_ADMIN: 'Business Admin',
  BUSINESS_MANAGER: 'Business Manager',
  STORE_MANAGER: 'Store Manager',
  SECURITY: 'Security / Surveillance',
  EMPLOYEE: 'Employee',
  CUSTOMER: 'Store Customer',
};

const INTERNAL_ROLES: SystemRoleKey[] = [
  'BUSINESS_OWNER',
  'BUSINESS_ADMIN',
  'BUSINESS_MANAGER',
  'STORE_MANAGER',
  'SECURITY',
  'EMPLOYEE',
];

const isBusinessRole = (key: SystemRoleKey) => BUSINESS_ROLE_KEYS.includes(key);

/** True when the person can manage everyone in the business (not just their stores). */
export function managesWholeBusiness(me: MeDto | null, businessId: string): boolean {
  return !!me?.grants.some(
    (g) =>
      g.permissions.includes('user.update') &&
      (g.scope.type === 'PLATFORM' ||
        (g.scope.type === 'BUSINESS' && g.scope.businessId === businessId)),
  );
}

/**
 * Roles the signed-in person may give: never one with permissions they lack (the server
 * enforces the same rule). Store managers can add employees and security staff.
 */
export function assignableRoles(me: MeDto | null, businessId: string): SystemRoleKey[] {
  if (!me) return [];
  if (!managesWholeBusiness(me, businessId)) return [...STORE_STAFF_ROLE_KEYS];
  const held = new Set(
    me.grants
      .filter(
        (g) =>
          g.scope.type === 'PLATFORM' ||
          (g.scope.type === 'BUSINESS' && g.scope.businessId === businessId),
      )
      .flatMap((g) => g.permissions),
  );
  return INTERNAL_ROLES.filter((key) => SYSTEM_ROLES[key].permissions.every((p) => held.has(p)));
}

function StoreChecklist({
  stores,
  selected,
  onChange,
  legend,
}: {
  stores: StoreDto[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  legend: string;
}) {
  if (stores.length === 0) return null;
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 font-semibold">{legend}</legend>
      {stores.map((s) => (
        <label key={s.id} className="flex min-h-11 items-center gap-3">
          <input
            type="checkbox"
            className="size-5"
            checked={selected.has(s.id)}
            onChange={() => {
              const next = new Set(selected);
              if (next.has(s.id)) next.delete(s.id);
              else next.add(s.id);
              onChange(next);
            }}
          />
          {s.name} <span className="text-sm text-muted">({s.code})</span>
        </label>
      ))}
    </fieldset>
  );
}

export function CreatePersonDialog({
  businessId,
  stores,
  roles,
  defaultStoreId,
  title = 'Add a person',
  onClose,
  onCreated,
}: {
  businessId: string;
  stores: StoreDto[];
  roles: SystemRoleKey[];
  defaultStoreId?: string;
  title?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    displayName: '',
    username: '',
    initialPassword: '',
    roleKey: (roles.includes('EMPLOYEE') ? 'EMPLOYEE' : roles[0]) as SystemRoleKey,
    email: '',
    phone: '',
    mustChangePassword: true,
  });
  const [storeIds, setStoreIds] = useState<Set<string>>(
    new Set(defaultStoreId ? [defaultStoreId] : stores.length === 1 ? [stores[0]!.id] : []),
  );
  const businessRole = isBusinessRole(form.roleKey);
  const create = useMutation({
    mutationFn: () =>
      api<AdminUserDto>(`/businesses/${businessId}/users`, {
        method: 'POST',
        body: {
          ...form,
          username: form.username.trim().toLowerCase(),
          email: form.email.trim(),
          phone: form.phone.trim() || undefined,
          storeIds: [...storeIds],
        },
      }),
    onSuccess: onCreated,
  });
  const fieldError = (path: string) =>
    create.error instanceof ApiRequestError
      ? create.error.details.find((d) => d.path === path)?.message
      : undefined;

  return (
    <Dialog open onClose={onClose} title={title} wide>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        {create.isError && <Alert tone="error">{errorMessage(create.error)}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Full name"
            required
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            error={fieldError('displayName')}
          />
          <TextField
            label="Username"
            hint="Used to sign in. Lowercase, no spaces, e.g. sara.khan"
            required
            autoCapitalize="none"
            spellCheck={false}
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value.replace(/\s/g, '') })}
            error={fieldError('username')}
          />
          <TextField
            label="Email"
            hint="Bound to the account; used for password resets. Never shown in chats."
            type="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            error={fieldError('email')}
          />
          <TextField
            label="Phone (private, optional)"
            hint="International format, e.g. +923001234567"
            type="tel"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            error={fieldError('phone')}
          />
          <TextField
            label="Password"
            hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
            type="password"
            autoComplete="new-password"
            required
            value={form.initialPassword}
            onChange={(e) => setForm({ ...form, initialPassword: e.target.value })}
            error={fieldError('initialPassword')}
          />
          <SelectField
            label="Role"
            value={form.roleKey}
            onChange={(e) => setForm({ ...form, roleKey: e.target.value as SystemRoleKey })}
          >
            {roles.map((key) => (
              <option key={key} value={key}>
                {ROLE_LABELS[key]}
              </option>
            ))}
          </SelectField>
        </div>
        <p className="text-sm text-muted">{SYSTEM_ROLES[form.roleKey].description}</p>
        <label className="flex min-h-11 items-center gap-3">
          <input
            type="checkbox"
            className="size-5"
            checked={form.mustChangePassword}
            onChange={(e) => setForm({ ...form, mustChangePassword: e.target.checked })}
          />
          Ask them to choose their own password at first sign-in
        </label>
        <StoreChecklist
          stores={stores}
          selected={storeIds}
          onChange={setStoreIds}
          legend={businessRole ? 'Works at (optional)' : 'Works at'}
        />
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={create.isPending}>
            Add person
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-4 first:border-0 first:pt-0">
      <h3 className="text-lg font-bold">{title}</h3>
      {children}
    </section>
  );
}

function useAction<TArgs = void>(fn: (args: TArgs) => Promise<unknown>, onDone: () => void) {
  const mutation = useMutation({ mutationFn: fn, onSuccess: () => onDone() });
  return { mutation };
}

/**
 * Everything an administrator can change about a person. Store managers (`full` = false)
 * only get password, two-step and deactivate for their own staff.
 */
export function ManagePersonDialog({
  businessId,
  user,
  stores,
  roles,
  full,
  onClose,
  onChanged,
}: {
  businessId: string;
  user: AdminUserDto;
  stores: StoreDto[];
  roles: SystemRoleKey[];
  full: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const currentRole = (user.roles.find((r) => r.roleKey in ROLE_LABELS)?.roleKey ??
    'EMPLOYEE') as SystemRoleKey;
  const [profile, setProfile] = useState({
    displayName: user.displayName,
    username: user.username,
  });
  const [contact, setContact] = useState<{ email: string; phone: string } | null>(null);
  const [roleKey, setRoleKey] = useState<SystemRoleKey>(currentRole);
  const [roleStores, setRoleStores] = useState(new Set(user.stores.map((s) => s.id)));
  const [password, setPassword] = useState('');
  const [mustChange, setMustChange] = useState(false);
  const [confirm, setConfirm] = useState<'deactivate' | 'remove' | 'delete' | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const after = (text: string) => () => {
    setMessage(text);
    onChanged();
  };
  const saveProfile = useAction(
    () =>
      api(`/businesses/${businessId}/users/${user.id}`, {
        method: 'PATCH',
        body: {
          displayName: profile.displayName.trim(),
          username: profile.username.trim().toLowerCase(),
        },
      }),
    after('Name and username saved.'),
  );
  const loadContact = useMutation({
    mutationFn: () => api<UserContactDto>(`/businesses/${businessId}/users/${user.id}/contact`),
    onSuccess: (c) => setContact({ email: c.email ?? '', phone: c.phone ?? '' }),
  });
  const saveContact = useAction(
    () =>
      api(`/businesses/${businessId}/users/${user.id}/contact`, {
        method: 'PUT',
        body: { email: contact!.email.trim() || null, phone: contact!.phone.trim() || null },
      }),
    after('Email and phone saved.'),
  );
  const saveRole = useAction(
    () =>
      api(`/businesses/${businessId}/users/${user.id}/role`, {
        method: 'PUT',
        body: { roleKey, storeIds: [...roleStores] },
      }),
    after(`Role changed to ${ROLE_LABELS[roleKey]}.`),
  );
  const savePassword = useAction(
    () =>
      api(`/users/${user.id}/password`, {
        method: 'POST',
        body: { newPassword: password, mustChangePassword: mustChange },
      }),
    () => {
      setPassword('');
      after('New password set. They were signed out on all devices.')();
    },
  );
  const resetMfa = useAction(
    () => api(`/users/${user.id}/mfa/reset`, { method: 'POST' }),
    after('Two-step verification turned off.'),
  );
  const signOut = useAction(
    () => api(`/businesses/${businessId}/users/${user.id}/sessions/revoke`, { method: 'POST' }),
    after('Signed out on all devices.'),
  );
  const status = useAction(
    (next: 'deactivate' | 'reactivate') => api(`/users/${user.id}/${next}`, { method: 'POST' }),
    () => {
      setConfirm(null);
      onChanged();
      onClose();
    },
  );
  const destroy = useAction(
    () => api(`/users/${user.id}`, { method: 'DELETE' }),
    () => {
      setConfirm(null);
      onChanged();
      onClose();
    },
  );
  const remove = useAction(
    () => api(`/businesses/${businessId}/users/${user.id}`, { method: 'DELETE' }),
    () => {
      setConfirm(null);
      onChanged();
      onClose();
    },
  );
  const errors = [
    saveProfile,
    saveContact,
    saveRole,
    savePassword,
    resetMfa,
    signOut,
    status,
    remove,
    destroy,
  ].find((a) => a.mutation.isError)?.mutation.error;
  const roleIsStoreScoped = !isBusinessRole(roleKey);
  // "Can export data": admins give it to people who are not admins.
  const me = useAuth((s) => s.me);
  const canGiveExport = full && hasPermission(me, 'report.export', businessId);
  const adminRole = user.roles.some((r) =>
    ['SUPER_ADMIN', 'BUSINESS_OWNER', 'BUSINESS_ADMIN'].includes(r.roleKey),
  );
  const exportGiven = user.roles.some((r) => r.roleKey === EXPORT_ROLE_KEY);
  const setExport = useAction(
    (allowed: boolean) =>
      api(`/businesses/${businessId}/users/${user.id}/export-access`, {
        method: 'PUT',
        body: { allowed },
      }),
    after('Export access saved.'),
  );
  const roleChoices = roles.includes(currentRole) ? roles : [currentRole, ...roles];

  return (
    <Dialog open onClose={onClose} title={`Manage ${user.displayName}`} wide>
      <div className="flex flex-col gap-5">
        {message && <Alert tone="success">{message}</Alert>}
        {(errors || loadContact.isError) && (
          <Alert tone="error">{errorMessage(errors ?? loadContact.error)}</Alert>
        )}

        {full && (
          <Section title="Name and username">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField
                label="Full name"
                value={profile.displayName}
                onChange={(e) => setProfile({ ...profile, displayName: e.target.value })}
              />
              <TextField
                label="Username"
                hint="Used to sign in. No spaces."
                autoCapitalize="none"
                spellCheck={false}
                value={profile.username}
                onChange={(e) =>
                  setProfile({ ...profile, username: e.target.value.replace(/\s/g, '') })
                }
              />
            </div>
            <Button
              className="self-start"
              variant="secondary"
              busy={saveProfile.mutation.isPending}
              onClick={() => saveProfile.mutation.mutate()}
            >
              Save name and username
            </Button>
          </Section>
        )}

        {full && (
          <Section title="Email and phone">
            {!contact ? (
              <>
                <p className="text-sm text-muted">
                  Private details. Viewing them is recorded in the audit log.
                </p>
                <Button
                  className="self-start"
                  variant="secondary"
                  busy={loadContact.isPending}
                  onClick={() => loadContact.mutate()}
                >
                  Show email and phone
                </Button>
              </>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <TextField
                    label="Email"
                    type="email"
                    value={contact.email}
                    onChange={(e) => setContact({ ...contact, email: e.target.value })}
                  />
                  <TextField
                    label="Phone"
                    type="tel"
                    value={contact.phone}
                    onChange={(e) => setContact({ ...contact, phone: e.target.value })}
                  />
                </div>
                <Button
                  className="self-start"
                  variant="secondary"
                  busy={saveContact.mutation.isPending}
                  onClick={() => saveContact.mutation.mutate()}
                >
                  Save email and phone
                </Button>
              </>
            )}
          </Section>
        )}

        {full && user.kind === 'INTERNAL' && (
          <Section title="Role">
            <SelectField
              label="Role"
              value={roleKey}
              onChange={(e) => setRoleKey(e.target.value as SystemRoleKey)}
            >
              {roleChoices.map((key) => (
                <option key={key} value={key}>
                  {ROLE_LABELS[key]}
                </option>
              ))}
            </SelectField>
            <p className="text-sm text-muted">{SYSTEM_ROLES[roleKey].description}</p>
            <StoreChecklist
              stores={stores}
              selected={roleStores}
              onChange={setRoleStores}
              legend={
                roleIsStoreScoped
                  ? roleKey === 'STORE_MANAGER'
                    ? 'Manages these stores'
                    : 'Works at'
                  : 'Works at (optional)'
              }
            />
            <Button
              className="self-start"
              busy={saveRole.mutation.isPending}
              disabled={roleIsStoreScoped && roleStores.size === 0}
              onClick={() => saveRole.mutation.mutate()}
            >
              Save role
            </Button>
          </Section>
        )}

        {canGiveExport && user.kind === 'INTERNAL' && (
          <Section title="Exporting">
            {adminRole ? (
              <p className="text-sm text-muted">
                As an admin, {user.displayName} can already export leads, customers and reports.
              </p>
            ) : (
              <>
                <label className="flex min-h-11 items-center gap-3">
                  <input
                    type="checkbox"
                    className="size-5"
                    checked={exportGiven}
                    disabled={setExport.mutation.isPending}
                    onChange={(e) => setExport.mutation.mutate(e.target.checked)}
                  />
                  Can export data (Excel/CSV)
                </label>
                <p className="text-sm text-muted">
                  Only admins can export unless you tick this. They export what they can see (a
                  sales agent: their own leads).
                </p>
              </>
            )}
            {setExport.mutation.isError && (
              <Alert tone="error">{errorMessage(setExport.mutation.error)}</Alert>
            )}
          </Section>
        )}

        <Section title="Password">
          <TextField
            label="New password"
            hint={`At least ${PASSWORD_MIN_LENGTH} characters. Tell them in person, never in a chat.`}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <label className="flex min-h-11 items-center gap-3">
            <input
              type="checkbox"
              className="size-5"
              checked={mustChange}
              onChange={(e) => setMustChange(e.target.checked)}
            />
            Ask them to choose their own password at next sign-in
          </label>
          <Button
            className="self-start"
            variant="secondary"
            icon={<KeyRound className="size-5" aria-hidden />}
            busy={savePassword.mutation.isPending}
            disabled={password.length < PASSWORD_MIN_LENGTH}
            onClick={() => savePassword.mutation.mutate()}
          >
            Set new password
          </Button>
        </Section>

        <Section title="Security">
          <p>
            Two-step verification is <strong>{user.mfaEnabled ? 'on' : 'off'}</strong>.
          </p>
          <div className="flex flex-wrap gap-2">
            {user.mfaEnabled && (
              <Button
                variant="secondary"
                icon={<ShieldOff className="size-5" aria-hidden />}
                busy={resetMfa.mutation.isPending}
                onClick={() => resetMfa.mutation.mutate()}
              >
                Turn off two-step verification
              </Button>
            )}
            {full && (
              <Button
                variant="secondary"
                icon={<LogOut className="size-5" aria-hidden />}
                busy={signOut.mutation.isPending}
                onClick={() => signOut.mutation.mutate()}
              >
                Sign out everywhere
              </Button>
            )}
          </div>
        </Section>

        <Section title="Account">
          <div className="flex flex-wrap gap-2">
            {user.status === 'ACTIVE' ? (
              <Button
                variant="danger"
                icon={<UserX className="size-5" aria-hidden />}
                onClick={() => setConfirm('deactivate')}
              >
                Deactivate account
              </Button>
            ) : (
              <Button
                icon={<UserCheck className="size-5" aria-hidden />}
                busy={status.mutation.isPending}
                onClick={() => status.mutation.mutate('reactivate')}
              >
                Reactivate account
              </Button>
            )}
            {full && (
              <Button variant="secondary" onClick={() => setConfirm('remove')}>
                Remove from business
              </Button>
            )}
            {full && (
              <Button
                variant="danger"
                icon={<Trash2 className="size-5" aria-hidden />}
                onClick={() => setConfirm('delete')}
              >
                Delete account
              </Button>
            )}
          </div>
        </Section>
      </div>
      <ConfirmDialog
        open={!!confirm}
        title={
          confirm === 'remove'
            ? `Remove ${user.displayName} from the business?`
            : confirm === 'delete'
              ? `Delete ${user.displayName}'s account?`
              : `Deactivate ${user.displayName}?`
        }
        message={
          confirm === 'remove'
            ? 'They lose access to this business, its stores and its chats. Their past messages stay in the history.'
            : confirm === 'delete'
              ? 'This cannot be undone. The account is removed from every business, store and chat, and its email, phone and password are erased. Messages they sent stay in chats as “Deleted user”. The username can be used again.'
              : 'They are signed out everywhere and cannot sign in until the account is reactivated. Their messages stay in the history.'
        }
        confirmLabel={
          confirm === 'remove'
            ? 'Remove from business'
            : confirm === 'delete'
              ? 'Delete account'
              : 'Deactivate'
        }
        danger
        busy={status.mutation.isPending || remove.mutation.isPending || destroy.mutation.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={() =>
          confirm === 'remove'
            ? remove.mutation.mutate()
            : confirm === 'delete'
              ? destroy.mutation.mutate()
              : status.mutation.mutate('deactivate')
        }
      />
    </Dialog>
  );
}
