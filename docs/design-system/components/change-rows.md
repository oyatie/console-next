<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Change rows

`ChangeRows` renders compact before-to-after diff rows (`<dl>`) for side record panes and approval documents.

## When to use it, and when not

| Use it for |
|---|
| Showing proposed field, headcount, or assignment transitions (`subject`, `before`, arrow, `after`) inside a record or approval pane. |

| Do not use it for | Use instead |
|---|---|
| Static single-value facts without a prior state | [`KeyValue`](key-value.md). |
| Chronological audit or event logs | [`ItemList`](item-list.md). |

## Anatomy

| Part | Element | Purpose |
|---|---|---|
| Root | `<dl data-change-rows>` | Named definition list (`aria-label` defaulting to `uiWorklist.changes`). |
| Row | `<div>` (`display: contents`) | Groups each subject `<dt>` with its `<dd>` cells on a 4-column CSS grid. |
| Subject | `<dt>` | Semibold entity, team, or person label. |
| Before / Arrow / After | `<dd>` | Muted prior value, decorative arrow (`aria-hidden="true"`), and semibold proposed value. |

## Looks and sizes

Rows align to `--row-h-compact` (`24px` on Console desk, `40px` on Console phone, `32px` on Classic) with `1px` `--border-soft` hairlines and `--text-xs` typography.

## States

`ChangeRows` is static read content and has no interactive or disabled states.

## Keyboard

`ChangeRows` introduces no tab stops; any links passed inside `before` or `after` keep native link keyboard behaviour.

## Accessibility contract

Uses semantic `<dl>`, `<dt>`, and `<dd>` elements named by `aria-label`, hiding the visual arrow icon (`aria-hidden="true"`) from assistive technology (WCAG 2.2 AA 1.3.1).

## Phone behaviour at 390 px

At `390px`, `minmax(0, 1fr)` columns wrap long before/after text cleanly within the viewport without horizontal overflow.

## Copy rules

Default list name reads `uiWorklist.changes` from `packages/i18n`; row values come from caller data or `packages/i18n`.

## Props

<!-- ds:props apps/web/src/ui/change-rows/change-rows.tsx -->

### ChangeRows

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `items` | yes | `readonly { id: string; subject: ReactNode; before: ReactNode; after: ReactNode; }[]` |  | Diff entries showing each subject's `before` and `after` states. |
| `label` | no | `string` |  | Accessible name of the change list; defaults to `uiWorklist.changes`. |

<!-- /ds:props -->

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/change-rows/change-rows.module.css -->

| Token | Read by |
| --- | --- |
| `--border-soft` | `border-block-end` |
| `--cell-px` | `padding` |
| `--faint` | `color` |
| `--fw-semibold` | `font-weight` |
| `--ink` | `color` |
| `--row-h-compact` | `min-height` |
| `--space-1` | `padding-inline` |
| `--space-half` | `padding` |
| `--steel` | `color` |
| `--text-xs` | `font-size` |

<!-- /ds:tokens -->
