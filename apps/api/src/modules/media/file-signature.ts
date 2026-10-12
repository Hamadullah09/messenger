import type { MediaMimeType } from '@storeline/shared';

/** Bytes inspected at the start of a file for signature detection. */
export const SNIFF_BYTES = 64 * 1024;

const OOXML_MARKERS: Partial<Record<MediaMimeType, string>> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'word/',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xl/',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'ppt/',
};

const ISO_BMFF_BRANDS: Record<string, MediaMimeType> = {
  heic: 'image/heic',
  heix: 'image/heic',
  heim: 'image/heic',
  heis: 'image/heic',
  mif1: 'image/heic',
  msf1: 'image/heic',
  'qt  ': 'video/quicktime',
  'M4A ': 'audio/mp4',
  'M4B ': 'audio/mp4',
};

function startsWith(head: Buffer, bytes: number[], offset = 0): boolean {
  return head.length >= offset + bytes.length && bytes.every((b, i) => head[offset + i] === b);
}

function ascii(head: Buffer, start: number, end: number): string {
  return head.subarray(start, end).toString('latin1');
}

/**
 * Detects an allow-listed type from file content only (never from the name or the declared
 * type). Returns null when the content does not match any allowed binary format.
 * Text formats are handled separately by `looksLikeText`.
 */
export function detectBinaryType(head: Buffer): MediaMimeType | null {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return 'image/webp';
  if (ascii(head, 0, 5) === '%PDF-') return 'application/pdf';
  if (ascii(head, 0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(head, 0, 3) === 'ID3') return 'audio/mpeg';
  if (head.length >= 2 && head[0] === 0xff) {
    // ADTS (AAC) frames have layer bits 00; MPEG audio (MP3) frames do not.
    if ((head[1]! & 0xf6) === 0xf0) return 'audio/aac';
    if ((head[1]! & 0xe0) === 0xe0 && (head[1]! & 0x06) !== 0) return 'audio/mpeg';
  }
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (ascii(head, 4, 8) === 'ftyp') {
    const brand = ascii(head, 8, 12);
    return ISO_BMFF_BRANDS[brand] ?? 'video/mp4';
  }
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
    // Office Open XML packages are ZIP files; the part names appear in local file headers.
    const text = head.toString('latin1');
    for (const [mime, marker] of Object.entries(OOXML_MARKERS)) {
      if (text.includes(marker) && text.includes('[Content_Types].xml'))
        return mime as MediaMimeType;
    }
    return null;
  }
  return null;
}

/** Plain text / CSV: valid UTF-8 without NUL or other binary control characters. */
export function looksLikeText(head: Buffer, complete: boolean): boolean {
  // Do not judge a multi-byte character that was cut off at the end of the sniff window.
  let sample = head;
  if (!complete) {
    let cut = sample.length;
    while (cut > 0 && cut > sample.length - 4 && (sample[cut - 1]! & 0xc0) === 0x80) cut--;
    if (cut > 0 && sample[cut - 1]! >= 0xc0) cut--;
    sample = sample.subarray(0, cut);
  }
  if (!isValidUtf8(sample)) return false;
  for (const byte of sample) {
    // Allow tab, newline, vertical tab, form feed and carriage return only.
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20) || byte === 0x7f) return false;
  }
  return true;
}

function isValidUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export type SignatureVerdict =
  { ok: true } | { ok: false; reason: 'type_mismatch' | 'unrecognised_content' };

/** The file content must match the declared, allow-listed type exactly. */
export function verifySignature(
  declared: MediaMimeType,
  head: Buffer,
  complete: boolean,
): SignatureVerdict {
  if (declared === 'text/plain' || declared === 'text/csv') {
    if (detectBinaryType(head) !== null) return { ok: false, reason: 'type_mismatch' };
    return looksLikeText(head, complete)
      ? { ok: true }
      : { ok: false, reason: 'unrecognised_content' };
  }
  const detected = detectBinaryType(head);
  if (detected === null) return { ok: false, reason: 'unrecognised_content' };
  // QuickTime and MP4 share the ISO BMFF container; browsers label .mov files either way.
  // Voice notes: WebM/MP4 containers with only an audio track look like video files.
  const compatible =
    detected === declared ||
    (declared === 'video/quicktime' && detected === 'video/mp4') ||
    (declared === 'video/mp4' && (detected === 'video/quicktime' || detected === 'audio/mp4')) ||
    (declared === 'audio/webm' && detected === 'video/webm') ||
    (declared === 'audio/mp4' && detected === 'video/mp4');
  return compatible ? { ok: true } : { ok: false, reason: 'type_mismatch' };
}
