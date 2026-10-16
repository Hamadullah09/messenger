/**
 * Excel/CSV uploads: the columns of each kind of file and its sample file. The sample files are
 * built from these lists, so adding a field here (or to LEAD_IMPORT_FIELDS) updates the sample
 * that people download — a field without a column entry does not compile.
 */
import { z } from 'zod';
import type { LeadImportField } from './crm-extra';

export interface ImportColumn {
  /** Key in the uploaded values. */
  field: string;
  /** Heading in the sample file (headings are matched loosely: case and spaces do not matter). */
  label: string;
  example: string;
  required: boolean;
  /** How to fill it (shown on the sample file's "How to fill" sheet). */
  hint: string;
  /** Other headings accepted for this column (lower-case, no spaces). */
  synonyms?: string[];
}

export const LEAD_IMPORT_COLUMNS: Record<
  LeadImportField,
  Omit<ImportColumn, 'field' | 'synonyms'>
> = {
  companyName: {
    label: 'Company name',
    example: 'Example Traders',
    required: true,
    hint: 'The business you are selling to.',
  },
  contactName: {
    label: 'Contact name',
    example: 'Ali Khan',
    required: false,
    hint: 'The person to talk to. Left empty: the company name is used.',
  },
  contactTitle: {
    label: 'Contact title',
    example: 'Owner',
    required: false,
    hint: 'Their job, e.g. Owner, Manager.',
  },
  email: {
    label: 'Email',
    example: 'ali@example.com',
    required: false,
    hint: 'One email address.',
  },
  phone: {
    label: 'Phone',
    example: '+923001234567',
    required: false,
    hint: 'Mobile or landline, with the country code if possible.',
  },
  website: {
    label: 'Website',
    example: 'https://example.com',
    required: false,
    hint: 'Their website, if any.',
  },
  industry: {
    label: 'Industry',
    example: 'Retail',
    required: false,
    hint: 'e.g. Retail, Pharmacy, Restaurant.',
  },
  city: { label: 'City', example: 'Lahore', required: false, hint: 'City.' },
  country: {
    label: 'Country',
    example: 'PK',
    required: false,
    hint: 'Two-letter code (PK, AE, SA…) or the country name.',
  },
  storeCount: {
    label: 'Number of stores',
    example: '3',
    required: false,
    hint: 'How many stores or branches they have.',
  },
  estimatedValue: {
    label: 'Estimated value',
    example: '50000',
    required: false,
    hint: 'Expected deal value, numbers only.',
  },
  notes: {
    label: 'Notes',
    example: 'Met at the expo; call after 5 pm.',
    required: false,
    hint: 'Anything else.',
  },
};

const ADDRESS_COLUMNS: ImportColumn[] = [
  {
    field: 'address',
    label: 'Address',
    example: '12 Main Boulevard, Gulberg',
    required: false,
    hint: 'Street address.',
    synonyms: ['street', 'addressline1', 'address1'],
  },
  {
    field: 'city',
    label: 'City',
    example: 'Lahore',
    required: false,
    hint: 'City.',
    synonyms: ['town'],
  },
  {
    field: 'country',
    label: 'Country',
    example: 'PK',
    required: false,
    hint: 'Two-letter code (PK, AE, SA…) or the country name.',
  },
];

const CONTACT_COLUMNS: ImportColumn[] = [
  {
    field: 'phone',
    label: 'Phone',
    example: '+924235761234',
    required: false,
    hint: 'International format: + then the country code, e.g. +923001234567.',
    synonyms: ['mobile', 'phonenumber', 'contactnumber', 'tel', 'telephone', 'whatsapp'],
  },
  {
    field: 'email',
    label: 'Email',
    example: 'info@example.com',
    required: false,
    hint: 'One email address.',
    synonyms: ['emailaddress', 'e-mail', 'mail'],
  },
];

