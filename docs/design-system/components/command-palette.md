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
| Open | The overlay and the palette are drawn, and the input has the focus. Everything outside the palette is made inert, and React Aria locks the scroll of the document. |
| Rest | An item has no fill. |
| Hover | The stylesheet has no hover rule. React Aria's menu moves its focus to the item the pointer enters, so that item takes the focused look. This is read from the installed library, not seen in a browser. |
| Focus, on an item | A `--primary-soft` fill and `--selected-bar`, a 3 px `--primary` bar inside the left edge. The rule reads `data-focused`. The focus is virtual: the input keeps the real focus and points at the item. While the field holds text, the palette keeps this focus on the first result: see Keyboard. |
| Focus, on the input | Nothing but the text caret. See the note under this table. |
| Focus, on the dialog | The dialog, the modal, the list and the items each set `outline: none`. See the note under this table. |
| Pressed | No look. React Aria sets `data-pressed` on an item; no rule reads it. |
| Selected | Does not exist. The menu has no selection. |
| Disabled | Does not exist. Neither the palette nor an item can be disabled. |
| Read-only, invalid | Do not exist. |
| Loading | No look. `pending` tells the palette that a search is still out. It changes what Enter does (see Keyboard) and draws nothing: no spinner and no text. The palette draws the sections it has. |
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

On the tenant side, the Console shell also opens it on `/` (`shell.search` in `lib/pure/keys.ts`, handled in
`shell/console/shell.tsx`). The platform side binds neither `/` nor ⌘K, and its top bar has no search button.
`/` is a single key, so it acts only while all of these hold:

- single keys are on for the device (`singleKeysOn`, read at each key press);
- focus is not in a field;
- no dialog or alert dialog is open;
- no input method is composing.

Before opening the palette, `/` looks in `#main` for the first `input[type="search"]` or input inside a
`[data-list-find]` element. If that first match is shown, `/` focuses and selects it instead. Only the first match is
checked, so a hidden first match lets the palette open even when a later find box is shown.

The top bar's search button names ⌘K, Ctrl+K and, while single keys are on, `/` in `aria-keyshortcuts`. It reads the
setting when the top bar renders and does not follow a change until the next render. The visible `/` hint on the
button shows either way.

The component has one key handler. It sits on the input and runs in the capture phase, before React Aria's
handlers, and it acts on Enter, on Escape, on a key the input method owns and on the six keys that move through
the list. Everything else in the table is React Aria's, read from the installed version
(`react-aria-components` 1.22.1).

`features/structure/ui/jump-palette.browser.test.tsx` runs the palette in a browser, through `JumpPalette`. "A
browser test" below is a test in that file. Between them they type characters, press Enter, Escape, Arrow Down,
Arrow Left, End, Backspace and the paste chord, and click in the field and on a result. No test presses Arrow
Up, Arrow Right, Home, Page Up, Page Down, Delete, Space or Tab in the palette, and none undoes a change. What
the table says of those is read from the code and the library, not run.

