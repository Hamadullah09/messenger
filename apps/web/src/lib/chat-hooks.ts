'use client';

import {
  isMediaMimeType,
  mimeTypeFromFileName,
  type ConversationDetailDto,
  type ConversationSummaryDto,
  type MessageDto,
  type MessagePageDto,
} from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UploadItem } from '@/components/chat/upload-tray';
import { api, errorMessage } from './api';
import { useAuth } from './auth-store';
import {
  fetchConversations,
  fetchLatestMessages,
  keys,
  mergeMessages,
  patchConversation,
  upsertMessages,
  type ClientMessage,
  type MessageWindow,
} from './chat-cache';
import { UploadCancelledError, uploadFile } from './uploads';

export function useConversations() {
  const signedIn = useAuth((s) => s.status === 'signed-in');
  return useQuery({ queryKey: keys.conversations, queryFn: fetchConversations, enabled: signedIn });
}

export function useConversationDetail(conversationId: string | null) {
  return useQuery({
    queryKey: keys.conversation(conversationId ?? 'none'),
    queryFn: () => api<ConversationDetailDto>(`/conversations/${conversationId}`),
    enabled: !!conversationId,
  });
}

export function useMessages(conversationId: string | null) {
  return useQuery({
    queryKey: keys.messages(conversationId ?? 'none'),
    queryFn: () => fetchLatestMessages(conversationId!),
    enabled: !!conversationId,
    // Kept current by socket events and seq-based sync; never refetch from scratch.
    staleTime: Infinity,
  });
}

export function useLoadOlder(conversationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const window = client.getQueryData<MessageWindow>(keys.messages(conversationId));
      const oldest = window?.items.find((m) => !m.local)?.seq;
      if (!oldest) return;
      const page = await api<MessagePageDto>(`/conversations/${conversationId}/messages`, {
        query: { beforeSeq: oldest, limit: 50 },
      });
      client.setQueryData<MessageWindow>(keys.messages(conversationId), (w) =>
        w ? { items: mergeMessages(w.items, page.items), hasMoreBefore: page.hasMoreBefore } : w,
      );
    },
  });
}

/**
 * Optimistic, idempotent sending: the message appears immediately with a local state, and
 * retries reuse the same clientMessageId so the server never creates duplicates.
 */
export function useSendMessage(conversationId: string) {
  const client = useQueryClient();
  const me = useAuth((s) => s.me);

  const sendExisting = useCallback(
    async (local: ClientMessage) => {
      upsertMessages(client, conversationId, [{ ...local, local: 'sending' }]);
      try {
        const saved = await api<MessageDto>(`/conversations/${conversationId}/messages`, {
          method: 'POST',
          body: {
            clientMessageId: local.clientMessageId,
            body: local.body,
            replyToId: local.replyTo?.id,
          },
        });
        upsertMessages(client, conversationId, [saved]);
        patchConversation(client, conversationId, (c) => ({
          ...c,
          lastMessage: saved,
          lastSeq: Math.max(c.lastSeq, saved.seq),
          lastActivityAt: saved.createdAt,
          lastMessageStatus:
            saved.state === 'DISPATCHED'
              ? 'SENT'
              : c.lastMessage?.id === saved.id
                ? c.lastMessageStatus
                : null,
        }));
      } catch {
        upsertMessages(client, conversationId, [{ ...local, local: 'failed' }]);
      }
    },
    [client, conversationId],
  );

  const send = useCallback(
    (body: string, replyTo: MessageDto | null) => {
      if (!me) return;
      const local: ClientMessage = {
        id: `local-${crypto.randomUUID()}`,
        clientMessageId: crypto.randomUUID(),
        conversationId,
        seq: Number.MAX_SAFE_INTEGER,
        sender: me.user,
        kind: 'TEXT',
        body,
        systemEvent: null,
        deleted: false,
        editedAt: null,
        createdAt: new Date().toISOString(),
        state: 'ACCEPTED',
        forwarded: false,
        replyTo: replyTo
          ? {
              id: replyTo.id,
              seq: replyTo.seq,
              senderDisplayName: replyTo.sender.displayName,
              bodyPreview: replyTo.body?.slice(0, 120) ?? null,
              deleted: replyTo.deleted,
            }
          : null,
        reactions: [],
        pinned: false,
        attachment: null,
        local: 'sending',
      };
      void sendExisting(local);
    },
    [me, conversationId, sendExisting],
  );

  return { send, retry: sendExisting };
}

