'use client';

import { create } from 'zustand';

const TYPING_TIMEOUT_MS = 6_000;

interface LiveState {
  connected: boolean;
  /** conversationId -> userId -> { name, until } */
  typing: Record<string, Record<string, { name: string; until: number }>>;
  presence: Record<string, { online: boolean; lastSeenAt: string | null }>;
  openConversationId: string | null;
  setConnected: (connected: boolean) => void;
  setTyping: (conversationId: string, userId: string, name: string, typing: boolean) => void;
  setPresence: (userId: string, online: boolean, lastSeenAt: string | null) => void;
  setOpenConversation: (id: string | null) => void;
}

/** Ephemeral real-time state (never persisted). */
export const useLive = create<LiveState>((set) => ({
  connected: false,
  typing: {},
  presence: {},
  openConversationId: null,
  setConnected: (connected) => set({ connected }),
  setTyping: (conversationId, userId, name, typing) =>
    set((state) => {
      const current = { ...(state.typing[conversationId] ?? {}) };
      if (typing) current[userId] = { name, until: Date.now() + TYPING_TIMEOUT_MS };
      else delete current[userId];
      return { typing: { ...state.typing, [conversationId]: current } };
    }),
  setPresence: (userId, online, lastSeenAt) =>
    set((state) => ({ presence: { ...state.presence, [userId]: { online, lastSeenAt } } })),
  setOpenConversation: (id) => set({ openConversationId: id }),
}));

export function activeTypers(
  typing: LiveState['typing'],
  conversationId: string,
  now = Date.now(),
): string[] {
  return Object.values(typing[conversationId] ?? {})
    .filter((t) => t.until > now)
    .map((t) => t.name);
}
