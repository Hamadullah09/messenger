'use client';

import type {
  GatewayMethod,
  PaymentGateway,
  PaymentGatewaySettingsDto,
  UpdatePaymentGatewayRequest,
} from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, TextField } from '@/components/ui';
import { api, ApiRequestError, errorMessage } from '@/lib/api';
import { copyText } from '@/lib/clipboard';

const LABEL: Record<PaymentGateway, string> = { JAZZCASH: 'JazzCash', EASYPAISA: 'Easypaisa' };

function GatewayCard({ g }: { g: PaymentGatewaySettingsDto }) {
  const client = useQueryClient();
  const [enabled, setEnabled] = useState(g.enabled);
  const [sandbox, setSandbox] = useState(g.sandbox);
  const [merchantId, setMerchantId] = useState(g.merchantId ?? '');
  const [methods, setMethods] = useState<GatewayMethod[]>(g.methods);
  const [accountNumber, setAccountNumber] = useState(g.accountNumber ?? '');
  const [secrets, setSecrets] = useState<
    Partial<
      Record<
        'password' | 'integritySalt' | 'hashKey' | 'inquiryUsername' | 'inquiryPassword',
        string
      >
    >
  >({});
  const [copied, setCopied] = useState<string | null>(null);
  const jazz = g.gateway === 'JAZZCASH';
  const save = useMutation({
    mutationFn: () => {
      const body: UpdatePaymentGatewayRequest = {
        enabled,
        sandbox,
        merchantId: merchantId.trim(),
        methods,
        ...(jazz ? {} : { accountNumber: accountNumber.trim() || null }),
        ...Object.fromEntries(
          Object.entries(secrets).filter(([, v]) => v !== undefined && v !== ''),
        ),
      };
      return api<PaymentGatewaySettingsDto[]>(
        `/sales/crm/payment-gateways/${g.gateway.toLowerCase()}`,
        {
          method: 'PUT',
          body,
        },
      );
    },
    onSuccess: (data) => {
      client.setQueryData(['crm', 'payment-gateways'], data);
      setSecrets({});
    },
  });
  const secret = (key: keyof typeof secrets, label: string, saved: boolean) => (
    <TextField
      label={label}
      type="password"
      autoComplete="new-password"
      value={secrets[key] ?? ''}
      placeholder={saved ? 'Saved — leave empty to keep it' : ''}
      onChange={(e) => setSecrets({ ...secrets, [key]: e.target.value })}
    />
  );
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="flex-1 text-lg font-bold">{LABEL[g.gateway]}</h3>
        <label className="flex min-h-11 items-center gap-2 font-semibold">
          <input
            type="checkbox"
            className="size-5 accent-[var(--color-brand)]"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Customers can pay with {LABEL[g.gateway]}
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-5 accent-[var(--color-brand)]"
          checked={sandbox}
          onChange={(e) => setSandbox(e.target.checked)}
        />
        Test mode ({LABEL[g.gateway]} sandbox, no real money). Turn off only after a full test
        payment works.
      </label>
      {!sandbox && enabled && (
        <Alert tone="warning">
          Live mode: customers pay real money into this merchant account.
        </Alert>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField
          label={jazz ? 'Merchant ID' : 'Store ID'}
          required
          maxLength={64}
          value={merchantId}
          onChange={(e) => setMerchantId(e.target.value)}
        />
        {jazz
          ? secret('password', 'Password', g.saved.password)
          : secret('hashKey', 'Hash key', g.saved.hashKey)}
        {jazz && secret('integritySalt', 'Integrity salt', g.saved.integritySalt)}
        {!jazz && (
          <TextField
            label="Account number (for checking payments)"
            maxLength={40}
            value={accountNumber}
            onChange={(e) => setAccountNumber(e.target.value)}
          />
        )}
        {!jazz && secret('inquiryUsername', 'Transaction check: username', g.saved.inquiryUsername)}
        {!jazz && secret('inquiryPassword', 'Transaction check: password', g.saved.inquiryPassword)}
      </div>
      {!jazz && (
        <p className="text-sm text-muted">
          Without the transaction-check details, Easypaisa payments wait for a manager to confirm
          them under Invoices → Payments to confirm.
        </p>
      )}
      <fieldset className="flex flex-wrap gap-4">
        <legend className="mb-1 font-semibold">Customers can pay with</legend>
        {(['WALLET', 'CARD'] as const).map((m) => (
          <label key={m} className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              className="size-5 accent-[var(--color-brand)]"
              checked={methods.includes(m)}
              onChange={(e) =>
                setMethods(e.target.checked ? [...methods, m] : methods.filter((x) => x !== m))
              }
            />
            {m === 'WALLET' ? `${LABEL[g.gateway]} wallet` : 'Debit or credit card'}
          </label>
        ))}
      </fieldset>
      <div className="rounded-xl bg-surface-2 p-3 text-sm">
        <p className="mb-1 font-semibold">
          Give these addresses to {LABEL[g.gateway]} (merchant portal)
        </p>
        {(
          [
            ['Return URL', g.callbackUrls.returnUrl],
            ...(jazz ? ([['IPN URL', g.callbackUrls.ipnUrl]] as const) : []),
          ] as const
        ).map(([label, url]) => (
          <p key={label} className="flex flex-wrap items-center gap-2">
            <span className="text-muted">{label}:</span>
            <code className="break-all">{url}</code>
            <button
              type="button"
              className="font-semibold text-brand"
              onClick={() => void copyText(url).then(() => setCopied(label))}
            >
              {copied === label ? 'Copied' : 'Copy'}
            </button>
          </p>
        ))}
      </div>
      {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
      {save.isSuccess && <Alert tone="success">Saved.</Alert>}
      <div className="flex justify-end">
        <Button
          busy={save.isPending}
          disabled={!merchantId.trim() || methods.length === 0}
          onClick={() => save.mutate()}
        >
          Save {LABEL[g.gateway]}
        </Button>
      </div>
    </section>
  );
}

/** Sales → CRM settings: online payment with the business's own JazzCash / Easypaisa accounts. */
export function OnlinePaymentsSettings() {
  const gateways = useQuery({
    queryKey: ['crm', 'payment-gateways'],
    queryFn: () => api<PaymentGatewaySettingsDto[]>('/sales/crm/payment-gateways'),
    retry: false,
  });
  // Only people who manage billing see this.
  if (gateways.error instanceof ApiRequestError && gateways.error.status === 403) return null;
  return (
    <section className="flex flex-col gap-4 rounded-3xl border border-line bg-surface p-5 shadow-card">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <CreditCard className="size-5" aria-hidden /> Online payment
        </h2>
        <p className="text-muted">
          Customers pay invoices on their pay page with JazzCash or Easypaisa (wallet or card). The
          money goes to your own merchant account, and the invoice is marked paid automatically once
          the payment is confirmed. Invoices must be in PKR.
        </p>
      </div>
      {gateways.isError && <Alert tone="error">{errorMessage(gateways.error)}</Alert>}
      {gateways.data?.map((g) => (
        <GatewayCard key={`${g.gateway}-${g.merchantId ?? ''}`} g={g} />
      ))}
    </section>
  );
}
