'use client';

import {
  STICKERS,
  type AttachmentDto,
  type ConversationDetailDto,
  type MessageDto,
  type MessageMeta,
} from '@storeline/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CalendarDays,
  CalendarPlus,
  Check,
  ExternalLink,
  Loader2,
  MapPin,
  Mic,
  Navigation,
  Pause,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Play,
  Square,
  Video,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { useCallControls } from '@/lib/calls';
import { keys, upsertMessages } from '@/lib/chat-cache';
import { formatTime } from '@/lib/format';
import { useLiveShares } from '@/lib/live-location';
import { useMediaUrl } from '@/lib/media-store';
import { Avatar, cx, Dialog } from '../ui';

type Meta<T extends MessageMeta['type']> = Extract<MessageMeta, { type: T }>;

function useMessageMutation(message: MessageDto) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (req: { path: string; method: 'PUT' | 'DELETE'; body?: unknown }) =>
      api<MessageDto>(`/messages/${message.id}${req.path}`, { method: req.method, body: req.body }),
    onSuccess: (updated) => upsertMessages(client, message.conversationId, [updated]),
  });
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

// ───────────────────────────── Voice notes and audio ─────────────────────────────

const SPEEDS = [1, 1.5, 2] as const;

/** WhatsApp-style voice note: play/pause, waveform progress, speed (1×, 1.5×, 2×). */
export function AudioMessage({
  attachment,
  meta,
  mine,
  senderName,
}: {
  attachment: AttachmentDto;
  meta: Meta<'audio'> | null;
  mine: boolean;
  senderName: string;
}) {
  const [requested, setRequested] = useState(false);
  const url = useMediaUrl(attachment.mediaId, 'original', requested);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState((meta?.durationMs ?? 0) / 1000);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const bars = meta?.waveform?.length ? meta.waveform : Array.from({ length: 40 }, (_, i) => 6 + ((i * 7) % 13));
  const progress = duration > 0 ? position / duration : 0;
  const voice = meta?.voice ?? false;

  useEffect(() => {
    if (requested && url.data && audioRef.current && audioRef.current.paused && playing) {
      void audioRef.current.play().catch(() => setPlaying(false));
    }
  }, [requested, url.data, playing]);

  const toggle = () => {
    const el = audioRef.current;
    if (!requested) {
      setRequested(true);
      setPlaying(true);
      return;
    }
    if (!el) return;
    if (el.paused) void el.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    else {
      el.pause();
      setPlaying(false);
    }
  };
  const seek = (fraction: number) => {
    const el = audioRef.current;
    if (!el || !duration) return;
    el.currentTime = fraction * duration;
    setPosition(el.currentTime);
  };

  return (
    <div className="flex w-[min(19rem,70vw)] items-center gap-2.5 px-1 py-1">
      {voice && !mine && (
        <span className="relative shrink-0">
          <Avatar name={senderName} size={44} />
          <Mic className="absolute -right-1 -bottom-1 size-4 rounded-full bg-wa-in text-brand" aria-hidden />
        </span>
      )}
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pause' : voice ? 'Play voice message' : `Play ${attachment.fileName}`}
        className="inline-flex size-10 shrink-0 items-center justify-center rounded-full text-wa-icon hover:bg-black/5"
      >
        {requested && url.isPending ? (
          <Loader2 className="size-6 animate-spin" aria-hidden />
        ) : playing ? (
          <Pause className="size-7 fill-current" aria-hidden />
        ) : (
          <Play className="size-7 fill-current" aria-hidden />
        )}
      </button>
      <div className="min-w-0 flex-1">
        <div
          className="flex h-8 cursor-pointer items-center gap-[2px]"
          role="slider"
          tabIndex={0}
          aria-label="Position"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(position)}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            seek((e.clientX - rect.left) / rect.width);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') seek(Math.min(1, progress + 0.05));
            if (e.key === 'ArrowLeft') seek(Math.max(0, progress - 0.05));
          }}
        >
          {bars.map((b, i) => (
            <span
              key={i}
              className={cx(
                'w-[3px] flex-1 rounded-full',
                i / bars.length < progress ? 'bg-brand' : 'bg-wa-icon/45',
              )}
              style={{ height: `${Math.max(12, (b / 31) * 100)}%` }}
            />
          ))}
        </div>
        <div className="flex items-center justify-between text-[0.7rem] text-wa-meta-in">
          <span className="tabular-nums">{formatDuration(playing || position > 0 ? position : duration)}</span>
          {!voice && <span className="truncate">{attachment.fileName}</span>}
        </div>
      </div>
      {(playing || position > 0) && (
        <button
          type="button"
          onClick={() => {
            const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!;
            setSpeed(next);
            if (audioRef.current) audioRef.current.playbackRate = next;
          }}
          className="shrink-0 rounded-full bg-black/10 px-2 py-0.5 text-xs font-bold dark:bg-white/15"
          aria-label={`Playback speed ${speed}×`}
        >
          {speed}×
        </button>
      )}
      {voice && mine && (
        <span className="relative shrink-0">
          <Mic className="size-5 text-wa-icon" aria-hidden />
        </span>
      )}
      {requested && url.data && (
        <audio
          ref={audioRef}
          src={url.data.url}
          preload="auto"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setDuration(d);
            e.currentTarget.playbackRate = speed;
          }}
          onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
          onEnded={() => {
            setPlaying(false);
            setPosition(0);
          }}
          onError={() => void url.refetch()}
        />
      )}
    </div>
  );
}