export function useMessageAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (action: {
      message: MessageDto;
      kind: 'react' | 'unreact' | 'edit' | 'delete' | 'star' | 'unstar' | 'pin' | 'unpin';
      value?: string;
    }) => {
      const { message, kind, value } = action;
      const base = `/messages/${message.id}`;
      switch (kind) {
        case 'react':
          return api<MessageDto>(`${base}/reaction`, { method: 'PUT', body: { emoji: value } });
        case 'unreact':
          return api<MessageDto>(`${base}/reaction`, { method: 'DELETE' });
        case 'edit':
          return api<MessageDto>(base, { method: 'PATCH', body: { body: value } });
        case 'delete':
          return api<MessageDto>(base, { method: 'DELETE' });
        case 'pin':
          return api<MessageDto>(`${base}/pin`, { method: 'PUT' });
        case 'unpin':
          return api<MessageDto>(`${base}/pin`, { method: 'DELETE' });
        case 'star':
          await api(`${base}/star`, { method: 'PUT' });
          return { ...message, starred: true };
        case 'unstar':
          await api(`${base}/star`, { method: 'DELETE' });
          return { ...message, starred: false };
      }
    },
    onSuccess: (updated, { message }) => {
      if (updated)
        upsertMessages(client, message.conversationId, [
          { ...updated, starred: updated.starred ?? message.starred },
        ]);
    },
  });
}

export function useUpdateMyState(conversationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      mutedUntil?: string | null;
      pinned?: boolean;
      archived?: boolean;
      markedUnread?: boolean;
    }) =>
      api<ConversationSummaryDto>(`/conversations/${conversationId}/me`, { method: 'PATCH', body }),
    onSuccess: (summary) => patchConversation(client, conversationId, () => summary),
  });
}

interface UploadJob extends UploadItem {
  mimeType: string | null;
  clientMessageId: string;
  mediaId: string | null;
  controller: AbortController;
}

/**
 * Sends files: upload → server-side safety check → message with the verified media. The
 * message uses a fixed clientMessageId, so a retry never posts the file twice.
 */
export function useMediaSend(conversationId: string) {
  const client = useQueryClient();
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  const patch = useCallback((key: string, update: Partial<UploadJob>) => {
    setJobs((current) => current.map((j) => (j.key === key ? { ...j, ...update } : j)));
  }, []);

  const run = useCallback(
    async (job: UploadJob) => {
      try {
        if (!job.mimeType)
          throw new Error(
            'This type of file cannot be shared. Try a photo, video, PDF or Office document.',
          );
        let mediaId = job.mediaId;
        if (!mediaId) {
          const media = await uploadFile(
            job.file,
            conversationId,
            job.mimeType,
            (progress) => patch(job.key, { stage: progress.stage, fraction: progress.fraction }),
            job.controller.signal,
          );
          mediaId = media.id;
          patch(job.key, { mediaId });
        }
        patch(job.key, { stage: 'sending' });
        const saved = await api<MessageDto>(`/conversations/${conversationId}/messages`, {
          method: 'POST',
          body: {
            clientMessageId: job.clientMessageId,
            mediaId,
            body: job.caption.trim() || undefined,
          },
        });
        upsertMessages(client, conversationId, [saved]);
        patchConversation(client, conversationId, (c) => ({
          ...c,
          lastMessage: saved,
          lastSeq: Math.max(c.lastSeq, saved.seq),
          lastActivityAt: saved.createdAt,
          lastMessageStatus:
            saved.state === 'DISPATCHED'
              ? 'SENT'
              : c.lastMessage?.id === saved.id
                ? c.lastMessageStatus
                : null,
        }));
        setJobs((current) => current.filter((j) => j.key !== job.key));
      } catch (error) {
        if (error instanceof UploadCancelledError || job.controller.signal.aborted) {
          setJobs((current) => current.filter((j) => j.key !== job.key));
          return;
        }
        patch(job.key, { stage: 'failed', error: errorMessage(error) });
      }
    },
    [client, conversationId, patch],
  );

  const send = useCallback(
    (file: File, caption: string) => {
      const declared = isMediaMimeType(file.type) ? file.type : mimeTypeFromFileName(file.name);
      const job: UploadJob = {
        key: crypto.randomUUID(),
        file,
        caption,
        stage: 'uploading',
        fraction: 0,
        error: null,
        mimeType: declared,
        clientMessageId: crypto.randomUUID(),
        mediaId: null,
        controller: new AbortController(),
      };
      setJobs((current) => [...current, job]);
      void run(job);
    },
    [run],
  );

  const cancel = useCallback((key: string) => {
    const job = jobsRef.current.find((j) => j.key === key);
    job?.controller.abort();
    setJobs((current) => current.filter((j) => j.key !== key));
  }, []);

  const retry = useCallback(
    (key: string) => {
      const job = jobsRef.current.find((j) => j.key === key);
      if (!job) return;
      // A failed safety check cannot be retried with the same upload; start fresh in that case.
      const fresh: UploadJob = {
        ...job,
        stage: 'uploading',
        fraction: 0,
        error: null,
        controller: new AbortController(),
      };
      setJobs((current) => current.map((j) => (j.key === key ? fresh : j)));
      void run(fresh);
    },
    [run],
  );

  // Abort uploads when leaving the conversation.
  useEffect(() => () => jobsRef.current.forEach((j) => j.controller.abort()), []);

  return { items: jobs as UploadItem[], send, cancel, retry };
}
