'use client';

import {
  Apple,
  Car,
  Cat,
  Clock,
  Flag,
  Hand,
  Heart,
  Lightbulb,
  Search,
  Smile,
  Trophy,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cx } from '../ui';

interface EmojiEntry {
  emoji: string;
  name: string;
  skin_tone_support: boolean;
  emoji_version: string;
}
interface EmojiGroup {
  name: string;
  slug: string;
  emojis: EmojiEntry[];
}

const GROUP_ICONS: Record<string, LucideIcon> = {
  'Smileys & Emotion': Smile,
  'People & Body': Hand,
  'Animals & Nature': Cat,
  'Food & Drink': Apple,
  Activities: Trophy,
  'Travel & Places': Car,
  Objects: Lightbulb,
  Symbols: Heart,
  Flags: Flag,
};
const GROUP_LABELS: Record<string, string> = {
  'Smileys & Emotion': 'Smileys & people',
  'People & Body': 'People & body',
  'Animals & Nature': 'Animals & nature',
  'Food & Drink': 'Food & drink',
  Activities: 'Activity',
  'Travel & Places': 'Travel & places',
  Objects: 'Objects',
  Symbols: 'Symbols',
  Flags: 'Flags',
};

/** Newer emoji than this show as empty boxes on many phones and computers. */
const MAX_EMOJI_VERSION = 14.0;
const TONES = ['', '\u{1F3FB}', '\u{1F3FC}', '\u{1F3FD}', '\u{1F3FE}', '\u{1F3FF}'] as const;
const RECENT_KEY = 'sma-emoji-recent';
const TONE_KEY = 'sma-emoji-tone';
export const EMOJI_FONT =
  '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Segoe UI Symbol",sans-serif';

/** Same rule as the server's reaction check: an emoji, no letters or digits. */
const REACTABLE = (e: string) => /\p{Extended_Pictographic}/u.test(e) && !/[\p{L}\p{N}]/u.test(e);

let cache: Promise<EmojiGroup[]> | null = null;
function loadGroups(): Promise<EmojiGroup[]> {
  cache ??= import('unicode-emoji-json/data-by-group.json').then((m) => {
    const raw = (m.default ?? m) as unknown as EmojiGroup[];
    // Windows shows flags as two letters: leave them out there.
    const windows = /Windows/i.test(navigator.userAgent);
    return raw
      .filter((g) => !(windows && g.name === 'Flags'))
      .map((g) => ({
        ...g,
        emojis: g.emojis.filter((e) => Number(e.emoji_version) <= MAX_EMOJI_VERSION),
      }));
  });
  return cache;
}

function withTone(entry: EmojiEntry, tone: string): string {
  if (!tone || !entry.skin_tone_support) return entry.emoji;
  const [first, ...rest] = [...entry.emoji.replace(/️/g, '')];
  return `${first}${tone}${rest.join('')}`;
}

function readList(key: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '[]') as string[];
  } catch {
    return [];
  }
}

/**
 * The full emoji keyboard, like WhatsApp's: recently used, every category with tabs, search
 * and skin tone. `reactions` keeps to emoji the server accepts as a reaction.
 */
