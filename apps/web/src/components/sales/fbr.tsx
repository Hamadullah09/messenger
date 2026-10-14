'use client';

import {
  FBR_PROVINCES,
  type FbrProvince,
  type FbrSettingsDto,
  type InvoiceDto,
  type UpdateFbrSettingsRequest,
} from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Landmark } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, Dialog, SelectField, TextField } from '@/components/ui';
import { api, ApiRequestError, errorMessage } from '@/lib/api';
import { formatDay } from '@/lib/format';

const provinceLabel = (p: string) => p.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

export function useFbrSettings() {
  return useQuery({
    queryKey: ['crm', 'fbr-settings'],
    queryFn: () => api<FbrSettingsDto | null>('/sales/crm/fbr-settings'),
    retry: false,
  });
}

/** Sales → CRM settings: FBR Digital Invoicing (PRAL) for sales-tax-registered businesses. */
export function FbrSettingsSection() {
  const client = useQueryClient();
  const current = useFbrSettings();
  const [form, setForm] = useState<Partial<UpdateFbrSettingsRequest> | null>(null);
  const save = useMutation({
    mutationFn: (body: UpdateFbrSettingsRequest) =>
      api<FbrSettingsDto>('/sales/crm/fbr-settings', { method: 'PUT', body }),
    onSuccess: (data) => {
      client.setQueryData(['crm', 'fbr-settings'], data);
      setForm(null);
    },
  });
  if (current.error instanceof ApiRequestError && current.error.status === 403) return null;
  if (current.isPending) return null;
  const c = current.data;
  const f: UpdateFbrSettingsRequest = {
    enabled: c?.enabled ?? false,
    sandbox: c?.sandbox ?? true,
    sellerNtnCnic: c?.sellerNtnCnic ?? '',
    sellerBusinessName: c?.sellerBusinessName ?? '',
    sellerProvince: (c?.sellerProvince as FbrProvince) ?? 'PUNJAB',
    sellerAddress: c?.sellerAddress ?? '',
    defaultHsCode: c?.defaultHsCode ?? '9983.9990',
    defaultSaleType: c?.defaultSaleType ?? 'Services',
    defaultUom: c?.defaultUom ?? 'Numbers, pieces, units',
    scenarioId: c?.scenarioId ?? 'SN001',
    ...form,
  };
  const set = (patch: Partial<UpdateFbrSettingsRequest>) => setForm({ ...form, ...patch });
  return (
    <section className="flex flex-col gap-4 rounded-3xl border border-line bg-surface p-5 shadow-card">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <Landmark className="size-5" aria-hidden /> FBR invoices
        </h2>
        <p className="text-muted">
          For sales-tax-registered businesses: send each issued invoice to FBR Digital Invoicing
          (PRAL). FBR gives it a number, which is printed on the invoice with its QR code. Get your
          security token from the PRAL/IRIS portal.
        </p>
      </div>
      {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
      <div className="flex flex-wrap gap-6">
        <label className="flex min-h-11 items-center gap-2 font-semibold">
          <input
            type="checkbox"
            className="size-5 accent-[var(--color-brand)]"
            checked={f.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          Send invoices to FBR
        </label>
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            className="size-5 accent-[var(--color-brand)]"
            checked={f.sandbox}
            onChange={(e) => set({ sandbox: e.target.checked })}
          />
          Test mode (PRAL sandbox)
        </label>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField
          label="Security token"
          type="password"
          autoComplete="new-password"
          placeholder={c?.tokenSaved ? 'Saved — leave empty to keep it' : ''}
          value={form?.token ?? ''}
          onChange={(e) => set({ token: e.target.value })}
        />
        <TextField
          label="Your NTN or CNIC"
          inputMode="numeric"
          maxLength={13}
          value={f.sellerNtnCnic}
          onChange={(e) => set({ sellerNtnCnic: e.target.value.replace(/\D/g, '') })}
        />
        <TextField
          label="Registered business name"
          maxLength={160}
          value={f.sellerBusinessName}
          onChange={(e) => set({ sellerBusinessName: e.target.value })}
        />
        <SelectField
          label="Province"
          value={f.sellerProvince}
          onChange={(e) => set({ sellerProvince: e.target.value as FbrProvince })}
        >
          {FBR_PROVINCES.map((p) => (
            <option key={p} value={p}>
              {provinceLabel(p)}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Registered address"
          maxLength={300}
          value={f.sellerAddress}
          onChange={(e) => set({ sellerAddress: e.target.value })}
        />
        <TextField
          label="HS code for your services"
          maxLength={20}
          value={f.defaultHsCode}
          onChange={(e) => set({ defaultHsCode: e.target.value })}
        />
        <TextField
          label="Sale type"
          maxLength={120}
          value={f.defaultSaleType}
          onChange={(e) => set({ defaultSaleType: e.target.value })}
        />
        <TextField
          label="Unit of measure"
          maxLength={60}
          value={f.defaultUom}
          onChange={(e) => set({ defaultUom: e.target.value })}
        />
        {f.sandbox && (
          <TextField
            label="Sandbox scenario (from PRAL)"
            maxLength={10}
            value={f.scenarioId ?? ''}
            onChange={(e) => set({ scenarioId: e.target.value || null })}
          />
        )}
      </div>
      <div className="flex justify-end">
        <Button
          busy={save.isPending}
          disabled={!form}
          onClick={() => {
            const { token, ...rest } = f;
            save.mutate({ ...rest, ...(token ? { token } : {}) });
          }}
        >
          Save FBR settings
        </Button>
      </div>
    </section>
  );
}

/** On an issued invoice: its FBR number, or the button to send it to FBR. */
export function FbrInvoiceBox({
  invoice,
  onChanged,
}: {
  invoice: InvoiceDto;
  onChanged: (i: InvoiceDto) => void;
}) {
  const settings = useFbrSettings();
  const [open, setOpen] = useState(false);
  const [buyerNtnCnic, setBuyer] = useState('');
  const [buyerProvince, setProvince] = useState<FbrProvince>(
    (settings.data?.sellerProvince as FbrProvince) ?? 'PUNJAB',
  );
  const send = useMutation({
    mutationFn: () =>
      api<InvoiceDto>(`/sales/crm/invoices/${invoice.id}/fbr`, {
        method: 'POST',
        body: { buyerProvince, ...(buyerNtnCnic ? { buyerNtnCnic } : {}) },
      }),
    onSuccess: (data) => {
      onChanged(data);
      setOpen(false);
    },
  });
  const fbr = invoice.fbr;
  if (fbr?.invoiceNumber)
    return (
      <div className="flex items-center gap-3 rounded-2xl bg-surface-2 p-3">
        {fbr.qrDataUrl && (
          <img src={fbr.qrDataUrl} alt="" className="size-16 rounded bg-white p-1" />
        )}
        <div className="text-sm">
          <p className="font-bold">
            FBR invoice {fbr.invoiceNumber}
            {fbr.sandbox ? ' (test)' : ''}
          </p>
          {fbr.submittedAt && <p className="text-muted">Registered {formatDay(fbr.submittedAt)}</p>}
        </div>
      </div>
    );
  if (
    !settings.data?.enabled ||
    invoice.status === 'DRAFT' ||
    invoice.status === 'VOID' ||
    invoice.currency !== 'PKR'
  )
    return null;
  return (
    <>
      {fbr?.error && (
        <Alert tone="error" title="FBR did not accept this invoice">
          {fbr.error}
        </Alert>
      )}
      <div>
        <Button
          variant="secondary"
          icon={<Landmark className="size-5" aria-hidden />}
          onClick={() => setOpen(true)}
        >
          Send to FBR
        </Button>
      </div>
      {open && (
        <Dialog open onClose={() => setOpen(false)} title={`Send ${invoice.number} to FBR`}>
          <div className="flex flex-col gap-3">
            {send.isError && <Alert tone="error">{errorMessage(send.error)}</Alert>}
            <TextField
              label="Buyer's NTN or CNIC (leave empty if not registered)"
              inputMode="numeric"
              maxLength={13}
              value={buyerNtnCnic}
              onChange={(e) => setBuyer(e.target.value.replace(/\D/g, ''))}
            />
            <SelectField
              label="Buyer's province"
              value={buyerProvince}
              onChange={(e) => setProvince(e.target.value as FbrProvince)}
            >
              {FBR_PROVINCES.map((p) => (
                <option key={p} value={p}>
                  {provinceLabel(p)}
                </option>
              ))}
            </SelectField>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                busy={send.isPending}
                disabled={buyerNtnCnic !== '' && ![7, 13].includes(buyerNtnCnic.length)}
                onClick={() => send.mutate()}
              >
                Send to FBR
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
