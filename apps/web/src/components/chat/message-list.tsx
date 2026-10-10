'use client';

import type { ConversationDetailDto } from '@storeline/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, Check, CheckCheck, ChevronsUp } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ClientMessage } from '@/lib/chat-cache';
import { formatDay, sameDay } from '@/lib/format';
import { Button, cx, EmptyState } from '../ui';
import { MessageBubble, type BubbleActions, type DeliveryStatus } from './message-bubble';

type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'unread'; key: string }
  | { kind: 'message'; key: string; message: ClientMessage; showSender: boolean }
  | { kind: 'receipt'; key: string; message: ClientMessage };

const NEAR_BOTTOM_PX = 160;

/**
 * Virtualised message history: only visible rows are in the DOM, so long histories stay
 * fast. Older pages load on request (an explicit button is easier for everyone than
 * infinite scroll), and the view sticks to the bottom while the user is reading the latest.
 */
export function MessageList({
  conversation,
  messages,
  hasMoreBefore,
  loadingOlder,
  onLoadOlder,
  myId,
  nameOf,
  actions,
  canModerate,
  firstUnreadSeq,
}: {
  conversation: ConversationDetailDto | undefined;
  messages: ClientMessage[];
  hasMoreBefore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  myId: string;
  nameOf: (id: string) => string;
  actions: BubbleActions;
  canModerate: boolean;
  firstUnreadSeq: number | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let previous: ClientMessage | undefined;
    for (const message of messages) {
      if (!previous || !sameDay(previous.createdAt, message.createdAt)) {
        out.push({
          kind: 'day',
          key: `day-${message.createdAt.slice(0, 10)}-${message.id}`,
          label: formatDay(message.createdAt),
        });
      }
      if (firstUnreadSeq !== null && !message.local && message.seq === firstUnreadSeq) {
        out.push({ kind: 'unread', key: 'unread-marker' });
      }
      // A new group starts with a different sender, after a system note, or after 5 minutes.
      const showSender =
        !previous ||
        previous.sender.id !== message.sender.id ||
        previous.kind === 'SYSTEM' ||
        Date.parse(message.createdAt) - Date.parse(previous.createdAt) > 5 * 60_000 ||
        !sameDay(previous.createdAt, message.createdAt);
      out.push({ kind: 'message', key: message.clientMessageId, message, showSender });
      previous = message;
    }
    // "Seen" / "Delivered" under the newest message, as in familiar messaging apps.
    const newest = messages.at(-1);
    if (newest && newest.sender.id === myId && newest.kind !== 'SYSTEM' && !newest.local) {
      out.push({ kind: 'receipt', key: `receipt-${newest.id}`, message: newest });
    }
    return out;
  }, [messages, firstUnreadSeq, myId]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === 'message' ? 76 : 44),
    getItemKey: (i) => rows[i]!.key,
    overscan: 12,
  });

  // Keep the oldest visible message anchored when older pages are prepended.
  const firstKeyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const previousFirst = firstKeyRef.current;
    firstKeyRef.current = rows[0]?.key ?? null;
    if (previousFirst && rows[0]?.key !== previousFirst) {
      const index = rows.findIndex((r) => r.key === previousFirst);
      if (index > 0) virtualizer.scrollToIndex(index, { align: 'start' });
    }
  }, [rows, virtualizer]);

  // Stick to the bottom for new messages (and on first load).
  const lastKey = rows.at(-1)?.key;
  useEffect(() => {
    if (atBottom && rows.length > 0) virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the newest row changes
  }, [lastKey]);

  const status = (message: ClientMessage): DeliveryStatus | null => {
    if (message.sender.id !== myId || message.kind === 'SYSTEM') return null;
    if (message.local) return message.local;
    if (message.state === 'FAILED') return 'failed';
    const others = conversation?.members.filter((m) => m.user.id !== myId) ?? [];
    if (
      others.length > 0 &&
      conversation?.readReceiptsEnabled &&
      others.every((m) => (m.lastReadSeq ?? 0) >= message.seq)
    )
      return 'read';
    if (others.length > 0 && others.every((m) => m.lastDeliveredSeq >= message.seq))
      return 'delivered';
    return message.state === 'DISPATCHED' ? 'sent' : 'queued';
  };

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center bg-chat">
        <EmptyState title="No messages yet">
          Say hello! Type a message below and press Send.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1 bg-chat">
      <div
        ref={scrollRef}
        className="scroll-thin h-full overflow-y-auto pb-4"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Messages"
        onScroll={(e) => {
          const el = e.currentTarget;
          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX);
        }}
      >
        {hasMoreBefore && (
          <div className="flex justify-center p-3">
            <Button
              variant="secondary"
              busy={loadingOlder}
              onClick={onLoadOlder}
              icon={<ChevronsUp className="size-5" aria-hidden />}
            >
              Load earlier messages
            </Button>
          </div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]!;
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {row.kind === 'day' && (
                  <div className="flex justify-center py-2">
                    <span className="rounded-full border border-line bg-surface px-4 py-1 text-sm font-semibold text-muted">
                      {row.label}
                    </span>
                  </div>
                )}
                {row.kind === 'unread' && (
                  <div className="my-2 flex items-center gap-3 px-6" role="separator">
                    <span className="h-0.5 flex-1 bg-brand" />
                    <span className="text-sm font-bold text-brand">Unread messages</span>
                    <span className="h-0.5 flex-1 bg-brand" />
                  </div>
                )}
                {row.kind === 'receipt' && <ReceiptLine status={status(row.message)} />}
                {row.kind === 'message' && (
                  <MessageBubble
                    message={row.message}
                    mine={row.message.sender.id === myId}
                    showSender={row.showSender}
                    status={status(row.message)}
                    myId={myId}
                    nameOf={nameOf}
                    actions={actions}
                    canModerate={canModerate}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {!atBottom && (
        <Button
          variant="secondary"
          className="absolute right-4 bottom-4 shadow-md"
          onClick={() => virtualizer.scrollToIndex(rows.length - 1, { align: 'end' })}
          icon={<ArrowDown className="size-5" aria-hidden />}
        >
          Latest
        </Button>
      )}
    </div>
  );
}

const RECEIPT_TEXT: Partial<Record<DeliveryStatus, string>> = {
  read: 'Seen',
  delivered: 'Delivered',
  sent: 'Sent',
  queued: 'Sending…',
};

function ReceiptLine({ status }: { status: DeliveryStatus | null }) {
  const text = status ? RECEIPT_TEXT[status] : undefined;
  if (!text) return null;
  const Icon = status === 'read' || status === 'delivered' ? CheckCheck : Check;
  return (
    <p
      className={cx(
        'flex items-center justify-end gap-1 px-6 pt-1 text-sm font-medium',
        status === 'read' ? 'text-brand' : 'text-muted',
      )}
    >
      <Icon className="size-4" aria-hidden />
      {text}
    </p>
  );
}
