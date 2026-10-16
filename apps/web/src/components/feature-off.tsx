import { PowerOff } from 'lucide-react';
import { EmptyState } from './ui';

/** Shown on a page whose feature the Super Admin switched off. */
export function FeatureOff({ name }: { name: string }) {
  return (
    <div className="flex flex-1 items-center justify-center">
      <EmptyState
        icon={<PowerOff className="size-9" aria-hidden />}
        title={`${name} is turned off`}
      >
        The administrator has switched this part of SMA off for now.
      </EmptyState>
    </div>
  );
}