| Key | What it does |
|---|---|
| A character | Changes the text: `onQuery` is called with the new value. The list's focus then goes to the first result of the new list: see "The first result" under this table. A change of the text also frees the list's focus from a result the person moved to with the keys. A browser test types a name and checks that the first person found has the list's focus, also when the server answers after the last character. |
| Paste, Backspace, Delete, undo | Changes the text. React Aria clears the list's focus, and the palette puts it back on the first result once the search for the new text is settled, so Enter picks that result. When the change leaves the field empty or holding only spaces, no result is focused and Enter does nothing. A browser test pastes a request key and presses Enter. Two more delete a character with Backspace and press Enter. |
| Arrow Down, Arrow Up | Moves the list's focus through the items, across sections. They wrap: Down on the last result goes to the first, and Up on the first goes to the last. When the list holds no place, as when the palette has just opened or the field has just been emptied, Down goes to the first result and Up to the last. The input keeps the real focus. A result moved to this way keeps the list's focus when late results land: see "The first result". A browser test presses Arrow Down on the first person and then Enter, and the second person opens. |
| Home, End, Page Up, Page Down | Go to the list, not to the text. A result moved to this way keeps the list's focus, as with the arrows. A browser test presses End, lets a late result land above, and checks that Enter still picks the last result. |
| Arrow Left, Arrow Right | Moves the caret in the text. A focused result also loses the list's focus, so Enter falls to its rule for no focused result: with text in the field it picks the first result, also when the result that lost the focus was another one. The list keeps its place all the same: Arrow Down or Arrow Up moves on from the result that was focused. A browser test presses Arrow Left with the first result focused and then Enter. The case of another result focused is read from the code, not run. |
| Enter | Picks the focused result: `onClose`, then the item's `onAction`. With no result focused and text in the field, it picks the first result. With no result focused and the field empty or holding only spaces, it does nothing. While a search that can change the first result is still out, it does nothing, unless the person has moved through the list with the keys: see "Enter and a late search". An Enter the input method owns picks nothing. `e2e/states/request-jump.spec.ts` presses Enter with a result listed, and expects the palette to close and the result's page to open. `e2e/structure-views.spec.ts` fills in a name, presses Enter and expects the chart to open with that place selected. |
| Space | Types a space. It never picks a result. |
| Escape | With text in the field: clears the text, through `onQuery("")`, and the palette stays open. No result is focused after the clear, so an Enter that follows picks nothing, also when the caller lists results for an empty field. With the field empty: closes the palette, through `onClose`. A browser test presses Escape twice, for the clear and the close. Another presses Escape and then Enter, and nothing opens. An Escape the input method owns does neither: see "The Korean input method". |
| Tab, Shift+Tab | Moves through the focusable elements inside the palette. Focus stays inside: React Aria contains it. The input is the only tab stop the palette renders; anything focusable in `footer` adds to it. |

A press on the backdrop also closes the palette. A press in the field with a mouse drops the list's focus as
Arrow Left does, and Enter then picks the first result. A browser test clicks in the field with the first result
focused and presses Enter.

**The first result.** While the field holds text other than spaces, the palette keeps the list's focus on the
first result: the first item of the first section drawn. It moves the focus there each time the text changes and
each time another result becomes the first, as when a server search answers late and its results land above
those already listed. This is also how the focus comes back after a paste or a deletion, where React Aria clears
it. A browser test covers each of these.

The palette marks a first result only while the search is settled. That means two things: `pending` is not true,
and React's deferred copy of `query` has caught up with `query`. The copy is there because a caller's results may
trail the text by a render, as those of `JumpPalette` do. With no first result marked, the palette moves nothing.

No prop or call was found in the installed React Aria by which a caller can move the list's focus once the list
is drawn, so the palette moves it with a key. It renders a component with no output inside the first result,
and each time that component mounts it sends the input a `keydown` event for the Home key, made in code. React
Aria answers Home by moving the list's focus to the first result. The event is made, not pressed, so it does
not pass through an input method.

React Aria makes a move of its own as well, which the palette leaves alone. Text typed forward arms one move of
the list's focus to the first result, made the next time the list's first result or its number of results
changes.

A result the person moved to is theirs. A pressed Arrow Up, Arrow Down, Page Up, Page Down, Home or End stops
the palette from sending its Home key until the text changes, so late results do not take the list's focus,
also when they land above the focused result. Only a pressed key does this. A result that has the list's focus
because the pointer entered it is not held: when another result becomes the first, the palette moves the focus
there. That last case is read from the code, not run.

Three things in this are fragile.

- The Home key is a real `keydown` event on the input. It bubbles, and its `isTrusted` flag is false. A listener
  in the capture phase on the document or the window sees it before React Aria does. Such listeners exist today.
  The idle timer in `auth/idle.ts` skips an event that is not trusted. The listeners in `lib/react/announce.ts`,
  which move focus to a heading after the page changes, do not: they take any key for the person's next action
  and drop a focus move that is still pending. None found acts on Home by name. A page-wide Home shortcut added
  later that listens in capture would run each time the palette marks a first result, unless it skips events
  that are not trusted.
- On Escape the handler sends the input a second made event: `beforeinput` with the input type `deleteContent`.
  React Aria reads the input type of the last `beforeinput` to tell typing forward from a deletion. Told this
  way, it takes the clear for a deletion and drops the list's focus. Untold, it takes the clear for the
  character typed last and focuses the first result of the emptied list, which Enter would then pick.
- To tell whether a result is focused, the Enter rule looks inside the dialog for a menu item that carries
  `data-focused`, an attribute React Aria sets.

All three lean on what React Aria 1.22.1 does, which was read from the library. The browser tests assert the
outcomes, so they are what would show an upgrade changing any of them.

