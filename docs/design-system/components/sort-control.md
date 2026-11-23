<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Sort control

`SortControl` is a compact command-strip readout and toggle that displays the active sort field and switches sort field or ascending/descending order.

## When to use it, and when not

| Use it for |
|---|
| Showing and changing list sort order inside a `PageHead` command strip (`1` or multiple fields). |

| Do not use it for | Use instead |
|---|---|
| Interactive column-header sorting inside `LongTable` | `LongTable` column `sort` metadata. |
| Filtering rows by status or category | `Segmented` (`ui/button`) or `SelectField` (`ui/select`). |

## Anatomy

| Part | Element | Purpose |
|---|---|---|
| Group | `<div role="group">` | Named control group (`aria-label` defaulting to `uiLongTable.sort`). |
| Prefix | `<bdi>` | Muted sort prefix label. |
| Field selector | `<select>` | Rendered only when `fields.length > 1` to switch the active sort field. |
| Direction button | `Button` (`variant="ghost"`, `size="sm"`) | Toggles between `"asc"` and `"desc"` with an arrow icon (`aria-hidden="true"`). |

## Looks and sizes

`SortControl` aligns to `--control-h` (`24px` on Console desk, `44px` on Console phone, `36px` on Classic) and uses `--text-sm` semibold text for the active sort criterion.

## States

Hover and focus states follow `Button` (`ghost`, `sm`) and `.fieldSelect:hover` (`--surface-hover` background, `--control-border` outline). There is no invalid state.

## Keyboard

| Key | What it does |
|---|---|
| `Tab` / `Shift+Tab` | Moves focus across the optional `<select>` and the direction `Button`. |
| `Enter` / `Space` on direction button | Flips `direction` between `"asc"` and `"desc"`. |
| `ArrowUp` / `ArrowDown` on `<select>` | Native `<select>` field navigation; Korean input composition does not trigger accidental submits. |

## Accessibility contract

The outer `<div role="group">` carries `aria-label` (`uiLongTable.sort` by default), and the direction button announces both the active field and current sort direction (`uiLongTable.ascending` or `uiLongTable.descending`) so icon direction is never conveyed visually alone (WCAG 2.2 AA 1.3.1, 2.5.8, 4.1.2).

## Phone behaviour at 390 px

At phone widths (`--phone`), `--control-h` and `--target` expand to `44px`, giving both the field selector and direction button full `44px` touch height.

## Copy rules

Built-in labels read `uiLongTable.sort`, `uiLongTable.ascending`, and `uiLongTable.descending` from `packages/i18n`. Caller field labels come from `packages/i18n`.

## Props

<!-- ds:props apps/web/src/ui/sort-control/sort-control.tsx -->

### SortControl

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `direction` | yes | `"asc" \| "desc"` |  | Active sort order (`"asc"` or `"desc"`). |
| `field` | yes | `T` |  | Currently active field identifier. |
| `fields` | yes | `readonly { id: T; label: string; }[]` |  | Sortable fields offered in the command strip (`1` or more). |
| `onChange` | yes | `(next: { field: T; direction: "asc" \| "desc"; }) => void` |  | Invoked whenever the sort field or direction changes. |
| `label` | no | `string` |  | Accessible group label; defaults to `uiLongTable.sort`. |

<!-- /ds:props -->

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/sort-control/sort-control.module.css -->

| Token | Read by |
| --- | --- |
| `--control-h` | `height`, `min-height` |
| `--fw-semibold` | `font-weight` |
| `--ink` | `color` |
| `--radius` | `border-radius` |
| `--space-1` | `gap`, `margin-inline-end`, `padding`, `padding-inline` |
| `--steel` | `color` |
| `--surface-hover` | `background` |
| `--text-sm` | `font-size` |
| `--text-xs` | `font-size` |

<!-- /ds:tokens -->
