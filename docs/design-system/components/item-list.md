<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# ItemList

`ItemList` is a short list of rows inside a card or a panel: a `<ul>` whose rows each hold a leading mark, the
text and a quiet value at the end, split by hairlines.

It lives in `apps/web/src/ui/item-list/item-list.tsx`, which also exports the type `Item`. Its styles are in
`item-list.module.css` beside it.

## When to use it, and when not

Use it for a handful of lines read top to bottom: a checklist where each line passed or failed, the people of a
unit, the history of one day. On this branch every view that renders it is in the attendance feature.

| Do not use it for | Use instead |
|---|---|
| Many records with the same columns | `Table` (`ui/table.tsx`), or `LongTable` (`ui/long-table`) for a list that is paged or sorted. |
| Rows where one stays selected | `Table` with `selected` and `onSelect`. `ItemList` has no selected state: `onSelect` on an item makes its row a button and nothing more. |
| Facts as label and value pairs | `KeyValue`: see [KeyValue](key-value.md). |
| A hierarchy | `TreeView`: see [Tree](tree.md). |
| Picking options in a form | `ChoiceField` or `Checks`: see [Choice](choice.md). |
| A list of commands behind a button | `ActionMenu` or `MenuButton`: see [Menu](menu.md). |
| The key to the marks of a picture | `Legend` (`ui/legend`). |
| The loading shape of a view | `Skeleton` (`ui/skeleton`). The list's own `loading` state draws nothing: see States. |
| A view with nothing to show and a next step | `EmptyState` (`ui/empty-state.tsx`). The list's `empty` is one line of text. |

## Anatomy

| Part | Element | Holds |
|---|---|---|
| Root | `<ul>` | `aria-label` from `label`, `data-density` from `density`, and `aria-busy="true"` while `loading`. |
| Row | `<li>`, one for each item | The parts below, and `data-tone` from the item's `tone`. |
| Row button | `<button type="button">` | Only on an item with `onSelect`. It wraps the mark, the text and the end, and fills the row. |
| Mark | `<span>` | The item's `mark`: an icon, an avatar. |
| Text | `<span>` | The item's `text`. Always rendered. |
| End | `<span>` | The item's `end`. |
| State row | `<li>` | The loading bar, the error or the empty text. It replaces every row. |

An item, `Item`, has:

| Member | Required | Type | Holds |
|---|---|---|---|
| `key` | yes | `string` | The React key. Unique within the list. |
| `text` | yes | `ReactNode` | The line. |
| `mark` | no | `ReactNode` | What leads the line. |
| `end` | no | `ReactNode` | The quiet value at the end of the line. |
| `tone` | no | `"ok"`, `"warn"` or `"danger"` | The colour of the mark. |
| `onSelect` | no | `() => void` | Makes the row a button that calls it. |

The mark and the end are left out when the member is `null` or `undefined`. A `false` left by a `condition && …`
expression counts as given, and renders an empty `<span>`.

`ItemList` takes no `className`, passes no other attribute through and has no ref.

## Looks and sizes

There is one look and one size.

| Part | Look |
|---|---|
| List | A column with no padding, no margin and no list marker. |
| Row | Its parts in one line, centred vertically, 8 px apart (`--space-2`). At least 32 px high (`--row-h-compact`). 13 px text (`--text-sm`). A 1 px `--border-soft` line above every row but the first. No side padding: the text starts at the edge of the list. |
| Mark | `--steel`. It keeps the width of its content. |
| Text | The colour it inherits. It takes the width that is left and may break anywhere (`overflow-wrap: anywhere`). |
| End | 12 px (`--text-xs`), `--steel`, tabular numbers. It keeps the width of its content. |
| Row button | No fill, no border, no padding. It inherits the row's font, colour and minimum height, and is as wide as the row. |

`tone` colours the mark and nothing else. It is set as the mark's text colour, so an icon drawn in the current
colour takes it. The text and the end do not change.

| `tone` | Mark colour |
|---|---|
| not set | `--steel` |
| `ok` | `--ok-solid` |
| `warn` | `--warn-solid` |
| `danger` | `--danger-solid` |

`density` changes nothing that can be seen:

| `density` | What happens |
|---|---|
| `dense` | Writes `data-density="dense"`. The one rule that reads it sets the row's minimum height to `--row-h-compact`, the value it already has. |
| `default` | Writes `data-density="default"`, which no rule reads. |

## States

