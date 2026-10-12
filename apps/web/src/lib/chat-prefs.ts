'use client';

import { create } from 'zustand';

/** WhatsApp-style chat preferences. Kept on this device only, like WhatsApp Web. */
export type Wallpaper = 'doodle' | 'plain' | 'sand' | 'mint' | 'sky' | 'blush' | 'slate';
export type ChatFontSize = 'small' | 'medium' | 'large';

export interface ChatPrefs {
  wallpaper: Wallpaper;
  /** Enter sends the message; Shift+Enter adds a new line. Off: Enter adds a new line. */
  enterToSend: boolean;
  fontSize: ChatFontSize;
}

const KEY = 'sma.chatPrefs';
const DEFAULTS: ChatPrefs = { wallpaper: 'doodle', enterToSend: true, fontSize: 'medium' };

function load(): ChatPrefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<ChatPrefs>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export const useChatPrefs = create<ChatPrefs & { set: (patch: Partial<ChatPrefs>) => void }>(
  (setState, get) => ({
    // Server render and first paint use defaults; hydrateChatPrefs() applies the saved ones.
    ...DEFAULTS,
    set: (patch) => {
      setState(patch);
      const { wallpaper, enterToSend, fontSize } = get();
      try {
        window.localStorage.setItem(KEY, JSON.stringify({ wallpaper, enterToSend, fontSize }));
      } catch {
        // Storage unavailable (private mode): the choice lasts until the page closes.
      }
    },
  }),
);

/** Wallpaper colours (light, dark). `doodle` uses the patterned WhatsApp-style background. */
export const WALLPAPERS: Record<Wallpaper, { label: string; light: string; dark: string }> = {
  doodle: { label: 'Doodles', light: '', dark: '' },
  plain: { label: 'Plain', light: '#efeae2', dark: '#0b141a' },
  sand: { label: 'Sand', light: '#f3e3c7', dark: '#2a2117' },
  mint: { label: 'Mint', light: '#d9f0e1', dark: '#13261c' },
  sky: { label: 'Sky', light: '#d6e8f5', dark: '#122130' },
  blush: { label: 'Blush', light: '#f6dde2', dark: '#2c171c' },
  slate: { label: 'Slate', light: '#dfe3e8', dark: '#1a1f26' },
};

export const FONT_SIZES: Record<ChatFontSize, { label: string; px: number }> = {
  small: { label: 'Small', px: 14 },
  medium: { label: 'Medium', px: 15.5 },
  large: { label: 'Large', px: 18 },
};

/** Applies the preferences saved on this device (call once after the app mounts). */
export function hydrateChatPrefs(): void {
  useChatPrefs.setState(load());
}
