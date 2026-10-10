'use client';

import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from 'lucide-react';
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'warm';

const variants: Record<ButtonVariant, string> = {
  primary:
    'bg-brand text-brand-contrast hover:bg-brand-strong border-transparent shadow-[0_1px_2px_rgb(16_24_40/0.08)]',
  secondary: 'bg-surface text-fg border-line-strong/60 hover:bg-surface-2',
  danger: 'bg-danger text-danger-contrast border-transparent hover:opacity-90',
  ghost: 'bg-transparent text-fg border-transparent hover:bg-surface-2',
  warm: 'bg-warm-strong text-warm-contrast border-transparent hover:opacity-90',
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    busy?: boolean;
    icon?: ReactNode;
    size?: 'sm' | 'md' | 'lg';
    pill?: boolean;
  }
>(function Button(
  { variant = 'primary', busy, icon, size = 'md', pill, className, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cx(
        'inline-flex items-center justify-center gap-2 border font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        pill ? 'rounded-full' : 'rounded-xl',
        size === 'lg'
          ? 'min-h-14 px-6 text-lg'
          : size === 'sm'
            ? 'min-h-10 px-3 text-sm'
            : 'min-h-12 px-4',
        variants[variant],
        className,
      )}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...props}
    >
      {busy ? <Loader2 className="size-5 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

/** Icon button that always carries an accessible label (and a tooltip). */
export function IconButton({
  label,
  showLabel = false,
  bordered = false,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  showLabel?: boolean;
  bordered?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={showLabel ? undefined : label}
      title={label}
      className={cx(
        'inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-xl px-2 text-fg transition-colors hover:bg-surface-2 disabled:opacity-50',
        bordered && 'border border-line bg-surface shadow-card',
        className,
      )}
      {...props}
    >
      {children}
      {showLabel && <span className="text-sm font-semibold">{label}</span>}
    </button>
  );
}

export function Card({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLElement> & { children: ReactNode }) {
  return (
    <section
      className={cx('rounded-3xl border border-line bg-surface p-5 shadow-card', className)}
      {...props}
    >
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Badge({
  children,
  tone = 'brand',
  className,
}: {
  children: ReactNode;
  tone?: 'brand' | 'muted' | 'warm' | 'success';
  className?: string;
}) {
  const tones = {
    brand: 'bg-brand text-brand-contrast',
    muted: 'bg-surface-3 text-fg',
    warm: 'bg-warm-soft text-warm-strong',
    success: 'bg-success-soft text-success',
  };
  return (
    <span
      className={cx(
        'inline-flex min-w-6 items-center justify-center rounded-lg px-1.5 py-0.5 text-xs font-bold',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
}

const fieldClass =
  'min-h-12 rounded-xl border bg-surface px-4 text-fg placeholder:text-muted transition-colors focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/20';

export function TextField({
  label,
  hint,
  error,
  className,
  ...props
}: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="font-semibold">
        {label}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      )}
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={
          [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined
        }
        className={cx(fieldClass, error ? 'border-danger' : 'border-line-strong/70')}
        {...props}
      />
      {error && (
        <p
          id={`${id}-error`}
          className="flex items-center gap-1 text-sm font-semibold text-danger"
          role="alert"
        >
          <XCircle className="size-4" aria-hidden /> {error}
        </p>
      )}
    </div>
  );
}

export function TextArea({
  label,
  hint,
  className,
  ...props
}: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="font-semibold">
        {label}
      </label>
      {hint && <p className="text-sm text-muted">{hint}</p>}
      <textarea
        id={id}
        className={cx(fieldClass, 'min-h-24 border-line-strong/70 py-3')}
        {...props}
      />
    </div>
  );
}

export function SelectField({
  label,
  hint,
  className,
  children,
  ...props
}: FieldProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="font-semibold">
        {label}
      </label>
      {hint && <p className="text-sm text-muted">{hint}</p>}
      <select id={id} className={cx(fieldClass, 'border-line-strong/70 px-3')} {...props}>
        {children}
      </select>
    </div>
  );
}

const alertStyles = {
  error: { cls: 'bg-danger-surface text-danger border-danger/40', Icon: XCircle },
  warning: { cls: 'bg-warning-surface text-warning border-warning/40', Icon: AlertTriangle },
  success: { cls: 'bg-success-soft text-success border-success/40', Icon: CheckCircle2 },
  info: { cls: 'bg-brand-soft text-brand-strong border-brand/30', Icon: Info },
} as const;

export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: keyof typeof alertStyles;
  title?: string;
  children?: ReactNode;
}) {
  const { cls, Icon } = alertStyles[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cx('flex gap-3 rounded-2xl border p-4', cls)}
    >
      <Icon className="mt-0.5 size-6 shrink-0" aria-hidden />
      <div className="flex flex-col gap-1">
        {title && <p className="font-bold">{title}</p>}
        {children && <div className="text-fg">{children}</div>}
      </div>
    </div>
  );
}

/** Background colours chosen so white initials keep ≥ 4.5:1 contrast. */
const AVATAR_COLORS = [
  '#2563eb',
  '#7c3aed',
  '#c2410c',
  '#0f766e',
  '#be185d',
  '#4d7c0f',
  '#0369a1',
  '#9333ea',
];

export function Avatar({
  name,
  size = 48,
  online,
}: {
  name: string;
  size?: number;
  /** true = online (green), false = offline (grey), undefined = unknown (no dot). */
  online?: boolean;
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
  const color =
    AVATAR_COLORS[[...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % AVATAR_COLORS.length];
  const dot = Math.max(10, Math.round(size * 0.28));
  return (
    <span className="relative inline-flex shrink-0" aria-hidden>
      <span
        className="inline-flex items-center justify-center rounded-full font-semibold text-white"
        style={{ width: size, height: size, background: color, fontSize: size * 0.38 }}
      >
        {initials || '?'}
      </span>
      {online !== undefined && (
        <span
          className={cx(
            'absolute right-0 bottom-0 rounded-full border-2 border-surface',
            online ? 'bg-success' : 'bg-line-strong',
          )}
          style={{ width: dot, height: dot }}
        />
      )}
    </span>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-3 p-6 text-muted">
      <Loader2 className="size-6 animate-spin" aria-hidden />
      <span>{label}…</span>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
      {icon && (
        <div className="flex size-20 items-center justify-center rounded-full bg-brand-soft text-brand">
          {icon}
        </div>
      )}
      <p className="text-lg font-bold">{title}</p>
      {children && <div className="max-w-md text-muted">{children}</div>}
    </div>
  );
}

/** Accessible modal built on the native <dialog> element (focus trap and Esc handled by the browser). */
export function Dialog({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={onClose}
      className={cx(
        'm-auto w-[calc(100%-1.5rem)] rounded-3xl border border-line bg-surface p-0 text-fg shadow-pop backdrop:bg-black/40 backdrop:backdrop-blur-[2px]',
        wide ? 'max-w-3xl' : 'max-w-lg',
      )}
    >
      {open && (
        <div className="flex max-h-[88vh] flex-col">
          <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-3">
            <h2 id={titleId} className="text-xl font-bold">
              {title}
            </h2>
            <IconButton label="Close" onClick={onClose}>
              <X className="size-6" aria-hidden />
            </IconButton>
          </div>
          <div className="scroll-thin overflow-y-auto p-5">{children}</div>
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className="flex flex-col gap-5">
        <div>{message}</div>
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} busy={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
