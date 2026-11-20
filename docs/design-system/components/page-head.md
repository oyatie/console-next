<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Page head

`PageHead` is the header and command strip of a screen or embedded section, accompanied by `PageHeadActions`, `Crumbs`, `PhaseLine`, and `AsOf`.

It lives in `apps/web/src/ui/page-head`: the components in `page-head.tsx`, `page-head-actions.tsx`, `crumbs.tsx`, `phase-line.tsx`, and `as-of.tsx`, their styles in `page-head.module.css`, and their gallery entry in `page-head.gallery.tsx`.

## When to use it, and when not

Use `PageHead` once at the top of a screen (or with `PageHeadingLevel` set to `2` inside an embedded pane) to hold the heading, breadcrumbs, inline filter controls, secondary commands, primary action, and view tabs.

| Do not use it for | Use instead |
|---|---|
| A section header inside a card or record body | `SectionHead` or `RecordSection`: see [Card](card.md) and [Record](record.md). |
| The phone application frame header | `PhoneTopBar`: see [Phone bars](phone-bars.md). |

## Anatomy

- **Header container:** `<header data-band={band} data-tabs={shown(tabs)}>`.
- **Breadcrumb trail (`Crumbs`):** optional `<nav>` with an `<ol>` of ancestor links and `aria-current="page"` current text.
- **Command row:**
  1. `<h1>` (or `<h2>` when `PageHeadingLevel` is `2`, including when `PagePhoneHeader` reports `shellOwnsH1: true`) with `tabIndex={-1}` for programmatic post-navigation focus.
  2. `meta`: status chips, `PhaseLine`, or registration codes beside the title.
  3. `filters`: inline filter controls (such as segmented toggles or quick find controls) before the flexible spacer.
  4. Flexible spacer pushing command slots to the trailing edge.
  5. `actions` (`PageHeadActions`), `tools`, and the single `primary` command.
- **Lower bands:** shell phase notice slot, optional `sub` block, `tabs`, and `asOf`.

## Looks and sizes

Without `band`, `PageHead` sits inside the page padding. With `band`, it spans full width on `--surface` above a `1px solid var(--border)` bottom rule (`--toolbar-h`: `40px` on Console desktop, `52px` on Console phone, `60px` on classic baseline). Under Console, `.title` reads `--text-lg` (`15px` desktop, `17px` phone); on classic baseline it keeps `--text-xl` (`20px`).

## States

- **Rest:** static header band; interactive children own their own hover, focus, pressed, and disabled states.
- **Tabs attached (`data-tabs`):** removes bottom padding so view or route tabs sit flush on the `1px` bottom rule.
- **Disabled / invalid / read-only / loading:** `PageHead` itself has no disabled, invalid, read-only, or loading state; `meta` reserves `1lh` so loading facts do not shift layout.

## Keyboard

`PageHead` handles no keys directly. Its heading has `tabIndex={-1}` so focus management can target `titleId` without adding a tab stop; child breadcrumbs, filters, tabs, and `PageHeadActions` follow their own keyboard contracts.

## Accessibility contract

- **Role:** `banner` or sectioning `<header>` containing the screen's single `<h1>` (automatically demoted to `<h2>` when `PageHeadingLevel` is `2`).
- **Accessible name:** `Crumbs` uses `uiCrumbs.label`; `PageHeadActions` names its phone overflow menu through `label`.
- **Announced:** `PhaseLine` conveys setup vs operating state in visible text rather than colour alone.
- **WCAG 2.2:** 1.3.1 Info and Relationships (heading hierarchy), 1.4.1 Use of Color (`PhaseLine`), 1.4.3 Contrast (Minimum), and 2.4.6 Headings and Labels apply.

## Phone behaviour at 390 px

At `--phone` (`<= 767px`), `.secondary` buttons in `PageHeadActions` collapse into an `ActionMenu` while `primary` remains inline; `meta` and `filters` wrap onto full-width rows beneath the title.

## Copy rules

`Crumbs` reads `uiCrumbs.label` from `@console/i18n`. All titles, filter labels, action labels, and phase descriptions are passed by the calling screen from catalog ids.

## Props

<!-- ds:props apps/web/src/ui/page-head/page-head.tsx -->

### PageHead

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `title` | yes | `ReactNode` |  | Primary heading text of the page or section. |
| `actions` | no | `ReactNode` |  | Named secondary command strip (`PageHeadActions`) that folds into an overflow menu on phones. |
| `asOf` | no | `ReactNode` |  | The existing AsOfControl (or an AsOf fact); owned by the head, above its view tabs. |
| `band` | no | `boolean` |  | Draws the head as a full-width surface band (`40px` command strip under Console). |
| `crumbs` | no | `ReactNode` |  | Breadcrumb trail rendered above the heading row. |
| `filters` | no | `ReactNode` |  | Filter controls (segmented views, quick checks, find box) placed beside the title before the spacer. |
| `meta` | no | `ReactNode` |  | Status chip, phase line, or code facts placed immediately beside the title. |
| `primary` | no | `ReactNode` |  | One primary action stays visible on phones; secondary commands move into the named menu. |
| `sub` | no | `ReactNode` |  | Under the title: what this page is for (a line, or a block such as a chain strip: a &lt;div>, never a &lt;p>). |
| `tabs` | no | `ReactNode` |  | View or route tabs seated on the bottom rule of the page head. |
| `titleId` | no | `string` |  | The h1's id: a screen that moves focus to its title after a load or a commit names it (the h1 takes focus, never a tab stop). |
| `tools` | no | `ReactNode` |  | Secondary toolbar controls aligned to the trailing side before `primary`. |

<!-- /ds:props -->

<!-- ds:props apps/web/src/ui/page-head/page-head-actions.tsx -->

### PageHeadActions

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `items` | yes | `readonly MenuAction[]` |  |  |
| `label` | yes | `string` |  |  |

<!-- /ds:props -->

<!-- ds:props apps/web/src/ui/page-head/crumbs.tsx -->

### Crumbs

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `items` | yes | `readonly ReactNode[]` |  |  |
| `current` | no | `ReactNode` |  |  |

<!-- /ds:props -->

<!-- ds:props apps/web/src/ui/page-head/phase-line.tsx -->

### PhaseLine

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `children` | yes | `ReactNode` |  |  |
| `phase` | yes | `"operating" \| "setup"` |  |  |

<!-- /ds:props -->

<!-- ds:props apps/web/src/ui/page-head/as-of.tsx -->

### AsOf

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `date` | yes | `string` |  |  |
| `label` | yes | `string` |  |  |
| `today` | yes | `string` |  |  |

<!-- /ds:props -->

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/page-head/page-head.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border-bottom` |
| `--control-border` | `border` |
| `--faint` | `color` |
| `--fw-medium` | `font-weight` |
| `--fw-strong` | `font-weight` |
| `--ink` | `color` |
| `--ok-solid` | `background` |
| `--primary` | `background` |
| `--radius` | `border-radius` |
| `--space-1` | `border-radius`, `gap`, `height` |
| `--space-2` | `gap`, `height`, `width` |
| `--space-3` | `gap`, `padding` |
| `--space-4` | `padding` |
| `--space-6` | `padding` |
| `--steel` | `color` |
| `--surface` | `background` |
| `--target` | `height` |
| `--text-lg` | `font-size` |
| `--text-sm` | `font-size` |
| `--text-xl` | `font-size` |
| `--text-xs` | `font-size` |
| `--toolbar-h` | `min-height` |
| `--toolbar-py` | `padding` |

<!-- /ds:tokens -->
