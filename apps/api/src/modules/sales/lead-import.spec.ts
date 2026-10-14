import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { assertSafeZip } from './lead-import.service';

async function workbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Leads');
  ws.addRow(['Company', 'Contact', 'Phone']);
  ws.addRow(['Test Co', 'Ali', '+923005550000']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Offset of the first central directory entry (from the end-of-central-directory record). */
function centralDirectory(buffer: Buffer): number {
  for (let i = buffer.length - 22; i >= 0; i--)
    if (buffer.readUInt32LE(i) === 0x06054b50) return buffer.readUInt32LE(i + 16);
  throw new Error('not a zip');
}

describe('lead import: .xlsx safety check', () => {
  it('accepts a normal workbook', async () => {
    const buffer = await workbook();
    expect(() => assertSafeZip(buffer)).not.toThrow();
  });

  it('rejects a file that would unpack too large (zip bomb)', async () => {
    const buffer = await workbook();
    // Claim the first file unpacks to 100 MB.
    buffer.writeUInt32LE(100 * 1024 * 1024, centralDirectory(buffer) + 24);
    expect(() => assertSafeZip(buffer)).toThrow(/too big/);
  });

  it('rejects files that are not zips or use ZIP64', async () => {
    expect(() => assertSafeZip(Buffer.from('Company,Contact\nA,B\n'))).toThrow();
    const buffer = await workbook();
    buffer.writeUInt32LE(0xffffffff, centralDirectory(buffer) + 24);
    expect(() => assertSafeZip(buffer)).toThrow();
  });
});
