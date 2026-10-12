'use client';

import Link from 'next/link';
import { AuthCard } from '@/components/auth/auth-card';
import { DemoRequestForm } from '@/components/sales/demo-request-form';

/** Public website form: becomes a WEBSITE lead in Sales & Marketing. */
export default function RequestDemoPage() {
  return (
    <AuthCard
      title="Request a demo"
      subtitle="Tell us about your business and our team will contact you to show how SMA works for your stores."
    >
      <DemoRequestForm
        afterSent={
          <Link href="/login" className="font-semibold text-brand hover:underline">
            Go to sign in
          </Link>
        }
      />
    </AuthCard>
  );
}
