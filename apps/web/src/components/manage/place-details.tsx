'use client';

import {
  SOCIAL_NETWORKS,
  type PlaceDetails,
  type PlaceDetailsDto,
  type SocialNetwork,
} from '@storeline/shared';
import { ExternalLink, Globe, ImagePlus, Mail, MapPin, Phone, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, errorMessage, uploadBody } from '@/lib/api';
import { countries, countryName } from '@/lib/countries';
import { Alert, Button, cx, SelectField, TextArea, TextField } from '../ui';

export const SOCIAL_LABELS: Record<SocialNetwork, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  x: 'X (Twitter)',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  whatsapp: 'WhatsApp link',
};

export interface PlaceForm {
  description: string;
  phone: string;
  email: string;
  website: string;
  mapUrl: string;
  line1: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  social: Record<SocialNetwork, string>;
}

const emptySocial = () =>
  Object.fromEntries(SOCIAL_NETWORKS.map((n) => [n, ''])) as Record<SocialNetwork, string>;

export function emptyPlaceForm(): PlaceForm {
  return {
    description: '',
    phone: '',
    email: '',
    website: '',
    mapUrl: '',
    line1: '',
    city: '',
    region: '',
    postalCode: '',
    country: '',
    social: emptySocial(),
  };
}

export function placeFormFrom(place: PlaceDetailsDto): PlaceForm {
  return {
    description: place.description ?? '',
    phone: place.phone ?? '',
    email: place.email ?? '',
    website: place.website ?? '',
    mapUrl: place.mapUrl ?? '',
    line1: place.address?.line1 ?? '',
    city: place.address?.city ?? '',
    region: place.address?.region ?? '',
    postalCode: place.address?.postalCode ?? '',
    country: place.address?.country ?? '',
    social: { ...emptySocial(), ...place.socialLinks },
  };
}

/** Empty fields become null (cleared) so the API never receives blank strings. */
export function placeRequest(form: PlaceForm): PlaceDetails {
  const v = (s: string) => s.trim() || null;
  const address = {
    line1: v(form.line1) ?? undefined,
    city: v(form.city) ?? undefined,
    region: v(form.region) ?? undefined,
    postalCode: v(form.postalCode) ?? undefined,
    country: v(form.country) ?? undefined,
  };
  return {
    description: v(form.description),
    phone: v(form.phone),
    email: v(form.email),
    website: v(form.website),
    mapUrl: v(form.mapUrl),
    address: Object.values(address).some(Boolean) ? address : null,
    socialLinks: Object.fromEntries(
      Object.entries(form.social)
        .map(([k, url]) => [k, url.trim()])
        .filter(([, url]) => url),
    ),
  };
}

