<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Meter

`Meter` shows how much of a known total a value represents, either as a compact continuous bar or as a segmented strip of discrete cells with optional pending allocation.

It lives in `apps/web/src/ui/meter/meter.tsx` and exports `Meter` and `MeterProps`.

## When to use it, and when not

Use it for a read-only reading inside a known range, paired with visible words or a legend beside it: retention period remaining (`features/people/ui/roster-table.tsx`) or annual leave allocation (`cells={30}` half-day cells).

| Do not use it for | Use instead |
|---|---|
| The progress of a running task | A `role="progressbar"` element (`ui/setup-rail/setup-rail.tsx`, `features/import/ui/job-step.tsx`). |
| The steps of a task, done and still to do | `StepLine` (`ui/step-line`). |
| Whose turn it is in a chain of people | [`ChainStepper`](chain-stepper.md). |
| The days left to a legal deadline | [`DeadlineChip`](deadline-chip.md). |
| The count on a filter | `Count` (`ui/count`). |
| A count the view acts on, as a number | `StatRow`: see [Key-value](key-value.md). |
| The loading shape of a view | `Skeleton` (`ui/skeleton`). |

## Anatomy

| Part | Element | Holds |
|---|---|---|
| Track | `<span role="meter">` | `aria-label` (`label`), `aria-valuemin="0"`, `aria-valuemax` (`max`), `aria-valuenow` (`value`), optional `aria-valuetext` (`valueText`), `data-warn="true"`, and `data-segmented="true"` when `cells > 0`. |
| Fill (continuous) | `<span />` | Self-closing element with `--pct` width (`2%..100%` when `max > 0`, `0%` otherwise). |
| Cells (segmented) | `<span />` × `cells` | Self-closing `aria-hidden="true"` cells with `data-state` (`used`, `partial-used`, `pending`, `partial-pending`, `rest`); partial cells receive `--pct` via `ref`. |

## Looks and sizes

- **Continuous mode** (default, when `cells` is omitted or `<= 0`): `72px` (`calc(var(--space-6) * 2.25)`) wide by `8px` (`--space-2`) high, `--muted` track with `--control-border` fill (or `--warn-solid` when `warn` is set).
- **Segmented mode** (`cells > 0`): full-width CSS grid (`grid-auto-flow: column`, `gap: var(--space-half)`, height `--space-4` `16px`).
  - `used`: `--ink` fill and border (or `--warn-solid` when `warn` is set).
  - `pending`: `2px solid var(--primary)` border with `--primary-soft` fill.
  - `partial-used` / `partial-pending`: single-element `linear-gradient` driven by `--pct`.
  - `rest`: `1px solid var(--control-border)` border with `--surface` background.

## States

| State | What changes |
|---|---|
| Rest | Default continuous or segmented rendering. |
| Warn (`warn`) | Used fill turns `--warn-solid`. |
| Pending (`pending`) | Segmented cells after `value` up to `value + pending` render with `--primary` outline and `--primary-soft` fill. |
| Empty | When `max <= 0`, continuous mode draws an empty track (`0%`) and segmented mode draws all `rest` cells. |
| Full | Values at or above `max` clamp at `100%` / all cells `used`. |
| Hover / Focus / Pressed / Disabled | None; `Meter` is non-interactive. |

## Keyboard

None. `Meter` handles no key and is not a tab stop.

## Accessibility contract

| Part | Role | Accessible name | Also exposed |
|---|---|---|---|
| Track | `meter` | `label` via `aria-label`. | `aria-valuemin="0"`, `aria-valuemax`, `aria-valuenow`, optional `aria-valuetext`. |
| Fill / Cells | None (`aria-hidden="true"` on cells) | None. | Nothing. |

WCAG 2.2 criteria:
- 1.1.1 Non-text Content & 4.1.2 Name, Role, Value: `role="meter"` with `aria-label`, range bounds, and optional human-readable `aria-valuetext`.
- 1.4.1 Use of Color: callers place visible words or a legend beside the meter; `valueText` communicates both used and pending amounts to assistive technology.
- 1.4.11 Non-text Contrast: continuous fill (`>= 3.16:1`) and segmented borders/fills (`--ink`, `--primary`, `--control-border`, `--warn-solid` on `--surface`) meet `>= 3:1` non-text contrast in light and dark themes.

## Phone behaviour at 390 px

Continuous mode stays `72px × 8px`. Segmented mode spans `100%` of its container width (`30` cells fit cleanly inside a `390px` viewport without horizontal overflow).

## Copy rules

`Meter` holds no catalog text of its own. Callers provide `label` and `valueText` from `@console/i18n` (and pair visible text or a legend beside the meter).

## Props

<!-- ds:props apps/web/src/ui/meter/meter.tsx -->

### Meter

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `label` | yes | `string` |  | Accessible name for `aria-label` (never visible). |
| `max` | yes | `number` |  | Maximum range value (`> 0`). |
| `value` | yes | `number` |  | Current measured value in `[0, max]`. |
| `cells` | no | `number` |  | Optional cell count for segmented display (for example `30` half-day cells for 15-day leave). |
| `pending` | no | `number` |  | Optional proposed increment after `value` shown in segmented mode. |
| `valueText` | no | `string` |  | Optional human-readable reading for `aria-valuetext`. |
| `warn` | no | `boolean` |  | Highlight the fill with warning colour. |

<!-- /ds:props -->

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/meter/meter.module.css -->

| Token | Read by |
| --- | --- |
| `--control-border` | `background`, `border` |
| `--ink` | `background`, `border-color` |
| `--muted` | `background` |
| `--pct` | `background`, `width` |
| `--primary` | `background`, `border` |
| `--primary-soft` | `background` |
| `--radius-sm` | `border-radius` |
| `--space-2` | `height` |
| `--space-4` | `height` |
| `--space-6` | `width` |
| `--space-half` | `gap` |
| `--surface` | `background` |
| `--warn-solid` | `background`, `border-color` |

<!-- /ds:tokens -->

`--pct` is registered locally in `meter.module.css` via `@property --pct` and set per element in `meter.tsx`.
