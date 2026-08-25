# SettleX Brand Guidelines

The single source of truth for SettleX's visual identity. Keep it consistent across the app, marketing, decks, and partner materials.

## Logo & mark

| Asset | File | Use on |
|---|---|---|
| Primary lockup | [public/brand/logo-horizontal.svg](../public/brand/logo-horizontal.svg) | Light backgrounds (header, docs) |
| Inverse lockup | [public/brand/logo-horizontal-inverse.svg](../public/brand/logo-horizontal-inverse.svg) | Dark backgrounds (footer, dark sections) |
| Mark only | [public/brand/logo-mark.svg](../public/brand/logo-mark.svg) | App icon contexts, avatars, tight spaces |
| Master app icon | [public/brand/icon-master.svg](../public/brand/icon-master.svg) | Source for all generated raster icons (full-bleed, maskable-safe) |
| Mono black | [public/brand/logo-mono-black.svg](../public/brand/logo-mono-black.svg) | Print, single-colour light |
| Mono white | [public/brand/logo-mono-white.svg](../public/brand/logo-mono-white.svg) | Watermarks, single-colour dark/photo |

Raster icons (favicon, Apple touch, PWA 192/512/maskable, social cards) are **generated at build time** from code — no binary files to maintain:
- Favicon: [app/icon.svg](../app/icon.svg)
- Apple touch icon (180×180 PNG): [app/apple-icon.tsx](../app/apple-icon.tsx)
- PWA manifest icons: [app/pwa-icon/route.tsx](../app/pwa-icon/route.tsx) (`/pwa-icon?size=192`, `…?size=512&mask=1`)
- Social / OpenGraph & Twitter (1200×630 PNG): [app/opengraph-image.tsx](../app/opengraph-image.tsx), [app/twitter-image.tsx](../app/twitter-image.tsx), shared layout in [components/og/OgCard.tsx](../components/og/OgCard.tsx)

### Logo rules
- **Clear space:** keep at least the height of the mark's square on all sides.
- **Minimum size:** 24px tall for the mark; 100px wide for the horizontal lockup.
- **Don't:** recolour the bolt; stretch or skew; add shadows/outlines; place the dark lockup on a dark background (use the inverse); rebuild the wordmark in another font.

## Colour

| Token | Hex | Role |
|---|---|---|
| Lime accent | `#B9FF66` | Primary accent — button fills, highlights, the "X" |
| Lime dark | `#9AE040` | Hover/active on lime |
| Lime light | `#D4FFB0` | Subtle tints |
| Ink base | `#0F0F14` | Primary text, dark surfaces, the mark square |
| Ink card | `#1A1A22` | Dark cards |
| Ink muted | `#2A2A35` | Dark borders/dividers |
| Neutral bg | `#F6F6F6` | App background (light) |
| Neutral card | `#FFFFFF` | Cards (light) |
| Neutral border | `#E5E5E5` | Borders (light) |
| Destructive | `#DC2626` | Errors, failed payments |
| Success | `#059669` | Confirmed payments |

### ⚠️ Contrast rule (accessibility, non-negotiable)
Lime `#B9FF66` on white has a contrast ratio of ~1.3:1 — it is **invisible as text**. Lime is a *fill behind dark ink*, or an accent on dark backgrounds. **Never** use lime as foreground text, thin icons, or hairlines on light surfaces. Body text is always ink `#0F0F14` on light or white on dark (both pass WCAG AA).

## Typography

- **Display / UI:** Poppins (self-hosted via `next/font`, weights 300–900). CSS var `--font-poppins`.
- **Monospace:** JetBrains Mono (var `--font-jetbrains-mono`) — use for **all** Stellar addresses, transaction hashes, amounts, and balances. Prevents digit jitter and misreads.
- Headline weights: 800–900. Body: 400–500. Buttons/labels: 600.

## Voice
Confident, plain, honest. We say what the product does, not more. "Settle in seconds," not "revolutionary." Never imply custody, banking, or guarantees we don't provide.
