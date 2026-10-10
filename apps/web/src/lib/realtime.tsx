'use client';

import {
  REALTIME_NAMESPACE,
  REALTIME_PATH,
  type ClientToServerEvents,
  type ConversationDetailDto,
  type ServerToClientEvents,
} from '@storeline/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { refreshSession } from './api';
import { useAuth } from './auth-store';
import {
  keys,
  lastKnownSeq,
  patchConversation,
  rememberState,
  removeConversation,
  syncAfter,
  upsertConversation,
  upsertMessages,
  type MessageWindow,
} from './chat-cache';
import {
  applyIncidentUpdate,
  AWAITING,
  emergencyKeys,
  sendReceipt,
  useEmergencyAlerts,
} from './emergency';
import { useLive } from './live-store';
import { useMediaStatus } from './media-store';

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const SocketContext = createContext<AppSocket | null>(null);

export function useSocket(): AppSocket | null {
  return useContext(SocketContext);
}

const realtimeUrl = process.env.NEXT_PUBLIC_REALTIME_URL ?? 'http://localhost:4000';

/**
 * Owns the Socket.IO connection and applies server events to the query cache. The socket
 * is only a fast path: after every (re)connect the client resyncs from the REST API by seq.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const token = useAuth((s) => s.accessToken);
  const myId = useAuth((s) => s.me?.user.id);
  const [socket, setSocket] = useState<AppSocket | null>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const signedIn = token !== null;
  useEffect(() => {
    if (!signedIn) return;
    const s: AppSocket = io(`${realtimeUrl}${REALTIME_NAMESPACE}`, {
      path: REALTIME_PATH,
      transports: ['websocket'],
      // Called on every (re)connect so the latest access token is used.
      auth: (cb) => cb({ token: tokenRef.current }),
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 15_000,
    });
    const live = useLive.getState();
    let receiptRefresh: ReturnType<typeof setTimeout> | null = null;

    s.on('connect', () => {
      live.setConnected(true);
      // Resync anything missed while disconnected (including emergency alerts).
      void client.invalidateQueries({ queryKey: keys.conversations });
      void client.invalidateQueries({ queryKey: emergencyKeys.all });
      for (const query of client.getQueryCache().findAll({ queryKey: ['messages'] })) {
        const conversationId = query.queryKey[1] as string;
        void syncAfter(client, conversationId).catch(() => undefined);
      }
    });
    s.on('disconnect', () => live.setConnected(false));
    s.on('connect_error', (error) => {
      live.setConnected(false);
      if (error.message === 'UNAUTHENTICATED') {
        void refreshSession().then((result) => {
          if (result === 'invalid') useAuth.getState().clear();
        });
      }
    });

    s.on('message.created', (message) => {
      const window = client.getQueryData<MessageWindow>(keys.messages(message.conversationId));
      if (window && message.seq > lastKnownSeq(window) + 1) {
        // Gap detected: fetch the missing range from the server.
        void syncAfter(client, message.conversationId);
      } else {
        upsertMessages(client, message.conversationId, [message]);
      }
      const mine = message.sender.id === useAuth.getState().me?.user.id;
      const open =
        useLive.getState().openConversationId === message.conversationId &&
        document.visibilityState === 'visible';
      if (!mine) {
        s.emit(
          'message.delivered',
          { conversationId: message.conversationId, seq: message.seq },
          () => undefined,
        );
        if (open)
          s.emit(
            'message.read',
            { conversationId: message.conversationId, seq: message.seq },
            () => undefined,
          );
      }
      let known = false;
      patchConversation(client, message.conversationId, (c) => {
        known = true;
        return {
          ...c,
          lastMessage: message,
          lastSeq: Math.max(c.lastSeq, message.seq),
          lastActivityAt: message.createdAt,
          unreadCount: mine || open ? c.unreadCount : c.unreadCount + 1,
          lastMessageStatus: mine && message.state === 'DISPATCHED' ? 'SENT' : null,
        };
      });
      if (!known) void client.invalidateQueries({ queryKey: keys.conversations });
      useLive
        .getState()
        .setTyping(message.conversationId, message.sender.id, message.sender.displayName, false);
    });

    s.on('message.updated', (message) => {
      upsertMessages(client, message.conversationId, [message]);
      patchConversation(client, message.conversationId, (c) =>
        c.lastMessage?.id === message.id ? { ...c, lastMessage: message } : c,
      );
    });

    s.on('message.status_changed', (event) => {
      if (event.state === 'DISPATCHED') {
        patchConversation(client, event.conversationId, (c) =>
          c.lastMessage?.id === event.messageId && !c.lastMessageStatus
            ? { ...c, lastMessageStatus: 'SENT' }
            : c,
        );
      }
      rememberState(event.messageId, event.state);
      client.setQueryData<MessageWindow>(keys.messages(event.conversationId), (w) =>
        w
          ? {
              ...w,
              items: w.items.map((m) =>
                m.id === event.messageId ? { ...m, state: event.state } : m,
              ),
            }
          : w,
      );
    });

    s.on('receipt.updated', (event) => {
      // Ticks in the chat list depend on every member's receipts; refresh the list (debounced).
      if (receiptRefresh) clearTimeout(receiptRefresh);
      receiptRefresh = setTimeout(
        () => void client.invalidateQueries({ queryKey: keys.conversations }),
        1500,
      );
      client.setQueryData<ConversationDetailDto>(
        keys.conversation(event.conversationId),
        (detail) =>
          detail
            ? {
                ...detail,
                members: detail.members.map((m) =>
                  m.user.id === event.userId
                    ? {
                        ...m,
                        lastDeliveredSeq: event.lastDeliveredSeq,
                        lastReadSeq: event.lastReadSeq,
                      }
                    : m,
                ),
              }
            : detail,
      );
    });

    s.on('conversation.updated', (summary) => {
      upsertConversation(client, summary);
      void client.invalidateQueries({ queryKey: keys.conversation(summary.id) });
    });
    s.on('conversation.removed', ({ conversationId }) =>
      removeConversation(client, conversationId),
    );
    s.on('conversation.unread_count', (event) =>
      patchConversation(client, event.conversationId, (c) => ({
        ...c,
        unreadCount: event.unreadCount,
        me: { ...c.me, lastReadSeq: event.lastReadSeq, markedUnread: false },
      })),
    );
    s.on('typing.changed', (event) =>
      useLive
        .getState()
        .setTyping(event.conversationId, event.userId, event.displayName, event.typing),
    );
    s.on('presence.changed', (event) =>
      useLive.getState().setPresence(event.userId, event.online, event.lastSeenAt),
    );
    s.on('session.revoked', () => useAuth.getState().clear());
    s.on('media.status_changed', (media) => useMediaStatus.getState().set(media));
    s.on('emergency.alert_created', (incident) => {
      // Confirms delivery to this device; "seen" is only sent when the person opens it.
      sendReceipt(incident.id, 'DELIVERED');
      useEmergencyAlerts.getState().push(incident);
      applyIncidentUpdate(client, incident);
    });
    s.on('emergency.incident_updated', (incident) => {
      applyIncidentUpdate(client, incident);
      if (!AWAITING.includes(incident.status)) useEmergencyAlerts.getState().remove(incident.id);
    });

    setSocket(s);
    return () => {
      s.removeAllListeners();
      s.disconnect();
      setSocket(null);
      live.setConnected(false);
    };
  }, [signedIn, client, myId]);

  return <SocketContext.Provider value={socket}>{children}</SocketContext.Provider>;
}
