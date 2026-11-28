<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Workspace tabs

`WorkspaceTabs` is a browser-like strip of open operational workspaces directly below the top frame bar, with a pinned first tab, sibling close buttons, keyboard arrow movement, and overflow folding.

It lives in `apps/web/src/ui/workspace-tabs`: the component in `workspace-tabs.tsx`, its styles in `workspace-tabs.module.css`, and its gallery entry in `workspace-tabs.gallery.tsx`.

## When to use it, and when not

Use it in the desktop application shell directly below the top bar to let operators keep up to eight workspaces or records open in parallel.

| Do not use it for | Use instead |
|---|---|
| Switching panels within a single screen | `Tabs` or `PageTabs`: see [Tabs](../../apps/web/src/ui/tabs/CONTRACT.md). |
| Top-level module navigation | `ModuleNavBar`: see [Module navigation](module-nav.md). |

## Anatomy

- **Landmark:** `<nav aria-label={label}>` on a `--canvas` strip (`min-height: max(var(--control-h-sm), var(--space-6))`, `32px` on Console desktop, `36px` on classic baseline, `44px` on touch).
- **Tab cells:** `<ul>` of `<li>` cells separated by `1px solid var(--border)` rules. Each cell holds:
  1. A route link (`<a>` or `renderLink`) containing `<bdi>` text and an optional `Badge`.
  2. For non-pinned tabs after index `0` when `onClose` is provided, a **sibling** `<button type="button">` (`--target` square: `24×24` on Console desktop) that closes the tab without nesting an interactive control inside `<a>`.
- **Trailing rail:** `.tail` spans the remaining inline space with a `1px solid var(--border)` bottom rule, an optional `+` button (`onAdd`), and an overflow `BarOverflowLinks` disclosure when tabs exceed the strip width.
- **Measurement shadow:** an off-flow `aria-hidden="true"` `inert` row observed by `ResizeObserver` so `partitionBarOverflow` keeps the active tab visible inline.

## Looks and sizes

One strip height (`32px` on Console desktop via `--space-6`, `36px` on classic baseline via `--control-h-sm`, `44px` at phone touch widths). Inactive cells sit on `--canvas` with `--steel` text and a `1px solid var(--border)` bottom rule. The active cell (`[data-active]`) takes `--surface` fill, `--ink` bold text, a `1px solid var(--surface)` bottom edge that joins the workspace surface below, and a `2px` (`--space-half`) top `--primary` border on `::before`.

## States

- **Rest (inactive):** transparent cell over `--canvas`, `--steel` text, `1px` `--border` end and bottom rules.
- **Hover:** `--muted` fill and `--ink` text on the cell or icon button.
- **Focus:** `2px solid var(--primary)` outline inset by `-2px` on the focused link or button.
- **Current workspace (`aria-current="page"`):** `--surface` fill, `--ink` bold text, open bottom join, and `2px` top `--primary` bar.
- **Pinned:** index `0` (and any tab with `pinned: true`) omits the close button.
- **Disabled / invalid / read-only / loading:** there is no disabled, invalid, read-only, or loading look; an empty `tabs` array renders nothing.

## Keyboard

- `Tab` / `Shift+Tab` moves through each visible tab link, its sibling close button (when closable), the optional `+` button, and the overflow menu button.
- `ArrowRight` / `ArrowLeft` / `Home` / `End` on a tab link moves focus across visible tab links without activating them; events owned by a Korean input method composition (`isImeKey`) are ignored.
- `Enter` on a tab link navigates to that workspace; `Enter` or `Space` on a close button closes that tab and moves focus to the adjacent surviving tab link so focus never drops to `<body>`.

## Accessibility contract

- **Role:** `navigation` landmark (`<nav>`) containing a list of route links and sibling buttons — never `tablist` or `tab`, which forbid sibling close buttons inside `tablist` and imply in-page `tabpanel` switching.
- **Accessible name:** `label` defaults to `shell.tabs.label`; each close button reads `shell.tabs.closeOne` with the tab's title; `+` reads `shell.tabs.new`; overflow reads `shell.tabs.more`.
- **Announced:** `aria-current="page"` announces the active workspace; counts inside `Badge` are read with the link label.
- **WCAG 2.2:** 1.4.3 Contrast (Minimum), 1.4.11 Non-text Contrast, 2.4.7 Focus Visible, and 2.5.8 Target Size (Minimum: every close and `+` button is `--target`, at least `24×24` CSS px on desktop and `44×44` on touch).

## Phone behaviour at 390 px

Phone shells omit `WorkspaceTabs`. When rendered directly at 390 px in tests or the gallery, `--control-h-sm` and `--target` expand to `44px` and excess tabs fold into the overflow menu.

## Copy rules

Default labels read `shell.tabs.label`, `shell.tabs.closeOne`, `shell.tabs.new`, and `shell.tabs.more` from `@console/i18n`. Tab titles come from caller-supplied route or entity labels, and positive counts format via `fmtNumber`.

## Props

<!-- ds:props apps/web/src/ui/workspace-tabs/workspace-tabs.tsx -->

### WorkspaceTabs

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `tabs` | yes | `readonly WorkspaceTab[]` |  | Ordered open workspace tabs; index `0` is pinned and never renders a close button. |
| `activeId` | no | `string` |  | Identifier of the active workspace tab marked with `aria-current="page"`. |
| `closeTabLabel` | no | `(tabLabel: string) => string` |  | Accessible name formatter for a closable tab's close button; defaults to `shell.tabs.closeOne`. |
| `label` | no | `string` |  | Accessible name of the workspace tabs navigation landmark; defaults to `shell.tabs.label`. |
| `moreLabel` | no | `string` |  | Accessible name for the overflow menu trigger; defaults to `shell.tabs.more`. |
| `newTabLabel` | no | `string` |  | Accessible name for the optional `+` new-tab button; defaults to `shell.tabs.new`. |
| `onAdd` | no | `() => void` |  | Optional callback to open a new workspace tab (`+` button). |
| `onClose` | no | `(tabId: string) => void` |  | Invoked when the user closes a non-pinned tab. |
| `onSelect` | no | `(tab: WorkspaceTab) => void` |  | Invoked when a plain primary click or overflow menu selection activates a tab. |
| `renderLink` | no | `(tab: WorkspaceTab, props: WorkspaceTabLinkRenderProps) => ReactNode` |  | Optional custom link renderer for router integration; falls back to a native `<a>` element. |

<!-- /ds:props -->

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/workspace-tabs/workspace-tabs.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border-block-end`, `border-inline-end` |
| `--canvas` | `background` |
| `--control-h-sm` | `min-height` |
| `--fw-medium` | `font-weight` |
| `--fw-strong` | `font-weight` |
| `--ink` | `color` |
| `--muted` | `background` |
| `--primary` | `border-block-start`, `color`, `outline` |
| `--radius-sm` | `border-radius` |
| `--space-1` | `gap`, `margin-inline-end`, `padding`, `padding-inline-end` |
| `--space-1-5` | `gap` |
| `--space-3` | `padding` |
| `--space-6` | `inline-size`, `max-inline-size`, `min-height` |
| `--space-half` | `border-block-start` |
| `--steel` | `color` |
| `--surface` | `background`, `border-block-end` |
| `--target` | `height`, `min-height`, `min-width`, `width` |
| `--text-sm` | `font-size` |

<!-- /ds:tokens -->
