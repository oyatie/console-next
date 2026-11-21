<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Period stepper

`PeriodStepper` steps a controlled business period (`day`, `week`, `month`, or `year`) backward, forward, or back to the current period without owning URL or dirty-form state.

It lives in `apps/web/src/ui/period-stepper/period-stepper.tsx`, with styles in `period-stepper.module.css` and barrel exports in `index.ts`.

## When to use it, and when not

Use it in a command strip, toolbar, or mobile statement bar where the user steps sequentially across days, weeks, months, or years.

| Do not use it for | Use instead |
|---|---|
| Picking an arbitrary calendar date or date range | [`DateField`](date.md). |
| Stepping through an approval chain | [`ChainStepper`](chain-stepper.md). |
| Switching between named page views or tabs | View tabs or [`ModuleNavBar`](module-nav.md). |

## Anatomy

| Part | Element | Purpose |
|---|---|---|
| Group | `<div role="group">` | Pairs the stepper cluster and optional quick-jump button under `aria-label`. |
| Cluster | `<div>` (`data-variant`) | Holds the previous button, period reading, and next button. |
| Step buttons | `IconButton` (`size="sm"`) | Steps backward (`ChevronLeft`) or forward (`ChevronRight`) by one unit. |
| Reading | `<strong>` | Tabular-numeral formatted period string (`fmtDate`, `fmtMonth`, or year format). |
| Jump button | `Button` (`size="sm"`, `variant="ghost"`) | Optional quick-jump to today / this week / this month / this year when `showCurrent` is true. |

## Looks and sizes

- `variant="plain"` (default): ghost chevron icon buttons flanking the tabular reading, matching inline statement toolbars (`390/payslip`) and classic attendance strips.
- `variant="boxed"`: unified bordered control (`1px solid var(--control-border)` outer frame with `1px solid var(--border)` inner vertical dividers) sized to `--target` (`24px` in Console desktop, `44px` on phone, `32px` in baseline).
- `showCurrent`: defaults to `true` for attendance toolbars; set `showCurrent={false}` on compact Console command strips (`1440/attendance`, `1440/payroll`) and phone statement headers (`390/payslip`).

## States

Rest, hover, and `:focus-visible` states are inherited from `Button` and `IconButton`. In `boxed` mode, `:focus-visible` uses a negative `outline-offset` so the focus ring stays crisp inside the bordered frame. There is no disabled, loading, or invalid state of its own.

## Keyboard

Each chevron `IconButton` and the optional quick-jump `Button` are native `<button>` elements, operated via `Tab`, `Enter`, and `Space`. No custom key handler or IME handling is required.

## Accessibility contract

| Part | Role | Accessible name | Also exposed |
|---|---|---|---|
| Root | `group` | `label` prop, defaulting to `attendance.period.label`. | None. |
| Step buttons | `button` | Unit-specific prev/next label from `@console/i18n`. | Tooltip via `title`. |
| Jump button | `button` | Unit-specific current-period label (`uiDate.today` or `attendance.period.*`). | None. |

WCAG 2.2 criteria:
- 1.3.1 Info and Relationships: `role="group"` groups the controls with a shared label.
- 2.1.1 Keyboard & 2.4.7 Focus Visible: native buttons with visible `:focus-visible` outlines.
- 2.5.8 Target Size: `--target` (`24px` desktop, `44px` phone) meets minimum target size requirements.

## Phone behaviour at 390 px

In Console at `--phone`, `--target` steps up to `44px` for touch operation, and `.controls` wraps cleanly (`flex-wrap: wrap`) if `showCurrent` is enabled alongside a long `week` range.

## Copy rules

Built-in labels read existing catalog keys from `@console/i18n`:
- `attendance.period.label`
- `attendanceRecords.toolbar.prevDay`, `attendanceRecords.toolbar.nextDay`, `uiDate.today`
- `attendance.week.prev`, `attendance.week.next`, `attendance.period.thisWeek`
- `attendanceRecords.toolbar.prevMonth`, `attendanceRecords.toolbar.nextMonth`, `attendance.period.thisMonth`
- `attendanceHolidays.year.prev`, `attendanceHolidays.year.next`, `attendanceHolidays.year`, `attendance.period.thisYear`

Dates are formatted via `fmtDate` and `fmtMonth` from `@console/i18n/format`.

## Props

<!-- ds:props apps/web/src/ui/period-stepper/period-stepper.tsx -->

### PeriodStepper

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `onChange` | yes | `(value: string) => void` |  | Called with the shifted or current ISO period string. |
| `unit` | yes | `"day" \| "month" \| "week" \| "year"` |  | Calendar granularity stepped by prev/next and current-period jump. |
| `value` | yes | `string` |  | Current business period (`YYYY-MM-DD`, `YYYY-MM`, or `YYYY`). |
| `disableNext` | no | `boolean` | `false` | Disable stepping forward (e.g. at the latest available period). |
| `disablePrev` | no | `boolean` | `false` | Disable stepping backward (e.g. at the oldest available period). |
| `label` | no | `string` |  | Accessible group label override (defaults to `attendance.period.label`). |
| `showCurrent` | no | `boolean` | `true` | Show the quick-jump button (`today` / `this week` / `this month` / `this year`). |
| `variant` | no | `"boxed" \| "plain"` | `"plain"` | Visual chrome: `plain` (inline chevrons) or `boxed` (unified bordered control). |

<!-- /ds:props -->

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/period-stepper/period-stepper.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border-left`, `border-right` |
| `--control-border` | `border` |
| `--fw-semibold` | `font-weight` |
| `--radius` | `border-radius` |
| `--space-1` | `gap` |
| `--space-2` | `padding` |
| `--space-6` | `min-width` |
| `--space-half` | `min-height` |
| `--surface` | `background` |
| `--target` | `min-height`, `width` |
| `--text-sm` | `font-size` |

<!-- /ds:tokens -->