export function EmojiPicker({
  onPick,
  reactions = false,
  className,
}: {
  onPick: (emoji: string) => void;
  reactions?: boolean;
  className?: string;
}) {
  const [groups, setGroups] = useState<EmojiGroup[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<string[]>([]);
  const [tone, setTone] = useState('');
  const [toneOpen, setToneOpen] = useState(false);
  const [active, setActive] = useState('recent');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    loadGroups()
      .then((g) => live && setGroups(g))
      .catch(() => live && setFailed(true));
    setRecent(readList(RECENT_KEY));
    try {
      setTone(localStorage.getItem(TONE_KEY) ?? '');
    } catch {
      // Per-device convenience only.
    }
    return () => {
      live = false;
    };
  }, []);

  const keep = (e: string) => !reactions || REACTABLE(e);
  const sections = useMemo(() => {
    if (!groups) return [];
    const q = query.trim().toLowerCase();
    if (q) {
      const found = groups
        .flatMap((g) => g.emojis)
        .filter((e) => e.name.includes(q))
        .map((e) => withTone(e, tone))
        .filter(keep);
      return [
        { id: 'search', label: `Results for “${query.trim()}”`, emojis: found.slice(0, 240) },
      ];
    }
    return [
      { id: 'recent', label: 'Recent', emojis: recent.filter(keep) },
      ...groups.map((g) => ({
        id: g.slug,
        label: GROUP_LABELS[g.name] ?? g.name,
        emojis: g.emojis.map((e) => withTone(e, tone)).filter(keep),
      })),
    ].filter((s) => s.emojis.length > 0 || s.id === 'recent');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, query, tone, recent, reactions]);

  const pick = (emoji: string) => {
    const next = [emoji, ...recent.filter((e) => e !== emoji)].slice(0, 32);
    setRecent(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
    onPick(emoji);
  };

  const jump = (id: string) => {
    setActive(id);
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-section="${id}"]`);
    if (el && scrollRef.current) scrollRef.current.scrollTop = el.offsetTop - 4;
  };

  const onScroll = () => {
    const box = scrollRef.current;
    if (!box) return;
    let current = sections[0]?.id ?? 'recent';
    for (const el of box.querySelectorAll<HTMLElement>('[data-section]'))
      if (el.offsetTop - box.scrollTop <= 24) current = el.dataset.section!;
    setActive(current);
  };

  const tabs = [
    { id: 'recent', label: 'Recent', Icon: Clock },
    ...(groups ?? []).map((g) => ({
      id: g.slug,
      label: GROUP_LABELS[g.name] ?? g.name,
      Icon: GROUP_ICONS[g.name] ?? Smile,
    })),
  ];

  return (
    <div className={cx('flex flex-col bg-wa-panel text-fg', className)}>
      {!query && (
        <div
          className="flex items-center gap-0.5 overflow-x-auto border-b border-wa-divider px-2"
          role="tablist"
          aria-label="Emoji categories"
        >
          {tabs.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active === id}
              aria-label={label}
              title={label}
              onClick={() => jump(id)}
              className={cx(
                'relative inline-flex size-10 shrink-0 items-center justify-center text-wa-icon hover:text-fg',
                active === id && 'text-brand',
              )}
            >
              <Icon className="size-5" aria-hidden />
              {active === id && (
                <span className="absolute inset-x-1.5 bottom-0 h-0.5 rounded-full bg-brand" />
              )}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2 px-3 py-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search emoji</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-wa-icon"
            aria-hidden
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search emoji"
            className="min-h-9 w-full rounded-lg bg-wa-input pr-3 pl-9 text-sm placeholder:text-wa-icon wa-field"
          />
        </label>
        <div className="relative">
          <button
            type="button"
            aria-label="Skin tone"
            title="Skin tone"
            aria-expanded={toneOpen}
            onClick={() => setToneOpen((v) => !v)}
            className="inline-flex size-9 items-center justify-center rounded-lg text-xl hover:bg-wa-hover"
            style={{ fontFamily: EMOJI_FONT }}
          >
            {`\u{1F44B}${tone}`}
          </button>
          {toneOpen && (
            <div className="absolute right-0 bottom-full z-20 mb-1 flex gap-0.5 rounded-xl bg-surface p-1 shadow-pop">
              {TONES.map((t) => (
                <button
                  key={t || 'default'}
                  type="button"
                  aria-label={t ? `Skin tone ${TONES.indexOf(t)}` : 'Default skin tone'}
                  onClick={() => {
                    setTone(t);
                    setToneOpen(false);
                    try {
                      localStorage.setItem(TONE_KEY, t);
                    } catch {
                      // ignore
                    }
                  }}
                  className={cx(
                    'inline-flex size-9 items-center justify-center rounded-lg text-xl hover:bg-wa-hover',
                    tone === t && 'bg-wa-active',
                  )}
                  style={{ fontFamily: EMOJI_FONT }}
                >
                  {`\u{1F44B}${t}`}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="scroll-thin relative min-h-0 flex-1 overflow-y-auto px-2 pb-2"
      >
        {failed && <p className="p-4 text-center text-sm text-muted">Emoji could not be loaded.</p>}
        {!groups && !failed && <p className="p-4 text-center text-sm text-muted">Loading…</p>}
        {sections.map((section) => (
          <section key={section.id} data-section={section.id} aria-label={section.label}>
            <h3 className="sticky top-0 z-10 bg-wa-panel px-1 py-1.5 text-xs font-semibold text-wa-meta-in">
              {section.label}
            </h3>
            {section.emojis.length === 0 ? (
              <p className="px-1 pb-2 text-sm text-muted">
                {section.id === 'search' ? 'No emoji found.' : 'Emoji you use show up here.'}
              </p>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(2.5rem,1fr))]">
                {section.emojis.map((emoji, i) => (
                  <button
                    key={`${emoji}-${i}`}
                    type="button"
                    aria-label={emoji}
                    onClick={() => pick(emoji)}
                    className="inline-flex size-10 items-center justify-center rounded-lg text-[1.6rem] leading-none hover:bg-wa-hover"
                    style={{ fontFamily: EMOJI_FONT }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

/** "😂", "👍🏽🔥" … up to three emoji and nothing else: shown big, as in WhatsApp. */
export function emojiOnlyCount(text: string | null | undefined): number {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 40 || /[\p{L}\p{N}]/u.test(trimmed.replace(/️|⃣/g, ''))) return 0;
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const parts = [...segmenter.segment(trimmed.replace(/\s+/g, ''))].map((s) => s.segment);
  if (parts.length === 0 || parts.length > 3) return 0;
  return parts.every((p) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(p))
    ? parts.length
    : 0;
}
