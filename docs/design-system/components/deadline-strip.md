<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Deadline strip

`DeadlineStrip` maps dated and undated worklist items across overdue, today, upcoming, and undated day columns in two horizontal lanes (`statutory` and `operational`).

## When to use it, and when not

| Use it for |
|---|
| Showing the near-term calendar distribution of open worklist items directly beneath a worklist table. |

| Do not use it for | Use instead |
|---|---|
| Full-month person-by-day attendance editing | [`PersonDayGrid`](person-day-grid.md). |
| Selecting a single calendar date in a form | [`DateCalendar`](date.md). |

## Anatomy

| Part | Element | Purpose |
|---|---|---|
| Root | `<section data-deadline-strip>` | Named region (`uiWorklist.schedule`) containing `PaneHead` and the scrollable table. |
| Scroller | `<div role="region" tabIndex={0}>` | Keyboard-scrollable horizontal container when day columns exceed viewport width. |
| Table | `<table>` | Two header rows (bucket bands + day numbers) and two body rows (`uiWorklist.statutoryLane` and `uiWorklist.operationalLane`). |
| Entry pill | `<button type="button">` | Focusable badge (`aria-label={entry.fullLabel}`, `aria-pressed`) that selects the corresponding item. |

## Looks and sizes

Statutory pills use high-contrast `--ink` fill with `--surface` text; operational pills use bordered `--surface`, `--over-bg`, or `--due-bg` fills; the active selection uses `--primary` fill with `--on-primary` text. Every interactive pill meets `--target` (`24px` on Console desk, `44px` on Console phone).

## States

Each pill supports rest, hover, `:focus-visible`, and `aria-pressed="true"` (`data-selected="true"`). Empty cells render blank without placeholder clutter.

## Keyboard

| Key | What it does |
|---|---|
| `Tab` / `Shift+Tab` | Moves focus to the scrollable region and across interactive item pills. |
| `ArrowLeft` / `ArrowRight` on scroller | Scrolls overflowing day columns horizontally. |
| `Enter` / `Space` on pill | Calls `onSelect(entry.id)`. Korean input composition does not trigger selection. |

## Accessibility contract

The schedule is a native `<table>` with `scope="colgroup"`, `scope="col"`, and `scope="row"` headers, wrapped in a named `tabIndex={0}` scroll container (WCAG 2.1.1), and each abbreviated pill carries its full item description in `aria-label` (WCAG 2.2 AA 1.3.1, 2.4.6, 2.5.8).

## Phone behaviour at 390 px

At `390px`, the strip scrolls horizontally inside its `tabIndex={0}` container without widening the page, and pills expand to `44px` touch targets.

## Copy rules

Built-in headings and lane labels read `uiWorklist.schedule`, `uiWorklist.overdue`, `uiWorklist.today`, `uiWorklist.upcoming`, `uiWorklist.undated`, `uiWorklist.statutoryLane`, and `uiWorklist.operationalLane` from `packages/i18n`.

## Props

<!-- ds:props apps/web/src/ui/deadline-strip/deadline-strip.tsx -->

### DeadlineStrip

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `days` | yes | `readonly StripDay[]` |  | Ordered day columns shown across the strip. |
| `entries` | yes | `readonly StripEntry[]` |  | Worklist entries placed into `statutory` or `operational` cells. |
| `monthLabel` | yes | `string` |  | Leading month cell label (for example `"Nov"` or `"11"`). |
| `meta` | no | `ReactNode` |  | Summary text shown beside the strip heading. |
| `onSelect` | no | `(id: string) => void` |  | Invoked when a badge inside the strip is pressed. |
| `selectedId` | no | `string` |  | Currently selected worklist item id. |

<!-- /ds:props -->

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/deadline-strip/deadline-strip.module.css -->

| Token | Read by |
| --- | --- |
| `--border-soft` | `border-block-end`, `border-inline-end` |
| `--cell-px` | `padding-inline` |
| `--control-border` | `border` |
| `--danger-tx` | `color` |
| `--due-bg` | `background` |
| `--due-tx` | `border-color`, `color` |
| `--fw-medium` | `font-weight` |
| `--fw-semibold` | `font-weight` |
| `--fw-strong` | `font-weight` |
| `--ink` | `background`, `border-color`, `color` |
| `--on-primary` | `color` |
| `--over-bg` | `background` |
| `--over-tx` | `border-color`, `color` |
| `--primary` | `background`, `border-color` |
| `--radius-sm` | `border-radius` |
| `--space-1` | `min-width`, `padding` |
| `--space-2` | `min-width` |
| `--space-5` | `min-width` |
| `--space-6` | `min-width` |
| `--space-half` | `gap`, `padding` |
| `--steel` | `color` |
| `--surface` | `background`, `color` |
| `--surface-2` | `background` |
| `--target` | `min-height` |
| `--text-xs` | `font-size` |

<!-- /ds:tokens -->
