<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Command palette

`CommandPalette` is a modal search box near the top of the screen: one field over sections of results, where
picking a result closes the palette and runs that result's action.

It lives in `apps/web/src/ui/command-palette`: the component in `command-palette.tsx` and its styles in
`command-palette.module.css`. It is built on five parts of React Aria Components: the modal overlay, the dialog,
the autocomplete, the search field and the menu.

One caller uses it on this branch: `JumpPalette` in `features/structure/ui/jump-palette.tsx`, which the shell
opens from a button in the top bar and from a key chord.

## When to use it, and when not

Use it to jump: one field that finds things of several kinds (places, people, tasks) and lists them in sections,
where each result does something different when picked.

The palette filters nothing. The caller reads `query`, builds the sections that match, and passes them in.

| Do not use it for | Use instead |
|---|---|
| A list of commands behind one button | `ActionMenu` or `MenuButton`: see [Menu](menu.md). |
| A box that narrows a list already on the page | `SearchField` (`ui/search`). |
| A palette where a row can be unavailable, a notice sits above the results, or Enter in the field always takes the first result | `Palette` (`ui/palette`). It is a second palette, built on a list box, with data types of the same names. `features/people/ui/people-jump.tsx` uses it. |
| Picking a value in a form | `SelectField` (`ui/select`) for a short list, `ServerPicker` (`ui/server-picker`) for a search over a large one. |
| The acts of one record, each with a letter key | `ActionGrid` (`ui/action-grid`). |
| A confirmation or a short question | `Dialog`: see [Dialog](dialog.md). |

## Anatomy

| Part | Element | Holds |
|---|---|---|
| Overlay | `<div>` | The dimmed backdrop. It fills the viewport and puts the palette at the top, centred. React Aria renders it in a portal on `<body>`. |
| Modal | `<div>` | The width of the palette. It starts with React Aria's visually hidden dismiss button. |
| Dialog | `<section role="dialog">` | The field, the list and the foot, in a column. |
| Field | `<div>` | An 18 px search icon, the input, then the Esc hint. |
| Input | `<input type="search">` | `query`, with `placeholder` while it is empty. |
| Esc hint | `<kbd>` | Message `uiCommandPalette.esc`. It shows a key; it is not a button. |
| List | `<div role="menu">` | The sections. It is the part that scrolls. |
| Section | `<section role="group">` | A header, then its items. |
| Header | `<header>` | The section's `title`. |
| Item | `<div role="menuitem">` | The icon, the label, the detail and the meta, in a row. |
| Icon | The caller's node | `icon`, as passed. The palette adds no wrapper and does not hide it. |
| Label | `<span>` | The item's `label`. |
| Detail | `<span>` | The item's `detail`. Left out when it is empty. |
| Meta | `<span>` | The item's `meta`, at the end of the row. Left out when it is empty. |
| Empty box | `<div>`, inside a `<div role="menuitem">` | `empty`. It replaces the sections when none of them has an item. |
| Foot | `<div>` | `footer`. Left out when `footer` is not given. |

The data is plain. A `PaletteSection` is `{ id, title, items }`. A `PaletteItem` is
`{ id, icon?, label, detail?, meta?, onAction }`.

- A section with no items is not drawn: no header, no group.
- Item ids must be unique across all sections. A pick is looked up by id in every drawn section, and the first
  match runs.
- A section id must not equal any item id. The palette passes both as `id` to one React Aria collection, which
  keeps sections and items under one set of keys. This is read from the library, not run.
- A pick calls `onClose` first, then the item's `onAction`.
- An item cannot be marked unavailable. Every item drawn can be picked.

With `open={false}` nothing is rendered. The component takes the props in the Props section and nothing else, and
passes no attribute through. Unlike `Dialog` and `Sheet`, it does not hold the page's live re-reads while it is
open.

## Looks and sizes

There is one look and one size.

