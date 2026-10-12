'use client';

import { MoreVertical, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cx } from '../ui';

export interface MenuAction {
  label: string;
  Icon: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
  hidden?: boolean;
}

/** "⋮" button with a small list of actions (secondary and destructive ones live here). */
export function ActionMenu({ label, actions }: { label: string; actions: MenuAction[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const visible = actions.filter((a) => !a.hidden);
  if (visible.length === 0) return null;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={label}
        title="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cx(
          'inline-flex size-10 items-center justify-center rounded-xl border border-line text-muted transition-colors hover:bg-surface-2 hover:text-fg',
          open && 'bg-surface-2 text-fg',
        )}
      >
        <MoreVertical className="size-5" aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 bottom-full z-30 mb-2 w-52 rounded-xl border border-line bg-surface py-1.5 shadow-pop"
        >
          {visible.map(({ label: text, Icon, onSelect, danger }, index) => (
            <button
              key={text}
              type="button"
              role="menuitem"
              autoFocus={index === 0}
              onClick={() => {
                setOpen(false);
                onSelect();
              }}
              className={cx(
                'flex min-h-11 w-full items-center gap-3 px-4 text-left font-medium hover:bg-surface-2',
                danger && 'text-danger',
              )}
            >
              <Icon className="size-5" aria-hidden /> {text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
