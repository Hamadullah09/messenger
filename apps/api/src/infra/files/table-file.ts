import ExcelJS from 'exceljs';
import { ApiError } from '../http/api-error';

/** Uploaded spreadsheets (Excel/CSV) read into rows of text. */

const MAX_BYTES = 4 * 1024 * 1024;

export const COUNTRIES: Record<string, string> = {
  pakistan: 'PK',
  uae: 'AE',
  'united arab emirates': 'AE',
  'saudi arabia': 'SA',
  ksa: 'SA',
  usa: 'US',
  'united states': 'US',
  uk: 'GB',
  'united kingdom': 'GB',
  qatar: 'QA',
  oman: 'OM',
  bahrain: 'BH',
  kuwait: 'KW',
  china: 'CN',
  india: 'IN',
};

export const norm = (h: string) => h.toLowerCase().replace(/[\s_.\-/#()]+/g, '');

/** Minimal CSV reader: commas or semicolons, quoted fields, BOM. */
function parseCsv(text: string): string[][] {
  const clean = text.startsWith('﻿') ? text.slice(1) : text;
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const sep =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]!;
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** Unpacked size limit for an .xlsx (a zip): stops "zip bombs" before they are opened. */
const MAX_UNZIPPED_BYTES = 40 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 400;

/**
 * Reads the zip's central directory (without unpacking anything) and rejects archives that
 * would unpack too large, have too many files, or use ZIP64.
 */
export function assertSafeZip(buffer: Buffer): void {
  const bad = () =>
    ApiError.validation(
      'This file could not be read. Save it again as .xlsx or .csv.',
      'contentBase64',
    );
  // End of central directory: in the last 22 + 65,535 bytes.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad();
  const entries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (entries === 0xffff || offset === 0xffffffff || entries > MAX_ZIP_ENTRIES) throw bad();
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw bad();
    const size = buffer.readUInt32LE(offset + 24);
    if (size === 0xffffffff) throw bad();
    total += size;
    if (total > MAX_UNZIPPED_BYTES)
      throw ApiError.validation(
        'This file is too big once opened. Split it into smaller files.',
        'contentBase64',
      );
    offset +=
      46 +
      buffer.readUInt16LE(offset + 28) +
      buffer.readUInt16LE(offset + 30) +
      buffer.readUInt16LE(offset + 32);
  }
}

async function parseXlsx(buffer: Buffer): Promise<string[][]> {
  assertSafeZip(buffer);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const values: string[] = [];
    for (let c = 1; c <= ws.columnCount; c++) values.push(r.getCell(c).text?.trim() ?? '');
    if (values.some(Boolean)) rows.push(values);
  });
  return rows;
}

/** Reads an uploaded .xlsx or .csv file into rows of text (the first row is the heading). */
export async function readTable(fileName: string, contentBase64: string): Promise<string[][]> {
  const buffer = Buffer.from(contentBase64, 'base64');
  if (buffer.length > MAX_BYTES)
    throw ApiError.validation('The file is too big (4 MB at most).', 'contentBase64');
  const name = fileName.toLowerCase();
  try {
    if (name.endsWith('.csv') || name.endsWith('.txt')) return parseCsv(buffer.toString('utf8'));
    if (name.endsWith('.xlsx')) return await parseXlsx(buffer);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw ApiError.validation(
      'This file could not be read. Save it again as .xlsx or .csv.',
      'contentBase64',
    );
  }
  throw ApiError.validation('Use an Excel (.xlsx) or CSV file.', 'fileName');
}
