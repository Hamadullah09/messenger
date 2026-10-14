'use client';

import type { CallLogEntryDto, ConversationDetailDto, PublicUserDto } from '@storeline/shared';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import {
  MessageCircle,
  Phone,
  PhoneCall,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Search,
  Users,
  Video,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import {
  Alert,
  Avatar,
  Button,
  cx,
  Dialog,
  EmptyState,
  PageHeader,
  Spinner,
} from '@/components/ui';
import { formatDuration } from '@/components/chat/rich-content';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-store';
import { startCall } from '@/lib/calls';
import { useConversations } from '@/lib/chat-hooks';
import { formatDay, formatTime } from '@/lib/format';

function outcomeText(c: CallLogEntryDto): { text: string; missed: boolean } {
  if (c.outcome === 'answered') return { text: formatDuration(c.durationSec), missed: false };
  if (c.outgoing)
    return {
      text: c.outcome === 'busy' ? 'Busy' : c.outcome === 'declined' ? 'Declined' : 'No answer',
      missed: false,
    };
  return { text: 'Missed', missed: true };
}

function CallButtons({
  label,
  onCall,
  busy,
}: {
  label: string;
  onCall: (media: 'audio' | 'video') => void;
  busy?: boolean;
}) {
  return (
    <span className="flex shrink-0 gap-1">
      <button
        type="button"
        disabled={busy}
        aria-label={`Voice call ${label}`}
        onClick={() => onCall('audio')}
        className="inline-flex size-10 items-center justify-center rounded-full text-brand hover:bg-surface-3 disabled:opacity-50"
      >
        <Phone className="size-5" aria-hidden />
      </button>
      <button
        type="button"
        disabled={busy}
        aria-label={`Video call ${label}`}
        onClick={() => onCall('video')}
        className="inline-flex size-10 items-center justify-center rounded-full text-brand hover:bg-surface-3 disabled:opacity-50"
      >
        <Video className="size-5" aria-hidden />
      </button>
    </span>
  );
}

/** WhatsApp-style "New call": pick a person or a group, then voice or video. */
function NewCallDialog({ onClose }: { onClose: () => void }) {
  const businessId = useAuth((s) => s.activeBusinessId);
  const myId = useAuth((s) => s.me?.user.id);
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  const conversations = useConversations();
  const groups = (conversations.data ?? []).filter(
    (c) =>
      c.type === 'GROUP' &&
      c.me.canPost &&
      (!businessId || c.businessId === businessId) &&
      (!q || c.title.toLowerCase().includes(q)),
  );
  const people = useQuery({
    queryKey: ['directory', businessId, search.trim()],
    queryFn: () =>
      api<PublicUserDto[]>('/directory', {
        query: { businessId, query: search.trim(), limit: 30 },
      }),
    enabled: !!businessId,
    placeholderData: keepPreviousData,
  });
  // Calling someone opens (or creates) your one-to-one chat with them first.
  const callPerson = useMutation({
    mutationFn: async ({ userId, media }: { userId: string; media: 'audio' | 'video' }) => {
      const chat = await api<ConversationDetailDto>('/conversations/direct', {
        method: 'POST',
        body: { businessId, userId },
      });
      onClose();
      await startCall(chat.id, media);
    },
  });
  const callGroup = (conversationId: string, media: 'audio' | 'video') => {
    onClose();
    void startCall(conversationId, media);
  };
  return (
    <Dialog open onClose={onClose} title="New call">
      <div className="flex flex-col gap-4">
        <label className="relative">
          <span className="sr-only">Search people and groups</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
            aria-hidden
          />
          <input
            type="search"
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search people and groups"
            className="min-h-11 w-full rounded-xl border border-line-strong/70 bg-surface pr-3 pl-9"
          />
        </label>
        {callPerson.isError && <Alert tone="error">{errorMessage(callPerson.error)}</Alert>}
        {groups.length > 0 && (
          <section>
            <h3 className="mb-1 text-sm font-bold text-muted uppercase">Groups</h3>
            <ul className="flex flex-col">
              {groups.slice(0, 20).map((g) => (
                <li
                  key={g.id}
                  className="flex items-center gap-3 rounded-2xl p-2 hover:bg-surface-2"
                >
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
                    <Users className="size-5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{g.title}</span>
                    <span className="block text-sm text-muted">{g.memberCount} members</span>
                  </span>
                  <CallButtons label={g.title} onCall={(media) => callGroup(g.id, media)} />
                </li>
              ))}
            </ul>
          </section>
        )}
        <section>
          <h3 className="mb-1 text-sm font-bold text-muted uppercase">People</h3>
          {!businessId && <p className="text-muted">Choose a business at the top first.</p>}
          {people.isPending && businessId && <Spinner label="Loading people" />}
          {people.isError && <Alert tone="error">{errorMessage(people.error)}</Alert>}
          {people.data?.filter((p) => p.id !== myId).length === 0 && (
            <p className="text-muted">Nobody found.</p>
          )}
          <ul className="flex flex-col">
            {people.data
              ?.filter((p) => p.id !== myId)
              .map((p) => (
                <li
                  key={p.id}
                  className="flex items-center gap-3 rounded-2xl p-2 hover:bg-surface-2"
                >
                  <Avatar name={p.displayName} size={44} />
                  <span className="min-w-0 flex-1 truncate font-semibold">{p.displayName}</span>
                  <CallButtons
                    label={p.displayName}
                    busy={callPerson.isPending}
                    onCall={(media) => callPerson.mutate({ userId: p.id, media })}
                  />
                </li>
              ))}
          </ul>
        </section>
      </div>
    </Dialog>
  );
}

export default function CallsPage() {
  const [newCall, setNewCall] = useState(false);
  const log = useQuery({
    queryKey: ['calls-log'],
    queryFn: () => api<CallLogEntryDto[]>('/calls/log'),
    refetchInterval: 30_000,
  });
  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-4 sm:p-6">
        <PageHeader
          title="Calls"
          subtitle="Voice and video calls with colleagues, one-to-one or in a group of up to 8."
          actions={
            <Button
              icon={<PhoneCall className="size-5" aria-hidden />}
              onClick={() => setNewCall(true)}
            >
              New call
            </Button>
          }
        />
        <Alert tone="info">
          Calls go directly between the devices. On the same Wi-Fi they work out of the box; across
          the internet the server needs a STUN/TURN relay set up. Calls need the https address.
        </Alert>
        {log.isPending && <Spinner label="Loading calls" />}
        {log.isError && <Alert tone="error">{errorMessage(log.error)}</Alert>}
        {log.data?.length === 0 && (
          <EmptyState icon={<Phone className="size-9" aria-hidden />} title="No calls yet">
            Press <b>New call</b> and choose a person or a group, or use the phone and camera
            buttons in a chat.
          </EmptyState>
        )}
        {log.data && log.data.length > 0 && (
          <ul className="flex flex-col rounded-3xl border border-line bg-surface p-2 shadow-card">
            {log.data.map((c) => {
              const { text, missed } = outcomeText(c);
              const Icon = missed ? PhoneMissed : c.outgoing ? PhoneOutgoing : PhoneIncoming;
              return (
                <li
                  key={c.messageId}
                  className="flex items-center gap-3 rounded-2xl p-2 hover:bg-surface-2"
                >
                  {c.group ? (
                    <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
                      <Users className="size-6" aria-hidden />
                    </span>
                  ) : (
                    <Avatar name={c.peer.displayName} size={48} />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className={cx('truncate font-semibold', missed && 'text-danger')}>
                      {c.peer.displayName}
                    </p>
                    <p className="flex items-center gap-1 text-sm text-muted">
                      <Icon
                        className={cx('size-4 shrink-0', missed ? 'text-danger' : 'text-success')}
                        aria-hidden
                      />
                      <span className="truncate">
                        {c.group ? 'Group ' : ''}
                        {c.media === 'video' ? 'video' : 'voice'} · {text} · {formatDay(c.at)},{' '}
                        {formatTime(c.at)}
                      </span>
                    </p>
                  </div>
                  <Link
                    href={`/chats?c=${c.conversationId}`}
                    aria-label={`Open chat with ${c.peer.displayName}`}
                    className="inline-flex size-10 items-center justify-center rounded-full text-wa-icon hover:bg-surface-3"
                  >
                    <MessageCircle className="size-5" aria-hidden />
                  </Link>
                  <button
                    type="button"
                    aria-label={`${c.media === 'video' ? 'Video' : 'Voice'} call ${c.peer.displayName}`}
                    onClick={() => void startCall(c.conversationId, c.media)}
                    className="inline-flex size-10 items-center justify-center rounded-full text-brand hover:bg-surface-3"
                  >
                    {c.media === 'video' ? (
                      <Video className="size-5" aria-hidden />
                    ) : (
                      <Phone className="size-5" aria-hidden />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {newCall && <NewCallDialog onClose={() => setNewCall(false)} />}
    </div>
  );
}
