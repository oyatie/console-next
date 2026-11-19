<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Avatar

An `Avatar` shows a person's photo or leading initial beside their name, in a row, header, frame bar, or record head.

It lives in `apps/web/src/ui/avatar`: the component in `avatar.tsx` and its styles in `avatar.module.css`.

## When to use it, and when not

Use it beside a person's name in a list, account control, or employee record header.

| Do not use it for | Use instead |
|---|---|
| A status indicator or category badge | `Chip`: see [Chip](chip.md). |
| A numeric count | `Badge`: see [Badge](badge.md). |

## Anatomy

- When `src` passes `safeMediaUrl`: `<img src="..." alt="...">`.
- Otherwise, when `fallbackAlt` is provided: `<span role="img" aria-label="...">` holding the first character of `name.trim()`.
- Otherwise (when the person's name already stands beside it): `<span aria-hidden="true">` holding the first character of `name.trim()`.

## Looks and sizes

| Prop | Values | Behaviour |
|---|---|---|
| `size` | `sm`, `md` (default), `lg` | `sm` uses `--chip-h`, `md` uses `--target`, and `lg` draws a `calc(var(--space-6) * 2)` record portrait with `--radius-lg` and a 1 px `--border`. `sm` and `md` take `--radius-avatar` (`50%` on baseline, `2px` under Control room). |
| `tone` | `default`, `accent` | `default` uses `--muted` and `--steel`; `accent` uses `--primary` and `--on-primary` (resolving to `--chrome-accent` and `--chrome` inside `[data-surface="chrome"]`). |

## States

There is no hover, focus, pressed, disabled, read-only, invalid, or loading state on `Avatar` itself.

## Keyboard

None. `Avatar` is non-interactive; keyboard focus belongs to any enclosing link or button.

## Accessibility contract

- **Decorative initial (default fallback):** `aria-hidden="true"` so the initial is not read ahead of the adjacent name.
- **Named photo (`src` + `alt`):** `<img>` named by `alt` (or `alt=""` when decorative).
- **Named missing photo (`fallbackAlt`):** `role="img"` named by `fallbackAlt`.
- **WCAG 2.2:** 1.1.1 Non-text Content and 1.4.3 Contrast (Minimum) (`--steel` on `--muted` and `--on-primary` on `--primary` both hold ≥ 4.5:1).

## Phone behaviour at 390 px

`sm` and `md` follow `--chip-h` and `--target` at phone widths; `lg` stays 64 px.

## Copy rules

`Avatar` owns no message ids; `alt` and `fallbackAlt` come from the caller's catalog messages.

## Props

<!-- ds:props apps/web/src/ui/avatar/avatar.tsx -->

### Avatar

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `name` | yes | `string` |  | Person display name whose leading character supplies the fallback initial. |
| `alt` | no | `string` |  | Accessible name for `src` when non-decorative. |
| `fallbackAlt` | no | `string` |  | Accessible name for the initial fallback when non-decorative. |
| `size` | no | `"lg" \| "md" \| "sm"` | `"md"` | Visual size step (`sm`, `md`, or `lg`). |
| `src` | no | `string` |  | Validated photo URL when present. |
| `tone` | no | `"accent" \| "default"` | `"default"` | Optional `accent` fill for the signed-in actor mark on the frame. |

<!-- /ds:props -->

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/avatar/avatar.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border` |
| `--chip-h` | `height`, `width` |
| `--fw-strong` | `font-weight` |
| `--muted` | `background` |
| `--on-primary` | `color` |
| `--primary` | `background` |
| `--radius-avatar` | `border-radius` |
| `--radius-lg` | `border-radius` |
| `--space-6` | `height`, `width` |
| `--steel` | `color` |
| `--target` | `height`, `width` |
| `--text-lg` | `font-size` |
| `--text-xs` | `font-size` |

<!-- /ds:tokens -->
