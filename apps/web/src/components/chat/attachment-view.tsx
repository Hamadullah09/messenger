'use client';

import type { AttachmentDto } from '@storeline/shared';
import {
  Download,
  FileSpreadsheet,
  FileText,
  ImageOff,
  Loader2,
  Play,
  Presentation,
} from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { formatBytes, useMediaUrl } from '@/lib/media-store';
import { Button, Dialog } from '../ui';

const MAX_PREVIEW_WIDTH = 320;

/** Renders an attachment inside a message bubble. URLs are fetched on demand and expire quickly. */
export function AttachmentView({ attachment }: { attachment: AttachmentDto }) {
  if (attachment.kind === 'IMAGE') return <ImageAttachment attachment={attachment} />;
  if (attachment.kind === 'VIDEO') return <VideoAttachment attachment={attachment} />;
  return <DocumentAttachment attachment={attachment} />;
}

function previewSize(attachment: AttachmentDto): { width: number; height: number } {
  const w = attachment.width ?? 4;
  const h = attachment.height ?? 3;
  const width = Math.min(MAX_PREVIEW_WIDTH, w);
  return { width, height: Math.round((width * h) / w) };
}

function ImageAttachment({ attachment }: { attachment: AttachmentDto }) {
  const [open, setOpen] = useState(false);
  const thumbnail = useMediaUrl(attachment.mediaId, 'thumbnail', attachment.hasThumbnail);
  const original = useMediaUrl(attachment.mediaId, 'original', open);
  const size = previewSize(attachment);

  if (!attachment.hasThumbnail) return <DocumentAttachment attachment={attachment} label="Photo" />;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-1 block overflow-hidden rounded-xl bg-surface-3"
        style={{
          width: size.width,
          maxWidth: '100%',
          aspectRatio: `${size.width} / ${size.height}`,
        }}
        aria-label={`Open photo ${attachment.fileName}`}
      >
        {thumbnail.data ? (
          <img
            src={thumbnail.data.url}
            alt={`Photo: ${attachment.fileName}`}
            className="h-full w-full object-cover"
          />
        ) : thumbnail.isError ? (
          <span className="flex h-full items-center justify-center gap-2 text-muted">
            <ImageOff className="size-6" aria-hidden /> Preview unavailable
          </span>
        ) : (
          <span className="flex h-full items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted" aria-label="Loading photo" />
          </span>
        )}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={attachment.fileName} wide>
        <div className="flex flex-col items-center gap-4">
          {original.data ? (
            <img
              src={original.data.url}
              alt={`Photo: ${attachment.fileName}`}
              className="max-h-[70vh] w-auto rounded-xl"
            />
          ) : (
            <Loader2 className="size-8 animate-spin text-muted" aria-label="Loading photo" />
          )}
          {original.data && (
            <a
              href={original.data.url}
              className="font-semibold text-brand underline"
              rel="noopener noreferrer"
            >
              Open full size ({formatBytes(attachment.sizeBytes)})
            </a>
          )}
        </div>
      </Dialog>
    </>
  );
}

function VideoAttachment({ attachment }: { attachment: AttachmentDto }) {
  const [playing, setPlaying] = useState(false);
  const original = useMediaUrl(attachment.mediaId, 'original', playing);
  if (playing && original.data) {
    return (
      <video
        src={original.data.url}
        controls
        autoPlay
        preload="metadata"
        className="mb-1 max-h-80 w-full max-w-[min(100%,360px)] rounded-xl bg-black"
        aria-label={`Video: ${attachment.fileName}`}
        // A signed URL may expire mid-playback; fetch a new one.
        onError={() => void original.refetch()}
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setPlaying(true)}
      className="mb-1 flex min-h-32 w-full max-w-[min(100%,360px)] flex-col items-center justify-center gap-2 rounded-xl bg-black/80 p-4 text-white"
      aria-label={`Play video ${attachment.fileName}`}
    >
      {playing ? (
        <Loader2 className="size-10 animate-spin" aria-hidden />
      ) : (
        <Play className="size-10" aria-hidden />
      )}
      <span className="max-w-full truncate text-sm font-semibold">{attachment.fileName}</span>
      <span className="text-xs">{formatBytes(attachment.sizeBytes)}</span>
    </button>
  );
}

function documentIcon(mimeType: string) {
  if (mimeType.includes('spreadsheet') || mimeType === 'text/csv') return FileSpreadsheet;
  if (mimeType.includes('presentation')) return Presentation;
  return FileText;
}

function DocumentAttachment({ attachment, label }: { attachment: AttachmentDto; label?: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const Icon = documentIcon(attachment.mimeType);
  async function download() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api<{ url: string }>(`/media/${attachment.mediaId}/url`);
      // The storage response forces a download (Content-Disposition: attachment).
      window.location.assign(url);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mb-1 flex max-w-full items-center gap-3 rounded-xl border border-line bg-surface-2 p-3">
      <Icon className="size-9 shrink-0 text-brand" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{attachment.fileName}</p>
        <p className="text-sm text-muted">
          {label ?? 'Document'} · {formatBytes(attachment.sizeBytes)}
        </p>
        {error && (
          <p className="text-sm font-semibold text-danger" role="alert">
            {error}
          </p>
        )}
      </div>
      <Button
        variant="secondary"
        onClick={() => void download()}
        busy={busy}
        icon={<Download className="size-5" aria-hidden />}
      >
        Download
      </Button>
    </div>
  );
}
