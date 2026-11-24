<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Ledger

`Ledger` renders a rule-divided itemized financial or payroll breakdown using a semantic `<section>` and `<table>` with `tabular-nums` alignment, optional basis details, and subtotal/total footer rows.

It lives in `apps/web/src/ui/ledger/ledger.tsx`, with styles in `ledger.module.css` and barrel exports in `index.ts`.

## When to use it, and when not

Use it for itemized earnings, deductions, settlements, or tax breakdowns that pair item labels with numeric amounts and optional calculation basis text.

| Do not use it for | Use instead |
|---|---|
| General entity metadata or non-tabular key-value pairs | [`KeyValue`](key-value.md). |
| Headline metric tiles | `StatRow` in [Key-value](key-value.md). |
| Multi-employee sortable registers or paginated lists | `Table` or [`LongTable`](long-table.md). |

## Anatomy

| Part | Element | Purpose |
|---|---|---|
| Root | `<section data-ledger="">` | Named via `aria-labelledby` (when `title` is set) or `aria-label` (`label`). |
| Header | `<header>` | Optional visible heading (`level`), `headerTag` chip, and right-aligned `unit`. |
| Table | `<table>` | Holds `<thead className="sr-only">`, `<tbody>` rows, and optional `<tfoot>` totals. |
| Row item | `<th scope="row">` | Row label plus inline `detail` when `detailLayout="inline"`. |
| Basis cell | `<td>` | Middle detail column when `detailLayout="column"` and any row or total provides `detail`. |
| Amount cell | `<td>` | Right-aligned `tabular-nums` value, wrapped in `<data value>` when `numericValue` is set. |
| State blocks | `<div>` outside `<table>` | `error` (`role="alert"`), `loading` (`role="status"`), and `empty` replace `<table>`. |
| Footnote | `<div>` | Optional summary note rendered below the table when not loading or errored. |

## Looks and sizes

- `headerSurface`: `"surface"` (default) draws a `28px` (`--row-h`) white header with a bottom border for embedded desktop panes; `"muted"` draws a `32px` (`--space-6`) `--surface-2` band with top and bottom borders for standalone mobile sections.
- `detailLayout`: `"column"` (default) aligns `detail` in a dedicated middle column; `"inline"` places `detail` beside the row label in a muted tone.
- Row `tone`: `"default"`, `"negative"` (`--danger-tx`, paired with caller-supplied minus sign), `"zero"` (`--faint`), and `"muted"` (`--steel`).
- Total `kind`: `"subtotal"`, `"total"` (default, bold with `--border-strong` top rule and `--surface-2` wash on desktop), and `"note"` (compact derived line below totals).

## States

Supports `loading` (two skeleton bars inside `role="status"`), `empty` (rendered when `rows.length === 0`), and `error` (`role="alert"`). All three render outside `<table>` so table semantics remain valid. Interactive links passed inside `detail` inherit `:focus-visible` outlines.

## Keyboard

`Ledger` is read-only and adds no tab stops. If `titleId` is provided, the heading receives `tabIndex={-1}` for programmatic focus without entering the tab order. Any link passed inside `detail` remains keyboard focusable.

## Accessibility contract

| Part | Role | Accessible name | Also exposed |
|---|---|---|---|
| Section | `region` | Heading via `aria-labelledby`, or `label`. | `aria-busy="true"` while `loading` (cleared when `error` is set). |
| Table | `table` | Same heading or `label`. | `sr-only` `<th scope="col">` headers; `<th scope="row">` per line. |
| Error / Loading | `alert` / `status` | Content text. | Rendered as siblings of `<table>`, never inside it. |

WCAG 2.2 criteria:
- 1.3.1 Info and Relationships: semantic `<th scope="col">` and `<th scope="row">` inside `<tbody>` and `<tfoot>`.
- 1.4.1 Use of Color & 1.4.3 Contrast: negative amounts pair `--danger-tx` with an explicit minus sign; all tones meet 4.5:1 text contrast on `--surface` and `--surface-2`.
- 1.4.10 Reflow: both `column` and `inline` detail layouts wrap without horizontal scrolling at `390px`.