**Enter and a late search.** `pending` is the caller's word that a search for the text is still out and that its
answer may become the first result. While the search is not settled, because `pending` is true or because the
deferred copy of `query` has not caught up, Enter in the field is stopped before React Aria sees it and picks
nothing, unless the person has moved through the list with the keys. This keeps Enter from opening a result that
is first only until the answer lands.

- The press is dropped, not held. When the answer has landed, the person presses Enter again. A browser test
  does that: its first Enter opens nothing, and its second opens the person the search found.
- A result can show the focused look while Enter does nothing. The palette sends no Home key during the wait,
  but React Aria's own move for typing forward still runs. A browser test sees the request lookup take the
  list's focus while the people search is out. Nothing on screen says that a search is out.
- Once the person has moved through the list with the keys, Enter is not stopped: it picks the result they are
  on. This is read from the code. The browser test that moves with End presses Enter after the answer has
  landed.
- A click on a result does not wait either: the rule is on Enter in the field alone. This too is read from the
  code. The browser test that clicks a result does so with the search settled.

`JumpPalette` passes `pending` while its people search for the text has not answered and no place matches the
text. People are listed above the request lookup and the tasks, so with no place found the first person becomes
the first result. When a place matches, it is the first result whatever the people search answers, and Enter
does not wait. A browser test covers that case too. A caller that searches late and does not pass `pending` gets
no wait: Enter picks whatever is first when it is pressed.

**Where focus goes.** The palette passes `autoFocus` to the search field, so the input has the focus when the
palette opens, and typing goes into it with no click and no Tab. A browser test checks this for both ways
`JumpPalette` is opened, the key chord and a button. When the palette closes, React Aria returns focus to the
element that had it before. The same test checks that for the button, after Escape closes the palette. No test
checks it after the key chord, or after a result is picked.

**The Korean input method.** The palette's key handler asks `isImeKey` (`lib/pure/ime.ts`) whether the input
method owns a key. It does when the event's `isComposing` flag is set, when its key code is 229, which covers
the key that ends a composition with the flag off, or when its key is `Process`. The component listens for no
composition event.

- An Enter that the input method owns is stopped before React Aria sees it. It picks nothing, with a result
  focused or without, so the Enter that confirms a syllable does not open a result. A browser test sends Enter
  marked both ways, by the flag and by key code 229 alone, checks that nothing opens, and then checks that a
  plain Enter picks the first result.
- An Escape that the input method owns is stopped the same way and its default action is cancelled: the text is
  not cleared and the palette does not close. A Tab that the input method owns is stopped too, and its default
  action is left to the browser. Both come from `leaveImeKey` in the same file. For this palette they are read
  from the code: `apps/web/src/ui/ime-keys.browser.test.tsx` tests that guard on other components, and not on
  this one. React Aria's own Escape handling, in the search field and in the overlay, skips an event flagged as
  composing too.
- The arrow keys are React Aria's. A key event whose `isComposing` flag is set is not passed on to the list, so
  an arrow key pressed while a syllable is being composed stays with the input method. React Aria does not
  check key code 229.
- Text that arrives from a composition is a change of the text like any other. React Aria counts it as typing
  forward, and the palette sends its Home key for it. A browser test grows one composition a letter at a time.
  It checks after each letter that the first result has the list's focus, and at the end that the composition
  was not broken.

No test runs a real input method. The browser test opens its composition in Chromium through the debugging
protocol, and its two Enter events are dispatched, not pressed.

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
  the character is heard first. Only typing forward arms that wait. When the palette puts the focus back after a
  paste or a deletion, none is armed, and the input points at the first result at once. Whether a wait applies
  when a late answer changes the first result was not worked out. All of this is read from the library, with no
  screen reader used. The browser tests read `aria-activedescendant` to tell which result has the list's focus,
  and do not time it.
- **Not announced:** that the results changed, how many there are, or that there are none. The empty box is not
  a status region. Nor is it announced, or shown, that a search is still out and that Enter is waiting for it.

What the specs check in a browser:

- `e2e/states/request-jump.spec.ts` opens the palette at 1440 and 390 px in the light and the dark theme. It
  finds the dialog by `label`, the input by the role `searchbox` with the caller's placeholder, and a result by
  the role `menuitem` and its label alone. It checks that the page fits and runs axe with a result listed. A
  second test opens the palette with the key chord.