| Part | Look |
|---|---|
| Overlay | Fixed to the viewport, with a `--scrim` fill. Its `z-index` is the literal `50`, above the sheet's layer (`--z-sheet`, 20). The palette starts `calc(var(--frame-top) * 2)` from the top: 96 px. |
| Modal | `min(940px, calc(100vw - var(--space-6) * 2))` wide: 940 px, or the viewport width less 64 px when that is less. The 940 is a literal. |
| Dialog | `--surface` fill, a 1 px `--border` border, a 10 px radius (`--radius-lg`) and `--shadow-pop`. Its height is at most `calc(100vh - var(--frame-top) * 4)`, the viewport height less 192 px. What does not fit is cut off at the box; the list scrolls inside it. |
| Field | 12 px top and bottom padding (`--space-3`), 16 px at the sides (`--space-4`), a 12 px gap, and a 1 px `--border` line under it. The icon is `--steel`. |
| Input | No border and no fill. `--ink` text at 16 px (`--text-lg`). It takes the width the icon and the hint leave. The browser's own clear button is hidden in WebKit. |
| Esc hint | A key cap: 12 px monospace text (`--text-xs`, `--font-mono`), `--steel`, on `--kbd-bg`, with a 1 px `--border` border, a 4 px radius (`--radius-sm`) and 4 px side padding. The rule is the palette's own; it does not use `Kbd` (see [Kbd](kbd.md)). |
| Header | 12 px (`--text-xs`), `--steel`, 8 px top and bottom padding and 16 px at the sides, with a 1 px `--border-soft` line under it. |
| Item | A row at least 40 px high (`--row-h`), with 16 px side padding, an 8 px gap, 13 px text (`--text-sm`), a 1 px `--border-soft` line under it and a pointer cursor. |
| Label | Weight 700 (`--fw-strong`). One line, with no ellipsis. |
| Detail | `--steel`. One line, cut with an ellipsis. |
| Meta | `--steel`, 13 px, pushed to the end of the row. No border and no fill. It keeps the 4 px side padding (`--space-1`) of the rule it shares with the Esc hint. |
| Empty box | 16 px of padding, `--steel`, 13 px. |
| Foot | A `--muted` fill, a 1 px `--border` line above it, 8 px top and bottom padding and 16 px at the sides, 12 px `--steel` text. A row with a 12 px gap. |

No prop picks a visual style. There is no open or close animation: the stylesheet has no transition and reads
neither `data-entering` nor `data-exiting`.

Every colour, padding, gap and font size in the stylesheet is a token. The literals are the `z-index` and the
940 px width.

## States

| State | What changes |
|---|---|
| Closed | Nothing is rendered. |
| Open | The overlay and the palette are drawn. Everything outside the palette is made inert, and React Aria locks the scroll of the document. |
| Rest | An item has no fill. |
| Hover | The stylesheet has no hover rule. React Aria's menu moves its focus to the item the pointer enters, so that item takes the focused look. This is read from the installed library, not seen in a browser. |
| Focus, on an item | A `--primary-soft` fill and `--selected-bar`, a 3 px `--primary` bar inside the left edge. The rule reads `data-focused`. The focus is virtual: the input keeps the real focus and points at the item. |
| Focus, on the input | Nothing but the text caret. See the note under this table. |
| Focus, on the dialog | The dialog, the modal, the list and the items each set `outline: none`. See the note under this table. |
| Pressed | No look. React Aria sets `data-pressed` on an item; no rule reads it. |
| Selected | Does not exist. The menu has no selection. |
| Disabled | Does not exist. Neither the palette nor an item can be disabled. |
| Read-only, invalid | Do not exist. |
| Loading | Does not exist. The palette has no prop for a search that is still running; it draws the sections it has. |
| Empty | When no section has an item, the empty box is drawn with `empty`. When `empty` is not passed, the box is still drawn, with its padding and no text. |

Two rules take the focus outline away, and they do not weigh the same.

- On the input, the rule is `.input:focus`, a class and a pseudo-class. It outweighs the global `:focus-visible`
  rule in `app.css` whatever the order of the stylesheets, and it removes the box shadow too. The input never
  shows a focus indicator of its own.
