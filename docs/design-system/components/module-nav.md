<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Module navigation

`ModuleNavBar` is a horizontal primary navigation bar inside the application frame that links to top-level modules and folds excess destinations into an overflow menu.

It lives in `apps/web/src/ui/module-nav`: the component in `module-nav.tsx`, its styles in `module-nav.module.css`, and its gallery entry in `module-nav.gallery.tsx`.

## When to use it, and when not

Use it inside the desktop application frame (`[data-surface="chrome"]`) when top-level modules sit in a single horizontal strip.

| Do not use it for | Use instead |
|---|---|
| Views inside a single screen or sections of a record | `Tabs`, `TabNav`, or `PageTabs`: see [Tabs](../../apps/web/src/ui/tabs/CONTRACT.md). |
| Open workspaces or pinned records below the top frame bar | `WorkspaceTabs`: see [Workspace tabs](workspace-tabs.md). |
| Record-level action commands | `ActionMenu`: see [Menu](menu.md). |

## Anatomy

- **Landmark:** `<nav aria-label={label}>`.
- **Inline list:** `<ul>` of `<li>` entries, each holding an `<a>` (or caller-supplied router link) with `<bdi>` label text and an optional `Badge` (`tone="attention"`) when `count > 0`.
- **Measurement shadow:** an off-flow `aria-hidden="true"` `inert` row observed by `ResizeObserver` so `partitionBarOverflow` keeps the active module inline whenever space allows.
- **Overflow trigger:** an optional `BarOverflowLinks` disclosure (`aria-expanded`) with an ellipsis icon when one or more items exceed the bar's inline width.

## Looks and sizes

One compact height (`min-height: var(--control-h)`, stretching to fill the enclosing frame row). Inside `[data-surface="chrome"]`, inactive links read `--steel` (`--on-chrome-muted`), hovered links take `--muted` (`--chrome-hover`) and `--ink` (`--on-chrome`), and the active link (`[aria-current="page"]`) takes `--primary-soft` (`--chrome-raised`), `--fw-strong`, and a `2px` (`--space-half`) bottom rule in `--primary` (`--chrome-accent`) drawn with `border-block-end` so Windows High Contrast preserves it.

## States

- **Rest:** `--steel` text on transparent fill.
- **Hover:** `--muted` fill and `--ink` text without underline.
- **Focus:** `2px solid var(--primary)` outline inset by `-2px`.
- **Current page (`aria-current="page"`):** `--primary-soft` fill, `--ink` bold text, and a `2px` bottom `--primary` border.
- **Overflow:** items that do not fit inline move into the trailing `BarOverflowLinks` disclosure; the active item stays inline whenever its width plus the overflow trigger fits the container.
- **Disabled / invalid / read-only / loading:** there is no disabled, invalid, read-only, or loading look; callers pass only destinations the signed-in account can open, and an empty `items` array renders nothing.

## Keyboard

- `Tab` / `Shift+Tab` moves across visible module links and, when present, the overflow trigger button.
- `Enter` follows the focused module link or opens the overflow menu.
- Inside the overflow disclosure, `ArrowDown`, `ArrowUp`, `Home`, `End`, and `Escape` move focus across links or close back to the trigger; Korean input method composition keys do not trigger navigation.

## Accessibility contract

- **Role:** `navigation` landmark (`<nav>`) containing a list of links, never `menubar` or `tablist`, because each item opens a route.
- **Accessible name:** `label` names the `<nav>`; `moreLabel` (defaulting to `shell.nav.more`) names the overflow button; `aria-current="page"` marks the active link.
- **Announced:** screen readers announce the active item as "current page" and read positive counts from `Badge` as part of the link name.
- **WCAG 2.2:** 1.4.3 Contrast (Minimum), 1.4.11 Non-text Contrast, 2.4.7 Focus Visible, and 2.5.8 Target Size (Minimum, at least 24 by 24 CSS px on desktop) apply.

## Phone behaviour at 390 px

`ModuleNavBar` is a desktop frame bar; phone shells replace it with bottom navigation (`PhoneBottomNav`). When rendered at narrow widths in isolation or the gallery, `ResizeObserver` collapses excess modules into the overflow menu while keeping targets at `--control-h` (`44px` under Console phone media queries).

## Copy rules

`label` is supplied by the caller (typically `shell.nav`), item labels come from `shell.link.*` message ids, and the overflow trigger defaults to `shell.nav.more`. Positive counts format through `fmtNumber`.

## Props

<!-- ds:props apps/web/src/ui/module-nav/module-nav.tsx -->

### ModuleNavBar

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `items` | yes | `readonly ModuleNavItem[]` |  | Ordered module destinations the signed-in account can open. |
| `label` | yes | `string` |  | Accessible name of the primary navigation landmark. |
| `activeId` | no | `string` |  | Identifier of the active module marked with `aria-current="page"`. |
| `moreLabel` | no | `string` |  | Accessible name for the overflow trigger; defaults to `shell.nav.more`. |
| `onNavigate` | no | `(item: ModuleNavItem) => void` |  | Invoked when a plain primary click or overflow menu selection activates an item. |
| `renderLink` | no | `(item: ModuleNavItem, props: ModuleNavLinkRenderProps) => ReactNode` |  | Optional custom link renderer for router integration; falls back to a native `<a>` element. |

<!-- /ds:props -->

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/module-nav/module-nav.module.css -->

| Token | Read by |
| --- | --- |
| `--control-h` | `min-height` |
| `--fw-medium` | `font-weight` |
| `--fw-strong` | `font-weight` |
| `--ink` | `color` |
| `--muted` | `background` |
| `--primary` | `border-block-end`, `outline` |
| `--primary-soft` | `background` |
| `--space-1` | `padding` |
| `--space-1-5` | `gap` |
| `--space-3` | `padding` |
| `--space-half` | `border-block-end` |
| `--steel` | `color` |
| `--text-sm` | `font-size` |

<!-- /ds:tokens -->
