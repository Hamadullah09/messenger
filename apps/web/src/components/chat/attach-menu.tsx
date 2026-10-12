'use client';

import {
  LIVE_LOCATION_MINUTES,
  POLL_OPTIONS_MAX,
  STICKERS,
  type PublicUserDto,
  type RichContent,
  type StoreDto,
} from '@storeline/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  BarChart3,
  Camera,
  CalendarDays,
  FileText,
  Headphones,
  Image as ImageIcon,
  MapPin,
  Navigation,
  Plus,
  RefreshCw,
  Smile,
  Store,
  Trash2,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { Alert, Avatar, Button, cx, Dialog, Spinner, TextArea, TextField } from '../ui';

export type AttachAction =
  | 'document'
  | 'media'
  | 'camera'
  | 'audio'
  | 'contact'
  | 'poll'
  | 'event'
  | 'location'
  | 'sticker';

const ITEMS: Array<{ action: AttachAction; label: string; Icon: LucideIcon; color: string; files?: boolean }> = [
  { action: 'document', label: 'Document', Icon: FileText, color: '#7f66ff', files: true },
  { action: 'media', label: 'Photos & videos', Icon: ImageIcon, color: '#007bfc', files: true },
  { action: 'camera', label: 'Camera', Icon: Camera, color: '#ff2e74', files: true },
  { action: 'audio', label: 'Audio', Icon: Headphones, color: '#fa6533', files: true },
  { action: 'contact', label: 'Contact', Icon: UserRound, color: '#009de2' },
  { action: 'poll', label: 'Poll', Icon: BarChart3, color: '#ffbc38' },
  { action: 'event', label: 'Event', Icon: CalendarDays, color: '#ff2e74' },
  { action: 'location', label: 'Location', Icon: MapPin, color: '#1daa61' },
  { action: 'sticker', label: 'Sticker', Icon: Smile, color: '#02a698' },
];