- On the dialog, the modal, the list and the items, the rule is one class against the one pseudo-class of the
  global rule. The two weigh the same, and the palette's rule comes later: the entry module imports `app.css`
  statically and reaches the palette only through lazy imports, so the palette's stylesheet loads after
  `app.css`. So none of the four shows the global outline. This was read from the stylesheets and the imports,
  not checked in a browser.

## Keyboard

Opening the palette is the caller's. The shell opens `JumpPalette` on Command+K or Control+K and from the search
button in the top bar. It matches the physical K key (`code`), not the character, so the chord does not depend on
the input language.

The component has no key handler of its own. Every key below is handled by React Aria, and what the table says
was read from the installed version (`react-aria-components` 1.22.1). Two rows name a spec that depends on them.
No test in this repository presses any other key in the palette.

| Key | What it does |
|---|---|
| A character | Changes the text: `onQuery` is called with the new value. Text typed forward also arms one move of the list's focus. The next time the list's first result or its number of results changes, the focus goes to the result that is then first, and the move is spent. While neither changes, nothing moves. If the list is empty at that change, the move waits for the next one. If the list's focus changes another way first, by an arrow key for one, the move is dropped. Results that land after the move, such as a server search that answers late, do not take the focus, also when they land above the focused result. `e2e/structure-views.spec.ts` depends on the move: it fills in a name, presses Enter and expects the chart to open with that place selected. |
| Paste, Backspace, Delete, undo | Changes the text, and clears the list's focus. Enter then does nothing until the focus is back in the list: by Arrow Down or Arrow Up, or by typing forward, as in the row above. |
| Arrow Down, Arrow Up | Moves the list's focus through the items, across sections. They wrap: Down on the last result goes to the first, and Up on the first goes to the last. When the list holds no place, as when the palette has just opened or after Backspace, Delete, paste or undo, Down goes to the first result and Up to the last. The input keeps the real focus. |
| Home, End, Page Up, Page Down | Go to the list, not to the text. |
| Arrow Left, Arrow Right | Moves the caret in the text. A focused result also loses the list's focus, and Enter then does nothing until the focus is back in the list. Unlike Backspace, this keeps the list's place: Arrow Down or Arrow Up moves on from the result that was focused. Typing a character brings the focus back as well. |
| Enter | Picks the focused result: `onClose`, then the item's `onAction`. With no result focused it does nothing. `e2e/states/request-jump.spec.ts` presses Enter with a result listed, and expects the palette to close and the result's page to open. |
| Space | Types a space. It never picks a result. |
| Escape | With text in the field: clears the text, through `onQuery("")`, and the palette stays open. With the field empty: closes the palette, through `onClose`. |
| Tab, Shift+Tab | Moves through the focusable elements inside the palette. Focus stays inside: React Aria contains it. The input is the only tab stop the palette renders; anything focusable in `footer` adds to it. |

A press on the backdrop also closes the palette.

**Where focus goes.** The palette passes no `autoFocus` to the field. React Aria's dialog then moves focus to the
dialog element itself when it opens, not into the input, so one Tab is needed before typing. This is read from
the library, not run: the specs that open the palette fill the field directly, and none checks where focus is
after opening. When the palette closes, React Aria returns focus to the element that had it before; no test
checks that for the palette either.

**The Korean input method.** The component has no check of `isComposing`, of key code 229 or of a composition
event. What happens is React Aria's:

- A key event whose `isComposing` flag is set is not passed on to the list. Arrow keys and Enter pressed while a
  syllable is being composed stay with the input method, so the Enter that confirms a syllable does not pick a
  result.
- Text that arrives from a composition counts as typing forward: it arms the move of the list's focus to the
  first result, as in the first row of the table.
- The Escape handling of the search field and of the overlay skips an event flagged as composing too.
- React Aria does not check key code 229. `Composer` (`ui/composer`) checks it as well as the flag, for a key
  event that ends a composition with the flag off. Nothing in the palette or in React Aria stops such an Enter
  from picking the focused result.

No test in this repository types through an input method into the palette.

## Accessibility contract

