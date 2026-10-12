import { Prisma } from '@prisma/client';
import {
  addressSchema,
  socialLinksSchema,
  type PlaceDetails,
  type PlaceDetailsDto,
} from '@storeline/shared';
import sharp from 'sharp';
import { ApiError } from '../../infra/http/api-error';

/** Shared public-profile columns of Business and Store (never the logo bytes). */
export const placeDetailsSelect = {
  description: true,
  phone: true,
  email: true,
  website: true,
  mapUrl: true,
  address: true,
  socialLinks: true,
  logoUpdatedAt: true,
} as const;

interface PlaceDetailsRow {
  description: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  mapUrl: string | null;
  address: Prisma.JsonValue;
  socialLinks: Prisma.JsonValue;
  logoUpdatedAt: Date | null;
}

/** `logoPath` is the API path of the logo; a version query busts caches after a change. */
export function toPlaceDetails(row: PlaceDetailsRow, logoPath: string): PlaceDetailsDto {
  const address = addressSchema.safeParse(row.address);
  const links = socialLinksSchema.safeParse(row.socialLinks);
  return {
    description: row.description,
    phone: row.phone,
    email: row.email,
    website: row.website,
    mapUrl: row.mapUrl,
    address: row.address && address.success ? address.data : null,
    socialLinks: links.success ? links.data : {},
    logoUrl: row.logoUpdatedAt ? `${logoPath}?v=${row.logoUpdatedAt.getTime()}` : null,
  };
}

/** Prisma data for the fields present in the request: undefined keeps, null clears. */
export function placeDetailsData(request: PlaceDetails) {
  return {
    ...(request.description !== undefined ? { description: request.description || null } : {}),
    ...(request.phone !== undefined ? { phone: request.phone } : {}),
    ...(request.email !== undefined ? { email: request.email } : {}),
    ...(request.website !== undefined ? { website: request.website } : {}),
    ...(request.mapUrl !== undefined ? { mapUrl: request.mapUrl } : {}),
    ...(request.address !== undefined
      ? { address: request.address === null ? Prisma.DbNull : request.address }
      : {}),
    ...(request.socialLinks !== undefined ? { socialLinks: request.socialLinks } : {}),
  };
}

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/**
 * Decodes an uploaded logo and re-encodes it as a 256×256 WebP. Only the re-encoded image
 * is stored, so nothing from the original file (metadata, scripts in SVG, polyglots) survives.
 */
export async function processLogo(body: unknown): Promise<Buffer> {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw ApiError.validation('Choose a PNG, JPEG or WebP image up to 2 MB.', 'logo');
  }
  try {
    const image = sharp(body, { limitInputPixels: 40_000_000, failOn: 'error' });
    const meta = await image.metadata();
    if (!meta.format || !['png', 'jpeg', 'webp'].includes(meta.format)) throw new Error('format');
    return await image
      .rotate()
      .resize(256, 256, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    throw ApiError.validation('This file is not a valid PNG, JPEG or WebP image.', 'logo');
  }
}