## Phone behaviour at 390 px

At `--phone`, body font size steps up to `--text-body` (`15px`), itemized rows step up to `40px` (`--row-h-sm`), total rows step up to `48px` (`--row-h`), horizontal padding widens to `--space-4`, and `inline` totals sit on `--surface`.

## Copy rules

Built-in column headers read `uiLedger.colItem`, `uiLedger.colDetail`, and `uiLedger.colAmount` from `@console/i18n` (overridable via `columns`). Callers supply localized item labels, formatted amounts (with currency and minus signs), and calculation basis strings.

## Props

<!-- ds:props apps/web/src/ui/ledger/ledger.tsx -->

### Ledger

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `rows` | yes | `readonly LedgerRow[]` |  | Itemized ledger lines rendered in `<tbody>`. |
| `columns` | no | `{ item?: string \| undefined; detail?: string \| undefined; amount?: string \| undefined; }` |  | Custom `sr-only` table column labels (defaults to `uiLedger.colItem`, `uiLedger.colDetail`, `uiLedger.colAmount`). |
| `detailLayout` | no | `"column" \| "inline"` | `"column"` | Placement of row `detail`: `"column"` aligns details in a middle column; `"inline"` sits beside `label`. |
| `empty` | no | `ReactNode` |  | Empty state content shown when `rows.length === 0` and not loading or error. |
| `error` | no | `ReactNode` |  | Error alert content shown when truthy, replacing rows. |
| `footnote` | no | `ReactNode` |  | Optional footer text rendered beneath the table when non-null. |
| `headerSurface` | no | `"muted" \| "surface"` | `"surface"` | Header surface style: `"surface"` for embedded desk panes, `"muted"` for standalone phone bands. |
| `headerTag` | no | `ReactNode` |  | Optional badge or status chip placed beside `title`. |
| `label` | no | `string` |  | Accessible name for the section and table when `title` is omitted or extra context is needed. |
| `level` | no | `2 \| 3 \| 4` | `3` | Heading level (`3` by default). |
| `loading` | no | `boolean` |  | Busy loading state replacing rows with a skeleton outside `<table>`. |
| `title` | no | `ReactNode` |  | Visible section heading. |
| `titleId` | no | `string` |  | Optional id applied to the heading element for external focus management. |
| `totals` | no | `readonly LedgerTotalRow[]` |  | Subtotal, total, and derived summary rows rendered in `<tfoot>`. |
| `unit` | no | `ReactNode` |  | Right-aligned unit header text. |

<!-- /ds:props -->

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/ledger/ledger.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border-block-end`, `border-block-start` |
| `--border-soft` | `background`, `border-block-end` |
| `--border-strong` | `border-block-start` |
| `--danger-tx` | `color` |
| `--faint` | `color` |
| `--fw-body` | `font-weight` |
| `--fw-semibold` | `font-weight` |
| `--fw-strong` | `font-weight` |
| `--ink` | `color` |
| `--lh-tight` | `line-height` |
| `--primary` | `color` |
| `--radius-sm` | `border-radius` |
| `--row-h` | `height`, `min-height` |
| `--row-h-sm` | `height` |
| `--space-1` | `gap`, `padding` |
| `--space-1-5` | `padding-block` |
| `--space-2` | `gap`, `padding` |
| `--space-3` | `padding`, `padding-inline-end`, `padding-inline-start` |
| `--space-4` | `padding`, `padding-inline`, `padding-inline-end`, `padding-inline-start` |
| `--space-6` | `min-height` |
| `--steel` | `color` |
| `--surface` | `background` |
| `--surface-2` | `background` |
| `--text-body` | `font-size` |
| `--text-sm` | `font-size` |
| `--text-xs` | `font-size` |

<!-- /ds:tokens -->
