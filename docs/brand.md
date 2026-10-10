# SMA Brand

Product name in the interface: **SMA** · Company: **SMA Technology**.

## Assets

| File | Use |
| --- | --- |
| `logo.jpeg` (repository root) | Master logo supplied by SMA Technology |
| `apps/web/public/brand/sma-mark.png` | Square figure mark (sidebar, phone header) |
| `apps/web/public/brand/sma-logo.webp` | Full "SMA Technology" logo (sign-in page) |
| `apps/web/src/app/icon.png`, `apple-icon.png` | Browser favicon and home-screen icon |

Regenerate everything after replacing `logo.jpeg`: `npm run brand:assets`.

The logo artwork has a white background, so the mark is always shown on a white tile; it stays
crisp in both light and dark themes.

## Colours

| Token | Light | Dark | Notes |
| --- | --- | --- | --- |
| `--brand` | `#c2410c` | `#ff8f45` | SMA orange. The logo's bright orange (`#f07c22`) is darkened in light mode so white text keeps ≥ 5:1 contrast. |
| `--brand-soft` | `#fff1e6` | `#3a1f0d` | Selected rows, info panels |
| `--bubble-out` | `#ffedd5` | `#4a2812` | Your own messages |
| `--warm-strong` | `#111827` | `#f3f4f6` | Logo black: secondary actions and highlights |

Colour is never the only signal: status always has text or an icon as well.
