'use client';

import type { MeDto } from '@storeline/shared';
import { useMutation } from '@tanstack/react-query';
import {
  Bell,
  KeyRound,
  Laptop,
  Monitor,
  Moon,
  Palette,
  ShieldCheck,
  Sun,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { NotificationSettings } from '@/components/notifications';
import { ChangePasswordForm, MfaSettings, SessionsList } from '@/components/security';
import { Alert, Avatar, Button, cx, PageHeader, TextField } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { primaryRoleName, useAuth } from '@/lib/auth-store';
import { useTheme, type ThemeChoice } from '@/lib/theme';

function Section({
  title,
  description,
  Icon,
  children,
}: {
  title: string;
  description?: string;
  Icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <section className="rounded-3xl border border-line bg-surface p-5 shadow-card sm:p-6">
      <div className="mb-4 flex items-start gap-3">
        <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-2xl bg-brand-soft text-brand">
          <Icon className="size-5" aria-hidden />
        </span>
        <div>
          <h2 className="text-xl font-bold">{title}</h2>
          {description && <p className="text-muted">{description}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

const THEMES: Array<[ThemeChoice, string, LucideIcon]> = [
  ['system', 'Same as device', Monitor],
  ['light', 'Light', Sun],
  ['dark', 'Dark', Moon],
];

export default function SettingsPage() {
  const me = useAuth((s) => s.me)!;
  const businessId = useAuth((s) => s.activeBusinessId);
  const [displayName, setDisplayName] = useState(me.user.displayName);
  const [theme, setTheme] = useTheme();

  const saveProfile = useMutation({
    mutationFn: () => api<MeDto>('/me', { method: 'PATCH', body: { displayName } }),
    onSuccess: (updated) => useAuth.getState().setMe(updated),
  });

  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-4 sm:p-6">
        <PageHeader title="Settings" subtitle="Your profile, appearance and account security" />

        <div className="grid gap-5 xl:grid-cols-2">
          <div className="flex flex-col gap-5">
            <Section
              title="Your profile"
              description="How colleagues see you. Your phone number and email are never shown in chats."
              Icon={UserRound}
            >
              <div className="mb-5 flex items-center gap-4 rounded-2xl bg-surface-2 p-4">
                <Avatar name={me.user.displayName} size={60} />
                <div className="min-w-0">
                  <p className="truncate text-lg font-bold">{me.user.displayName}</p>
                  <p className="truncate text-muted">
                    @{me.user.username} · {primaryRoleName(me, businessId)}
                  </p>
                </div>
              </div>
              <form
                className="flex flex-col gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveProfile.mutate();
                }}
              >
                {saveProfile.isError && (
                  <Alert tone="error">{errorMessage(saveProfile.error)}</Alert>
                )}
                {saveProfile.isSuccess && <Alert tone="success">Saved.</Alert>}
                <TextField
                  label="Display name"
                  value={displayName}
                  maxLength={80}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
                <div>
                  <Button
                    type="submit"
                    busy={saveProfile.isPending}
                    disabled={!displayName.trim() || displayName === me.user.displayName}
                  >
                    Save profile
                  </Button>
                </div>
              </form>
            </Section>

            <Section
              title="Appearance"
              description="Choose light or dark colours for this device."
              Icon={Palette}
            >
              <div
                role="radiogroup"
                aria-label="Colour theme"
                className="grid grid-cols-1 gap-2 sm:grid-cols-3"
              >
                {THEMES.map(([value, label, Icon]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={theme === value}
                    onClick={() => setTheme(value)}
                    className={cx(
                      'flex min-h-14 items-center justify-center gap-2 rounded-2xl border px-4 font-semibold transition-colors',
                      theme === value
                        ? 'border-brand bg-brand-soft text-brand-strong'
                        : 'border-line hover:bg-surface-2',
                    )}
                  >
                    <Icon className="size-5" aria-hidden /> {label}
                  </button>
                ))}
              </div>
            </Section>

            <Section
              title="Password"
              description="Use a long sentence that only you know."
              Icon={KeyRound}
            >
              <ChangePasswordForm />
            </Section>
          </div>

          <div className="flex flex-col gap-5">
            <Section
              title="Notifications"
              description="Choose where you are notified and what shows on your lock screen."
              Icon={Bell}
            >
              <NotificationSettings />
            </Section>
            <Section title="Two-step verification" Icon={ShieldCheck}>
              <MfaSettings />
            </Section>
            <Section
              title="Signed-in devices"
              description="Sign out of devices you no longer use or do not recognise."
              Icon={Laptop}
            >
              <SessionsList />
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}
