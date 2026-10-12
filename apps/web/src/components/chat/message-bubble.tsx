'use client';

import type { MessageDto } from '@storeline/shared';
import {
  AlertCircle,
  Ban,
  Check,
  CheckCheck,
  ChevronDown,
  Clock,
  Copy,
  Forward,
  Info,
  Pencil,
  Pin,
  PinOff,
  Reply,
  RotateCcw,
  Star,
  StarOff,
  Timer,
  Trash2,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ClientMessage } from '@/lib/chat-cache';
import { copyText } from '@/lib/clipboard';
import { describeSystemEvent, formatTime } from '@/lib/format';
import { Avatar, cx } from '../ui';
import { AttachmentView } from './attachment-view';
import {
  AudioMessage,
  CallMessage,
  ContactMessage,
  EventMessage,
  LocationMessage,
  PollMessage,
  StickerMessage,
} from './rich-content';

/** Kinds whose text is a plain body (copy/edit apply). */
const TEXT_KINDS = new Set(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']);

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '🙏', '✅'];

export type DeliveryStatus = 'sending' | 'failed' | 'queued' | 'sent' | 'delivered' | 'read';

export interface BubbleActions {
  onReply: (m: MessageDto) => void;
  onReact: (m: MessageDto, emoji: string | null) => void;
  onEdit: (m: MessageDto) => void;
  onDelete: (m: MessageDto) => void;
  onForward: (m: MessageDto) => void;
  onStar: (m: MessageDto, star: boolean) => void;
  onPin: (m: MessageDto, pin: boolean) => void;
  onInfo: (m: MessageDto) => void;
  onRetry: (m: ClientMessage) => void;
}

/** WhatsApp-style ticks: one grey tick = sent, two grey = delivered, two blue = read. */
const STATUS: Record<DeliveryStatus, { label: string; Icon: typeof Check; cls: string }> = {
  sending: { label: 'Sending', Icon: Clock, cls: '' },
  queued: { label: 'Queued', Icon: Clock, cls: '' },
  failed: { label: 'Not sent', Icon: AlertCircle, cls: 'text-danger' },
  sent: { label: 'Sent', Icon: Check, cls: '' },
  delivered: { label: 'Delivered', Icon: CheckCheck, cls: '' },
  read: { label: 'Read', Icon: CheckCheck, cls: 'text-wa-read' },
};

/** Stable colour per sender in groups, as in WhatsApp. */
function nameColor(id: string): string {
  const n = [...id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 8;
  return `var(--wa-name-${n})`;
}

/** The little speech-bubble tail on the first message of a run. */
function Tail({ mine }: { mine: boolean }) {
  return (
    <svg
      viewBox="0 0 8 13"
      width="8"
      height="13"
      aria-hidden
      className={cx('absolute top-0', mine ? '-right-2 text-wa-out' : '-left-2 text-wa-in')}
    >
      <path
        fill="currentColor"
        d={
          mine
            ? 'M5.188 1H0v11.193l6.467-8.625C7.526 2.156 6.958 1 5.188 1z'
            : 'M2.812 1H8v11.193L1.533 3.568C.474 2.156 1.042 1 2.812 1z'
        }
      />
    </svg>
  );
}

const SWIPE_MAX = 84;
const SWIPE_TRIGGER = 56;

/**
 * WhatsApp's swipe-to-reply on touch screens: drag a message to the right to reply. Vertical
 * scrolling stays native (touch-action: pan-y); the gesture only locks when it is horizontal.
 */
function useSwipeToReply(enabled: boolean, onReply: () => void) {
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number; horizontal: boolean | null } | null>(null);
  const dxRef = useRef(0);
  const set = (value: number) => {
    dxRef.current = value;
    setDx(value);
  };
  if (!enabled) return { dx: 0, handlers: {} };
  return {
    dx,
    handlers: {
      onTouchStart: (e: React.TouchEvent) => {
        const t = e.touches[0];
        if (t) start.current = { x: t.clientX, y: t.clientY, horizontal: null };
      },
      onTouchMove: (e: React.TouchEvent) => {
        const st = start.current;
        const t = e.touches[0];
        if (!st || !t) return;
        const ddx = t.clientX - st.x;
        const ddy = t.clientY - st.y;
        if (st.horizontal === null) {
          if (Math.abs(ddx) < 8 && Math.abs(ddy) < 8) return;
          st.horizontal = Math.abs(ddx) > Math.abs(ddy) * 1.2 && ddx > 0;
        }
        if (!st.horizontal) return;
        // Resistance near the end, like WhatsApp.
        const pulled = ddx < SWIPE_TRIGGER ? ddx : SWIPE_TRIGGER + (ddx - SWIPE_TRIGGER) * 0.35;
        set(Math.max(0, Math.min(pulled, SWIPE_MAX)));
      },
      onTouchEnd: () => {
        if (dxRef.current >= SWIPE_TRIGGER) {
          navigator.vibrate?.(12);
          onReply();
        }
        start.current = null;
        set(0);
      },
      onTouchCancel: () => {
        start.current = null;
        set(0);
      },
    },
  };
}

