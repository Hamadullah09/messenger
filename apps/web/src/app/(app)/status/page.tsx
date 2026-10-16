'use client';

import {
  isMediaMimeType,
  STATUS_BACKGROUNDS,
  type MediaKind,
  type StatusFeedDto,
  type StatusPostDto,
  type StatusViewerDto,
} from '@storeline/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Eye,
  Image as ImageIcon,
  Loader2,
  Plus,
  Trash2,
  Type,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Avatar,
  Button,
  cx,
  Dialog,
  EmptyState,
  PageHeader,
  SelectField,
  Spinner,
  TextArea,
} from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useFeatures } from '@/lib/features';
import { FeatureOff } from '@/components/feature-off';
import { useAuth } from '@/lib/auth-store';
import { formatRelativeShort, formatTime } from '@/lib/format';
import { useMediaUrl } from '@/lib/media-store';
import { uploadFile } from '@/lib/uploads';

const SHOW_MS = 5_000;

function Ring({
  name,
  posts,
  seen,
  size = 52,
}: {
  name: string;
  posts: number;
  seen: boolean;
  size?: number;
}) {
  // WhatsApp's segmented ring: one arc per update, brand colour until seen.
  const r = size / 2 - 2;
  const c = 2 * Math.PI * r;
  const gap = posts > 1 ? 4 : 0;
  const seg = c / Math.max(1, posts) - gap;
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="absolute inset-0 -rotate-90" aria-hidden>
        {Array.from({ length: Math.max(1, posts) }, (_, i) => (
          <circle
            key={i}
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={2.5}
            className={seen ? 'stroke-line-strong' : 'stroke-brand'}
            strokeDasharray={`${seg} ${c - seg}`}
            strokeDashoffset={-i * (seg + gap)}
          />
        ))}
      </svg>
      <span className="absolute inset-[4px] overflow-hidden rounded-full">
        <Avatar name={name} size={size - 8} />
      </span>
    </span>
  );
}

export default function StatusPage() {
  const features = useFeatures();
  if (!features.STATUS) return <FeatureOff name="Status" />;
  return <StatusPageContent />;
}

