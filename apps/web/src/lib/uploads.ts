'use client';

import type { MediaAssetDto, UploadPartsDto, UploadSessionDto } from '@storeline/shared';
import { api, ApiRequestError } from './api';
import { useMediaStatus } from './media-store';

const PARALLEL_PARTS = 3;
const PART_ATTEMPTS = 3;
const READY_TIMEOUT_MS = 5 * 60_000;

export class UploadCancelledError extends Error {}

export interface UploadProgress {
  stage: 'uploading' | 'checking';
  /** 0–1 while uploading. */
  fraction: number;
}

/** PUT with progress via XMLHttpRequest (fetch has no upload progress events). */
function put(
  url: string,
  body: Blob,
  headers: Record<string, string>,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.onabort = () => reject(new UploadCancelledError());
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

/**
 * Uploads a file straight to object storage using the server-issued session, resuming
 * multipart uploads with fresh URLs when parts fail, then waits for the server-side
 * safety check. Resolves with the READY asset or throws with a user-facing message.
 */
export async function uploadFile(
  file: File,
  /** A conversation id, a draft campaign, or a status update (its business) as the context. */
  target: string | { campaignId: string } | { statusBusinessId: string },
  mimeType: string,
  onProgress: (progress: UploadProgress) => void,
  signal: AbortSignal,
): Promise<MediaAssetDto> {
  const session = await api<UploadSessionDto>('/media/uploads', {
    method: 'POST',
    body: {
      ...(typeof target === 'string' ? { conversationId: target } : target),
      fileName: file.name,
      mimeType,
      sizeBytes: file.size,
    },
  });
  const mediaId = session.media.id;
  const onAbort = () =>
    void api(`/media/uploads/${mediaId}`, { method: 'DELETE' }).catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    if (session.upload.method === 'PUT') {
      await put(
        session.upload.url,
        file,
        session.upload.headers,
        (loaded) => onProgress({ stage: 'uploading', fraction: loaded / file.size }),
        signal,
      );
    } else {
      await uploadParts(
        file,
        mediaId,
        session.upload.partSize,
        session.upload.parts,
        onProgress,
        signal,
      );
    }
    onProgress({ stage: 'checking', fraction: 1 });
    await api(`/media/uploads/${mediaId}/complete`, { method: 'POST' });
    return await waitUntilVerified(mediaId, signal);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function uploadParts(
  file: File,
  mediaId: string,
  partSize: number,
  initialParts: UploadPartsDto['parts'],
  onProgress: (progress: UploadProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  const loadedByPart = new Map<number, number>();
  const report = () => {
    const loaded = [...loadedByPart.values()].reduce((a, b) => a + b, 0);
    onProgress({ stage: 'uploading', fraction: Math.min(1, loaded / file.size) });
  };
  let pending = [...initialParts];
  for (let attempt = 1; attempt <= PART_ATTEMPTS && pending.length > 0; attempt++) {
    const failed: number[] = [];
    const queue = [...pending];
    await Promise.all(
      Array.from({ length: PARALLEL_PARTS }, async () => {
        for (let part = queue.shift(); part; part = queue.shift()) {
          const start = (part.partNumber - 1) * partSize;
          const blob = file.slice(start, start + part.sizeBytes);
          try {
            await put(
              part.url,
              blob,
              {},
              (loaded) => {
                loadedByPart.set(part!.partNumber, loaded);
                report();
              },
              signal,
            );
            loadedByPart.set(part.partNumber, part.sizeBytes);
          } catch (error) {
            if (error instanceof UploadCancelledError) throw error;
            loadedByPart.set(part.partNumber, 0);
            failed.push(part.partNumber);
          }
          report();
        }
      }),
    );
    if (failed.length === 0) return;
    // Resume: ask the server which parts it has and get fresh URLs for the rest.
    const resume = await api<UploadPartsDto>(`/media/uploads/${mediaId}/parts`, {
      method: 'POST',
      body: {},
    });
    pending = resume.parts;
  }
  if (pending.length > 0)
    throw new Error('The upload kept failing. Check your connection and try again.');
}

async function waitUntilVerified(mediaId: string, signal: AbortSignal): Promise<MediaAssetDto> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let delay = 1000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new UploadCancelledError();
    const pushed = useMediaStatus.getState().byId[mediaId];
    const media =
      pushed && pushed.status !== 'VERIFYING'
        ? pushed
        : await api<MediaAssetDto>(`/media/${mediaId}`);
    if (media.status === 'READY') return media;
    if (media.status !== 'VERIFYING' && media.status !== 'PENDING_UPLOAD') {
      throw new ApiRequestError(
        422,
        'VALIDATION_FAILED',
        media.failureReason ?? 'This file could not be shared.',
      );
    }
    // Wait for the socket event, polling as a fallback.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      const unsubscribe = useMediaStatus.subscribe((state) => {
        if (state.byId[mediaId] && state.byId[mediaId].status !== 'VERIFYING') {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        }
      });
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        },
        { once: true },
      );
    });
    delay = Math.min(delay * 1.5, 5000);
  }
  throw new Error('Checking the file is taking longer than expected. Please try again later.');
}
