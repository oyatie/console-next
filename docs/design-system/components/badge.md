<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Badge

A `Badge` is a compact numeric count pill placed beside a navigation item, workspace tab, or primary command.

It lives in `apps/web/src/ui/badge`: the component in `badge.tsx`, its styles in `badge.module.css`, and its gallery entry in `badge.gallery.tsx`.

## When to use it, and when not

Use it when a link, tab, or button carries an actionable or summary count that belongs to the control's label.

| Do not use it for | Use instead |
|---|---|
| A status word or enum value | `Chip`: see [Chip](chip.md). |
| A filter button's server count that holds space while loading | `Count` (`ui/count`) or `ToggleButton` with `count`: see [Button](button.md). |
| A keyboard shortcut hint | `Kbd`: see [Key cap](kbd.md). |

## Anatomy

One element: `<data value="<count>" data-tone="<tone>">`, containing the locale-formatted count from `fmtNumber`. Using `<data>` keeps the accessible tree clean while adding zero `<p>` or `<span>` standing-text blocks to importing screens.

## Looks and sizes

One compact height (`--kbd-h`: 20 px on classic baseline, 16 px under Console) with three tones:

| `tone` | Fill and text | Typical placement |
|---|---|---|
| `neutral` (default) | `--muted` fill, `--border` hairline, `--ink` text | Neutral tabs and secondary buttons (automatically adapts inside `[data-surface="chrome"]`). |
| `attention` | `--chrome-attention` fill, `--chrome` text | Actionable module counts in the application frame. |
| `inverse` | `--on-primary` fill, `--primary` text | Count inside a primary button. |

## States

There is no hover, focus, pressed, selected, disabled, read-only, invalid, loading, or empty look on `Badge` itself; when placed inside a disabled button or link, it dims with the parent control.

## Keyboard

None. `Badge` is not focusable and handles no keys.

## Accessibility contract

- **Role:** generic phrasing content (`<data>`), contributing its formatted number to the enclosing link or button's accessible name.
- **Announced:** read as part of the enclosing control's accessible name.
- **WCAG 2.2:** 1.4.3 Contrast (Minimum) is enforced at 4.5:1 across light and dark themes for `--ink` on `--muted`, `--chrome` on `--chrome-attention`, and `--primary` on `--on-primary`.

## Phone behaviour at 390 px

Nothing changes; the pill keeps its compact height and tabular digits at 390 px.

## Copy rules

`Badge` owns no message ids; it formats `count` through `fmtNumber` from `@console/i18n/format`.

## Props

<!-- ds:props apps/web/src/ui/badge/badge.tsx -->

### Badge

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `count` | yes | `number` |  | Numeric count formatted with locale separators. |
| `tone` | no | `BadgeTone` | `"neutral"` | `attention` for actionable frame counts, `inverse` inside a primary button, `neutral` elsewhere. |

<!-- /ds:props -->

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/badge/badge.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border` |
| `--chrome` | `color` |
| `--chrome-attention` | `background` |
| `--fw-strong` | `font-weight` |
| `--ink` | `color` |
| `--kbd-h` | `height`, `min-width` |
| `--muted` | `background` |
| `--on-primary` | `background` |
| `--primary` | `color` |
| `--radius-sm` | `border-radius` |
| `--space-1` | `padding` |
| `--text-xs` | `font-size` |

<!-- /ds:tokens -->