export function MessageBubble({
  message,
  mine,
  showSender,
  group,
  status,
  myId,
  nameOf,
  actions,
}: {
  message: ClientMessage;
  mine: boolean;
  /** First message of a run (new sender, after a gap or a system note): shows the tail. */
  showSender: boolean;
  /** Group-like chat: incoming runs show the sender's avatar and coloured name. */
  group: boolean;
  status: DeliveryStatus | null;
  myId: string;
  nameOf: (id: string) => string;
  actions: BubbleActions;
}) {
  const swipe = useSwipeToReply(
    message.kind !== 'SYSTEM' && !message.deleted && !message.local,
    () => actions.onReply(message),
  );
  if (message.kind === 'SYSTEM' && message.systemEvent) {
    return (
      <div className="flex justify-center px-4 py-1.5">
        <p className="wa-bubble max-w-[85%] rounded-lg bg-wa-chip px-3 py-1.5 text-center text-[0.8rem] text-wa-chip-text">
          {describeSystemEvent(message.systemEvent, nameOf)}
        </p>
      </div>
    );
  }

  const myReaction = message.reactions.find((r) => r.userId === myId)?.emoji ?? null;
  const reactionCounts = message.reactions.reduce<Record<string, number>>((acc, r) => {
    acc[r.emoji] = (acc[r.emoji] ?? 0) + 1;
    return acc;
  }, {});
  const hasReactions = Object.keys(reactionCounts).length > 0;
  const statusInfo = mine && status ? STATUS[status] : null;
  const senderName = mine ? 'You' : message.sender.displayName;
  const showAvatarColumn = group && !mine;
  const edited = !!message.editedAt && !message.deleted;
  // Room on the last text line for the time and ticks, like WhatsApp.
  const metaWidth =
    58 +
    (statusInfo ? 22 : 0) +
    (edited ? 44 : 0) +
    (message.pinned ? 16 : 0) +
    (message.starred ? 16 : 0);
  const metaColor = mine ? 'text-wa-meta-out' : 'text-wa-meta-in';
  const meta = message.deleted ? null : message.meta;
  const sticker = meta?.type === 'sticker';
  /** Structured messages draw their own content; the body is part of it (poll question…). */
  const rich =
    !message.deleted &&
    !!meta &&
    ['location', 'contact', 'poll', 'event', 'call', 'sticker'].includes(meta.type);

  return (
    <div
      {...swipe.handlers}
      style={{ touchAction: 'pan-y' }}
      className={cx(
        'group relative flex px-[3%] md:px-[6%]',
        showSender ? 'mt-2.5' : 'mt-0.5',
        hasReactions && 'mb-4',
        mine ? 'justify-end' : 'justify-start',
      )}
    >
      {swipe.dx > 0 && (
        <span
          aria-hidden
          className="absolute top-1/2 left-2 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-full bg-wa-chip text-wa-icon shadow"
          style={{
            opacity: Math.min(1, swipe.dx / SWIPE_TRIGGER),
            transform: `translateY(-50%) scale(${0.6 + 0.4 * Math.min(1, swipe.dx / SWIPE_TRIGGER)})`,
          }}
        >
          <Reply className="size-4" />
        </span>
      )}
      {showAvatarColumn && (
        <div className="mr-2 w-7 shrink-0 self-start">
          {showSender && <Avatar name={message.sender.displayName} size={28} />}
        </div>
      )}
      <article
        aria-label={`${senderName} at ${formatTime(message.createdAt)}`}
        style={{
          transform: swipe.dx ? `translateX(${swipe.dx}px)` : undefined,
          transition: swipe.dx ? 'none' : 'transform 180ms ease-out',
        }}
        className={cx(
          'relative max-w-[85%] min-w-[5.5rem] rounded-lg px-1.5 pt-1.5 pb-2 text-[length:var(--chat-font,0.95rem)] sm:max-w-[65%]',
          sticker ? 'bg-transparent' : cx('wa-bubble', mine ? 'bg-wa-out' : 'bg-wa-in'),
          showSender && !sticker && (mine ? 'rounded-tr-none' : 'rounded-tl-none'),
          message.local === 'failed' && 'ring-2 ring-danger',
        )}
      >
        {showSender && !sticker && <Tail mine={mine} />}
        {showSender && group && !mine && (
          <p
            className="truncate px-1 pb-0.5 text-[0.82rem] font-semibold"
            style={{ color: nameColor(message.sender.id) }}
          >
            {message.sender.displayName}
          </p>
        )}
        {message.forwarded && (
          <p className={cx('flex items-center gap-1 px-1 text-xs italic', metaColor)}>
            <Forward className="size-3.5" aria-hidden /> Forwarded
          </p>
        )}
        {message.replyTo && (
          <div className="mb-1 overflow-hidden rounded-md border-l-4 border-brand bg-black/5 px-2.5 py-1.5 text-[0.85rem] dark:bg-black/20">
            <p className="font-semibold text-brand">{message.replyTo.senderDisplayName}</p>
            <p className={cx('line-clamp-2', metaColor)}>
              {message.replyTo.deleted ? 'This message was deleted' : message.replyTo.bodyPreview}
            </p>
          </div>
        )}
        {!message.deleted && message.attachment && message.kind === 'AUDIO' && (
          <AudioMessage
            attachment={message.attachment}
            meta={meta?.type === 'audio' ? meta : null}
            mine={mine}
            senderName={message.sender.displayName}
          />
        )}
        {!message.deleted && message.attachment && message.kind !== 'AUDIO' && message.kind !== 'STICKER' && (
          <div className="-mx-0.5 mb-0.5">
            <AttachmentView attachment={message.attachment} />
          </div>
        )}
        {meta?.type === 'location' && <LocationMessage message={message} meta={meta} mine={mine} />}
        {meta?.type === 'contact' && <ContactMessage message={message} meta={meta} mine={mine} />}
        {meta?.type === 'poll' && (
          <PollMessage message={message} meta={meta} myId={myId} nameOf={nameOf} />
        )}
        {meta?.type === 'event' && <EventMessage message={message} meta={meta} myId={myId} />}
        {meta?.type === 'call' && <CallMessage message={message} meta={meta} myId={myId} />}
        {meta?.type === 'sticker' && <StickerMessage meta={meta} attachment={message.attachment} />}
        {rich ? (
          <div className="h-4" aria-hidden />
        ) : message.deleted ? (
          <p className={cx('flex items-center gap-1.5 px-1 italic', metaColor)}>
            <Ban className="size-4" aria-hidden />
            This message was deleted
            <span aria-hidden className="inline-block" style={{ width: metaWidth }} />
          </p>
        ) : message.body ? (
          <p className="px-1 leading-[1.35] break-words whitespace-pre-wrap">
            {message.body}
            <span aria-hidden className="inline-block" style={{ width: metaWidth }} />
          </p>
        ) : (
          <div className="h-3.5" aria-hidden />
        )}

        <span
          className={cx(
            'absolute right-2 bottom-1 flex items-center gap-1 text-[0.7rem] leading-none',
            metaColor,
          )}
        >
          {message.expiresAt && <Timer className="size-3" aria-label="Disappearing message" />}
          {message.pinned && <Pin className="size-3" aria-label="Pinned" />}
          {message.starred && <Star className="size-3" aria-label="Starred" />}
          {edited && <span>Edited</span>}
          <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
          {statusInfo && (
            <span className={cx('flex items-center', statusInfo.cls)}>
              <statusInfo.Icon className="size-4" aria-hidden />
              <span className="sr-only">{statusInfo.label}</span>
            </span>
          )}
        </span>

        {!message.local && (
          <MessageMenu message={message} mine={mine} myReaction={myReaction} actions={actions} />
        )}

        {message.local === 'failed' && (
          <button
            type="button"
            onClick={() => actions.onRetry(message)}
            className="mt-1 flex min-h-9 items-center gap-1 px-1 text-sm font-semibold text-danger underline"
          >
            <RotateCcw className="size-4" aria-hidden /> Not sent — tap to retry
          </button>
        )}

        {hasReactions && (
          <div
            className={cx(
              'wa-bubble absolute -bottom-4 flex items-center gap-0.5 rounded-full border border-wa-divider bg-wa-chip px-1 py-0.5',
              mine ? 'right-3' : 'left-3',
            )}
          >
            {Object.entries(reactionCounts).map(([emoji, count]) => (
              <button
                key={emoji}
                type="button"
                onClick={() => actions.onReact(message, myReaction === emoji ? null : emoji)}
                aria-pressed={myReaction === emoji}
                aria-label={`${emoji} ${count}${myReaction === emoji ? ', your reaction' : ''}`}
                className={cx(
                  'flex h-6 items-center gap-0.5 rounded-full px-1 text-sm leading-none',
                  myReaction === emoji && 'bg-brand-soft',
                )}
              >
                {emoji}
                {count > 1 && <span className="text-xs text-wa-chip-text">{count}</span>}
              </button>
            ))}
          </div>
        )}
      </article>
    </div>
  );
}

