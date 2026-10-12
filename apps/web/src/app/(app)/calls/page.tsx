'use client';

import type { CallLogEntryDto } from '@storeline/shared';
import { useQuery } from '@tanstack/react-query';
import { MessageCircle, Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing, Video } from 'lucide-react';
import Link from 'next/link';
import { Alert, Avatar, cx, EmptyState, PageHeader, Spinner } from '@/components/ui';
import { formatDuration } from '@/components/chat/rich-content';
import { api, errorMessage } from '@/lib/api';
import { startCall } from '@/lib/calls';
import { formatDay, formatTime } from '@/lib/format';

function outcomeText(c: CallLogEntryDto): { text: string; missed: boolean } {
  if (c.outcome === 'answered') return { text: formatDuration(c.durationSec), missed: false };
  if (c.outgoing) return { text: c.outcome === 'busy' ? 'Busy' : c.outcome === 'declined' ? 'Declined' : 'No answer', missed: false };
  return { text: 'Missed', missed: true };
}

export default function CallsPage() {
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
          subtitle="Voice and video calls with colleagues. Start one from a one-to-one chat."
        />
        <Alert tone="info">
          Calls go directly between the two devices. On the same Wi-Fi they work out of the box;
          across the internet the server needs a STUN/TURN relay set up.
        </Alert>
        {log.isPending && <Spinner label="Loading calls" />}
        {log.isError && <Alert tone="error">{errorMessage(log.error)}</Alert>}
        {log.data?.length === 0 && (
          <EmptyState icon={<Phone className="size-9" aria-hidden />} title="No calls yet">
            Open a chat with someone and press the phone or camera button.
          </EmptyState>
        )}
        {log.data && log.data.length > 0 && (
          <ul className="flex flex-col rounded-3xl border border-line bg-surface p-2 shadow-card">
            {log.data.map((c) => {
              const { text, missed } = outcomeText(c);
              const Icon = missed ? PhoneMissed : c.outgoing ? PhoneOutgoing : PhoneIncoming;
              return (
                <li key={c.messageId} className="flex items-center gap-3 rounded-2xl p-2 hover:bg-surface-2">
                  <Avatar name={c.peer.displayName} size={48} />
                  <div className="min-w-0 flex-1">
                    <p className={cx('truncate font-semibold', missed && 'text-danger')}>{c.peer.displayName}</p>
                    <p className="flex items-center gap-1 text-sm text-muted">
                      <Icon className={cx('size-4', missed ? 'text-danger' : 'text-success')} aria-hidden />
                      {c.media === 'video' ? 'Video' : 'Voice'} · {text} · {formatDay(c.at)}, {formatTime(c.at)}
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
                    {c.media === 'video' ? <Video className="size-5" aria-hidden /> : <Phone className="size-5" aria-hidden />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
