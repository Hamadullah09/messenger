'use client';

import type {
  ConversationDetailDto,
  Page,
  PublicUserDto,
  SearchResultDto,
} from '@storeline/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { FileText, MessageCircle, Search, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { Alert, Avatar, Card, EmptyState, PageHeader, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-store';
import { useConversations } from '@/lib/chat-hooks';
import { formatRelativeShort } from '@/lib/format';

function SearchScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const q = params.get('q') ?? '';
  const [text, setText] = useState(q);
  const businessId = useAuth((s) => s.activeBusinessId);
  const conversations = useConversations();
  useEffect(() => setText(q), [q]);

  const enabled = q.trim().length >= 2;
  const messages = useQuery({
    queryKey: ['global-search', businessId, q],
    queryFn: () =>
      api<Page<SearchResultDto>>('/search/messages', { query: { q, businessId, limit: 30 } }),
    enabled,
  });
  const people = useQuery({
    queryKey: ['directory', businessId, q],
    queryFn: () =>
      api<PublicUserDto[]>('/directory', { query: { businessId, query: q, limit: 10 } }),
    enabled: enabled && !!businessId,
  });
  const startChat = useMutation({
    mutationFn: (userId: string) =>
      api<ConversationDetailDto>('/conversations/direct', {
        method: 'POST',
        body: { businessId, userId },
      }),
    onSuccess: (c) => router.push(`/chats?c=${c.id}`),
  });

  // Direct chats are titled by the other person's name.
  const titleOf = (id: string, fallback: string) =>
    conversations.data?.find((c) => c.id === id)?.title ?? fallback;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    router.replace(`/search?q=${encodeURIComponent(text.trim())}`);
  };

  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4 sm:p-6">
        <PageHeader title="Search" subtitle="Find messages, files and colleagues" />
        <form role="search" onSubmit={submit}>
          <label className="relative block">
            <span className="sr-only">Search</span>
            <Search
              className="pointer-events-none absolute top-1/2 left-4 size-6 -translate-y-1/2 text-muted"
              aria-hidden
            />
            <input
              type="search"
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type at least 2 letters, then press Enter"
              className="min-h-14 w-full rounded-2xl border border-line-strong/60 bg-surface pr-4 pl-13 text-lg shadow-card focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/20"
            />
          </label>
        </form>

        {!enabled && (
          <EmptyState
            icon={<Search className="size-9" aria-hidden />}
            title="What are you looking for?"
          >
            Search words in messages, photo captions and file names. Only chats you belong to are
            searched.
          </EmptyState>
        )}

        {enabled && (
          <>
            <Card aria-labelledby="people-title">
              <h2 id="people-title" className="mb-3 flex items-center gap-2 text-lg font-bold">
                <UserRound className="size-5 text-brand" aria-hidden /> People
              </h2>
              {people.isLoading && <Spinner label="Searching people" />}
              {startChat.isError && <Alert tone="error">{errorMessage(startChat.error)}</Alert>}
              {people.data?.length === 0 && (
                <p className="text-muted">No colleagues match “{q}”.</p>
              )}
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {people.data?.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => startChat.mutate(p.id)}
                      disabled={startChat.isPending}
                      className="flex min-h-16 w-full items-center gap-3 rounded-2xl border border-line px-3 text-left hover:border-brand/50 hover:bg-brand-soft"
                    >
                      <Avatar name={p.displayName} size={44} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold">{p.displayName}</span>
                        <span className="block truncate text-sm text-muted">@{p.username}</span>
                      </span>
                      <MessageCircle className="size-5 text-brand" aria-label="Message" />
                    </button>
                  </li>
                ))}
              </ul>
            </Card>

            <Card aria-labelledby="messages-title">
              <h2 id="messages-title" className="mb-3 flex items-center gap-2 text-lg font-bold">
                <MessageCircle className="size-5 text-brand" aria-hidden /> Messages and files
              </h2>
              {messages.isLoading && <Spinner label="Searching messages" />}
              {messages.isError && <Alert tone="error">{errorMessage(messages.error)}</Alert>}
              {messages.data?.items.length === 0 && (
                <p className="text-muted">No messages match “{q}”.</p>
              )}
              <ul className="divide-y divide-line">
                {messages.data?.items.map((r) => (
                  <li key={r.message.id}>
                    <Link
                      href={`/chats?c=${r.conversation.id}`}
                      className="-mx-2 flex gap-3 rounded-2xl px-2 py-3 hover:bg-surface-2"
                    >
                      <Avatar name={r.message.sender.displayName} size={40} />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-semibold">{r.message.sender.displayName}</span>
                          <span className="text-sm text-muted">
                            in {titleOf(r.conversation.id, r.conversation.title)} ·{' '}
                            {formatRelativeShort(r.message.createdAt)}
                          </span>
                        </span>
                        {r.message.attachment && (
                          <span className="mt-1 flex items-center gap-1.5 text-sm font-medium">
                            <FileText className="size-4 text-brand" aria-hidden />{' '}
                            {r.message.attachment.fileName}
                          </span>
                        )}
                        {r.message.body && (
                          <span className="mt-0.5 line-clamp-2 block">{r.message.body}</span>
                        )}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <SearchScreen />
    </Suspense>
  );
}