/** WhatsApp's attach menu (the paperclip). File items are hidden where files are not allowed. */
export function AttachMenu({
  canShareFiles,
  onSelect,
}: {
  canShareFiles: boolean;
  onSelect: (action: AttachAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const items = ITEMS.filter((i) => canShareFiles || !i.files);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Attach"
        title="Attach"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cx(
          'inline-flex size-10 shrink-0 items-center justify-center rounded-full text-wa-icon transition-colors hover:bg-wa-hover',
          open && 'bg-wa-active',
        )}
      >
        <Plus className={cx('size-6 transition-transform', open && 'rotate-45')} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Attach"
          className="absolute bottom-full left-0 z-40 mb-2 w-56 rounded-2xl bg-surface py-2 shadow-pop"
        >
          {items.map(({ action, label, Icon, color }, i) => (
            <button
              key={action}
              type="button"
              role="menuitem"
              autoFocus={i === 0}
              onClick={() => {
                setOpen(false);
                onSelect(action);
              }}
              className="flex min-h-11 w-full items-center gap-3.5 px-4 text-left hover:bg-wa-hover"
            >
              <Icon className="size-5" style={{ color }} aria-hidden />
              <span className="text-[0.95rem]">{label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── Poll ─────────────────────────────

export function PollDialog({ onClose, onSend }: { onClose: () => void; onSend: (c: RichContent) => void }) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multiple, setMultiple] = useState(false);
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const duplicate = new Set(filled.map((o) => o.toLowerCase())).size !== filled.length;
  return (
    <Dialog open onClose={onClose} title="Create poll">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          onSend({ kind: 'POLL', question: question.trim(), options: filled, multiple });
        }}
      >
        <TextField label="Question" required maxLength={255} value={question} placeholder="Ask a question" onChange={(e) => setQuestion(e.target.value)} />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-semibold">Options</legend>
          {options.map((o, i) => (
            <div key={i} className="flex gap-2">
              <input
                aria-label={`Option ${i + 1}`}
                value={o}
                maxLength={100}
                placeholder={`Option ${i + 1}`}
                onChange={(e) => {
                  const next = [...options];
                  next[i] = e.target.value;
                  if (i === options.length - 1 && e.target.value && options.length < POLL_OPTIONS_MAX) next.push('');
                  setOptions(next);
                }}
                className="min-h-11 flex-1 rounded-xl border border-line-strong/70 bg-surface px-3"
              />
              {options.length > 2 && (
                <button
                  type="button"
                  aria-label={`Remove option ${i + 1}`}
                  onClick={() => setOptions(options.filter((_, j) => j !== i))}
                  className="inline-flex size-11 items-center justify-center rounded-xl text-muted hover:bg-surface-2"
                >
                  <Trash2 className="size-4" aria-hidden />
                </button>
              )}
            </div>
          ))}
          {duplicate && <p className="text-sm text-danger">Options must be different.</p>}
        </fieldset>
        <label className="flex min-h-11 items-center gap-3">
          <input type="checkbox" className="size-5 accent-[var(--color-brand)]" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} />
          <span>Allow multiple answers</span>
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!question.trim() || filled.length < 2 || duplicate}>
            Send poll
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ───────────────────────────── Event ─────────────────────────────

function localInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function EventDialog({ onClose, onSend }: { onClose: () => void; onSend: (c: RichContent) => void }) {
  const soon = new Date(Date.now() + 86_400_000);
  soon.setMinutes(0, 0, 0);
  const [title, setTitle] = useState('');
  const [startsAt, setStartsAt] = useState(localInput(soon));
  const [endsAt, setEndsAt] = useState(localInput(new Date(soon.getTime() + 3_600_000)));
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const invalid = endsAt && new Date(endsAt) <= new Date(startsAt);
  return (
    <Dialog open onClose={onClose} title="Create event">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          onSend({
            kind: 'EVENT',
            title: title.trim(),
            startsAt: new Date(startsAt),
            ...(endsAt ? { endsAt: new Date(endsAt) } : {}),
            ...(location.trim() ? { location: location.trim() } : {}),
            ...(description.trim() ? { description: description.trim() } : {}),
          });
        }}
      >
        <TextField label="Event name" required maxLength={120} value={title} placeholder="e.g. Monthly store meeting" onChange={(e) => setTitle(e.target.value)} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TextField label="Starts" type="datetime-local" required value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          <TextField label="Ends" type="datetime-local" value={endsAt} error={invalid ? 'Must be after the start' : undefined} onChange={(e) => setEndsAt(e.target.value)} />
        </div>
        <TextField label="Location (optional)" maxLength={200} value={location} placeholder="e.g. Head office, or a meeting link" onChange={(e) => setLocation(e.target.value)} />
        <TextArea label="Description (optional)" rows={3} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!title.trim() || !startsAt || !!invalid}>
            Send event
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ───────────────────────────── Location ─────────────────────────────

/** Reads coordinates from a Google/Apple/OSM map link ("@lat,lng", "q=lat,lng", "ll=…"). */
export function coordinatesFromMapUrl(url: string | null): { lat: number; lng: number } | null {
  if (!url) return null;
  const match =
    url.match(/@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/) ??
    url.match(/[?&](?:q|query|ll|destination)=(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/) ??
    url.match(/mlat=(-?\d{1,2}\.\d+)&mlon=(-?\d{1,3}\.\d+)/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

function storeAddress(store: StoreDto): string | undefined {
  const a = store.address;
  if (!a) return undefined;
  return [a.line1, a.line2, a.city, a.region, a.country].filter(Boolean).join(', ') || undefined;
}

export function LocationDialog({
  businessId,
  onClose,
  onSend,
}: {
  businessId: string;
  onClose: () => void;
  onSend: (c: RichContent) => void;
}) {
  const [position, setPosition] = useState<GeolocationPosition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const stores = useQuery({
    queryKey: ['stores', businessId],
    queryFn: () => api<StoreDto[]>(`/businesses/${businessId}/stores`),
  });
  const locate = () => {
    setError(null);
    if (!window.isSecureContext || !('geolocation' in navigator)) {
      setError('Location needs a secure (https) address.');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setPosition(p);
        setLocating(false);
      },
      () => {
        setError('Allow location access in your browser to share where you are.');
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };
  useEffect(locate, []);
  const here = position
    ? { lat: position.coords.latitude, lng: position.coords.longitude, accuracy: Math.round(position.coords.accuracy) }
    : null;
  const withCoords = (stores.data ?? []).map((s) => ({ store: s, at: coordinatesFromMapUrl(s.mapUrl) }));
  return (
    <Dialog open onClose={onClose} title="Send location">
      <div className="flex flex-col gap-3">
        {error && <Alert tone="warning">{error}</Alert>}
        <div className="rounded-2xl border border-line p-3">
          <p className="flex items-center gap-2 font-semibold">
            <Navigation className="size-5 text-sky-600" aria-hidden /> Live location
          </p>
          <p className="mb-2 text-sm text-muted">
            Others see you move while SMA is open on this device. Useful in emergencies.
          </p>
          <div className="grid grid-cols-3 gap-2">
            {LIVE_LOCATION_MINUTES.map((m) => (
              <Button
                key={m}
                variant="secondary"
                size="sm"
                disabled={!here}
                onClick={() => here && onSend({ kind: 'LOCATION', ...here, liveMinutes: m })}
              >
                {m < 60 ? `${m} min` : `${m / 60} hour${m > 60 ? 's' : ''}`}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1 rounded-2xl border border-line pr-2">
          <button
            type="button"
            disabled={!here}
            onClick={() => here && onSend({ kind: 'LOCATION', ...here })}
            className="flex min-h-14 flex-1 items-center gap-3 rounded-2xl px-3 text-left hover:bg-surface-2 disabled:opacity-50"
          >
            <MapPin className="size-6 text-green-600" aria-hidden />
            <span className="flex-1">
              <span className="block font-semibold">Send your current location</span>
              <span className="block text-sm text-muted">
                {locating
                  ? 'Finding you…'
                  : here
                    ? `Accurate to about ${here.accuracy} m`
                    : 'Location not available'}
              </span>
            </span>
          </button>
          <button
            type="button"
            aria-label="Find my location again"
            onClick={locate}
            className="inline-flex size-9 items-center justify-center rounded-full hover:bg-surface-3"
          >
            <RefreshCw className={cx('size-4', locating && 'animate-spin')} aria-hidden />
          </button>
        </div>
        <section>
          <p className="mb-1 font-semibold">A store’s location</p>
          {stores.isLoading && <Spinner label="Loading stores" />}
          <ul className="flex flex-col gap-1">
            {withCoords.map(({ store, at }) => (
              <li key={store.id}>
                <button
                  type="button"
                  disabled={!at}
                  title={at ? undefined : 'Add a map link with coordinates in the store details first'}
                  onClick={() =>
                    at &&
                    onSend({
                      kind: 'LOCATION',
                      ...at,
                      name: store.name,
                      ...(storeAddress(store) ? { address: storeAddress(store) } : {}),
                    })
                  }
                  className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left hover:bg-surface-2 disabled:opacity-50"
                >
                  <Store className="size-5 text-brand" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{store.name}</span>
                    <span className="block truncate text-sm text-muted">
                      {at ? (storeAddress(store) ?? 'Map location') : 'No map coordinates yet'}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Dialog>
  );
}

// ───────────────────────────── Contact ─────────────────────────────

export function ContactDialog({
  businessId,
  onClose,
  onSend,
}: {
  businessId: string;
  onClose: () => void;
  onSend: (c: RichContent) => void;
}) {
  const [query, setQuery] = useState('');
  const search = useDebounced(query.trim());
  const people = useQuery({
    queryKey: ['directory', businessId, search],
    queryFn: () => api<PublicUserDto[]>('/directory', { query: { businessId, query: search, limit: 30 } }),
    placeholderData: keepPreviousData,
  });
  return (
    <Dialog open onClose={onClose} title="Share a contact">
      <div className="flex flex-col gap-3">
        <TextField label="Search people" placeholder="Name or username" value={query} autoFocus onChange={(e) => setQuery(e.target.value)} />
        {people.isError && <Alert tone="error">{errorMessage(people.error)}</Alert>}
        <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
          {people.data?.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                onClick={() => onSend({ kind: 'CONTACT', userId: u.id })}
                className="flex min-h-14 w-full items-center gap-3 rounded-xl px-3 text-left hover:bg-surface-2"
              >
                <Avatar name={u.displayName} size={40} />
                <span>
                  <span className="block font-semibold">{u.displayName}</span>
                  <span className="block text-sm text-muted">@{u.username}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}

// ───────────────────────────── Stickers ─────────────────────────────

const MY_STICKERS_KEY = 'sma.myStickers';
const MY_STICKERS_MAX = 12;

function loadMyStickers(): string[] {
  try {
    const raw = window.localStorage.getItem(MY_STICKERS_KEY);
    return raw ? (JSON.parse(raw) as string[]).filter((s) => s.startsWith('data:image/')) : [];
  } catch {
    return [];
  }
}

function saveMyStickers(list: string[]): void {
  try {
    window.localStorage.setItem(MY_STICKERS_KEY, JSON.stringify(list.slice(0, MY_STICKERS_MAX)));
  } catch {
    // Storage full or private mode: the sticker is still sent.
  }
}

function dataUrlToFile(dataUrl: string): File {
  const [head, body] = dataUrl.split(',') as [string, string];
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? 'image/webp';
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], `sticker.${mime === 'image/png' ? 'png' : 'webp'}`, { type: mime });
}

/** Square crop with a white sticker outline, 512 × 512 (WebP, or PNG where WebP is unsupported). */
function makeSticker(image: HTMLImageElement, zoom: number, dx: number, dy: number, round: boolean): string {
  const size = 512;
  const border = 18;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const side = Math.min(image.naturalWidth, image.naturalHeight) / zoom;
  const sx = (image.naturalWidth - side) / 2 + dx * (image.naturalWidth - side) / 2;
  const sy = (image.naturalHeight - side) / 2 + dy * (image.naturalHeight - side) / 2;
  const shape = (inset: number) => {
    ctx.beginPath();
    if (round) ctx.arc(size / 2, size / 2, size / 2 - inset, 0, Math.PI * 2);
    else ctx.roundRect(inset, inset, size - inset * 2, size - inset * 2, 64 - inset);
  };
  ctx.fillStyle = '#ffffff';
  shape(4);
  ctx.fill();
  ctx.save();
  shape(border);
  ctx.clip();
  ctx.drawImage(image, sx, sy, side, side, border, border, size - border * 2, size - border * 2);
  ctx.restore();
  const webp = canvas.toDataURL('image/webp', 0.85);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
}

export function StickerDialog({
  onClose,
  onSend,
  onSendCustom,
}: {
  onClose: () => void;
  onSend: (c: RichContent) => void;
  /** Sends a picture as a sticker; missing where files cannot be shared. */
  onSendCustom?: (file: File) => void;
}) {
  const [tab, setTab] = useState<'pack' | 'mine'>('pack');
  const [mine, setMine] = useState<string[]>(() => (typeof window === 'undefined' ? [] : loadMyStickers()));
  const [source, setSource] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [dx, setDx] = useState(0);
  const [dy, setDy] = useState(0);
  const [round, setRound] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const preview = source ? makeSticker(source, zoom, dx, dy, round) : null;
  return (
    <Dialog open onClose={onClose} title="Stickers">
      <div className="flex flex-col gap-3">
        {onSendCustom && (
          <div className="flex gap-1 rounded-xl bg-surface-2 p-1" role="tablist">
            {(['pack', 'mine'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={cx('min-h-10 flex-1 rounded-lg text-sm font-semibold', tab === t ? 'bg-surface shadow-card' : 'text-muted')}
              >
                {t === 'pack' ? 'SMA stickers' : 'My stickers'}
              </button>
            ))}
          </div>
        )}
        {tab === 'pack' ? (
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
            {STICKERS.map((s) => (
              <button
                key={s.id}
                type="button"
                title={s.label}
                aria-label={`Send sticker: ${s.label}`}
                onClick={() => onSend({ kind: 'STICKER', sticker: s.id })}
                className="flex aspect-square items-center justify-center rounded-2xl text-5xl hover:bg-surface-2"
              >
                {s.emoji}
              </button>
            ))}
          </div>
        ) : source && preview ? (
          <div className="flex flex-col items-center gap-3">
            <img src={preview} alt="Sticker preview" className="size-44 drop-shadow-lg" />
            <label className="flex w-full items-center gap-3 text-sm">
              Zoom
              <input type="range" min={1} max={3} step={0.05} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="flex-1" />
            </label>
            <label className="flex w-full items-center gap-3 text-sm">
              Left / right
              <input type="range" min={-1} max={1} step={0.02} value={dx} onChange={(e) => setDx(Number(e.target.value))} className="flex-1" />
            </label>
            <label className="flex w-full items-center gap-3 text-sm">
              Up / down
              <input type="range" min={-1} max={1} step={0.02} value={dy} onChange={(e) => setDy(Number(e.target.value))} className="flex-1" />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-[var(--color-brand)]" checked={round} onChange={(e) => setRound(e.target.checked)} />
              Round
            </label>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setSource(null)}>
                Back
              </Button>
              <Button
                onClick={() => {
                  const next = [preview, ...mine.filter((m) => m !== preview)];
                  setMine(next);
                  saveMyStickers(next);
                  setSource(null);
                  onSendCustom?.(dataUrlToFile(preview));
                }}
              >
                Save and send
              </Button>
            </div>
          </div>
        ) : (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                const img = new Image();
                img.onload = () => {
                  setZoom(1);
                  setDx(0);
                  setDy(0);
                  setSource(img);
                };
                img.src = URL.createObjectURL(file);
              }}
            />
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex aspect-square flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed border-line text-sm font-semibold text-brand hover:bg-surface-2"
              >
                <Plus className="size-6" aria-hidden /> Create
              </button>
              {mine.map((m, i) => (
                <span key={i} className="group relative">
                  <button
                    type="button"
                    aria-label="Send this sticker"
                    onClick={() => onSendCustom?.(dataUrlToFile(m))}
                    className="flex aspect-square w-full items-center justify-center rounded-2xl hover:bg-surface-2"
                  >
                    <img src={m} alt="" className="size-full object-contain p-1" />
                  </button>
                  <button
                    type="button"
                    aria-label="Remove from my stickers"
                    onClick={() => {
                      const next = mine.filter((x) => x !== m);
                      setMine(next);
                      saveMyStickers(next);
                    }}
                    className="absolute -top-1 -right-1 hidden size-6 items-center justify-center rounded-full bg-surface text-muted shadow group-hover:inline-flex"
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </button>
                </span>
              ))}
            </div>
            <p className="text-sm text-muted">Make a sticker from any photo. Your stickers are kept on this device.</p>
          </>
        )}
      </div>
    </Dialog>
  );
}

// ───────────────────────────── Camera ─────────────────────────────

/** Takes a photo with the computer's camera (phones use their own camera app instead). */
export function CameraDialog({ onClose, onCapture }: { onClose: () => void; onCapture: (file: File) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  useEffect(() => {
    let current: MediaStream | null = null;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError('The camera needs a secure (https) address.');
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: facing, width: { ideal: 1920 } }, audio: false })
      .then((s) => {
        current = s;
        setStream(s);
        if (video.current) video.current.srcObject = s;
      })
      .catch(() => setError('Allow the camera in your browser to take a photo.'));
    return () => current?.getTracks().forEach((t) => t.stop());
  }, [facing]);
  const capture = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d')?.drawImage(v, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        onCapture(new File([blob], `photo-${stamp}.jpg`, { type: 'image/jpeg' }));
      },
      'image/jpeg',
      0.9,
    );
  };
  return (
    <Dialog open onClose={onClose} title="Take a photo" wide>
      <div className="flex flex-col items-center gap-3">
        {error ? (
          <Alert tone="warning">{error}</Alert>
        ) : (
          <video ref={video} autoPlay playsInline muted className="max-h-[60vh] w-full rounded-2xl bg-black object-contain" />
        )}
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setFacing(facing === 'user' ? 'environment' : 'user')} icon={<RefreshCw className="size-4" aria-hidden />}>
            Switch camera
          </Button>
          <Button onClick={capture} disabled={!stream} icon={<Camera className="size-5" aria-hidden />}>
            Take photo
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