| State | What changes |
|---|---|
| Rest | The look above. |
| Hover | The row under the pointer takes a `--muted` fill. This applies to every row, including one without `onSelect`, which does nothing when pressed. The rule also names a `data-hovered` attribute, which the component never writes. |
| Focus | A row without `onSelect` cannot take focus. A row button with keyboard focus (`:focus-visible`) shows the `--focus` ring as a box shadow: a 2 px `--surface` ring, then a 2 px `--primary` ring. Its outline is removed. A control the caller put in `text` or `end` keeps its own focus look. |
| Pressed | No look. |
| Selected | Does not exist. |
| Disabled | Does not exist. An item cannot be disabled; a row that cannot be pressed is an item without `onSelect`. |
| Read-only | Does not exist. |
| Invalid | Does not exist for a row. A list that failed to load has the error state. |
| Loading (`loading`) | The root gets `aria-busy="true"`. One state row with `role="status"` and 12 px padding (`--space-3`) replaces the rows. It holds a `<span>` meant as a bar: `--row-h-compact` high, `--border-soft`, with a 4 px radius (`--radius-sm`). The `<span>` has no `display` rule, so it stays an inline box: its `height` does not apply and it has no content, so by the CSS no bar is drawn and the state row is empty padding. That is read from the CSS, not measured in a browser. The row holds no text. |
| Error (`error`) | One state row with `role="alert"` and `data-state="error"` replaces the rows. It shows `error` at 13 px (`--text-sm`) in `--danger-solid`, inside 12 px padding. |
| Empty | With no items and `empty` given, one state row shows `empty` at 13 px in `--steel`, centred, inside 12 px padding. With no items and no `empty`, the list is an empty `<ul>`. There is no built-in empty text. |

`loading` wins over `error`, and `error` wins over `empty`. That order is not the one `KeyValue` and `TreeView`
use, where `error` wins over `loading`: an `ItemList` given both shows the loading row and not the error.

`loading` and `error` hide the items even when there are some. `empty` shows only when there are none. `error`
counts only when it is truthy. `empty` counts when it is anything but `null` or `undefined`: with no items, a
`false` or an empty string opens a state row with nothing in it.

A state row has no hover fill and no line above it.

## Keyboard

`ItemList` has no key handler. What works is the browser's own behaviour for a `<button>`:

| Key | What it does |
|---|---|
| Tab, Shift+Tab | Moves to and from each row button, and each control the caller put in a row, in document order. |
| Enter, Space | On a row button, calls the item's `onSelect`. |

There is no arrow-key movement between rows, no roving focus and no type-ahead. A list of ten selectable rows is
ten tab stops.

The component takes no text, so it has no rule for a key the Korean input method owns. The module has no
`keydown` handler, no `isComposing` check, no key code 229 check and no composition event.

## Accessibility contract

| Part | Role | Accessible name |
|---|---|---|
| Root | `list`, from the `<ul>` | `label`, through `aria-label`. Optional: without it the list has no name. |
| Row | `listitem`, from the `<li>` | None. Its content is read in place. |
| Row button | `button` | Its content: the mark, the text and the end, in that order. |
| Loading row | `status` | None, and it holds no text. |
| Error row | `alert` | None. The error text is its content. |

- **Tone:** `data-tone` is a colour and nothing else. The component adds no icon and no hidden text, so the
  shape of the mark and the words of the line must say what the tone says. Callers mark their icons
  `aria-hidden`, which leaves the words.
- **Announced:** an error, through the `alert` role. Loading has the `status` role and no text, so there are no
  words to announce. A row that appears or changes is not announced.
- **Controls in a row:** with `onSelect`, the mark, the text and the end are all inside one `<button>`. An `end`
  that is itself a button or a link would then sit inside a button, which HTML does not allow. The component does
  not prevent it. On this branch no view passes `onSelect`; several pass a button or a link as `end` without it.

Known gaps:

- The loading and the error state put `role="status"` and `role="alert"` on an `<li>` that is a child of the
  `<ul>`. In the axe-core version this repository installs (4.14.0), the `list` rule, a WCAG 1.3.1 rule that the
  scans run, accepts only `listitem` as an explicit role on a child of a `<ul>`, so by its source it reports a
  list in either state. The rule's impact is serious, and the scan helper, `e2e/a11y.ts`, fails on a serious
  violation. The gallery shows neither state and no view on this branch passes `loading` or `error`, so no scan
  reaches it today. This is read from the rule's source and from the scan helper, not from a run.
- The loading state draws no bar and holds no text: see States.
- The error text is `--danger-solid` at 13 px, which needs 4.5:1. The list has no fill, so the pair depends on
  the surface behind it. Computed from the token values, in the light theme it is 4.83:1 on `--surface`, 4.38:1
  on `--canvas` and 4.19:1 on `--muted`, so it passes on `--surface` only. In the dark theme it is at least
  5.45:1 on all three.
- Every row has a hover fill, whether or not it can be pressed.

The WCAG 2.2 criteria that apply:

