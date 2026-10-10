import { z } from 'zod';
import { idSchema } from './common';

export type MediaKind = 'IMAGE' | 'VIDEO' | 'DOCUMENT';

/**
 * Allow-listed upload types. The declared type must be one of these, and the worker
 * verifies the file signature matches before the file becomes downloadable.
 * Active content (SVG, HTML, scripts, executables, archives) is deliberately excluded.
 */
export const MEDIA_TYPES = {
  'image/jpeg': { kind: 'IMAGE', label: 'JPEG image', extensions: ['jpg', 'jpeg'] },
  'image/png': { kind: 'IMAGE', label: 'PNG image', extensions: ['png'] },
  'image/webp': { kind: 'IMAGE', label: 'WebP image', extensions: ['webp'] },
  'image/gif': { kind: 'IMAGE', label: 'GIF image', extensions: ['gif'] },
  'image/heic': { kind: 'IMAGE', label: 'HEIC photo', extensions: ['heic', 'heif'] },
  'video/mp4': { kind: 'VIDEO', label: 'MP4 video', extensions: ['mp4', 'm4v'] },
  'video/quicktime': { kind: 'VIDEO', label: 'QuickTime video', extensions: ['mov'] },
  'video/webm': { kind: 'VIDEO', label: 'WebM video', extensions: ['webm'] },
  'application/pdf': { kind: 'DOCUMENT', label: 'PDF document', extensions: ['pdf'] },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    kind: 'DOCUMENT',
    label: 'Word document',
    extensions: ['docx'],
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    kind: 'DOCUMENT',
    label: 'Excel spreadsheet',
    extensions: ['xlsx'],
  },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
    kind: 'DOCUMENT',
    label: 'PowerPoint presentation',
    extensions: ['pptx'],
  },
  'text/plain': { kind: 'DOCUMENT', label: 'Text file', extensions: ['txt'] },
  'text/csv': { kind: 'DOCUMENT', label: 'CSV file', extensions: ['csv'] },
} as const satisfies Record<
  string,
  { kind: MediaKind; label: string; extensions: readonly string[] }
>;

export type MediaMimeType = keyof typeof MEDIA_TYPES;

export function isMediaMimeType(value: string): value is MediaMimeType {
  return Object.prototype.hasOwnProperty.call(MEDIA_TYPES, value);
}

/** Guesses an allow-listed type from a file name when the browser reports none. */
export function mimeTypeFromFileName(fileName: string): MediaMimeType | null {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  for (const [mime, info] of Object.entries(MEDIA_TYPES)) {
    if ((info.extensions as readonly string[]).includes(extension)) return mime as MediaMimeType;
  }
  return null;
}

export const MEDIA_ACCEPT_ATTRIBUTE = Object.keys(MEDIA_TYPES).join(',');

export const createUploadRequestSchema = z
  .object({
    /** Upload context: a conversation you belong to, or a draft campaign you manage. */
    conversationId: idSchema.optional(),
    campaignId: idSchema.optional(),
    fileName: z.string().trim().min(1).max(255),
    mimeType: z
      .string()
      .refine((v): v is MediaMimeType => isMediaMimeType(v), 'This file type is not allowed'),
    sizeBytes: z.number().int().positive(),
  })
  .refine((r) => !!r.conversationId !== !!r.campaignId, 'Upload to a conversation or a campaign');
export type CreateUploadRequest = z.infer<typeof createUploadRequestSchema>;

export const requestPartsSchema = z.object({
  /** Omit to get URLs for every part that has not been uploaded yet. */
  partNumbers: z.array(z.number().int().min(1).max(10_000)).max(200).optional(),
});
export type RequestPartsRequest = z.infer<typeof requestPartsSchema>;

export const mediaUrlQuerySchema = z.object({
  variant: z.enum(['original', 'thumbnail']).default('original'),
});
export type MediaUrlQuery = z.infer<typeof mediaUrlQuerySchema>;