| Part | Role | Accessible name | Also exposed |
|---|---|---|---|
| Dialog | `dialog` | `label`, through `aria-label`. | No `aria-modal` and no description. |
| Input | `searchbox` | `label`, through `aria-label`. | `aria-autocomplete="list"`, `aria-controls` pointing at the list, and `aria-activedescendant` pointing at the focused item. |
| List | `menu` | `label`, through `aria-label`. | |
| Section | `group` | Its `title`, through `aria-labelledby`, which points at the header. | The header itself has `role="presentation"`. |
| Item | `menuitem` | Its `label`, through `aria-labelledby`. | `detail` is its description, through `aria-describedby`. `meta` is neither. |
| Esc hint | None | None. | Its text is read in place. It is not hidden. |
| Hidden dismiss button | `button` | React Aria's own text for "dismiss", in the locale the app gives React Aria. | It closes the palette. It is not in the tab order. |
| Empty box | Inside a `menuitem` | Its text. | |

- **Modality:** while the palette is open, everything outside it is `inert`: it cannot be focused, pressed or
  read.
- **Announced:** nothing through a live region. A screen reader comes to an item through
  `aria-activedescendant` on the input, and reads the item's name and description. When typing moves the list's
  focus to the first result, React Aria waits half a second before it points the input at that result, so that
  the character is heard first. This is read from the library.
- **Not announced:** that the results changed, how many there are, or that there are none. The empty box is not
  a status region.

What the specs check in a browser:

- `e2e/states/request-jump.spec.ts` opens the palette at 1440 and 390 px in the light and the dark theme. It
  finds the dialog by `label`, the input by the role `searchbox` with the caller's placeholder, and a result by
  the role `menuitem` and its label alone. It checks that the page fits and runs axe with a result listed. A
  second test opens the palette with the key chord.
- `e2e/structure-views.spec.ts` opens it with the key chord against a real server, at 1440 px, and runs its
  accessibility check with results listed.

The WCAG 2.2 criteria that apply:

| Criterion | How the palette answers it |
|---|---|
| 1.3.1 Info and Relationships | Sections are groups named by their headers, and results are menu items in them. |
| 1.4.3 Contrast (Minimum), 1.4.11 Non-text Contrast | Every colour is a token. The focused result is marked by a fill and by a 3 px bar. |
| 1.4.10 Reflow | The palette is never wider than the viewport less 64 px, and the list scrolls inside it. A label does not wrap. |
| 2.1.1 Keyboard | Every result can be reached and picked with the arrow keys and Enter, and the palette closed with Escape. |
| 2.1.2 No Keyboard Trap | Focus is held inside on purpose. Escape is the way out, pressed twice when the field has text. |
| 2.1.4 Character Key Shortcuts | It has none: no single character key runs a command. |
| 2.4.3 Focus Order | Focus moves into the palette on open and back on close. It does not start in the input: see the gaps. |
| 2.4.7 Focus Visible | The focused result shows the fill and the bar. The input shows only its caret: see the gaps. |
| 2.4.11 Focus Not Obscured (Minimum) | The page behind is inert, so focus cannot sit under the overlay. |
| 2.5.8 Target Size (Minimum) | A result is a full-width row at least 40 px high. |
| 4.1.2 Name, Role, Value | The table above. |
| 4.1.3 Status Messages | Not answered. A change in the results, and an empty result, are not status messages. |

Known gaps:

- Focus lands on the dialog, not in the input, when the palette opens. Read from the library, as said under
  Keyboard.
- The input has no focus indicator but its caret.
- The dialog, the input and the list all carry the same name.
- `meta` is not part of an item's name or description.
- The empty box sits inside an element with the role `menuitem`, also when `empty` is not passed and the box has
  no text.
- The hint in the field says Esc, and the first Escape clears the text when there is any. It closes the palette
  only when the field is empty.
- The name of the hidden dismiss button is React Aria's text, not a message from `packages/i18n`.
- A long label is not cut: it has no ellipsis and does not wrap.

There is no gallery entry. No `*.gallery.tsx` under `apps/web/src` names `CommandPalette` or `JumpPalette`, so the
gallery and its accessibility scan never show the palette.

