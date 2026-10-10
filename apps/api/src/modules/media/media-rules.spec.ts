import { describe, expect, it } from 'vitest';
import { escapeLikePattern } from '../messaging/search.service';
import { detectBinaryType, looksLikeText, verifySignature } from './file-signature';
import { contentDisposition, sanitizeFileName } from './media.mapper';

const bytes = (...values: number[]) => Buffer.from(values);
const withAscii = (prefix: Buffer, text: string) =>
  Buffer.concat([prefix, Buffer.from(text, 'latin1')]);

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16);
const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ\n');
const MP4 = withAscii(bytes(0, 0, 0, 0x18), 'ftypisom\0\0\x02\0isomiso2');
const MOV = withAscii(bytes(0, 0, 0, 0x14), 'ftypqt  \0\0\x02\0qt  ');
const HEIC = withAscii(bytes(0, 0, 0, 0x18), 'ftypheic\0\0\0\0mif1heic');
const DOCX = withAscii(
  bytes(0x50, 0x4b, 0x03, 0x04),
  '\x14\0\x06\0[Content_Types].xml....PK\x03\x04word/document.xml',
);
const ZIP = withAscii(bytes(0x50, 0x4b, 0x03, 0x04), '\x14\0\0\0payload.exe');

describe('detectBinaryType', () => {
  it.each([
    [PNG, 'image/png'],
    [JPEG, 'image/jpeg'],
    [Buffer.from('GIF89a....'), 'image/gif'],
    [withAscii(Buffer.from('RIFF'), '\0\0\0\0WEBPVP8 '), 'image/webp'],
    [PDF, 'application/pdf'],
    [MP4, 'video/mp4'],
    [MOV, 'video/quicktime'],
    [HEIC, 'image/heic'],
    [bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01), 'video/webm'],
    [DOCX, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ])('recognises %#', (head, expected) => {
    expect(detectBinaryType(head)).toBe(expected);
  });

  it('does not accept arbitrary ZIP archives or executables', () => {
    expect(detectBinaryType(ZIP)).toBeNull();
    expect(detectBinaryType(Buffer.from('MZ\x90\0\x03\0\0\0'))).toBeNull();
    expect(detectBinaryType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
  });
});

describe('verifySignature', () => {
  it('accepts content that matches the declared type', () => {
    expect(verifySignature('image/png', PNG, false)).toEqual({ ok: true });
    expect(verifySignature('video/quicktime', MP4, false)).toEqual({ ok: true });
  });

  it('rejects a renamed file whose content is a different allowed type', () => {
    expect(verifySignature('image/png', PDF, false)).toEqual({
      ok: false,
      reason: 'type_mismatch',
    });
    expect(verifySignature('text/plain', PNG, false)).toEqual({
      ok: false,
      reason: 'type_mismatch',
    });
  });

  it('rejects unrecognised binary content', () => {
    expect(verifySignature('application/pdf', Buffer.from('MZ\x90\0'), true)).toEqual({
      ok: false,
      reason: 'unrecognised_content',
    });
  });

  it('accepts UTF-8 text and CSV, rejects binary disguised as text', () => {
    expect(verifySignature('text/csv', Buffer.from('name,qty\nmilk,2\ncafé,1\n'), true)).toEqual({
      ok: true,
    });
    expect(verifySignature('text/plain', Buffer.from('hello\0world'), true).ok).toBe(false);
    expect(verifySignature('text/plain', bytes(0xc3, 0x28), true).ok).toBe(false);
  });
});

describe('looksLikeText', () => {
  it('tolerates a multi-byte character cut at the end of the sniff window', () => {
    const cut = Buffer.from('price 10€', 'utf8').subarray(0, -1);
    expect(looksLikeText(cut, false)).toBe(true);
    expect(looksLikeText(cut, true)).toBe(false);
  });
});

describe('sanitizeFileName', () => {
  it('strips paths, control characters and reserved characters', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\Users\\me\\report<1>.pdf')).toBe('report1.pdf');
    expect(sanitizeFileName('a\u0000b\u001fc.txt')).toBe('abc.txt');
    expect(sanitizeFileName('  ..hidden  ')).toBe('hidden');
    expect(sanitizeFileName('...')).toBe('file');
  });

  it('limits length', () => {
    expect(sanitizeFileName(`${'x'.repeat(300)}.pdf`)).toHaveLength(200);
  });
});

describe('contentDisposition', () => {
  it('forces download for documents and keeps a safe ASCII fallback', () => {
    const header = contentDisposition('Zeugnis "Müller".pdf', 'DOCUMENT');
    expect(header).toMatch(/^attachment; filename="Zeugnis _M_ller_.pdf"; filename\*=UTF-8''/);
    expect(header).toContain(encodeURIComponent('Müller'));
    expect(/^[\x20-\x7e]+$/.test(header)).toBe(true);
  });

  it('shows images and videos inline', () => {
    expect(contentDisposition('photo.jpg', 'IMAGE').startsWith('inline;')).toBe(true);
  });
});

describe('escapeLikePattern', () => {
  it('escapes LIKE wildcards and the escape character', () => {
    expect(escapeLikePattern('100%_done\\')).toBe('100\\%\\_done\\\\');
  });
});
