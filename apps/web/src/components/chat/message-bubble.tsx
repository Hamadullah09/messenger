'use client';

import type { MessageDto } from '@storeline/shared';
import {
  AlertCircle,
  Check,
  CheckCheck,
  Clock,
  Copy,
  Forward,
  Info,
  MoreVertical,
  Pencil,
  Pin,
  PinOff,
  Reply,
  RotateCcw,
  Star,
  StarOff,
  Trash2,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ClientMessage } from '@/lib/chat-cache';
import { describeSystemEvent, formatTime } from '@/lib/format';
import { Avatar, cx } from '../ui';
import { AttachmentView } from './attachment-view';

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

const STATUS: Record<DeliveryStatus, { label: string; Icon: typeof Check; cls: string }> = {
  sending: { label: 'Sending', Icon: Clock, cls: 'text-muted' },
  queued: { label: 'Queued', Icon: Clock, cls: 'text-muted' },
  failed: { label: 'Not sent', Icon: AlertCircle, cls: 'text-danger' },
  sent: { label: 'Sent', Icon: Check, cls: 'text-muted' },
  delivered: { label: 'Delivered', Icon: CheckCheck, cls: 'text-muted' },
  read: { label: 'Read', Icon: CheckCheck, cls: 'text-brand' },
};

export function MessageBubble({
  message,
  mine,
  showSender,
  status,
  myId,
  nameOf,
  actions,
  canModerate,
}: {
  message: ClientMessage;
  mine: boolean;
  showSender: boolean;
  status: DeliveryStatus | null;
  myId: string;
  nameOf: (id: string) => string;
  actions: BubbleActions;
  canModerate: boolean;
}) {
  if (message.kind === 'SYSTEM' && message.systemEvent) {
    return (
      <div className="flex justify-center px-4 py-2">
        <p className="rounded-full bg-surface-2 px-4 py-1.5 text-center text-sm text-muted">
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
  const statusInfo = status ? STATUS[status] : null;
  const senderName = mine ? 'You' : message.sender.displayName;

  return (
    <div
      className={cx(
        'group flex gap-2.5 px-3 sm:px-6',
        showSender ? 'pt-4' : 'pt-1',
        mine && 'flex-row-reverse',
      )}
    >
      {/* Avatar column keeps every bubble of a group aligned */}
      <div className={cx('w-9 shrink-0', mine && 'hidden sm:block')}>
        {showSender && !mine && <Avatar name={message.sender.displayName} size={36} />}
      </div>
      <div
        className={cx(
          'flex max-w-[85%] min-w-0 flex-col sm:max-w-[70%]',
          mine ? 'items-end' : 'items-start',
        )}
      >
        {showSender && (
          <p
            className={cx(
              'mb-1.5 flex items-baseline gap-2 px-1 text-sm',
              mine && 'flex-row-reverse',
            )}
          >
            <span className="font-semibold">{senderName}</span>
            <time dateTime={message.createdAt} className="text-xs text-muted">
              {formatTime(message.createdAt)}
            </time>
          </p>
        )}
        <div className={cx('flex max-w-full items-start gap-1', mine && 'flex-row-reverse')}>
          <article
            aria-label={`${senderName} at ${formatTime(message.createdAt)}`}
            className={cx(
              'relative max-w-full min-w-24 rounded-2xl px-4 py-2.5',
              mine ? 'rounded-tr-md bg-bubble-out' : 'rounded-tl-md bg-bubble-in',
              message.local === 'failed' && 'border-2 border-danger',
            )}
          >
            {message.forwarded && (
              <p className="flex items-center gap-1 text-sm text-muted italic">
                <Forward className="size-4" aria-hidden /> Forwarded
              </p>
            )}
            {message.replyTo && (
              <div className="mb-1.5 rounded-xl border-l-4 border-brand bg-surface px-3 py-1.5 text-sm">
                <p className="font-bold text-brand">{message.replyTo.senderDisplayName}</p>
                <p className="line-clamp-2 text-muted">
                  {message.replyTo.deleted
                    ? 'This message was deleted'
                    : message.replyTo.bodyPreview}
                </p>
              </div>
            )}
            {!message.deleted && message.attachment && (
              <AttachmentView attachment={message.attachment} />
            )}
            {message.deleted ? (
              <p className="text-muted italic">This message was deleted</p>
            ) : (
              message.body && (
                <p className="text-[1.02rem] leading-relaxed break-words whitespace-pre-wrap">
                  {message.body}
                </p>
              )
            )}
            <p className="mt-1 flex items-center justify-end gap-1 text-xs text-muted">
              {message.pinned && <Pin className="size-3.5" aria-label="Pinned" />}
              {message.starred && <Star className="size-3.5" aria-label="Starred" />}
              {message.editedAt && !message.deleted && <span>Edited ·</span>}
              {!showSender && (
                <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
              )}
              {mine && statusInfo && (
                <span className={cx('flex items-center gap-0.5', statusInfo.cls)}>
                  <statusInfo.Icon className="size-4" aria-hidden />
                  <span className="sr-only">{statusInfo.label}</span>
                </span>
              )}
            </p>
            {message.local === 'failed' && (
              <button
                type="button"
                onClick={() => actions.onRetry(message)}
                className="mt-1 flex min-h-10 items-center gap-1 font-semibold text-danger underline"
              >
                <RotateCcw className="size-4" aria-hidden /> Not sent — tap to retry
              </button>
            )}
            {Object.keys(reactionCounts).length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {Object.entries(reactionCounts).map(([emoji, count]) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => actions.onReact(message, myReaction === emoji ? null : emoji)}
                    aria-pressed={myReaction === emoji}
                    aria-label={`${emoji} ${count}${myReaction === emoji ? ', your reaction' : ''}`}
                    className={cx(
                      'min-h-8 rounded-full border px-2.5 text-sm',
                      myReaction === emoji
                        ? 'border-brand bg-brand-soft'
                        : 'border-line bg-surface',
                    )}
                  >
                    {emoji} {count}
                  </button>
                ))}
              </div>
            )}
          </article>
          {!message.local && !message.deleted && (
            <MessageMenu
              message={message}
              mine={mine}
              myReaction={myReaction}
              actions={actions}
              canModerate={canModerate}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function MessageMenu({
  message,
  mine,
  myReaction,
  actions,
  canModerate,
}: {
  message: MessageDto;
  mine: boolean;
  myReaction: string | null;
  actions: BubbleActions;
  canModerate: boolean;
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

  const item =
    'flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left font-semibold hover:bg-surface-2';
  return (
    <div ref={ref} className="relative self-center">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Message options"
        title="Message options"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex size-11 items-center justify-center rounded-full text-muted opacity-70 group-hover:opacity-100 hover:bg-surface-2 focus:opacity-100"
      >
        <MoreVertical className="size-5" aria-hidden />
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
            className="z-50 w-64 rounded-xl border border-line bg-surface p-2 text-fg shadow-lg"
          >
            <div className="mb-2 flex flex-wrap gap-1" aria-label="React">
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  role="menuitem"
                  aria-label={`React with ${emoji}`}
                  aria-pressed={myReaction === emoji}
                  onClick={run(() => actions.onReact(message, myReaction === emoji ? null : emoji))}
                  className={cx(
                    'size-11 rounded-full text-xl hover:bg-surface-2',
                    myReaction === emoji && 'bg-surface-3',
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
              <Reply className="size-5" aria-hidden /> Reply
            </button>
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={run(() => actions.onForward(message))}
            >
              <Forward className="size-5" aria-hidden /> Forward
            </button>
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={run(() => void navigator.clipboard?.writeText(message.body ?? ''))}
            >
              <Copy className="size-5" aria-hidden /> Copy text
            </button>
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={run(() => actions.onStar(message, !message.starred))}
            >
              {message.starred ? (
                <StarOff className="size-5" aria-hidden />
              ) : (
                <Star className="size-5" aria-hidden />
              )}
              {message.starred ? 'Remove star' : 'Star'}
            </button>
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={run(() => actions.onPin(message, !message.pinned))}
            >
              {message.pinned ? (
                <PinOff className="size-5" aria-hidden />
              ) : (
                <Pin className="size-5" aria-hidden />
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
                  <Info className="size-5" aria-hidden /> Message info
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={item}
                  onClick={run(() => actions.onEdit(message))}
                >
                  <Pencil className="size-5" aria-hidden /> Edit
                </button>
              </>
            )}
            {(mine || canModerate) && (
              <button
                type="button"
                role="menuitem"
                className={cx(item, 'text-danger')}
                onClick={run(() => actions.onDelete(message))}
              >
                <Trash2 className="size-5" aria-hidden /> Delete for everyone
              </button>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