// ───────────────────────────── Location ─────────────────────────────

export function mapsLink(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

export function LocationMessage({ message, meta, mine }: { message: MessageDto; meta: Meta<'location'>; mine: boolean }) {
  const mutation = useMessageMutation(message);
  const stopShare = useLiveShares((s) => s.stop);
  const live = meta.live;
  const now = Date.now();
  const liveActive = !!live && !live.stoppedAt && Date.parse(live.until) > now;
  return (
    <div className="w-[min(18rem,70vw)] overflow-hidden rounded-xl">
      <a
        href={mapsLink(meta.lat, meta.lng)}
        target="_blank"
        rel="noopener noreferrer"
        className="relative block h-32 overflow-hidden bg-[#e7efe3] dark:bg-[#1f2c27]"
        aria-label="Open the location in maps"
      >
        {/* A simple map-like backdrop (no third-party map tiles are loaded). */}
        <span
          aria-hidden
          className="absolute inset-0 opacity-60"
          style={{
            backgroundImage:
              'linear-gradient(90deg, rgb(0 0 0 / 0.06) 1px, transparent 1px), linear-gradient(rgb(0 0 0 / 0.06) 1px, transparent 1px), linear-gradient(35deg, transparent 46%, rgb(255 255 255 / 0.7) 46%, rgb(255 255 255 / 0.7) 52%, transparent 52%)',
            backgroundSize: '24px 24px, 24px 24px, 100% 100%',
          }}
        />
        <span className="absolute inset-0 flex items-center justify-center">
          {liveActive ? (
            <span className="relative inline-flex size-12 items-center justify-center">
              <span className="absolute inset-0 animate-ping rounded-full bg-sky-500/40" />
              <span className="relative inline-flex size-9 items-center justify-center rounded-full bg-sky-600 text-white shadow">
                <Navigation className="size-5" aria-hidden />
              </span>
            </span>
          ) : (
            <MapPin className="size-11 fill-red-600 text-white drop-shadow" aria-hidden />
          )}
        </span>
      </a>
      <div className="px-1 pt-1.5">
        {liveActive ? (
          <p className="font-semibold">Live location</p>
        ) : (
          (meta.name || !live) && <p className="font-semibold">{meta.name ?? 'Location'}</p>
        )}
        {meta.address && <p className="text-sm text-wa-meta-in">{meta.address}</p>}
        {live && (
          <p className="text-xs text-wa-meta-in">
            {liveActive
              ? `Until ${formatTime(live.until)} · updated ${formatTime(live.updatedAt)}`
              : 'Live location ended'}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap gap-2">
          <a
            href={mapsLink(meta.lat, meta.lng)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm font-semibold text-brand"
          >
            <ExternalLink className="size-4" aria-hidden /> Open in Maps
          </a>
          {mine && liveActive && (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-sm font-semibold text-danger"
              disabled={mutation.isPending}
              onClick={() => {
                stopShare(message.id);
                mutation.mutate({ path: '/live-location', method: 'DELETE' });
              }}
            >
              <Square className="size-3.5 fill-current" aria-hidden /> Stop sharing
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────── Contact card ─────────────────────────────

export function ContactMessage({ message, meta, mine }: { message: MessageDto; meta: Meta<'contact'>; mine: boolean }) {
  const router = useRouter();
  const client = useQueryClient();
  const open = useMutation({
    mutationFn: async () => {
      const conversation = client.getQueryData<ConversationDetailDto>(keys.conversation(message.conversationId));
      const businessId =
        conversation?.businessId ??
        (await api<ConversationDetailDto>(`/conversations/${message.conversationId}`)).businessId;
      return api<ConversationDetailDto>('/conversations/direct', {
        method: 'POST',
        body: { businessId, userId: meta.userId },
      });
    },
    onSuccess: (c) => router.push(`/chats?c=${c.id}`),
  });
  return (
    <div className="w-[min(17rem,70vw)]">
      <div className="flex items-center gap-3 px-1 py-2">
        <Avatar name={meta.displayName} size={44} />
        <div className="min-w-0">
          <p className="truncate font-semibold">{meta.displayName}</p>
          <p className="truncate text-sm text-wa-meta-in">@{meta.username}</p>
        </div>
      </div>
      {!mine && (
        <button
          type="button"
          onClick={() => open.mutate()}
          disabled={open.isPending}
          className="w-full border-t border-black/10 pt-2 text-center font-semibold text-brand dark:border-white/10"
        >
          {open.isPending ? 'Opening…' : 'Message'}
        </button>
      )}
      {open.isError && <p className="px-1 text-sm text-danger">{errorMessage(open.error)}</p>}
    </div>
  );
}

// ───────────────────────────── Poll ─────────────────────────────

export function PollMessage({
  message,
  meta,
  myId,
  nameOf,
}: {
  message: MessageDto;
  meta: Meta<'poll'>;
  myId: string;
  nameOf: (id: string) => string;
}) {
  const mutation = useMessageMutation(message);
  const [showVotes, setShowVotes] = useState(false);
  const mine = new Set(message.pollVotes.filter((v) => v.userId === myId).map((v) => v.option));
  const voters = new Set(message.pollVotes.map((v) => v.userId));
  const counts = meta.options.map((_, i) => message.pollVotes.filter((v) => v.option === i).length);
  const max = Math.max(1, ...counts);
  const choose = (option: number) => {
    const next = new Set(mine);
    if (meta.multiple) {
      if (next.has(option)) next.delete(option);
      else next.add(option);
    } else if (next.has(option)) next.clear();
    else {
      next.clear();
      next.add(option);
    }
    mutation.mutate({ path: '/poll-vote', method: 'PUT', body: { options: [...next] } });
  };
  return (
    <div className="w-[min(19rem,72vw)] px-1">
      <p className="font-semibold">{message.body}</p>
      <p className="mb-2 flex items-center gap-1 text-xs text-wa-meta-in">
        <Check className="size-3.5" aria-hidden />
        {meta.multiple ? 'Select one or more' : 'Select one'}
      </p>
      <ul className="flex flex-col gap-2.5" role={meta.multiple ? 'group' : 'radiogroup'} aria-label="Poll options">
        {meta.options.map((option, i) => {
          const selected = mine.has(i);
          return (
            <li key={i}>
              <button
                type="button"
                role={meta.multiple ? 'checkbox' : 'radio'}
                aria-checked={selected}
                disabled={mutation.isPending}
                onClick={() => choose(i)}
                className="flex w-full items-start gap-2.5 text-left"
              >
                <span
                  className={cx(
                    'mt-0.5 inline-flex size-5 shrink-0 items-center justify-center border-2',
                    meta.multiple ? 'rounded-md' : 'rounded-full',
                    selected ? 'border-brand bg-brand text-white' : 'border-wa-icon',
                  )}
                >
                  {selected && <Check className="size-3.5" strokeWidth={3} aria-hidden />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex justify-between gap-2">
                    <span>{option}</span>
                    <span className="text-sm tabular-nums text-wa-meta-in">{counts[i]}</span>
                  </span>
                  <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-black/10 dark:bg-white/15">
                    <span
                      className="block h-full rounded-full bg-brand transition-[width]"
                      style={{ width: `${(counts[i]! / max) * 100}%` }}
                    />
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={() => setShowVotes(true)}
        className="mt-2.5 w-full border-t border-black/10 pt-2 text-center text-sm font-semibold text-brand dark:border-white/10"
      >
        View votes ({voters.size})
      </button>
      {mutation.isError && <p className="text-sm text-danger">{errorMessage(mutation.error)}</p>}
      <Dialog open={showVotes} onClose={() => setShowVotes(false)} title="Poll results">
        <div className="flex flex-col gap-4">
          <p className="font-bold">{message.body}</p>
          {meta.options.map((option, i) => (
            <section key={i}>
              <p className="flex justify-between font-semibold">
                <span>{option}</span>
                <span className="text-muted">{counts[i]} votes</span>
              </p>
              <ul className="mt-1 flex flex-col gap-1">
                {message.pollVotes
                  .filter((v) => v.option === i)
                  .map((v) => (
                    <li key={v.userId} className="flex items-center gap-2 text-sm">
                      <Avatar name={nameOf(v.userId)} size={24} /> {nameOf(v.userId)}
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </div>
      </Dialog>
    </div>
  );
}

// ───────────────────────────── Event ─────────────────────────────

const RESPONSES = [
  { value: 'GOING', label: 'Going' },
  { value: 'MAYBE', label: 'Maybe' },
  { value: 'NOT_GOING', label: "Can't go" },
] as const;

function icsDate(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Downloads an .ics file so the event can be added to any calendar app. */
function addToCalendar(title: string, meta: Meta<'event'>) {
  const end = meta.endsAt ?? new Date(Date.parse(meta.startsAt) + 3_600_000).toISOString();
  const esc = (s: string) => s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SMA Technology//Chat event//EN',
    'BEGIN:VEVENT',
    `UID:${Date.now()}@sma`,
    `DTSTAMP:${icsDate(new Date().toISOString())}`,
    `DTSTART:${icsDate(meta.startsAt)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${esc(title)}`,
    ...(meta.location ? [`LOCATION:${esc(meta.location)}`] : []),
    ...(meta.description ? [`DESCRIPTION:${esc(meta.description)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title.replace(/[^\w-]+/g, '-').slice(0, 40) || 'event'}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function EventMessage({ message, meta, myId }: { message: MessageDto; meta: Meta<'event'>; myId: string }) {
  const mutation = useMessageMutation(message);
  const mine = message.eventResponses.find((r) => r.userId === myId)?.response ?? null;
  const count = (r: string) => message.eventResponses.filter((x) => x.response === r).length;
  const start = new Date(meta.startsAt);
  const past = (meta.endsAt ? Date.parse(meta.endsAt) : start.getTime() + 3_600_000) < Date.now();
  return (
    <div className="w-[min(19rem,72vw)] px-1">
      <div className="flex items-start gap-3">
        <span className="flex w-12 shrink-0 flex-col items-center overflow-hidden rounded-lg bg-surface text-center shadow-sm">
          <span className="w-full bg-brand py-0.5 text-[0.65rem] font-bold text-white uppercase">
            {start.toLocaleDateString(undefined, { month: 'short' })}
          </span>
          <span className="py-0.5 text-lg font-bold">{start.getDate()}</span>
        </span>
        <div className="min-w-0">
          <p className="font-semibold">{message.body}</p>
          <p className="flex items-center gap-1 text-sm text-wa-meta-in">
            <CalendarDays className="size-4" aria-hidden />
            {start.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}{' '}
            · {formatTime(meta.startsAt)}
            {meta.endsAt ? `–${formatTime(meta.endsAt)}` : ''}
          </p>
          {meta.location && (
            <p className="flex items-center gap-1 text-sm text-wa-meta-in">
              <MapPin className="size-4" aria-hidden /> {meta.location}
            </p>
          )}
        </div>
      </div>
      {meta.description && <p className="mt-2 text-sm whitespace-pre-wrap">{meta.description}</p>}
      <p className="mt-2 text-xs text-wa-meta-in">
        {count('GOING')} going · {count('MAYBE')} maybe · {count('NOT_GOING')} can’t go
        {past ? ' · ended' : ''}
      </p>
      {!past && (
        <div className="mt-2 grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Your answer">
          {RESPONSES.map((r) => (
            <button
              key={r.value}
              type="button"
              role="radio"
              aria-checked={mine === r.value}
              disabled={mutation.isPending}
              onClick={() =>
                mutation.mutate({
                  path: '/event-response',
                  method: 'PUT',
                  body: { response: mine === r.value ? null : r.value },
                })
              }
              className={cx(
                'min-h-9 rounded-lg border text-sm font-semibold',
                mine === r.value
                  ? 'border-brand bg-brand text-white'
                  : 'border-black/15 hover:bg-black/5 dark:border-white/20',
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => addToCalendar(message.body ?? 'Event', meta)}
        className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-brand"
      >
        <CalendarPlus className="size-4" aria-hidden /> Add to calendar
      </button>
    </div>
  );
}

// ───────────────────────────── Call record ─────────────────────────────

export function callLabel(meta: Meta<'call'>, outgoing: boolean): { text: string; missed: boolean } {
  const kind = meta.media === 'video' ? 'video call' : 'voice call';
  switch (meta.outcome) {
    case 'answered':
      return { text: `${outgoing ? 'Outgoing' : 'Incoming'} ${kind}`, missed: false };
    case 'missed':
      return outgoing ? { text: `No answer · ${kind}`, missed: false } : { text: `Missed ${kind}`, missed: true };
    case 'declined':
      return { text: outgoing ? `Declined · ${kind}` : `You declined a ${kind}`, missed: !outgoing };
    case 'cancelled':
      return { text: outgoing ? `Cancelled ${kind}` : `Missed ${kind}`, missed: !outgoing };
    case 'busy':
      return { text: outgoing ? `Busy · ${kind}` : `Missed ${kind} (you were on another call)`, missed: !outgoing };
    default:
      return { text: `Call failed · ${kind}`, missed: false };
  }
}

export function CallMessage({ message, meta, myId }: { message: MessageDto; meta: Meta<'call'>; myId: string }) {
  const calls = useCallControls();
  const outgoing = meta.callerId === myId;
  const { text, missed } = callLabel(meta, outgoing);
  const Icon = missed ? PhoneMissed : outgoing ? PhoneOutgoing : PhoneIncoming;
  return (
    <div className="flex w-[min(16rem,70vw)] items-center gap-3 px-1 py-1">
      <span
        className={cx(
          'inline-flex size-10 shrink-0 items-center justify-center rounded-full',
          missed ? 'bg-danger/15 text-danger' : 'bg-black/10 text-wa-icon dark:bg-white/15',
        )}
      >
        {meta.media === 'video' ? <Video className="size-5" aria-hidden /> : <Icon className="size-5" aria-hidden />}
      </span>
      <div className="min-w-0 flex-1">
        <p className={cx('font-semibold', missed && 'text-danger')}>{text}</p>
        <p className="text-xs text-wa-meta-in">
          {meta.outcome === 'answered' ? formatDuration(meta.durationSec) : 'Tap to call back'}
        </p>
      </div>
      <button
        type="button"
        aria-label={`Call back (${meta.media === 'video' ? 'video' : 'voice'})`}
        className="inline-flex size-9 items-center justify-center rounded-full text-brand hover:bg-black/5"
        onClick={() => calls.start(message.conversationId, meta.media)}
      >
        {meta.media === 'video' ? <Video className="size-5" aria-hidden /> : <Phone className="size-5" aria-hidden />}
      </button>
    </div>
  );
}

// ───────────────────────────── Sticker ─────────────────────────────

export function stickerEmoji(id: string): string {
  return STICKERS.find((s) => s.id === id)?.emoji ?? '🙂';
}

export function StickerMessage({ meta }: { meta: Meta<'sticker'> }) {
  const sticker = STICKERS.find((s) => s.id === meta.sticker);
  return (
    <span
      role="img"
      aria-label={`Sticker: ${sticker?.label ?? meta.sticker}`}
      className="block text-[96px] leading-none select-none"
      style={{
        filter:
          'drop-shadow(2px 0 0 #fff) drop-shadow(-2px 0 0 #fff) drop-shadow(0 2px 0 #fff) drop-shadow(0 -2px 0 #fff) drop-shadow(0 3px 6px rgb(0 0 0 / 0.25))',
      }}
    >
      {sticker?.emoji ?? '🙂'}
    </span>
  );
}