/** Companies (businesses) the platform creates in one go. */
export const BUSINESS_IMPORT_COLUMNS: ImportColumn[] = [
  {
    field: 'name',
    label: 'Business name',
    example: 'Example Traders',
    required: true,
    hint: '2 to 120 characters.',
    synonyms: ['name', 'company', 'companyname', 'business'],
  },
  {
    field: 'slug',
    label: 'Short name',
    example: 'example-traders',
    required: false,
    hint: 'Used in links and the website lead form: lowercase letters, numbers and dashes. Left empty: made from the business name.',
    synonyms: ['slug', 'shortname', 'handle', 'code'],
  },
  {
    field: 'timeZone',
    label: 'Time zone',
    example: 'Asia/Karachi',
    required: false,
    hint: 'e.g. Asia/Karachi, Asia/Dubai. Left empty: UTC.',
    synonyms: ['timezone', 'tz'],
  },
  ...CONTACT_COLUMNS,
  {
    field: 'website',
    label: 'Website',
    example: 'https://example.com',
    required: false,
    hint: 'Full link, e.g. https://example.com.',
    synonyms: ['web', 'url', 'site'],
  },
  ...ADDRESS_COLUMNS,
  {
    field: 'description',
    label: 'Description',
    example: 'Grocery chain with 3 stores',
    required: false,
    hint: 'Up to 500 characters.',
    synonyms: ['about', 'notes', 'details'],
  },
];

/** Stores of one business created in one go. */
export const STORE_IMPORT_COLUMNS: ImportColumn[] = [
  {
    field: 'name',
    label: 'Store name',
    example: 'Gulberg Branch',
    required: true,
    hint: '2 to 120 characters.',
    synonyms: ['name', 'store', 'branch', 'branchname', 'outlet'],
  },
  {
    field: 'code',
    label: 'Store code',
    example: 'LHR-01',
    required: true,
    hint: 'Up to 16 letters, numbers or dashes; different for each store of the business.',
    synonyms: ['code', 'storecode', 'branchcode', 'id', 'storeid'],
  },
  {
    field: 'timeZone',
    label: 'Time zone',
    example: 'Asia/Karachi',
    required: false,
    hint: "e.g. Asia/Karachi. Left empty: the business's time zone.",
    synonyms: ['timezone', 'tz'],
  },
  ...CONTACT_COLUMNS,
  ...ADDRESS_COLUMNS,
  {
    field: 'description',
    label: 'Description',
    example: 'Open 9 am to 11 pm',
    required: false,
    hint: 'Up to 500 characters.',
    synonyms: ['about', 'notes', 'details'],
  },
];

export const IMPORT_SAMPLE_KINDS = ['leads', 'businesses', 'stores'] as const;
export type ImportSampleKind = (typeof IMPORT_SAMPLE_KINDS)[number];

/** The columns of a sample file, in order. */
export function importColumns(kind: ImportSampleKind): ImportColumn[] {
  if (kind === 'businesses') return BUSINESS_IMPORT_COLUMNS;
  if (kind === 'stores') return STORE_IMPORT_COLUMNS;
  return (Object.keys(LEAD_IMPORT_COLUMNS) as LeadImportField[]).map((field) => ({
    field,
    ...LEAD_IMPORT_COLUMNS[field],
  }));
}

export const bulkImportPreviewRequestSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  /** The .xlsx or .csv file, base64 encoded (max ~4 MB). */
  contentBase64: z.string().min(4).max(6_000_000),
});
export type BulkImportPreviewRequest = z.infer<typeof bulkImportPreviewRequestSchema>;

export interface BulkImportRowDto {
  /** Row number in the file (the heading is row 1). */
  row: number;
  values: Record<string, string>;
  /** Problems that stop this row from being created. */
  errors: string[];
}

export interface BulkImportPreviewDto {
  columns: string[];
  /** Which file heading fills each field. */
  mapping: Record<string, string>;
  rows: BulkImportRowDto[];
  truncated: boolean;
}

export const bulkImportRequestSchema = z.object({
  rows: z
    .array(
      z.object({
        row: z.number().int().min(1),
        values: z.record(z.string().max(40), z.string().max(500)),
      }),
    )
    .min(1)
    .max(1000),
});
export type BulkImportRequest = z.infer<typeof bulkImportRequestSchema>;

export interface BulkImportResultDto {
  created: number;
  /** Rows that could not be created, with the reason. */
  failed: Array<{ row: number; error: string }>;
}
