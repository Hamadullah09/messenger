'use client';

import {
  LEAD_DIRECTIONS,
  LEAD_SOURCES,
  OUTBOUND_SOURCES,
  type FollowUpKind,
  type LeadDirection,
  type LeadDetailDto,
  type LeadDto,
  type LeadDuplicateDto,
  type SalesUserDto,
} from '@storeline/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useDebounced } from '@/lib/use-debounced';
import { useState } from 'react';
import { api, ApiRequestError, errorMessage } from '@/lib/api';
import { countries } from '@/lib/countries';
import { Alert, Button, Dialog, SelectField, TextArea, TextField } from '../ui';
import { FollowUpKindField, toLocalInput } from './follow-up';
import { DIRECTION_LABEL, SOURCE_LABEL } from './labels';

/** Create a lead, or edit one's details. */
export function LeadFormDialog({
  lead,
  team,
  canAssign,
  onClose,
  onSaved,
}: {
  lead?: LeadDto;
  team: SalesUserDto[];
  canAssign: boolean;
  onClose: () => void;
  onSaved: (lead: LeadDetailDto) => void;
}) {
  const [form, setForm] = useState({
    companyName: lead?.companyName ?? '',
    contactName: lead?.contactName ?? '',
    contactTitle: lead?.contactTitle ?? '',
    email: lead?.email ?? '',
    phone: lead?.phone ?? '',
    website: lead?.website ?? '',
    industry: lead?.industry ?? '',
    city: lead?.city ?? '',
    country: lead?.country ?? 'PK',
    storeCount: lead?.storeCount?.toString() ?? '',
    estimatedValue: lead?.estimatedValue?.toString() ?? '',
    currency: lead?.currency ?? 'PKR',
    source: lead?.source ?? 'COLD_CALL',
    direction: (lead?.direction ?? 'OUTBOUND') as LeadDirection,
    sourceDetail: lead?.sourceDetail ?? '',
    notes: lead?.notes ?? '',
    nextFollowUpAt: toLocalInput(lead?.nextFollowUpAt),
    nextFollowUpKind: (lead?.nextFollowUpKind ?? '') as FollowUpKind | '',
    nextFollowUpNote: lead?.nextFollowUpNote ?? '',
    ownerId: lead?.owner?.id ?? '',
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const nullable = (v: string) => (v.trim() ? v.trim() : null);
  const number = (v: string) => (v.trim() ? Number(v) : null);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        companyName: form.companyName.trim(),
        contactName: form.contactName.trim(),
        contactTitle: nullable(form.contactTitle),
        email: nullable(form.email),
        phone: nullable(form.phone),
        website: nullable(form.website),
        industry: nullable(form.industry),
        city: nullable(form.city),
        country: nullable(form.country),
        storeCount: number(form.storeCount),
        estimatedValue: number(form.estimatedValue),
        currency: form.currency,
        source: form.source,
        direction: form.direction,
        sourceDetail: nullable(form.sourceDetail),
        notes: nullable(form.notes),
        nextFollowUpAt: form.nextFollowUpAt ? new Date(form.nextFollowUpAt).toISOString() : null,
        ...(form.nextFollowUpAt
          ? { nextFollowUpKind: form.nextFollowUpKind || null, nextFollowUpNote: nullable(form.nextFollowUpNote) }
          : {}),
        ...(!lead && canAssign ? { ownerId: form.ownerId || null } : {}),
      };
      return lead
        ? api<LeadDetailDto>(`/sales/leads/${lead.id}`, { method: 'PATCH', body })
        : api<LeadDetailDto>('/sales/leads', { method: 'POST', body });
    },
    onSuccess: onSaved,
  });
  const err = (path: string) =>
    save.error instanceof ApiRequestError
      ? save.error.details.find((d) => d.path === path)?.message
      : undefined;

  const dupKey = useDebounced(`${form.companyName.trim()}|${form.email.trim()}|${form.phone.trim()}`);
  const [dupCompany, dupEmail, dupPhone] = dupKey.split('|');
  const duplicates = useQuery({
    queryKey: ['lead-duplicates', dupKey],
    queryFn: () =>
      api<LeadDuplicateDto[]>('/sales/crm/leads/duplicates', {
        query: {
          companyName: dupCompany || undefined,
          email: dupEmail || undefined,
          phone: dupPhone || undefined,
        },
      }),
    enabled: !lead && ((dupCompany?.length ?? 0) >= 3 || !!dupEmail || (dupPhone?.length ?? 0) >= 7),
  });

  return (
    <Dialog open onClose={onClose} title={lead ? `Edit ${lead.companyName}` : 'New lead'} wide>
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
        {!lead && duplicates.data && duplicates.data.length > 0 && (
          <Alert tone="warning" title="This lead may already exist">
            <ul className="mt-1 list-disc pl-5">
              {duplicates.data.map((d) => (
                <li key={d.id}>
                  <b>{d.companyName}</b> ({d.contactName}) · {d.reason} · {d.stage.toLowerCase()}
                  {d.owner ? ` · ${d.owner.displayName}` : ' · unassigned'}
                </li>
              ))}
            </ul>
          </Alert>
        )}
        <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <legend className="mb-2 font-bold">Company</legend>
          <TextField
            label="Company / business name"
            required
            value={form.companyName}
            onChange={(e) => set({ companyName: e.target.value })}
            error={err('companyName')}
          />
          <TextField
            label="Industry (optional)"
            placeholder="e.g. Retail, Pharmacy, Restaurants"
            value={form.industry}
            onChange={(e) => set({ industry: e.target.value })}
          />
          <TextField
            label="Number of stores or branches"
            type="number"
            min={0}
            value={form.storeCount}
            onChange={(e) => set({ storeCount: e.target.value })}
          />
          <TextField
            label="Website (optional)"
            type="url"
            placeholder="https://"
            value={form.website}
            onChange={(e) => set({ website: e.target.value })}
            error={err('website')}
          />
          <TextField
            label="City"
            value={form.city}
            onChange={(e) => set({ city: e.target.value })}
          />
          <SelectField
            label="Country"
            value={form.country}
            onChange={(e) => set({ country: e.target.value })}
          >
            <option value="">Not set</option>
            {countries().map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </SelectField>
        </fieldset>
        <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <legend className="mb-2 font-bold">Contact person</legend>
          <TextField
            label="Name"
            required
            value={form.contactName}
            onChange={(e) => set({ contactName: e.target.value })}
            error={err('contactName')}
          />
          <TextField
            label="Job title (optional)"
            placeholder="e.g. Owner, Operations manager"
            value={form.contactTitle}
            onChange={(e) => set({ contactTitle: e.target.value })}
          />
          <TextField
            label="Phone"
            type="tel"
            hint="International format, e.g. +923001234567"
            value={form.phone}
            onChange={(e) => set({ phone: e.target.value })}
            error={err('phone')}
          />
          <TextField
            label="Email"
            type="email"
            value={form.email}
            onChange={(e) => set({ email: e.target.value })}
            error={err('email')}
          />
        </fieldset>
        <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <legend className="mb-2 font-bold">Deal</legend>
          <SelectField
            label="Where did this lead come from?"
            value={form.source}
            onChange={(e) => {
              const source = e.target.value as typeof form.source;
              // Cold calls and email campaigns are outbound; everything else usually inbound.
              set({
                source,
                direction: OUTBOUND_SOURCES.includes(source) ? 'OUTBOUND' : 'INBOUND',
              });
            }}
          >
            {LEAD_SOURCES.map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABEL[s]}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Inbound or outbound?"
            hint="Inbound: they contacted us. Outbound: we reached out to them."
            value={form.direction}
            onChange={(e) => set({ direction: e.target.value as LeadDirection })}
          >
            {LEAD_DIRECTIONS.map((d) => (
              <option key={d} value={d}>
                {DIRECTION_LABEL[d]}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Source details (optional)"
            placeholder="Campaign, referrer or event name"
            value={form.sourceDetail}
            onChange={(e) => set({ sourceDetail: e.target.value })}
          />
          <TextField
            label="Expected monthly value"
            type="number"
            min={0}
            value={form.estimatedValue}
            onChange={(e) => set({ estimatedValue: e.target.value })}
          />
          <SelectField
            label="Currency"
            value={form.currency}
            onChange={(e) => set({ currency: e.target.value })}
          >
            {['PKR', 'USD', 'AED', 'SAR', 'GBP', 'EUR'].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </SelectField>
          <TextField
            label="Next follow-up"
            type="datetime-local"
            value={form.nextFollowUpAt}
            onChange={(e) => set({ nextFollowUpAt: e.target.value })}
          />
          {form.nextFollowUpAt && (
            <FollowUpKindField value={form.nextFollowUpKind} onChange={(v) => set({ nextFollowUpKind: v })} />
          )}
          {form.nextFollowUpAt && (
            <TextField
              label="Follow-up note (optional)"
              maxLength={300}
              placeholder="e.g. At their office, bring the price list"
              value={form.nextFollowUpNote}
              onChange={(e) => set({ nextFollowUpNote: e.target.value })}
            />
          )}
          {!lead && canAssign && (
            <SelectField
              label="Assign to"
              value={form.ownerId}
              onChange={(e) => set({ ownerId: e.target.value })}
            >
              <option value="">Unassigned queue</option>
              {team.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </SelectField>
          )}
        </fieldset>
        <TextArea
          label="Notes (optional)"
          rows={3}
          maxLength={2000}
          value={form.notes}
          onChange={(e) => set({ notes: e.target.value })}
        />
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={save.isPending}>
            {lead ? 'Save lead' : 'Create lead'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