/** Form fields for the public details of a business or store. */
export function PlaceDetailsFields({
  value,
  onChange,
  fieldError,
}: {
  value: PlaceForm;
  onChange: (next: PlaceForm) => void;
  fieldError?: (path: string) => string | undefined;
}) {
  const set = (patch: Partial<PlaceForm>) => onChange({ ...value, ...patch });
  return (
    <div className="flex flex-col gap-4">
      <TextArea
        label="Description (optional)"
        rows={2}
        maxLength={500}
        value={value.description}
        onChange={(e) => set({ description: e.target.value })}
      />
      <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <legend className="mb-2 font-bold">Location</legend>
        <TextField
          label="Street address"
          className="sm:col-span-2"
          value={value.line1}
          onChange={(e) => set({ line1: e.target.value })}
          error={fieldError?.('address.line1')}
        />
        <TextField
          label="City"
          value={value.city}
          onChange={(e) => set({ city: e.target.value })}
        />
        <TextField
          label="State / province"
          value={value.region}
          onChange={(e) => set({ region: e.target.value })}
        />
        <TextField
          label="Postal code"
          value={value.postalCode}
          onChange={(e) => set({ postalCode: e.target.value })}
        />
        <SelectField
          label="Country"
          value={value.country}
          onChange={(e) => set({ country: e.target.value })}
        >
          <option value="">Choose a country</option>
          {countries().map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Map link"
          hint="Paste the share link from Google Maps, Apple Maps or OpenStreetMap."
          className="sm:col-span-2"
          type="url"
          inputMode="url"
          placeholder="https://maps.google.com/…"
          value={value.mapUrl}
          onChange={(e) => set({ mapUrl: e.target.value })}
          error={fieldError?.('mapUrl')}
        />
      </fieldset>
      <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <legend className="mb-2 font-bold">Contact</legend>
        <TextField
          label="Phone"
          hint="International format, e.g. +924211234567"
          type="tel"
          value={value.phone}
          onChange={(e) => set({ phone: e.target.value })}
          error={fieldError?.('phone')}
        />
        <TextField
          label="Email"
          type="email"
          value={value.email}
          onChange={(e) => set({ email: e.target.value })}
          error={fieldError?.('email')}
        />
        <TextField
          label="Website"
          className="sm:col-span-2"
          type="url"
          inputMode="url"
          placeholder="https://"
          value={value.website}
          onChange={(e) => set({ website: e.target.value })}
          error={fieldError?.('website')}
        />
      </fieldset>
      <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <legend className="mb-2 font-bold">Social links</legend>
        {SOCIAL_NETWORKS.map((network) => (
          <TextField
            key={network}
            label={SOCIAL_LABELS[network]}
            type="url"
            inputMode="url"
            placeholder="https://"
            value={value.social[network]}
            onChange={(e) => set({ social: { ...value.social, [network]: e.target.value } })}
            error={fieldError?.(`socialLinks.${network}`)}
          />
        ))}
      </fieldset>
    </div>
  );
}

/** Logo picker: uploads straight away (the server re-encodes it to a 256px WebP). */
export function LogoField({
  name,
  logoUrl,
  uploadPath,
  onChanged,
}: {
  name: string;
  logoUrl: string | null;
  uploadPath: string;
  onChanged: (next: PlaceDetailsDto) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(task: () => Promise<PlaceDetailsDto>) {
    setBusy(true);
    setError(null);
    try {
      onChanged(await task());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="font-semibold">Logo</span>
      <div className="flex flex-wrap items-center gap-4">
        <PlaceLogo name={name} logoUrl={logoUrl} size={72} />
        <Button
          type="button"
          variant="secondary"
          busy={busy}
          icon={<ImagePlus className="size-5" aria-hidden />}
          onClick={() => input.current?.click()}
        >
          {logoUrl ? 'Change logo' : 'Upload logo'}
        </Button>
        {logoUrl && (
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            icon={<Trash2 className="size-5" aria-hidden />}
            onClick={() => void run(() => api<PlaceDetailsDto>(uploadPath, { method: 'DELETE' }))}
          >
            Remove
          </Button>
        )}
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          aria-label="Logo image"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void run(() => uploadBody<PlaceDetailsDto>(uploadPath, file));
          }}
        />
      </div>
      <p className="text-sm text-muted">PNG, JPEG or WebP, up to 2 MB. Square images look best.</p>
      {error && <Alert tone="error">{error}</Alert>}
    </div>
  );
}

export function PlaceLogo({
  name,
  logoUrl,
  size = 48,
  className,
}: {
  name: string;
  logoUrl: string | null;
  size?: number;
  className?: string;
}) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return logoUrl ? (
    <img
      src={logoUrl}
      alt={`${name} logo`}
      width={size}
      height={size}
      className={cx('shrink-0 rounded-2xl border border-line bg-white object-contain', className)}
      style={{ width: size, height: size }}
    />
  ) : (
    <span
      aria-hidden
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-2xl bg-brand-soft font-bold text-brand-strong',
        className,
      )}
      style={{ width: size, height: size, fontSize: size * 0.36 }}
    >
      {initials}
    </span>
  );
}

/** "City, State, Country" (whatever is known). */
export function placeLocation(place: PlaceDetailsDto): string {
  const a = place.address;
  return [a?.city, a?.region, countryName(a?.country)].filter(Boolean).join(', ');
}

/** Read-only details: location, contact, website, map and social links (open in a new tab). */
export function PlaceSummary({ place }: { place: PlaceDetailsDto }) {
  const location = placeLocation(place);
  const links = Object.entries(place.socialLinks) as Array<[SocialNetwork, string]>;
  const linkCls =
    'inline-flex items-center gap-1 rounded-lg px-1 font-semibold text-brand hover:underline';
  return (
    <div className="flex flex-col gap-2 text-sm">
      {place.description && <p className="text-base">{place.description}</p>}
      {(place.address?.line1 || location) && (
        <p className="flex items-start gap-2 text-muted">
          <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden />
          {[place.address?.line1, location].filter(Boolean).join(' · ')}
        </p>
      )}
      {place.phone && (
        <p className="flex items-center gap-2 text-muted">
          <Phone className="size-4 shrink-0" aria-hidden /> {place.phone}
        </p>
      )}
      {place.email && (
        <p className="flex items-center gap-2 text-muted">
          <Mail className="size-4 shrink-0" aria-hidden /> {place.email}
        </p>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {place.website && (
          <a href={place.website} target="_blank" rel="noopener noreferrer" className={linkCls}>
            <Globe className="size-4" aria-hidden /> Website
          </a>
        )}
        {place.mapUrl && (
          <a href={place.mapUrl} target="_blank" rel="noopener noreferrer" className={linkCls}>
            <MapPin className="size-4" aria-hidden /> Open map
          </a>
        )}
        {links.map(([network, url]) => (
          <a key={network} href={url} target="_blank" rel="noopener noreferrer" className={linkCls}>
            <ExternalLink className="size-4" aria-hidden /> {SOCIAL_LABELS[network]}
          </a>
        ))}
      </div>
    </div>
  );
}
