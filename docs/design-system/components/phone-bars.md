<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Phone bars

`PhoneTopBar` (`52px` chrome header) and `PhoneBottomNav` (`56px` bottom navigation with safe-area inset) form the application frame on phone viewports (`<= 767px`).

They live in `apps/web/src/ui/phone-bars`: the components in `phone-bars.tsx`, their styles in `phone-bars.module.css`, and their gallery entry in `phone-bars.gallery.tsx`.

## When to use it, and when not

Use `PhoneTopBar` and `PhoneBottomNav` in the phone shell layout (`< 768px`) to frame self-service and operational phone screens.

| Do not use it for | Use instead |
|---|---|
| Desktop frame navigation (`>= 768px`) | `ModuleNavBar` and `WorkspaceTabs`: see [Module navigation](module-nav.md) and [Workspace tabs](workspace-tabs.md). |
| In-page section headers | `PageHead` or `SectionHead`: see [Page head](page-head.md) and [Card](card.md). |

## Anatomy

- **`PhoneTopBar`:**
  - `<header data-surface="chrome">` (`52px` min-height, `16px` inline gutter).
  - Optional `back` link or button (`44×44` `--target-touch` square with `ChevronLeft`).
  - Title rendered as `<div>` (default) or `<h1>` (`headingAs="h1"` when `PagePhoneHeader` sets `shellOwnsH1: true` so `PageMain` demotes inner `PageHead` titles to `<h2>`).
  - Optional right-aligned `context` text (`--text-xs`, `--on-chrome-muted`) and `trailing` control slot.
- **`PhoneBottomNav`:**
  - `<nav aria-label={label}>` on `--surface` above `env(safe-area-inset-bottom, 0)` with a `1px solid var(--border)` top rule.
  - Up to five equal-width `<li>` slots (`56px` min-height): when `items.length <= 5`, all render inline; when `items.length > 5`, the first four render inline and slot five opens a top-aligned `BarOverflowLinks` disclosure for the remaining destinations.
  - Each slot stacks a `20px` icon (with optional `Badge`) above a single-line `<bdi>` label, crowned by a `2px` (`--space-half`) `--primary` top indicator bar when active.

## Looks and sizes

`PhoneTopBar` is `52px` high on `--chrome` with `--text-lg` (`17px` on Console phone) bold `--on-chrome` title and `--text-xs` (`13px`) `--on-chrome-muted` context. `PhoneBottomNav` is `56px` high (plus safe-area inset) on `--surface` with `44×44` minimum touch targets.

## States

- **Rest:** inactive `PhoneBottomNav` slots show `--steel` icon and label.
- **Hover / Focus:** `--muted` fill and `2px solid var(--primary)` inset focus outline.
- **Current destination (`aria-current="page"` or active overflow item `data-active`):** `--primary` icon, `--ink` bold label, and `2px` top `--primary` border bar.
- **Disabled / invalid / read-only / loading:** neither bar has a disabled, invalid, read-only, or loading look; callers pass only reachable destinations.

## Keyboard

- `Tab` / `Shift+Tab` traverses the optional `back` control, `trailing` controls, and the five bottom navigation slots.
- `Enter` follows a destination link; `Enter` or `Space` activates a button `back` control or opens the fifth overflow menu (`ArrowUp`, `ArrowDown`, `Home`, `End`, `Escape` inside the menu, ignoring Korean IME composition keys).

## Accessibility contract

- **Role:** `<header>` for `PhoneTopBar`; `navigation` landmark (`<nav>`) for `PhoneBottomNav`.
- **Accessible name:** `PhoneBottomNav` defaults to `shell.nav`; `back.label` names the back button (`common.back`); `moreLabel` defaults to `shell.nav.more`; `aria-current="page"` marks the active link.
- **Heading coordination:** `PagePhoneHeader` (`shellOwnsH1: true`) ensures `<main>` shifts inner `PageHead` headings to `<h2>` whenever `PhoneTopBar` renders `headingAs="h1"`, preserving a single `<h1>` per document.
- **WCAG 2.2:** 1.4.3 Contrast (Minimum), 2.4.7 Focus Visible, and 2.5.8 Target Size (Minimum: all interactive controls are at least `44×44` CSS px).

## Phone behaviour at 390 px

Designed specifically for 390 px phone viewports (`52px` top bar, five `78px × 56px` bottom slots across a `390px` screen, plus iOS/Android bottom safe-area inset).

## Copy rules

`PhoneBottomNav` reads `shell.nav` and `shell.nav.more` by default; callers pass translated `shell.link.*`, `shell.account`, and `common.back` labels from `@console/i18n`.

## Props

<!-- ds:props apps/web/src/ui/phone-bars/phone-bars.tsx -->

### PhoneBottomNav

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `items` | yes | `readonly PhoneNavItem[]` |  | Ordered destinations available to the signed-in account. |
| `activeId` | no | `string` |  | Identifier of the active destination marked with `aria-current="page"`. |
| `label` | no | `string` |  | Accessible name of the bottom navigation landmark; defaults to `shell.nav`. |
| `moreLabel` | no | `string` |  | Label for the fifth overflow slot when `items.length > 5`; defaults to `shell.nav.more`. |
| `onNavigate` | no | `(item: PhoneNavItem) => void` |  | Invoked when a plain primary click or overflow menu selection activates an item. |
| `renderLink` | no | `(item: PhoneNavItem, props: PhoneNavLinkRenderProps) => ReactNode` |  | Optional custom link renderer for router integration; falls back to a native `<a>` element. |

### PhoneTopBar

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `title` | yes | `ReactNode` |  | Screen title shown in the phone header. |
| `back` | no | `PhoneBackAction` |  | Optional `44×44` back link or button placed before the title. |
| `context` | no | `ReactNode` |  | Optional single-line context fact (tenant name, person number, or period) aligned to the trailing side. |
| `headingAs` | no | `"div" \| "h1"` | `"div"` | Element used for `title`; set `"h1"` only when enclosed pages shift their own `PageHead` to `<h2>` via `PagePhoneHeader`. |
| `trailing` | no | `ReactNode` |  | Optional trailing controls (such as an account or search trigger). |

<!-- /ds:props -->

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/phone-bars/phone-bars.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border-block-end`, `border-block-start` |
| `--fw-medium` | `font-weight` |
| `--fw-strong` | `font-weight` |
| `--ink` | `color` |
| `--muted` | `background` |
| `--phone-safe-bottom` | `padding-block-end` |
| `--primary` | `border-block-start`, `color`, `outline` |
| `--radius` | `border-radius` |
| `--space-1` | `gap`, `min-height`, `padding`, `padding-inline-start` |
| `--space-2` | `gap` |
| `--space-3` | `min-height` |
| `--space-4` | `padding` |
| `--space-5` | `min-height` |
| `--space-6` | `min-height` |
| `--space-half` | `border-block-start`, `gap` |
| `--steel` | `color` |
| `--surface` | `background` |
| `--target-touch` | `height`, `min-height`, `width` |
| `--text-lg` | `font-size` |
| `--text-xs` | `font-size` |

<!-- /ds:tokens -->