function MessageMenu({
  message,
  mine,
  myReaction,
  actions,
}: {
  message: MessageDto;
  mine: boolean;
  myReaction: string | null;
  actions: BubbleActions;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // The menu renders in a portal with fixed positioning so virtualised rows cannot clip it.
  useLayoutEffect(() => {
    if (!open || !buttonRef.current || !menuRef.current) return;
    const anchor = buttonRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const margin = 8;
    const below = anchor.bottom + 4;
    const top =
      below + menu.height > window.innerHeight - margin
        ? Math.max(margin, anchor.top - menu.height - 4)
        : below;
    const preferredLeft = mine ? anchor.right - menu.width : anchor.left;
    const left = Math.min(Math.max(margin, preferredLeft), window.innerWidth - menu.width - margin);
    setPosition({ top, left });
  }, [open, mine]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const onScroll = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScroll);
    document.addEventListener('scroll', onScroll, true);
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('scroll', onScroll, true);
      setPosition(null);
    };
  }, [open]);

  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  const item = 'flex min-h-11 w-full items-center gap-3 px-4 text-left hover:bg-wa-hover';
  return (
    <div ref={ref} className="absolute top-0.5 right-0.5">
      {/* Hover chevron (always visible on touch screens), as in WhatsApp Web. */}
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Message options"
        title="Message options"
        onClick={() => setOpen((v) => !v)}
        style={{ background: `var(${mine ? '--wa-out' : '--wa-in'})` }}
        className={cx(
          'inline-flex size-7 items-center justify-center rounded-full transition-opacity',
          mine ? 'text-wa-meta-out' : 'text-wa-meta-in',
          open
            ? 'opacity-100'
            : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-80',
        )}
      >
        <ChevronDown className="size-5" aria-hidden />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="Message options"
            style={{
              position: 'fixed',
              top: position?.top ?? -9999,
              left: position?.left ?? -9999,
            }}
            className="z-50 w-60 rounded-lg bg-surface py-2 text-fg shadow-pop"
          >
            {!message.deleted && (
              <>
                <div className="mb-1 flex justify-between px-2" aria-label="React">
                  {QUICK_REACTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      role="menuitem"
                      aria-label={`React with ${emoji}`}
                      aria-pressed={myReaction === emoji}
                      onClick={run(() =>
                        actions.onReact(message, myReaction === emoji ? null : emoji),
                      )}
                      className={cx(
                        'size-9 rounded-full text-xl hover:bg-wa-hover',
                        myReaction === emoji && 'bg-wa-active',
                      )}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  role="menuitem"
                  className={item}
                  onClick={run(() => actions.onReply(message))}
                >
                  <Reply className="size-5 text-wa-icon" aria-hidden /> Reply
                </button>
                {message.kind !== 'POLL' && message.kind !== 'CALL' && (
                  <button
                    type="button"
                    role="menuitem"
                    className={item}
                    onClick={run(() => actions.onForward(message))}
                  >
                    <Forward className="size-5 text-wa-icon" aria-hidden /> Forward
                  </button>
                )}
                {TEXT_KINDS.has(message.kind) && message.body && (
                  <button
                    type="button"
                    role="menuitem"
                    className={item}
                    onClick={run(() => void copyText(message.body ?? ''))}
                  >
                    <Copy className="size-5 text-wa-icon" aria-hidden /> Copy
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className={item}
                  onClick={run(() => actions.onStar(message, !message.starred))}
                >
                  {message.starred ? (
                    <StarOff className="size-5 text-wa-icon" aria-hidden />
                  ) : (
                    <Star className="size-5 text-wa-icon" aria-hidden />
                  )}
                  {message.starred ? 'Unstar' : 'Star'}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={item}
                  onClick={run(() => actions.onPin(message, !message.pinned))}
                >
                  {message.pinned ? (
                    <PinOff className="size-5 text-wa-icon" aria-hidden />
                  ) : (
                    <Pin className="size-5 text-wa-icon" aria-hidden />
                  )}
                  {message.pinned ? 'Unpin' : 'Pin'}
                </button>
                {mine && (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      className={item}
                      onClick={run(() => actions.onInfo(message))}
                    >
                      <Info className="size-5 text-wa-icon" aria-hidden /> Message info
                    </button>
                    {TEXT_KINDS.has(message.kind) && (
                      <button
                        type="button"
                        role="menuitem"
                        className={item}
                        onClick={run(() => actions.onEdit(message))}
                      >
                        <Pencil className="size-5 text-wa-icon" aria-hidden /> Edit
                      </button>
                    )}
                  </>
                )}
              </>
            )}
            <button
              type="button"
              role="menuitem"
              className={cx(item, 'text-danger')}
              onClick={run(() => actions.onDelete(message))}
            >
              <Trash2 className="size-5" aria-hidden /> Delete
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
