import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IMPORT_SAMPLE_KINDS,
  bulkImportPreviewRequestSchema,
  bulkImportRequestSchema,
  createBusinessRequestSchema,
  createStoreRequestSchema,
  importColumns,
  type BulkImportPreviewDto,
  type BulkImportPreviewRequest,
  type BulkImportRequest,
  type BulkImportResultDto,
  type BulkImportRowDto,
  type ImportColumn,
  type ImportSampleKind,
} from '@storeline/shared';
import ExcelJS from 'exceljs';
import type { Response } from 'express';
import { z } from 'zod';
import { COUNTRIES, norm, readTable } from '../../infra/files/table-file';
import { ApiError } from '../../infra/http/api-error';
import { ApiZodBody, ZodPipe } from '../../infra/http/zod';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CurrentActor, type Actor } from '../auth/actor';
import { AuthorizationService } from '../authorization/authorization.service';
import { BusinessesService } from '../tenancy/businesses.service';
import { StoresService } from '../tenancy/stores.service';
import { TenancyModule } from '../tenancy/tenancy.module';

const MAX_ROWS = 1000;

/** A sample workbook: the headings with one example row, and a sheet explaining each column. */
export async function sampleWorkbook(kind: ImportSampleKind): Promise<Buffer> {
  const columns = importColumns(kind);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SMA';
  const sheet = wb.addWorksheet(
    kind === 'leads' ? 'Leads' : kind === 'stores' ? 'Stores' : 'Businesses',
  );
  sheet.columns = columns.map((c) => ({
    header: c.label,
    key: c.field,
    width: Math.max(14, c.label.length + 4, c.example.length + 2),
  }));
  sheet.addRow(Object.fromEntries(columns.map((c) => [c.field, c.example])));
  const head = sheet.getRow(1);
  head.font = { bold: true };
  head.eachCell((cell, i) => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: columns[i - 1]?.required ? 'FFFDE68A' : 'FFE5E7EB' },
    };
  });
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  const help = wb.addWorksheet('How to fill');
  help.columns = [
    { header: 'Column', key: 'label', width: 22 },
    { header: 'Required', key: 'required', width: 10 },
    { header: 'How to fill', key: 'hint', width: 70 },
    { header: 'Example', key: 'example', width: 30 },
  ];
  help.getRow(1).font = { bold: true };
  for (const c of columns)
    help.addRow({
      label: c.label,
      required: c.required ? 'Yes' : '',
      hint: c.hint,
      example: c.example,
    });
  help.addRow({});
  help.addRow({
    label: 'Note',
    hint: 'Keep the heading row. Replace the example row with your own, one per row. Yellow headings are required. Up to 1,000 rows per file (.xlsx or .csv).',
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Which file heading fills each column: exact (ignoring case and spaces) first, then synonyms. */
function mapHeadings(headings: string[], columns: ImportColumn[]): Record<string, number> {
  const mapping: Record<string, number> = {};
  const used = new Set<number>();
  const tries: Array<(c: ImportColumn, h: string) => boolean> = [
    (c, h) => norm(h) === norm(c.label),
    (c, h) => norm(h) === c.field.toLowerCase() || (c.synonyms ?? []).includes(norm(h)),
  ];
  for (const test of tries)
    for (const c of columns) {
      if (c.field in mapping) continue;
      const idx = headings.findIndex((h, i) => !used.has(i) && test(c, h));
      if (idx >= 0) {
        mapping[c.field] = idx;
        used.add(idx);
      }
    }
  return mapping;
}

const slugFrom = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');

/** "0300 1234567", "0092-300…" → "+92300…" where it is clear; otherwise left for the check. */
function cleanPhone(raw: string, country: string | undefined): string {
  let p = raw.replace(/[\s\-().]/g, '');
  if (p.startsWith('00')) p = `+${p.slice(2)}`;
  if (!p.startsWith('+') && p.startsWith('0') && (country ?? 'PK') === 'PK') p = `+92${p.slice(1)}`;
  return p;
}

const firstIssue = (error: z.ZodError) => {
  const issue = error.issues[0];
  const field = issue?.path[0];
  const label = typeof field === 'string' ? field : '';
  return `${label ? `${label}: ` : ''}${issue?.message ?? 'Not valid'}`;
};

type Kind = 'businesses' | 'stores';

@Injectable()
export class BulkImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly businesses: BusinessesService,
    private readonly stores: StoresService,
    private readonly audit: AuditService,
  ) {}

  private async requireRight(actor: Actor, kind: Kind, businessId?: string) {
    if (kind === 'businesses') await this.authz.require(actor, 'business.create', null);
    else {
      const business = await this.prisma.business.findFirst({
        where: { id: businessId, deletedAt: null },
        select: { id: true },
      });
      if (!business) throw ApiError.notFound('Business');
      await this.authz.require(actor, 'store.create', { businessId: business.id });
    }
  }

  /** The request a row becomes (or the reason it cannot). */
  private toRequest(kind: Kind, values: Record<string, string>) {
    const country = values.country
      ? values.country.length === 2
        ? values.country.toUpperCase()
        : COUNTRIES[values.country.toLowerCase()]
      : undefined;
    const address =
      values.address || values.city || country
        ? {
            ...(values.address ? { line1: values.address } : {}),
            ...(values.city ? { city: values.city } : {}),
            ...(country ? { country } : {}),
          }
        : undefined;
    const website = values.website
      ? /^https?:\/\//i.test(values.website)
        ? values.website
        : `https://${values.website}`
      : undefined;
    const common = {
      name: values.name,
      ...(values.timeZone ? { timeZone: values.timeZone } : {}),
      ...(values.phone ? { phone: cleanPhone(values.phone, country) } : {}),
      ...(values.email ? { email: values.email } : {}),
      ...(website ? { website } : {}),
      ...(values.description ? { description: values.description } : {}),
      ...(address ? { address } : {}),
    };
    const errors: string[] = [];
    if (values.country && !country) errors.push('Country: use a two-letter code such as PK');
    if (kind === 'businesses') {
      const parsed = createBusinessRequestSchema.safeParse({
        ...common,
        slug: values.slug || slugFrom(values.name ?? ''),
      });
      return parsed.success
        ? { errors, business: parsed.data }
        : { errors: [...errors, firstIssue(parsed.error)] };
    }
    const parsed = createStoreRequestSchema.safeParse({ ...common, code: values.code });
    return parsed.success
      ? { errors, store: parsed.data }
      : { errors: [...errors, firstIssue(parsed.error)] };
  }

  async sample(kind: string): Promise<Buffer> {
    if (!(IMPORT_SAMPLE_KINDS as readonly string[]).includes(kind))
      throw ApiError.notFound('Sample file');
    return sampleWorkbook(kind as ImportSampleKind);
  }

  async preview(
    actor: Actor,
    kind: Kind,
    request: BulkImportPreviewRequest,
    businessId?: string,
  ): Promise<BulkImportPreviewDto> {
    await this.requireRight(actor, kind, businessId);
    const table = await readTable(request.fileName, request.contentBase64);
    if (table.length < 2)
      throw ApiError.validation(
        'The file needs a heading row and at least one row.',
        'contentBase64',
      );
    const headings = table[0]!.map((h, i) => h.trim() || `Column ${i + 1}`);
    const columns = importColumns(kind);
    const mapping = mapHeadings(headings, columns);
    const required = columns.filter((c) => c.required && !(c.field in mapping));
    if (required.length)
      throw ApiError.validation(
        `The file has no ${required.map((c) => `"${c.label}"`).join(' or ')} column. Download the sample file to see the headings.`,
        'contentBase64',
      );
    // Already taken: business short names (platform-wide) or store codes (in this business).
    const taken = new Set(
      kind === 'businesses'
        ? (await this.prisma.business.findMany({ select: { slug: true } })).map((b) => b.slug)
        : (await this.prisma.store.findMany({ where: { businessId }, select: { code: true } })).map(
            (s) => s.code,
          ),
    );
    const seen = new Map<string, number>();
    const rows: BulkImportRowDto[] = table.slice(1, MAX_ROWS + 1).map((cells, i) => {
      const values: Record<string, string> = {};
      for (const [field, idx] of Object.entries(mapping)) {
        const v = cells[idx]?.trim();
        if (v) values[field] = v;
      }
      const built = this.toRequest(kind, values);
      const errors = [...built.errors];
      const key = built.business?.slug ?? built.store?.code;
      if (built.business) values.slug = built.business.slug;
      if (key && taken.has(key))
        errors.push(
          kind === 'businesses'
            ? `Short name "${key}" is already used by another business`
            : `Store code "${key}" is already used in this business`,
        );
      else if (key && seen.has(key))
        errors.push(
          `Same ${kind === 'businesses' ? 'short name' : 'store code'} as row ${seen.get(key)! + 2}`,
        );
      if (key && !seen.has(key)) seen.set(key, i);
      return { row: i + 2, values, errors };
    });
    return {
      columns: headings,
      mapping: Object.fromEntries(Object.entries(mapping).map(([f, idx]) => [f, headings[idx]!])),
      rows,
      truncated: table.length - 1 > MAX_ROWS,
    };
  }

  async import(
    actor: Actor,
    kind: Kind,
    request: BulkImportRequest,
    businessId?: string,
  ): Promise<BulkImportResultDto> {
    await this.requireRight(actor, kind, businessId);
    let created = 0;
    const failed: BulkImportResultDto['failed'] = [];
    // One by one through the normal create (same checks, limits and audit as the form).
    for (const { row, values } of request.rows) {
      const built = this.toRequest(kind, values);
      if (built.errors.length) {
        failed.push({ row, error: built.errors.join('; ') });
        continue;
      }
      try {
        if (built.business) await this.businesses.create(actor, built.business);
        else if (built.store) await this.stores.create(actor, businessId!, built.store);
        created += 1;
      } catch (error) {
        failed.push({
          row,
          error: error instanceof Error ? error.message : 'Could not be created',
        });
      }
    }
    await this.audit.record(actor, {
      action: kind === 'businesses' ? 'business.bulk_imported' : 'store.bulk_imported',
      ...(businessId ? { businessId } : {}),
      metadata: { created, failed: failed.length },
    });
    return { created, failed };
  }
}

