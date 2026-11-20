<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Due cell

`DueCell` renders a server-computed remaining-days readout (`<data>`) for worklist and statutory table cells, pairing icons and words with five cell-level tones (`over`, `today`, `near`, `far`, `undated`).

## When to use it, and when not

| Use it for |
|---|
| Showing days remaining or overdue in a worklist, inbox, or statutory filing column. |

| Do not use it for | Use instead |
|---|---|
| Standalone D-n pills accompanied by a legal basis sentence or accruing-interest notice | [`DeadlineChip`](deadline-chip.md). |
| Non-temporal workflow statuses | [`Chip`](chip.md). |

## Anatomy

| Part | Element | Purpose |
|---|---|---|
| Root | `<data>` | Machine-readable day count (`value`) styled with `data-tone` and optional `data-fill`. |
| Icon | `<svg aria-hidden="true">` | Warning triangle on `over`; clock glyph on `today`. |
| Text | `<bdi>` | Localized day phrase (`uiDeadlineChip.over`, `uiWorklist.today`, `uiDeadlineChip.left`, or `uiWorklist.undated`). |

## Looks and sizes

Inline form (`fill={false}`) aligns to `--row-h-compact` with `--radius-sm`. Full-cell form (`fill={true}`) stretches across `--row-h` with edge-to-edge `--over-bg` or `--due-bg` tint.

## States

`data-tone` is `"over"` (`days < 0`), `"today"` (`days === 0`), `"near"` (`1 <= days <= nearWindow`), `"far"` (`days > nearWindow`), or `"undated"` (`days == null`). `DueCell` is non-interactive; there is no hover, pressed, or disabled state.

## Keyboard

`DueCell` is static read content and receives no keyboard focus of its own; parent table or grid rows own keyboard navigation.

## Accessibility contract

Urgency is never communicated by colour alone: `over` and `today` carry explicit words and decorative icons (`aria-hidden="true"`), and every tone meets WCAG 2.2 AA `4.5:1` text contrast against its ground (WCAG 1.4.1, 1.4.3).

## Phone behaviour at 390 px

At phone widths (`--phone`), `--text-xs` steps up from `12px` to `13px` and `--row-h` steps up to `48px` in Console.

## Copy rules

Built-in copy reads `uiDeadlineChip.over`, `uiDeadlineChip.left`, `uiWorklist.today`, and `uiWorklist.undated` from `packages/i18n`.

## Props

<!-- ds:props apps/web/src/ui/due-cell/due-cell.tsx -->

### DueCell

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `days` | yes | `number \| null \| undefined` |  | Server-computed days remaining (`< 0` overdue, `0` today, `> 0` future, `null`/`undefined` undated). |
| `fill` | no | `boolean` | `false` | Stretch across a table cell with edge-to-edge background tint on `over` and `today`. |
| `nearWindow` | no | `number` | `7` | Days threshold within which upcoming items take semibold `near` emphasis (`7` by default). |

<!-- /ds:props -->

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/due-cell/due-cell.module.css -->

| Token | Read by |
| --- | --- |
| `--cell-px` | `padding-inline` |
| `--due-bg` | `background` |
| `--due-tx` | `color` |
| `--faint` | `color` |
| `--fw-semibold` | `font-weight` |
| `--ink` | `color` |
| `--over-bg` | `background` |
| `--over-tx` | `color` |
| `--radius-sm` | `border-radius` |
| `--row-h` | `min-height` |
| `--row-h-compact` | `min-height` |
| `--space-1` | `gap` |
| `--space-1-5` | `padding` |
| `--space-half` | `margin-block` |
| `--steel` | `color` |
| `--text-xs` | `font-size` |

<!-- /ds:tokens -->