| Criterion | How the list answers it |
|---|---|
| 1.3.1 Info and Relationships | A `<ul>` of `<li>`. The gap about the roles of the state rows is against this criterion. |
| 1.4.1 Use of Color | The tone is colour alone, so the mark's shape and the line's words carry the meaning. The error is text in a colour with no icon, so its words must say that something failed. |
| 1.4.3 Contrast (Minimum) | The end is `--steel` at 12 px: computed from the token values, 6.04:1 on `--surface` and 5.24:1 on the `--muted` hover fill in the light theme. The gap about the error text is against this criterion. |
| 1.4.10 Reflow | The text breaks anywhere. The mark and the end keep their width. |
| 1.4.11 Non-text Contrast | A mark that is an icon needs 3:1. The lowest pair is `--ok-solid` on the `--muted` hover fill: 3.27:1 in the light theme, computed from the token values. A mark that is text needs 4.5:1, which `--ok-solid` does not reach on any light surface (3.77:1 on `--surface`). |
| 2.1.1 Keyboard | A row button is a native button. A row without `onSelect` has nothing to operate. |
| 2.4.7 Focus Visible | The ring on the row button. |
| 2.5.8 Target Size (Minimum) | A row button is as wide as the row and at least 32 px high. |
| 4.1.2 Name, Role, Value | The table above. |
| 4.1.3 Status Messages | The error has the `alert` role. The loading row has the `status` role and no text. |

The gallery entry is `apps/web/src/ui/item-list/item-list.gallery.tsx`. It shows a checklist of three rows, one
in each tone, two of them with an end value, and a one-row list of people with an avatar as its mark. The same
entry also shows a `Legend` and a `Skeleton`, which are other components. It does not show `onSelect`, `loading`,
`error`, `empty` or `density`.

Tests:

| Test | What it checks |
|---|---|
| `apps/web/src/ui/item-list/item-list.test.tsx` | The static markup: rows with a mark, an end and a tone; a row button; `aria-busy` and the `status` row while loading; an empty list; the `alert` row with `data-state="error"`. |
| `apps/web/src/ui/canonical.test.tsx` | The shape of one row: `<ul>`, `<li data-tone>`, the text, the end. |
| `apps/web/src/ui/timeline-lanes/collections.browser.test.tsx` | In a browser, a focused row button has a box shadow. |

None of them checks the hover fill, the size of the loading bar, or the list at 390 px. The gallery screenshot
below takes in this entry at that width.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component).

The same spec takes a full-page screenshot of the gallery at 1440, 1024 and 390 px in both themes and compares it
with a baseline image, under the same skip. This entry is in the gallery. No baseline image for those
screenshots is checked in on this branch.

## Phone behaviour at 390 px

Nothing in the list's own rules changes with the width of the screen. The module has no media query and no
container query.

- A row is at least 32 px high (`--row-h-compact`) at every width, and grows as its text wraps. Nothing grows to
  the 44 px touch size: the module does not read `--target-touch`.
- The text takes what the mark and the end leave, and may break anywhere.
- The mark and the end do not shrink (`flex: none`). A long end value leaves less room for the text; nothing is
  cut off with an ellipsis.

## Copy rules

- `ItemList` holds no text of its own, owns no message id and imports no catalog. There is no built-in loading,
  empty or error text.
- `label`, each item's `text` and `end`, `empty` and `error` come from the message catalog in `packages/i18n`,
  through the caller. The `en` catalog is the source and the `ko` catalog must define every id.
- `label` is a plain string that names the list for assistive technology. It is never visible. A visible title
  for the list is a `Card` title or a `SectionHead`: see [Card](card.md).
- The line says its state in words. The tone and the mark repeat it.
- `error` says what failed, in words. Its look is a colour and nothing else.
- Format a number or a date before passing it. The list prints `text` and `end` as given.
- The gallery's sample text is in the gallery catalog, which stays out of production.

## Props

<!-- ds:props apps/web/src/ui/item-list/item-list.tsx -->

### ItemList

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `items` | yes | `readonly Item[]` |  |  |
| `density` | no | `"default" \| "dense"` |  |  |
| `empty` | no | `ReactNode` |  |  |
| `error` | no | `ReactNode` |  |  |
| `label` | no | `string` |  |  |
| `loading` | no | `boolean` |  |  |

<!-- /ds:props -->

The members of `Item` are under Anatomy.

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/item-list/item-list.module.css -->

| Token | Read by |
| --- | --- |
| `--border-soft` | `background`, `border-top` |
| `--danger-solid` | `color` |
| `--focus` | `box-shadow` |
| `--muted` | `background` |
| `--ok-solid` | `color` |
| `--radius-sm` | `border-radius` |
| `--row-h-compact` | `height`, `min-height` |
| `--space-2` | `gap` |
| `--space-3` | `padding` |
| `--steel` | `color` |
| `--text-sm` | `font-size` |
| `--text-xs` | `font-size` |
| `--warn-solid` | `color` |

<!-- /ds:tokens -->

The focus look of a control the caller puts inside a row belongs to that control and is not listed.