const xlsx = (res: Response, fileName: string, buffer: Buffer) => {
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  return new StreamableFile(buffer);
};

@ApiTags('imports')
@ApiBearerAuth()
@Controller({ path: 'imports', version: '1' })
export class ImportsController {
  constructor(private readonly imports: BulkImportService) {}

  /** Sample file for an upload (leads, businesses or stores), built from the current columns. */
  @Get(':kind/sample.xlsx')
  async sample(
    @Param('kind') kind: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    return xlsx(res, `sma-${kind}-sample.xlsx`, await this.imports.sample(kind));
  }

  @Post('businesses/preview')
  @HttpCode(200)
  @ApiZodBody(bulkImportPreviewRequestSchema)
  previewBusinesses(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(bulkImportPreviewRequestSchema)) body: BulkImportPreviewRequest,
  ): Promise<BulkImportPreviewDto> {
    return this.imports.preview(actor, 'businesses', body);
  }

  @Post('businesses')
  @HttpCode(200)
  @ApiZodBody(bulkImportRequestSchema)
  importBusinesses(
    @CurrentActor() actor: Actor,
    @Body(new ZodPipe(bulkImportRequestSchema)) body: BulkImportRequest,
  ): Promise<BulkImportResultDto> {
    return this.imports.import(actor, 'businesses', body);
  }

  @Post('stores/:businessId/preview')
  @HttpCode(200)
  @ApiZodBody(bulkImportPreviewRequestSchema)
  previewStores(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Body(new ZodPipe(bulkImportPreviewRequestSchema)) body: BulkImportPreviewRequest,
  ): Promise<BulkImportPreviewDto> {
    return this.imports.preview(actor, 'stores', body, businessId);
  }

  @Post('stores/:businessId')
  @HttpCode(200)
  @ApiZodBody(bulkImportRequestSchema)
  importStores(
    @CurrentActor() actor: Actor,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Body(new ZodPipe(bulkImportRequestSchema)) body: BulkImportRequest,
  ): Promise<BulkImportResultDto> {
    return this.imports.import(actor, 'stores', body, businessId);
  }
}

@Module({
  imports: [TenancyModule],
  controllers: [ImportsController],
  providers: [BulkImportService],
})
export class ImportsModule {}