- `e2e/structure-views.spec.ts` opens it with the key chord against a real server, at 1440 px, and runs its
  accessibility check with results listed.
- `features/structure/ui/jump-palette.browser.test.tsx` opens `JumpPalette` on a fixture page that wires it as
  the shell does, with the server's answers made up and, where a test needs it, held back. It checks where focus
  is on open and on close, which result the input points at through `aria-activedescendant`, and what Enter
  opens: see Keyboard. It runs no axe scan, and it runs in Chromium only.

The WCAG 2.2 criteria that apply:

| Criterion | How the palette answers it |
|---|---|
| 1.3.1 Info and Relationships | Sections are groups named by their headers, and results are menu items in them. |
| 1.4.3 Contrast (Minimum), 1.4.11 Non-text Contrast | Every colour is a token. The focused result is marked by a fill and by a 3 px bar. |
| 1.4.10 Reflow | The palette is never wider than the viewport less 64 px, and the list scrolls inside it. A label does not wrap. |
| 2.1.1 Keyboard | Every result can be reached and picked with the arrow keys and Enter, and the palette closed with Escape. |
| 2.1.2 No Keyboard Trap | Focus is held inside on purpose. Escape is the way out, pressed twice when the field has text. |
| 2.1.4 Character Key Shortcuts | It has none: no single character key runs a command. |
| 2.4.3 Focus Order | Focus moves into the input on open, and back to the element that had it on close. |
| 2.4.7 Focus Visible | The focused result shows the fill and the bar. The input shows only its caret: see the gaps. |
| 2.4.11 Focus Not Obscured (Minimum) | The page behind is inert, so focus cannot sit under the overlay. |
| 2.5.8 Target Size (Minimum) | A result is a full-width row at least 40 px high. |
| 4.1.2 Name, Role, Value | The table above. |
| 4.1.3 Status Messages | Not answered. A change in the results, an empty result and a search that is still out are not status messages. |

Known gaps:

- The input has no focus indicator but its caret.
- The dialog, the input and the list all carry the same name.
- `meta` is not part of an item's name or description.
- The empty box sits inside an element with the role `menuitem`, also when `empty` is not passed and the box has
  no text.
- The hint in the field says Esc, and the first Escape clears the text when there is any. It closes the palette
  only when the field is empty.
- The name of the hidden dismiss button is React Aria's text, not a message from `packages/i18n`.
- A long label is not cut: it has no ellipsis and does not wrap.
- Nothing shows or announces that a search is still out. While one is, a result can look focused and Enter does
  nothing, and that press is not kept.
- After Arrow Left, Arrow Right or a press in the field, Enter picks the first result, also when the list's
  focus was on another result before.
- The list's focus is kept on the first result by a Home key made in code, which every capture-phase `keydown`
  listener on the document sees: see "The first result" under Keyboard.
- The focus on open, a late search, a paste, a deletion and the input method are proved by one test file, which
  launches Chromium by name. The specs follow the engine their run names (`e2e/browser.ts`), but they check none
  of those. No test uses a real input method or a screen reader.

There is no gallery entry. No `*.gallery.tsx` under `apps/web/src` names `CommandPalette` or `JumpPalette`, so the
gallery and its accessibility scan never show the palette.

There is no test file in `ui/command-palette`: the palette is tested through its one caller.
`features/structure/ui/jump-palette.test.tsx` replaces the component with a stub that records `sections`, so it
tests what the caller builds and not the palette. Four test files were found that render it: the two specs and
the browser test above, and `e2e/states/patterns-baseline.spec.ts`, which opens it with the key chord, sees the
dialog and presses Escape.

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
- The input takes the focus on open at any width: the code has no width in it. No test checks that at 390 px.
  The browser test runs at Playwright's default viewport, 1280 px wide, and the spec that opens the palette at
  390 px fills the field without checking where focus is.

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
| `pending` | no | `boolean` |  | A search for the text is still out and its answer may become the first result. |

<!-- /ds:props -->

`PaletteSection` and `PaletteItem` are the two data types under Anatomy. The module exports both.

`pending` draws nothing. It is the caller's word that a search for the text in the field is still out and that
its answer may become the first result. While it is true the palette marks no first result, and Enter in the
field waits: see "Enter and a late search" under Keyboard. A caller whose late results can only land below the
first result has no need of it.

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