There is no test in `ui/command-palette`. `features/structure/ui/jump-palette.test.tsx` replaces the component
with a stub that records `sections`, so it tests what the caller builds and not the palette. The two specs above
are the only tests found that render it.

## Phone behaviour at 390 px

`command-palette.module.css` has no media query and no container query. What changes at 390 px follows from the
width rule.

- The palette is 326 px wide: 390 less 32 px (`--space-6`) on each side.
- It still starts 96 px from the top, and its height limit is still the viewport height less 192 px.
- That limit is written in `vh`, not `dvh`, so it does not follow the visible viewport as the browser's bars
  come and go.
- A result is 40 px high, as at 1440 px. It does not grow to the 44 px touch size; the palette does not read
  `--target-touch`.
- The label keeps to one line with no ellipsis, and the detail is cut with one, so in a narrow row the detail
  gives way first. A label wider than the row is not handled by any rule of the palette. This is read from the
  CSS, not seen in a browser.
- The Esc hint is still shown.
- React Aria asks the on-screen keyboard for a "go" key (`enterkeyhint`) and turns autocorrect and spell check
  off on the input.

`e2e/states/request-jump.spec.ts` checks at 390 px that the page fits with results listed.

## Copy rules

- The palette has one message id of its own: `uiCommandPalette.esc`, the text of the Esc hint.
- `label`, `placeholder`, each section's `title`, each item's `label`, `detail` and `meta`, `empty` and `footer`
  are the caller's, from the message catalog in `packages/i18n` or from data. The `en` catalog is the source and
  the `ko` catalog must define every id.
- `label` is a name, not a sentence: it names the dialog, the input and the list.
- An item's `label` is short, because it is never cut. Put what can be long in `detail`.
- `detail` is what a screen reader reads after the label. `meta` is not read with the item, so it must not carry
  the only copy of a fact.
- The one built-in text that is not from the catalog is the name of the hidden dismiss button. It comes from
  React Aria.

## Props

<!-- ds:props apps/web/src/ui/command-palette/command-palette.tsx -->

### CommandPalette

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `label` | yes | `string` |  |  |
| `onClose` | yes | `() => void` |  |  |
| `onQuery` | yes | `(q: string) => void` |  |  |
| `open` | yes | `boolean` |  |  |
| `placeholder` | yes | `string` |  |  |
| `query` | yes | `string` |  |  |
| `sections` | yes | `readonly PaletteSection[]` |  |  |
| `empty` | no | `ReactNode` |  |  |
| `footer` | no | `ReactNode` |  |  |

<!-- /ds:props -->

`PaletteSection` and `PaletteItem` are the two data types under Anatomy. The module exports both.

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/command-palette/command-palette.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border`, `border-bottom`, `border-top` |
| `--border-soft` | `border-bottom` |
| `--font-mono` | `font-family` |
| `--frame-top` | `max-height`, `padding-top` |
| `--fw-strong` | `font-weight` |
| `--ink` | `color` |
| `--kbd-bg` | `background` |
| `--muted` | `background` |
| `--primary-soft` | `background` |
| `--radius-lg` | `border-radius` |
| `--radius-sm` | `border-radius` |
| `--row-h` | `min-height` |
| `--scrim` | `background` |
| `--selected-bar` | `--shadow-x` |
| `--shadow-pop` | `box-shadow` |
| `--shadow-x` | `box-shadow` |
| `--space-1` | `padding` |
| `--space-2` | `gap`, `padding` |
| `--space-3` | `gap`, `padding` |
| `--space-4` | `padding` |
| `--space-6` | `width` |
| `--steel` | `color` |
| `--surface` | `background` |
| `--text-lg` | `font-size` |
| `--text-sm` | `font-size` |
| `--text-xs` | `font-size` |

<!-- /ds:tokens -->

`--shadow-x` is not a token from `packages/tokens`. The rule for a focused item sets it to `--selected-bar` and
reads it back as the item's `box-shadow`.

The table lists tokens only. The `z-index` of the overlay and the 940 px of the width are literals and are not in
it.
