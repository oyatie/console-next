<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Pane grid

`PaneGrid` and `PaneHead` arrange operational multi-pane desktop and phone workspaces separated by `1px` `--border-strong` dividers, with optional start, bottom, record, and related panes.

## When to use it, and when not

| Use it for |
|---|
| Page patterns that place an optional filter or document-metadata rail (`start`), a primary table or document (`main`), an optional lower strip or summary (`bottom`), and resizable `record` / `related` side panes. |
| Filled section or pane title bars (`PaneHead`) inside panes (`--surface-2` background, `--border` bottom rule). |

| Do not use it for | Use instead |
|---|---|
| Modal or command forms that interrupt or commit a governed write | [`Sheet`](sheet.md) or [`Composer`](composer.md). |
| Stacked standalone cards inside a single-column document | [`Card`](card.md). |

## Anatomy

| Part | Element | Purpose |
|---|---|---|
| Root | `<div data-pane-grid>` | Flex workspace container holding `start`, `center`, splitters, `record`, and `related`. |
| Start pane | `<div>` | Optional inline-start column (`--pane-start-w`) separated by `1px solid var(--border-strong)`. |
| Center column | `<div>` | Holds `main` and optional `bottom` (`1px solid var(--border-strong)` top rule). |
| Splitter | `<div role="separator">` | Focusable vertical resize handle (`aria-orientation="vertical"`) before each open side pane. |
| Side pane | `<aside>` | Named complementary region (`aria-label`) with `PaneHead`, scrollable `tabIndex={0}` body, and optional pinned `footer`. |
| `PaneHead` | `<header>` | Filled title bar (`--row-h`) with `<h2>`/`<h3>` title, optional `<bdi>` `meta`, and trailing `actions`. |

## Looks and sizes

`PaneGrid` fills available width and height with flat `--surface` panes divided by `1px` `--border-strong` rules. `PaneHead` uses `--row-h` minimum height (`28px` on Console desk, `48px` on Console phone, `40px` on Classic) and `--surface-2` background.

## States

`data-depth` reflects open side panes (`0`, `1`, or `2`). `data-full` expands the deepest open side pane across tablet/desktop widths. There is no disabled or invalid state on the grid container itself.

## Keyboard

| Key | What it does |
|---|---|
| `ArrowLeft` / `ArrowRight` on splitter | Widens or narrows the adjacent side pane by `24px`; ignores keys while `isImeKey(event)` is true. |
| `Home` on splitter | Resets the side pane width to its default token width. |
| `Escape` inside `PaneGrid` | Exits `full` mode or closes `related` then `record` and returns focus via `returnFocus`, unless `isImeKey(event)` is true, focus is in an editable control, or a dialog/menu is open. |

## Accessibility contract

Each open side pane is an `<aside>` named by `pane.label`, its scrollable body has `tabIndex={0}` (WCAG 2.1.1), and each splitter exposes `role="separator"`, `aria-orientation="vertical"`, `aria-valuemin`, `aria-valuemax`, and `aria-valuenow` (WCAG 2.2 AA 1.3.1, 2.1.1, 2.5.7, 2.5.8).

## Phone behaviour at 390 px

Below `768px` (`--phone`), when `record` or `related` is open (`data-depth` > `0`), `start`, `main`, `bottom`, and splitters hide, the deepest open side pane fills `100%` width, and `PaneHead` reveals a `common.back` button at the inline start.

## Copy rules

Built-in labels read `common.back`, `common.closePanel`, `common.closeRelated`, `common.resizeColumn`, `uiFlexibleColumns.full`, and `uiFlexibleColumns.openInTab` from `packages/i18n`.

## Props

<!-- ds:props apps/web/src/ui/pane-grid/pane-grid.tsx -->

### PaneGrid

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `main` | yes | `ReactNode` |  | Primary center region (table, grid, or document body). |
| `bottom` | no | `ReactNode` |  | Optional lower pane directly beneath `main` inside the center column. |
| `full` | no | `boolean` |  | Whether the active side pane expands across the workspace on tablet/desk widths. |
| `onFull` | no | `(on: boolean) => void` |  | Toggle handler for full-pane mode. |
| `onOpen` | no | `(id: string) => void` |  | Row activation callback invoked on `Enter` when `record` already shows the focused row. |
| `onSelect` | no | `(id: string) => void` |  | Row selection callback invoked when row focus settles while `record` is open. |
| `record` | no | `"" \| SidePaneSpec \| false \| null` |  | Optional primary detail or decision pane on the inline end. |
| `related` | no | `"" \| SidePaneSpec \| false \| null` |  | Optional secondary related-record pane beside `record`. |
| `start` | no | `ReactNode` |  | Optional inline-start pane (filter rail, document metadata, or settings view list). |

### PaneHead

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `title` | yes | `ReactNode` |  | Heading label of the pane. |
| `actions` | no | `ReactNode` |  | Trailing action controls aligned to the inline end of the bar. |
| `level` | no | `2 \| 3` | `2` | Heading level (`2` for top-level panes, `3` inside nested sections). |
| `meta` | no | `ReactNode` |  | Secondary contextual fact shown inline after `title` (for example period or item reference). |
| `titleRef` | no | `RefObject<HTMLHeadingElement \| null>` |  | Optional ref attached to the heading element for programmatic focus. |

<!-- /ds:props -->

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/pane-grid/pane-grid.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border-block-end`, `border-block-start` |
| `--border-strong` | `border-block-start`, `border-inline-end`, `border-inline-start` |
| `--cell-px` | `padding` |
| `--faint` | `color` |
| `--focus` | `box-shadow` |
| `--frame-bottom` | `max-height` |
| `--frame-top` | `max-height` |
| `--fw-body` | `font-weight` |
| `--fw-semibold` | `font-weight` |
| `--ink` | `color` |
| `--pane-record-w` | `flex`, `width` |
| `--pane-related-w` | `flex`, `width` |
| `--pane-start-w` | `flex`, `width` |
| `--panel-w` | `--pane-record-w` |
| `--primary` | `border-inline-start` |
| `--queue-w` | `--pane-record-w`, `--pane-related-w`, `min-width` |
| `--row-h` | `min-height` |
| `--space-1` | `gap`, `margin-inline-end`, `padding` |
| `--space-1-5` | `flex` |
| `--space-2` | `gap`, `padding` |
| `--space-3` | `padding` |
| `--space-6` | `--pane-start-w` |
| `--space-half` | `inset-inline-start`, `margin-inline-start` |
| `--surface` | `background` |
| `--surface-2` | `background` |
| `--text-xs` | `font-size` |

<!-- /ds:tokens -->
