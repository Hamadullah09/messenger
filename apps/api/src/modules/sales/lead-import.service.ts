import { Injectable } from '@nestjs/common';
import {
  LEAD_IMPORT_FIELDS,
  OUTBOUND_SOURCES,
  type LeadDuplicateDto,
  type LeadImportField,
  type LeadImportPreviewDto,
  type LeadImportPreviewRequest,
  type LeadImportRequest,
  type LeadImportResultDto,
  type LeadImportRowDto,
} from '@storeline/shared';
import ExcelJS from 'exceljs';
import { ApiError } from '../../infra/http/api-error';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';
import { publicUserSelect, toPublicUser } from '../users/user.mapper';
import { SALES_PEOPLE_ROLE_KEYS, SalesService } from './sales.service';

const MAX_ROWS = 2000;
const MAX_BYTES = 4 * 1024 * 1024;

/** Heading words that identify each lead field (lower-case, spaces removed). */
const SYNONYMS: Record<LeadImportField, string[]> = {
  companyName: ['company', 'companyname', 'business', 'businessname', 'organisation', 'organization', 'shop', 'store', 'brand', 'name'],
  contactName: ['contact', 'contactname', 'person', 'contactperson', 'owner', 'fullname', 'customer'],
  contactTitle: ['title', 'designation', 'position', 'role', 'jobtitle'],
  email: ['email', 'e-mail', 'emailaddress', 'mail'],
  phone: ['phone', 'mobile', 'cell', 'contactno', 'contactnumber', 'whatsapp', 'number', 'tel', 'telephone', 'phoneno'],
  website: ['website', 'web', 'url', 'site'],
  industry: ['industry', 'sector', 'category', 'type'],
  city: ['city', 'town', 'location'],
  country: ['country'],
  storeCount: ['stores', 'storecount', 'branches', 'outlets', 'noofstores', 'numberofstores', 'locations'],
  estimatedValue: ['value', 'budget', 'dealvalue', 'estimatedvalue', 'monthlyvalue', 'amount'],
  notes: ['notes', 'note', 'remarks', 'comment', 'comments', 'details', 'description'],
};

