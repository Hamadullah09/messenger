'use client';

import {
  AlertCircle,
  FileText,
  Image as ImageIcon,
  RotateCcw,
  ShieldCheck,
  Video,
  X,
} from 'lucide-react';
import { formatBytes } from '@/lib/media-store';
import { cx, IconButton } from '../ui';

export interface UploadItem {
  key: string;
  file: File;
  caption: string;
  stage: 'uploading' | 'checking' | 'sending' | 'failed';
  fraction: number;
  error: string | null;
}

const STAGE_LABEL: Record<UploadItem['stage'], string> = {
  uploading: 'Uploading',
  checking: 'Checking the file for safety…',
  sending: 'Sending…',
  failed: 'Not sent',
};

/** Shows each file being shared with clear progress, cancel and retry controls. */
export function UploadTray({
  items,
  onCancel,
  onRetry,
}: {
  items: UploadItem[];
  onCancel: (key: string) => void;
  onRetry: (key: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul
      className="flex flex-col gap-2 border-t border-line bg-surface px-3 pt-3"
      aria-label="Files being sent"
    >
      {items.map((item) => {
        const Icon = item.file.type.startsWith('image/')
          ? ImageIcon
          : item.file.type.startsWith('video/')
            ? Video
            : FileText;
        const percent = Math.round(item.fraction * 100);
        return (
          <li
            key={item.key}
            className={cx(
              'flex items-center gap-3 rounded-2xl border p-2',
              item.stage === 'failed'
                ? 'border-danger bg-danger-surface'
                : 'border-line bg-surface-2',
            )}
          >
            <Icon className="size-7 shrink-0 text-brand" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{item.file.name}</p>
              <p
                className={cx(
                  'flex items-center gap-1 text-sm',
                  item.stage === 'failed' ? 'font-semibold text-danger' : 'text-muted',
                )}
                role="status"
              >
                {item.stage === 'failed' && <AlertCircle className="size-4" aria-hidden />}
                {item.stage === 'checking' && <ShieldCheck className="size-4" aria-hidden />}
                {item.stage === 'failed'
                  ? (item.error ?? STAGE_LABEL.failed)
                  : STAGE_LABEL[item.stage]}
                {item.stage === 'uploading' && ` ${percent}%`}
                {' · '}
                {formatBytes(item.file.size)}
              </p>
              {item.stage === 'uploading' && (
                <div
                  className="mt-1 h-2 overflow-hidden rounded-full bg-surface-3"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                  aria-label={`Uploading ${item.file.name}`}
                >
                  <div
                    className="h-full bg-brand transition-[width]"
                    style={{ width: `${percent}%` }}
                  />
                </div>
              )}
            </div>
            {item.stage === 'failed' && (
              <IconButton label="Try again" showLabel onClick={() => onRetry(item.key)}>
                <RotateCcw className="size-5" aria-hidden />
              </IconButton>
            )}
            {item.stage !== 'sending' && (
              <IconButton
                label={item.stage === 'failed' ? 'Remove' : 'Cancel upload'}
                onClick={() => onCancel(item.key)}
              >
                <X className="size-5" aria-hidden />
              </IconButton>
            )}
          </li>
        );
      })}
    </ul>
  );
}
