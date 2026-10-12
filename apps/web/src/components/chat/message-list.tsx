'use client';

import type { ConversationDetailDto } from '@storeline/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronsUp } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ClientMessage } from '@/lib/chat-cache';
import { FONT_SIZES, useChatPrefs, WALLPAPERS } from '@/lib/chat-prefs';
import { resolvedTheme, useTheme } from '@/lib/theme';
import { formatDay, sameDay } from '@/lib/format';
import { Button } from '../ui';
import { MessageBubble, type BubbleActions, type DeliveryStatus } from './message-bubble';

type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'unread'; key: string }
  | { kind: 'message'; key: string; message: ClientMessage; showSender: boolean };

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
  const wallpaper = useChatPrefs((p) => p.wallpaper);
  const fontSize = useChatPrefs((p) => p.fontSize);
  const [theme] = useTheme();
  const paper = WALLPAPERS[wallpaper];
  // Chat wallpaper and text size from Settings → Chats (this device only).
  const backdrop = {
    ...(wallpaper === 'doodle'
      ? {}
      : {
          backgroundImage: 'none',
          backgroundColor: resolvedTheme(theme) === 'dark' ? paper.dark : paper.light,
        }),
    '--chat-font': `${FONT_SIZES[fontSize].px}px`,
  } as CSSProperties;
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
    return out;
  }, [messages, firstUnreadSeq]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === 'message' ? 64 : 44),
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
      <div className="wa-wallpaper flex flex-1 items-center justify-center p-4" style={backdrop}>
        <p className="wa-bubble max-w-sm rounded-lg bg-wa-chip px-4 py-2 text-center text-sm text-wa-chip-text">
          <span className="font-semibold">No messages yet.</span> Say hello! Type a message below
          and press Send.
        </p>
      </div>
    );
  }

  return (
    <div className="wa-wallpaper relative min-h-0 flex-1" style={backdrop}>
      <div
        ref={scrollRef}
        className="scroll-thin h-full overflow-y-auto pt-2 pb-5"
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
                  <div className="flex justify-center pt-3 pb-1">
                    <span className="wa-bubble rounded-lg bg-wa-chip px-3 py-1.5 text-[0.8rem] font-medium text-wa-chip-text uppercase">
                      {row.label}
                    </span>
                  </div>
                )}
                {row.kind === 'unread' && (
                  <div className="my-2 flex justify-center bg-wa-chip/60 py-1" role="separator">
                    <span className="wa-bubble rounded-full bg-wa-chip px-4 py-1 text-[0.8rem] font-semibold text-brand-strong">
                      Unread messages
                    </span>
                  </div>
                )}
                {row.kind === 'message' && (
                  <MessageBubble
                    message={row.message}
                    mine={row.message.sender.id === myId}
                    showSender={row.showSender}
                    group={!!conversation && conversation.type !== 'DIRECT'}
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
        <button
          type="button"
          aria-label="Scroll to latest"
          title="Scroll to latest"
          className="wa-bubble absolute right-5 bottom-4 inline-flex size-11 items-center justify-center rounded-full bg-wa-in text-wa-icon shadow-md hover:text-fg"
          onClick={() => virtualizer.scrollToIndex(rows.length - 1, { align: 'end' })}
        >
          <ChevronDown className="size-6" aria-hidden />
        </button>
      )}
    </div>
  );
}
