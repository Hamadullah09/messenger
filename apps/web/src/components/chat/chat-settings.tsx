'use client';

import { Check } from 'lucide-react';
import {
  FONT_SIZES,
  useChatPrefs,
  WALLPAPERS,
  type ChatFontSize,
  type Wallpaper,
} from '@/lib/chat-prefs';
import { resolvedTheme, useTheme } from '@/lib/theme';
import { cx } from '../ui';

/** Settings → Chats: wallpaper, Enter-to-send and text size (saved on this device). */
export function ChatSettings() {
  const prefs = useChatPrefs();
  const [theme] = useTheme();
  const dark = resolvedTheme(theme) === 'dark';
  return (
    <div className="flex flex-col gap-6">
      <fieldset>
        <legend className="mb-2 font-semibold">Chat wallpaper</legend>
        <div
          role="radiogroup"
          aria-label="Chat wallpaper"
          className="grid grid-cols-4 gap-2 sm:grid-cols-7"
        >
          {(Object.keys(WALLPAPERS) as Wallpaper[]).map((key) => {
            const paper = WALLPAPERS[key];
            const selected = prefs.wallpaper === key;
            return (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={paper.label}
                title={paper.label}
                onClick={() => prefs.set({ wallpaper: key })}
                className={cx(
                  'relative flex aspect-square items-end justify-center overflow-hidden rounded-xl border-2 pb-1 text-[0.7rem] font-semibold',
                  key === 'doodle' && 'wa-wallpaper',
                  selected ? 'border-brand' : 'border-line',
                )}
                style={
                  key === 'doodle'
                    ? { backgroundSize: '90px 90px' }
                    : { backgroundColor: dark ? paper.dark : paper.light }
                }
              >
                {selected && (
                  <span className="absolute top-1 right-1 inline-flex size-5 items-center justify-center rounded-full bg-brand text-brand-contrast">
                    <Check className="size-3.5" aria-hidden />
                  </span>
                )}
                <span className="rounded bg-surface/80 px-1 text-fg">{paper.label}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 font-semibold">Text size in chats</legend>
        <div role="radiogroup" aria-label="Text size in chats" className="grid grid-cols-3 gap-2">
          {(Object.keys(FONT_SIZES) as ChatFontSize[]).map((key) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={prefs.fontSize === key}
              onClick={() => prefs.set({ fontSize: key })}
              className={cx(
                'min-h-12 rounded-2xl border px-3 font-semibold',
                prefs.fontSize === key
                  ? 'border-brand bg-brand-soft text-brand-strong'
                  : 'border-line hover:bg-surface-2',
              )}
              style={{ fontSize: FONT_SIZES[key].px }}
            >
              {FONT_SIZES[key].label}
            </button>
          ))}
        </div>
      </fieldset>

      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 size-5"
          checked={prefs.enterToSend}
          onChange={(e) => prefs.set({ enterToSend: e.target.checked })}
        />
        <span>
          <span className="block font-semibold">Enter is send</span>
          <span className="text-sm text-muted">
            {prefs.enterToSend
              ? 'Enter sends your message. Shift + Enter adds a new line.'
              : 'Enter adds a new line. Ctrl + Enter sends your message.'}
          </span>
        </span>
      </label>
      <p className="text-sm text-muted">
        These chat settings are saved on this device. Mute, pin, archive and group settings are in
        each chat’s info panel (tap the chat name).
      </p>
    </div>
  );
}
