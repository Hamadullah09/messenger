import { cx } from './ui';

export const BRAND = {
  name: 'SMA',
  company: 'SMA Technology',
  tagline: 'Team messaging for every store',
} as const;

/**
 * The SMA figure on a white tile: the logo artwork has a white background, so the tile keeps
 * it crisp in both light and dark themes.
 */
export function BrandIcon({ size = 44, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl border border-line bg-white',
        className,
      )}
      style={{ width: size, height: size }}
    >
      {/* Static asset generated from logo.jpeg (see docs/brand.md). */}
      <img
        src="/brand/sma-mark.png"
        alt=""
        width={size}
        height={size}
        className="size-full object-contain"
      />
    </span>
  );
}

/** Icon + name. `compact` shows the icon only (icon rail, phone header). */
export function BrandMark({ compact = false, size = 44 }: { compact?: boolean; size?: number }) {
  return (
    <span className="flex items-center gap-3">
      <BrandIcon size={size} />
      {compact ? (
        <span className="sr-only">{BRAND.company}</span>
      ) : (
        <span className="leading-none">
          <span className="block text-2xl font-extrabold tracking-tight">{BRAND.name}</span>
          <span className="mt-1 block text-xs font-semibold tracking-[0.18em] text-brand uppercase">
            Technology
          </span>
        </span>
      )}
    </span>
  );
}