const COUNTRIES: Record<string, string> = {
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

const norm = (h: string) => h.toLowerCase().replace(/[\s_.\-/#()]+/g, '');
const phoneKey = (p: string | null | undefined) => {
  const digits = (p ?? '').replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-10) : null;
};
const companyKey = (c: string | null | undefined) =>
  (c ?? '').toLowerCase().replace(/\b(pvt|private|ltd|limited|llc|inc|co|company)\b/g, '').replace(/[^a-z0-9]/g, '') || null;

/** Minimal CSV reader: commas or semicolons, quoted fields, BOM. */
function parseCsv(text: string): string[][] {
  const clean = text.startsWith('﻿') ? text.slice(1) : text;
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
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

async function parseXlsx(buffer: Buffer): Promise<string[][]> {
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

/** Lead import from Excel/CSV with duplicate detection (email, phone, company name). */
@Injectable()
export class LeadImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly sales: SalesService,
    private readonly audit: AuditService,
  ) {}

  private async requireManage(actor: Actor) {
    const { businessId } = await this.sales.tenant(actor);
    await this.authz.require(actor, 'sales.lead.manage', { businessId });
    return businessId;
  }

  /** Existing leads keyed by email, phone and company (to spot duplicates). */
  private async existingIndex(tenantId: string) {
    const leads = await this.prisma.lead.findMany({
      where: { tenantId, deletedAt: null },
      select: { id: true, companyName: true, email: true, phone: true },
      take: 50_000,
    });
    const byEmail = new Map<string, (typeof leads)[number]>();
    const byPhone = new Map<string, (typeof leads)[number]>();
    const byCompany = new Map<string, (typeof leads)[number]>();
    for (const l of leads) {
      if (l.email) byEmail.set(l.email.toLowerCase(), l);
      const p = phoneKey(l.phone);
      if (p) byPhone.set(p, l);
      const c = companyKey(l.companyName);
      if (c) byCompany.set(c, l);
    }
    return { byEmail, byPhone, byCompany };
  }

  private match(
    index: Awaited<ReturnType<LeadImportService['existingIndex']>>,
    values: { email?: string; phone?: string; companyName?: string },
  ): { id: string; companyName: string; reason: string } | null {
    const email = values.email?.toLowerCase();
    if (email && index.byEmail.has(email)) {
      const l = index.byEmail.get(email)!;
      return { id: l.id, companyName: l.companyName, reason: 'Same email' };
    }
    const p = phoneKey(values.phone);
    if (p && index.byPhone.has(p)) {
      const l = index.byPhone.get(p)!;
      return { id: l.id, companyName: l.companyName, reason: 'Same phone number' };
    }
    const c = companyKey(values.companyName);
    if (c && index.byCompany.has(c)) {
      const l = index.byCompany.get(c)!;
      return { id: l.id, companyName: l.companyName, reason: 'Same company name' };
    }
    return null;
  }

  async preview(actor: Actor, request: LeadImportPreviewRequest): Promise<LeadImportPreviewDto> {
    const tenantId = await this.requireManage(actor);
    const buffer = Buffer.from(request.contentBase64, 'base64');
    if (buffer.length > MAX_BYTES) throw ApiError.validation('The file is too big (4 MB at most).', 'contentBase64');
    const name = request.fileName.toLowerCase();
    let table: string[][];
    try {
      if (name.endsWith('.csv') || name.endsWith('.txt')) table = parseCsv(buffer.toString('utf8'));
      else if (name.endsWith('.xlsx')) table = await parseXlsx(buffer);
      else throw ApiError.validation('Use an Excel (.xlsx) or CSV file.', 'fileName');
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw ApiError.validation('This file could not be read. Save it again as .xlsx or .csv.', 'contentBase64');
    }
    if (table.length < 2) throw ApiError.validation('The file needs a heading row and at least one lead.', 'contentBase64');
    const headings = table[0]!.map((h, i) => h.trim() || `Column ${i + 1}`);
    const mapping: Partial<Record<LeadImportField, string>> = {};
    const used = new Set<number>();
    // Exact heading matches first, then partial ones, so "Company name" beats "Name".
    for (const pass of ['exact', 'partial'] as const) {
      for (const field of LEAD_IMPORT_FIELDS) {
        if (mapping[field]) continue;
        const idx = headings.findIndex((h, i) => {
          if (used.has(i)) return false;
          const n = norm(h);
          return pass === 'exact' ? SYNONYMS[field].includes(n) : SYNONYMS[field].some((s) => s.length > 3 && n.includes(s));
        });
        if (idx >= 0) {
          mapping[field] = headings[idx]!;
          used.add(idx);
        }
      }
    }
    const index = await this.existingIndex(tenantId);
    const seen = new Map<string, number>();
    const body = table.slice(1, MAX_ROWS + 1);
    const rows: LeadImportRowDto[] = body.map((cells, i) => {
      const values: Partial<Record<LeadImportField, string>> = {};
      for (const [field, heading] of Object.entries(mapping) as Array<[LeadImportField, string]>) {
        const v = cells[headings.indexOf(heading)]?.trim();
        if (v) values[field] = v;
      }
      if (values.email) values.email = values.email.toLowerCase();
      if (values.country) {
        const c = values.country.trim();
        values.country = c.length === 2 ? c.toUpperCase() : (COUNTRIES[c.toLowerCase()] ?? '');
        if (!values.country) delete values.country;
      }
      if (values.storeCount) values.storeCount = String(parseInt(values.storeCount.replace(/\D/g, ''), 10) || '');
      if (values.estimatedValue) values.estimatedValue = String(Math.round(Number(values.estimatedValue.replace(/[^\d.]/g, ''))) || '');
      if (!values.contactName && values.companyName) values.contactName = values.companyName;
      const errors: string[] = [];
      if (!values.companyName || values.companyName.length < 2) errors.push('Company name is missing');
      if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.push('Email looks wrong');
      if (values.phone && phoneKey(values.phone) === null) errors.push('Phone number is too short');
      let duplicate = this.match(index, values);
      // Repeated inside the same file.
      const keys = [values.email?.toLowerCase(), phoneKey(values.phone), companyKey(values.companyName)].filter(Boolean) as string[];
      if (!duplicate)
        for (const k of keys) {
          if (seen.has(k)) {
            duplicate = { id: '', companyName: values.companyName ?? '', reason: `Same as row ${seen.get(k)! + 2} in this file` };
            break;
          }
        }
      keys.forEach((k) => !seen.has(k) && seen.set(k, i));
      return { row: i + 2, values, errors, duplicate };
    });
    return { columns: headings, mapping, rows, truncated: table.length - 1 > MAX_ROWS };
  }

  async import(actor: Actor, request: LeadImportRequest): Promise<LeadImportResultDto> {
    const teamId = await this.requireManage(actor);
    let ownerId: string | null = actor.userId;
    if (request.ownerId !== undefined && request.ownerId !== actor.userId) {
      await this.authz.require(actor, 'sales.lead.assign', { businessId: teamId });
      if (request.ownerId) {
        const isSalesPerson = await this.prisma.roleAssignment.count({
          where: {
            userId: request.ownerId,
            businessId: teamId,
            revokedAt: null,
            role: { key: { in: [...SALES_PEOPLE_ROLE_KEYS] }, isSystem: true },
            user: { status: 'ACTIVE', deletedAt: null },
          },
        });
        if (!isSalesPerson) throw ApiError.validation('Choose someone from the sales team.', 'ownerId');
      }
      ownerId = request.ownerId;
    }
    const index = await this.existingIndex(teamId);
    const direction = (OUTBOUND_SOURCES as readonly string[]).includes(request.source) ? 'OUTBOUND' : 'INBOUND';
    let created = 0;
    let skipped = 0;
    const seen = new Set<string>();
    for (const row of request.rows) {
      const keys = [row.email?.toLowerCase(), phoneKey(row.phone), companyKey(row.companyName)].filter(Boolean) as string[];
      const dup = this.match(index, row) || keys.some((k) => seen.has(k));
      keys.forEach((k) => seen.add(k));
      if (dup && request.skipDuplicates) {
        skipped += 1;
        continue;
      }
      await this.prisma.$transaction(async (tx) => {
        const lead = await tx.lead.create({
          data: {
            ...row,
            email: row.email ?? null,
            source: request.source,
            direction,
            sourceDetail: 'Imported from a file',
            tenantId: teamId,
            ownerId,
            createdById: actor.userId,
          },
          select: { id: true },
        });
        await tx.leadActivity.create({
          data: { leadId: lead.id, type: 'CREATED', toStage: 'NEW', actorId: actor.userId, body: 'Imported from a file' },
        });
      });
      created += 1;
    }
    await this.audit.record(actor, {
      action: 'sales.leads_imported',
      businessId: teamId,
      metadata: { created, skipped },
    });
    return { created, skipped };
  }

  /** Possible duplicates while typing a new lead. */
  async duplicates(actor: Actor, values: { companyName?: string; email?: string; phone?: string }): Promise<LeadDuplicateDto[]> {
    const tenantId = await this.requireManage(actor);
    const or = [
      values.email ? { email: { equals: values.email.trim(), mode: 'insensitive' as const } } : null,
      values.companyName && values.companyName.trim().length >= 3
        ? { companyName: { contains: values.companyName.trim(), mode: 'insensitive' as const } }
        : null,
      phoneKey(values.phone) ? { phone: { contains: phoneKey(values.phone)!.slice(-7) } } : null,
    ].filter((v): v is NonNullable<typeof v> => v !== null);
    if (or.length === 0) return [];
    const rows = await this.prisma.lead.findMany({
      where: { tenantId, deletedAt: null, OR: or },
      select: {
        id: true,
        companyName: true,
        contactName: true,
        stage: true,
        email: true,
        phone: true,
        owner: { select: publicUserSelect },
      },
      take: 8,
    });
    return rows.map((r) => ({
      id: r.id,
      companyName: r.companyName,
      contactName: r.contactName,
      stage: r.stage,
      owner: r.owner ? toPublicUser(r.owner) : null,
      reason:
        values.email && r.email?.toLowerCase() === values.email.trim().toLowerCase()
          ? 'Same email'
          : phoneKey(values.phone) && phoneKey(r.phone) === phoneKey(values.phone)
            ? 'Same phone number'
            : 'Similar company name',
    }));
  }
}
