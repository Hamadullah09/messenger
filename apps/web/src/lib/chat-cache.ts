'use client';

import type {
  MessageState,
  ConversationDetailDto,
  ConversationSummaryDto,
  MessageDto,
  MessagePageDto,
  Page,
  RichContent,
} from '@storeline/shared';
import type { QueryClient } from '@tanstack/react-query';
import { api } from './api';

/** A message as the client knows it: server state plus local sending/failed state. */
export type ClientMessage = MessageDto & {
  local?: 'sending' | 'failed';
  /** Structured content still to be sent (kept for retries). */
  pendingContent?: RichContent;
};

export interface MessageWindow {
  items: ClientMessage[];
  hasMoreBefore: boolean;
}

export const keys = {
  conversations: ['conversations'] as const,
  conversation: (id: string) => ['conversation', id] as const,
  messages: (id: string) => ['messages', id] as const,
};

export function fetchConversations(): Promise<ConversationSummaryDto[]> {
  return api<Page<ConversationSummaryDto>>('/conversations', { query: { limit: 100 } }).then(
    (p) => p.items,
  );
}

export async function fetchLatestMessages(conversationId: string): Promise<MessageWindow> {
  const page = await api<MessagePageDto>(`/conversations/${conversationId}/messages`, {
    query: { limit: 50 },
  });
  return { items: page.items, hasMoreBefore: page.hasMoreBefore };
}

const STATE_RANK: Record<MessageState, number> = { ACCEPTED: 0, FAILED: 1, DISPATCHED: 2 };

/**
 * Status events can overtake the HTTP response or the message.created event for the same
 * message, so the latest known state per message id is remembered and state never moves
 * backwards (ACCEPTED → DISPATCHED).
 */
const knownStates = new Map<string, MessageState>();

export function rememberState(messageId: string, state: MessageState): void {
  const current = knownStates.get(messageId);
  if (!current || STATE_RANK[state] >= STATE_RANK[current]) knownStates.set(messageId, state);
  if (knownStates.size > 5000) knownStates.delete(knownStates.keys().next().value!);
}

function bestState(...states: Array<MessageState | undefined>): MessageState {
  return states.reduce<MessageState>(
    (best, s) => (s && STATE_RANK[s] > STATE_RANK[best] ? s : best),
    'ACCEPTED',
  );
}

/** Merge messages by id, keep ascending seq order; local (unsent) messages stay at the end. */
export function mergeMessages(
  existing: ClientMessage[],
  incoming: ClientMessage[],
): ClientMessage[] {
  const byClientId = new Map(existing.map((m) => [m.clientMessageId, m]));
  for (const message of incoming) {
    const current = byClientId.get(message.clientMessageId);
    // Never let a stale event overwrite a newer edit/delete.
    if (
      current &&
      !current.local &&
      current.editedAt &&
      message.editedAt &&
      current.editedAt > message.editedAt
    )
      continue;
    const state = message.local
      ? message.state
      : bestState(
          message.state,
          current && !current.local ? current.state : undefined,
          knownStates.get(message.id),
        );
    byClientId.set(message.clientMessageId, { ...message, state });
  }
  return [...byClientId.values()].sort((a, b) => {
    if (a.local && !b.local) return 1;
    if (!a.local && b.local) return -1;
    if (a.local && b.local) return a.createdAt.localeCompare(b.createdAt);
    return a.seq - b.seq;
  });
}

export function lastKnownSeq(window: MessageWindow | undefined): number {
  return window?.items.reduce((max, m) => (m.local ? max : Math.max(max, m.seq)), 0) ?? 0;
}

/** Messages this user deleted "for me" in this session (later updates must not bring them back). */
const hiddenIds = new Set<string>();

export function upsertMessages(
  client: QueryClient,
  conversationId: string,
  messages: ClientMessage[],
): void {
  const visible = messages.filter((m) => !hiddenIds.has(m.id));
  if (visible.length === 0) return;
  client.setQueryData<MessageWindow>(keys.messages(conversationId), (current) =>
    current ? { ...current, items: mergeMessages(current.items, visible) } : current,
  );
}

/** "Delete for me": drop the message from this device's view. */
export function hideMessage(client: QueryClient, conversationId: string, messageId: string): void {
  hiddenIds.add(messageId);
  client.setQueryData<MessageWindow>(keys.messages(conversationId), (current) =>
    current ? { ...current, items: current.items.filter((m) => m.id !== messageId) } : current,
  );
  patchConversation(client, conversationId, (c) =>
    c.lastMessage?.id === messageId ? { ...c, lastMessage: null, lastMessageStatus: null } : c,
  );
}

/** Fetches everything after the last known seq (gap recovery after reconnects or missed events). */
export async function syncAfter(client: QueryClient, conversationId: string): Promise<void> {
  const window = client.getQueryData<MessageWindow>(keys.messages(conversationId));
  if (!window) return;
  let after = lastKnownSeq(window);
  for (let i = 0; i < 20; i++) {
    const page = await api<MessagePageDto>(`/conversations/${conversationId}/messages`, {
      query: { afterSeq: after, limit: 100 },
    });
    upsertMessages(client, conversationId, page.items);
    if (!page.hasMoreAfter || page.items.length === 0) break;
    after = page.items.at(-1)!.seq;
  }
}

export function upsertConversation(client: QueryClient, summary: ConversationSummaryDto): void {
  client.setQueryData<ConversationSummaryDto[]>(keys.conversations, (list) => {
    if (!list) return list;
    const others = list.filter((c) => c.id !== summary.id);
    return [summary, ...others];
  });
  client.setQueryData<ConversationDetailDto>(keys.conversation(summary.id), (detail) =>
    detail ? { ...detail, ...summary } : detail,
  );
}

export function patchConversation(
  client: QueryClient,
  conversationId: string,
  patch: (c: ConversationSummaryDto) => ConversationSummaryDto,
): void {
  client.setQueryData<ConversationSummaryDto[]>(keys.conversations, (list) =>
    list?.map((c) => (c.id === conversationId ? patch(c) : c)),
  );
}

export function removeConversation(client: QueryClient, conversationId: string): void {
  client.setQueryData<ConversationSummaryDto[]>(keys.conversations, (list) =>
    list?.filter((c) => c.id !== conversationId),
  );
  client.removeQueries({ queryKey: keys.conversation(conversationId) });
  client.removeQueries({ queryKey: keys.messages(conversationId) });
}

/** Pinned first, then most recent activity. */
export function sortConversations(list: ConversationSummaryDto[]): ConversationSummaryDto[] {
  return [...list].sort((a, b) => {
    const pa = a.me.pinnedAt ?? '';
    const pb = b.me.pinnedAt ?? '';
    if (pa !== pb) return pb.localeCompare(pa);
    return b.lastActivityAt.localeCompare(a.lastActivityAt);
  });
}
