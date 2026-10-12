import type { ReactNode } from 'react';
import { BrandMark } from '../brand';

/** Centered card used by the public account pages (forgot / reset password). */
export function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <main id="main" className="flex min-h-screen items-center justify-center bg-bg p-4 sm:p-8">
      <div className="w-full max-w-md rounded-3xl border border-line bg-surface p-6 shadow-card sm:p-10">
        <div className="mb-8">
          <BrandMark size={52} />
        </div>
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        <p className="mt-1 mb-6 text-muted">{subtitle}</p>
        {children}
      </div>
    </main>
  );
}
