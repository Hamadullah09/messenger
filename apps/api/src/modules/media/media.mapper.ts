import type { Prisma } from '@prisma/client';
import {
  MEDIA_TYPES,
  type AttachmentDto,
  type MediaAssetDto,
  type MediaKind,
  type MediaMimeType,
} from '@storeline/shared';
import type { ObjectHeaders } from '../../infra/storage/storage.service';

export const attachmentMediaSelect = {
  id: true,
  kind: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  width: true,
  height: true,
  thumbnailKey: true,
} as const satisfies Prisma.MediaAssetSelect;

export type AttachmentMediaRow = Prisma.MediaAssetGetPayload<{
  select: typeof attachmentMediaSelect;
}>;

export function toAttachmentDto(media: AttachmentMediaRow): AttachmentDto {
  return {
    mediaId: media.id,
    kind: media.kind,
    fileName: media.fileName,
    mimeType: media.mimeType,
    sizeBytes: Number(media.sizeBytes),
    width: media.width,
    height: media.height,
    hasThumbnail: media.thumbnailKey !== null,
  };
}

const FAILURE_MESSAGES: Record<string, string> = {
  type_mismatch: 'The file’s contents do not match its type, so it was not shared.',
  unrecognised_content: 'This file could not be recognised as a supported type.',
  malware_detected: 'This file was blocked because it may be harmful.',
  size_mismatch: 'The upload was incomplete. Please try again.',
  image_unreadable: 'This image could not be opened.',
  upload_expired: 'The upload took too long and was cancelled.',
  cancelled: 'The upload was cancelled.',
  processing_failed: 'The file could not be checked. Please try again later.',
};

export function failureMessage(code: string | null): string | null {
  if (!code) return null;
  return FAILURE_MESSAGES[code] ?? 'The file could not be shared.';
}

export const mediaAssetSelect = {
  ...attachmentMediaSelect,
  conversationId: true,
  campaignId: true,
  status: true,
  failureReason: true,
  createdAt: true,
} as const satisfies Prisma.MediaAssetSelect;

export type MediaAssetRow = Prisma.MediaAssetGetPayload<{ select: typeof mediaAssetSelect }>;

export function toMediaAssetDto(media: MediaAssetRow): MediaAssetDto {
  return {
    id: media.id,
    conversationId: media.conversationId,
    campaignId: media.campaignId,
    kind: media.kind,
    status: media.status,
    fileName: media.fileName,
    mimeType: media.mimeType,
    sizeBytes: Number(media.sizeBytes),
    width: media.width,
    height: media.height,
    hasThumbnail: media.thumbnailKey !== null,
    failureReason: failureMessage(media.failureReason),
    createdAt: media.createdAt.toISOString(),
  };
}

/** Display name only: strips paths, control characters and surrounding dots/spaces. */
export function sanitizeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 200);
  return cleaned || 'file';
}

/** RFC 6266 Content-Disposition with an ASCII fallback and an RFC 5987 UTF-8 name. */
export function contentDisposition(fileName: string, kind: MediaKind): string {
  const disposition = kind === 'DOCUMENT' ? 'attachment' : 'inline';
  const asciiName = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encoded}`;
}

export function objectHeaders(media: {
  fileName: string;
  mimeType: string;
  kind: MediaKind;
}): ObjectHeaders {
  return {
    contentType: media.mimeType,
    contentDisposition: contentDisposition(media.fileName, media.kind),
  };
}

export function mediaKindOf(mime: MediaMimeType): MediaKind {
  return MEDIA_TYPES[mime].kind;
}

export const storageKeys = {
  incoming: (businessId: string, mediaId: string) => `incoming/${businessId}/${mediaId}`,
  verified: (businessId: string, mediaId: string) => `media/${businessId}/${mediaId}`,
  thumbnail: (businessId: string, mediaId: string) => `media/${businessId}/${mediaId}.thumb.webp`,
  quarantine: (businessId: string, mediaId: string) => `quarantine/${businessId}/${mediaId}`,
};