function StatusPageContent() {
  const me = useAuth((s) => s.me)!;
  const businessId = useAuth((s) => s.activeBusinessId);
  const [composing, setComposing] = useState(false);
  const [viewing, setViewing] = useState<{ posts: StatusPostDto[]; index: number } | null>(null);
  const feed = useQuery({
    queryKey: ['status', businessId],
    queryFn: () =>
      api<StatusFeedDto>('/status', { query: { businessId: businessId ?? undefined } }),
    enabled: !!businessId,
    refetchInterval: 60_000,
  });
  const canPost = me.grants.some(
    (g) =>
      g.permissions.includes('status.post') &&
      (g.scope.type === 'PLATFORM' || g.scope.businessId === businessId),
  );

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-4 sm:p-6">
        <PageHeader
          title="Status"
          subtitle="Updates for your team that disappear after 24 hours. Store announcements reach only that store."
          actions={
            canPost && businessId ? (
              <Button
                icon={<Plus className="size-5" aria-hidden />}
                onClick={() => setComposing(true)}
              >
                Add status
              </Button>
            ) : undefined
          }
        />
        {!businessId && (
          <EmptyState
            icon={<CircleDashed className="size-9" aria-hidden />}
            title="Choose a business"
          >
            Status updates belong to a business. Pick one from the switcher at the top.
          </EmptyState>
        )}
        {feed.isPending && businessId && <Spinner label="Loading updates" />}
        {feed.isError && <Alert tone="error">{errorMessage(feed.error)}</Alert>}
        {feed.data && (
          <>
            <section className="rounded-3xl border border-line bg-surface p-2 shadow-card">
              <button
                type="button"
                onClick={() =>
                  feed.data.mine.length > 0
                    ? setViewing({ posts: feed.data.mine, index: 0 })
                    : canPost && setComposing(true)
                }
                className="flex w-full items-center gap-3 rounded-2xl p-2 text-left hover:bg-surface-2"
              >
                {feed.data.mine.length > 0 ? (
                  <Ring name={me.user.displayName} posts={feed.data.mine.length} seen />
                ) : (
                  <span className="relative">
                    <Avatar name={me.user.displayName} size={52} />
                    <span className="absolute -right-0.5 -bottom-0.5 inline-flex size-5 items-center justify-center rounded-full border-2 border-surface bg-brand text-white">
                      <Plus className="size-3" strokeWidth={3} aria-hidden />
                    </span>
                  </span>
                )}
                <span>
                  <span className="block font-semibold">My status</span>
                  <span className="block text-sm text-muted">
                    {feed.data.mine.length > 0
                      ? `${feed.data.mine.length} update${feed.data.mine.length > 1 ? 's' : ''} · ${formatRelativeShort(feed.data.mine.at(-1)!.createdAt)}`
                      : 'Tap to add a status update'}
                  </span>
                </span>
              </button>
            </section>
            <section>
              <h2 className="mb-2 text-sm font-bold tracking-wide text-muted uppercase">
                Recent updates
              </h2>
              {feed.data.others.length === 0 ? (
                <p className="text-muted">No updates from your team in the last 24 hours.</p>
              ) : (
                <ul className="flex flex-col gap-1 rounded-3xl border border-line bg-surface p-2 shadow-card">
                  {feed.data.others.map((g) => (
                    <li key={g.author.id}>
                      <button
                        type="button"
                        onClick={() =>
                          setViewing({
                            posts: g.posts,
                            index: Math.max(
                              0,
                              g.posts.findIndex((p) => !p.viewed),
                            ),
                          })
                        }
                        className="flex w-full items-center gap-3 rounded-2xl p-2 text-left hover:bg-surface-2"
                      >
                        <Ring
                          name={g.author.displayName}
                          posts={g.posts.length}
                          seen={g.allViewed}
                        />
                        <span className="min-w-0">
                          <span className="block truncate font-semibold">
                            {g.author.displayName}
                          </span>
                          <span className="block truncate text-sm text-muted">
                            {formatRelativeShort(g.posts.at(-1)!.createdAt)}
                            {g.posts.some((p) => p.storeName)
                              ? ` · ${g.posts.find((p) => p.storeName)!.storeName}`
                              : ''}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
      {composing && businessId && (
        <StatusComposer businessId={businessId} onClose={() => setComposing(false)} />
      )}
      {viewing && (
        <StatusViewer
          posts={viewing.posts}
          start={viewing.index}
          myId={me.user.id}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

function StatusMedia({
  post,
  onVideoEnd,
  paused,
}: {
  post: StatusPostDto;
  onVideoEnd: () => void;
  paused: boolean;
}) {
  const url = useMediaUrl(post.media!.mediaId, 'original');
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!video.current) return;
    if (paused) video.current.pause();
    else void video.current.play().catch(() => undefined);
  }, [paused, url.data]);
  if (!url.data)
    return <Loader2 className="size-10 animate-spin text-white" aria-label="Loading" />;
  return post.media!.kind === 'VIDEO' ? (
    <video
      ref={video}
      src={url.data.url}
      autoPlay
      playsInline
      onEnded={onVideoEnd}
      className="max-h-full max-w-full"
    />
  ) : (
    <img
      src={url.data.url}
      alt={post.text ?? `Status from ${post.author.displayName}`}
      className="max-h-full max-w-full object-contain"
    />
  );
}

function StatusViewer({
  posts,
  start,
  myId,
  onClose,
}: {
  posts: StatusPostDto[];
  start: number;
  myId: string;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [index, setIndex] = useState(start);
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const [viewers, setViewers] = useState(false);
  const post = posts[index];
  const mine = post?.author.id === myId;
  const isVideo = post?.media?.kind === 'VIDEO';
  const next = () => (index + 1 < posts.length ? setIndex(index + 1) : onClose());
  const prev = () => index > 0 && setIndex(index - 1);

  useEffect(() => {
    setElapsed(0);
    if (post && !post.viewed && !mine)
      void api(`/status/${post.id}/view`, { method: 'POST' })
        .then(() => client.invalidateQueries({ queryKey: ['status'] }))
        .catch(() => undefined);
  }, [index]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (paused || viewers || isVideo) return;
    const t = window.setInterval(() => setElapsed((e) => e + 100), 100);
    return () => window.clearInterval(t);
  }, [paused, viewers, isVideo, index]);
  useEffect(() => {
    if (elapsed >= SHOW_MS) next();
  }, [elapsed]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') next();
      if (e.key === 'ArrowLeft') prev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const remove = useMutation({
    mutationFn: () => api(`/status/${post!.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['status'] });
      onClose();
    },
  });
  if (!post) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Status from ${post.author.displayName}`}
      className="fixed inset-0 z-[70] flex flex-col bg-black text-white"
    >
      <div className="flex gap-1 px-3 pt-3">
        {posts.map((p, i) => (
          <span key={p.id} className="h-0.5 flex-1 overflow-hidden rounded-full bg-white/30">
            <span
              className="block h-full bg-white"
              style={{
                width:
                  i < index
                    ? '100%'
                    : i > index
                      ? '0%'
                      : isVideo
                        ? '100%'
                        : `${Math.min(100, (elapsed / SHOW_MS) * 100)}%`,
              }}
            />
          </span>
        ))}
      </div>
      <div className="flex items-center gap-3 px-3 py-2">
        <Avatar name={post.author.displayName} size={40} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{mine ? 'My status' : post.author.displayName}</p>
          <p className="text-xs text-white/70">
            {formatTime(post.createdAt)}
            {post.storeName ? ` · ${post.storeName}` : ''}
          </p>
        </div>
        {mine && (
          <button
            type="button"
            aria-label="Delete this update"
            onClick={() => remove.mutate()}
            className="inline-flex size-10 items-center justify-center rounded-full hover:bg-white/15"
          >
            <Trash2 className="size-5" aria-hidden />
          </button>
        )}
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="inline-flex size-10 items-center justify-center rounded-full hover:bg-white/15"
        >
          <X className="size-6" aria-hidden />
        </button>
      </div>
      <div
        className="relative flex flex-1 items-center justify-center overflow-hidden"
        style={post.media ? undefined : { background: post.background ?? '#ea580c' }}
        onPointerDown={() => setPaused(true)}
        onPointerUp={() => setPaused(false)}
        onPointerLeave={() => setPaused(false)}
      >
        {post.media ? (
          <StatusMedia post={post} paused={paused || viewers} onVideoEnd={next} />
        ) : (
          <p className="max-w-2xl px-8 text-center text-3xl leading-snug font-semibold whitespace-pre-wrap sm:text-4xl">
            {post.text}
          </p>
        )}
        <button
          type="button"
          aria-label="Previous"
          onClick={prev}
          className="absolute inset-y-0 left-0 w-1/4 focus-visible:bg-white/10"
        >
          <ChevronLeft className="ml-2 size-8 opacity-0 sm:opacity-60" aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Next"
          onClick={next}
          className="absolute inset-y-0 right-0 flex w-1/4 items-center justify-end focus-visible:bg-white/10"
        >
          <ChevronRight className="mr-2 size-8 opacity-0 sm:opacity-60" aria-hidden />
        </button>
      </div>
      {post.media && post.text && <p className="bg-black/60 px-6 py-3 text-center">{post.text}</p>}
      {mine && (
        <button
          type="button"
          onClick={() => setViewers(true)}
          className="mx-auto mb-4 inline-flex items-center gap-2 rounded-full bg-white/15 px-4 py-2 font-semibold"
        >
          <Eye className="size-5" aria-hidden /> {post.viewCount ?? 0} views
        </button>
      )}
      {viewers && <ViewersDialog statusId={post.id} onClose={() => setViewers(false)} />}
    </div>
  );
}

function ViewersDialog({ statusId, onClose }: { statusId: string; onClose: () => void }) {
  const viewers = useQuery({
    queryKey: ['status-viewers', statusId],
    queryFn: () => api<StatusViewerDto[]>(`/status/${statusId}/viewers`),
  });
  return (
    <Dialog open onClose={onClose} title="Viewed by">
      {viewers.isPending && <Spinner />}
      {viewers.data?.length === 0 && <p className="text-muted">Nobody has seen it yet.</p>}
      <ul className="flex flex-col gap-1">
        {viewers.data?.map((v) => (
          <li key={v.user.id} className="flex items-center gap-3 rounded-xl px-2 py-2">
            <Avatar name={v.user.displayName} size={40} />
            <span className="flex-1 font-semibold">{v.user.displayName}</span>
            <span className="text-sm text-muted">{formatTime(v.viewedAt)}</span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

function StatusComposer({ businessId, onClose }: { businessId: string; onClose: () => void }) {
  const client = useQueryClient();
  const me = useAuth((s) => s.me)!;
  const stores = me.businesses.find((b) => b.id === businessId)?.stores ?? [];
  const [mode, setMode] = useState<'text' | 'media'>('text');
  const [text, setText] = useState('');
  const [background, setBackground] = useState<string>(STATUS_BACKGROUNDS[0]);
  const [storeId, setStoreId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<{ url: string; kind: MediaKind } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );
  const post = useMutation({
    mutationFn: async () => {
      let mediaId: string | undefined;
      if (mode === 'media' && file) {
        const type = file.type.split(';')[0]!;
        if (!isMediaMimeType(type)) throw new Error('Choose a photo or video.');
        const controller = new AbortController();
        const media = await uploadFile(
          file,
          { statusBusinessId: businessId },
          type,
          (p) => setProgress(p.stage === 'checking' ? 1 : p.fraction),
          controller.signal,
        );
        mediaId = media.id;
      }
      return api<StatusPostDto>('/status', {
        method: 'POST',
        body: {
          businessId,
          storeId: storeId || null,
          ...(text.trim() ? { text: text.trim() } : {}),
          ...(mode === 'text' ? { background } : {}),
          ...(mediaId ? { mediaId } : {}),
        },
      });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['status'] });
      onClose();
    },
    onSettled: () => setProgress(null),
  });
  return (
    <Dialog open onClose={onClose} title="New status update" wide>
      <div className="flex flex-col gap-4">
        {post.isError && <Alert tone="error">{errorMessage(post.error)}</Alert>}
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Kind of update">
          {(
            [
              ['text', 'Text', Type],
              ['media', 'Photo or video', ImageIcon],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={mode === key}
              onClick={() => setMode(key)}
              className={cx(
                'flex min-h-12 items-center justify-center gap-2 rounded-xl border font-semibold',
                mode === key
                  ? 'border-brand bg-brand-soft text-brand-strong'
                  : 'border-line hover:bg-surface-2',
              )}
            >
              <Icon className="size-5" aria-hidden /> {label}
            </button>
          ))}
        </div>
        {mode === 'text' ? (
          <>
            <div
              className="flex min-h-56 items-center justify-center rounded-3xl p-6"
              style={{ background }}
            >
              <textarea
                aria-label="Status text"
                value={text}
                maxLength={700}
                autoFocus
                placeholder="Type a status"
                onChange={(e) => setText(e.target.value)}
                className="w-full resize-none bg-transparent text-center text-2xl font-semibold text-white placeholder:text-white/70 focus:outline-none"
                rows={4}
              />
            </div>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Background colour">
              {STATUS_BACKGROUNDS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={background === c}
                  aria-label={`Background ${c}`}
                  onClick={() => setBackground(c)}
                  className={cx(
                    'size-9 rounded-full border-2',
                    background === c ? 'border-fg' : 'border-transparent',
                  )}
                  style={{ background: c }}
                />
              ))}
            </div>
          </>
        ) : (
          <>
            <input
              ref={input}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                setPreview(
                  f
                    ? {
                        url: URL.createObjectURL(f),
                        kind: f.type.startsWith('video') ? 'VIDEO' : 'IMAGE',
                      }
                    : null,
                );
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => input.current?.click()}
              className="flex min-h-56 items-center justify-center overflow-hidden rounded-3xl border-2 border-dashed border-line bg-surface-2"
            >
              {preview ? (
                preview.kind === 'VIDEO' ? (
                  <video src={preview.url} className="max-h-72" muted autoPlay loop playsInline />
                ) : (
                  <img src={preview.url} alt="Chosen photo" className="max-h-72 object-contain" />
                )
              ) : (
                <span className="flex flex-col items-center gap-2 text-muted">
                  <ImageIcon className="size-10" aria-hidden /> Choose a photo or video
                </span>
              )}
            </button>
            <TextArea
              label="Caption (optional)"
              rows={2}
              maxLength={700}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </>
        )}
        {stores.length > 0 && (
          <SelectField
            label="Who can see it"
            value={storeId}
            onChange={(e) => setStoreId(e.target.value)}
          >
            <option value="">Everyone in the business</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                Only {s.name}
              </option>
            ))}
          </SelectField>
        )}
        {progress !== null && (
          <p className="text-sm text-muted">
            {progress >= 1 ? 'Checking the file…' : `Uploading ${Math.round(progress * 100)}%`}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            busy={post.isPending}
            disabled={mode === 'text' ? !text.trim() : !file}
            onClick={() => post.mutate()}
          >
            Post status
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
