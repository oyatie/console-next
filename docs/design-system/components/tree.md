<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Tree

A tree shows a hierarchy as indented rows and lets one row be chosen: `TreeView` renders the caller's items as a
tree grid in which a chevron opens and closes each branch.

It lives in `apps/web/src/ui/tree/tree.tsx`, with `tree.module.css` beside it. The layout of a row and the
chevron are global rules in `apps/web/src/app.css`: `tree__row` and `tree__chevron`. It is built on `Tree`,
`TreeItem` and `TreeItemContent` of React Aria Components.

What this page says React Aria does is read from the source of the installed version (`react-aria-components`
1.22.1, with `react-aria` 3.53.1), unless a test is named.

## When to use it, and when not

Use it to pick one node of a hierarchy: the place a department moves to, the unit a grant covers, the scope of a
schedule. On this branch five feature components render it: the target tree of organisation changes, which
several sheets and pages use, the move dialog of the structure page, the scope sheet of a grant, the scope tree
of attendance and the destination picker of a closing workplace.

| Do not use it for | Use instead |
|---|---|
| One pick from a flat list | `ChoiceField`: see [Choice](choice.md). Or `SelectField` (`ui/select`). |
| Several picks | Nothing in the tree: it is single-select and has no checkboxes. For a flat list, `Checks`: see [Choice](choice.md). |
| A place picked by searching, shown as its path | `PathPicker` (`ui/path-picker`), or `PathList` (`ui/path-list`) for a list that is always open. |
| A flat list of lines that nobody picks from | `ItemList`: see [ItemList](item-list.md). |
| Records with the same columns | `Table` (`ui/table.tsx`). |
| The organisation chart as a picture | `OrgCanvas` (`ui/org-canvas`). |

## Anatomy

| Part | Element | Holds |
|---|---|---|
| Root | `<div role="treegrid">`, with the global `tree` class and the module's class | `id`, `aria-label` from `label`, `data-density` from `density`, `data-state="error"` when `error` is given, and `data-form-value` with `selected`, or an empty string when none is chosen: see [Sheet](sheet.md#dirty-and-how-a-sheet-closes). |
| Row | `<div role="row" class="react-aria-TreeItem">`, one for each visible item | `data-id` with the item's `id`. Rows are siblings in the document whatever their depth: React Aria flattens the tree and gives each row its level. |
| Cell | `<div role="gridcell">` with `display: contents` | The row layout. Every row has exactly one. |
| Row layout | `<div class="tree__row">` | The chevron or its placeholder, then the row content. |
| Chevron | `<button class="tree__chevron">` | On an item with children: a 14 px chevron icon, marked `aria-hidden`. A press opens or closes the item. |
| Chevron placeholder | `<span class="tree__chevron">` | On an item with no children: empty. It keeps the content of a leaf in line with its siblings. |
| Row content | Whatever `row(item)` returns | The caller's markup. |
| State block | A `<div role="row">` holding a `<div role="gridcell">`, both with `display: contents` | The error, the loading bar or the empty text, when the tree has no rows. |

The data is the caller's:

- An item is any object with a string `id`. The `id` is the item's key, so it is unique in the whole tree, not
  only among its siblings.
- `roots` is the top level, and `childrenOf(item)` returns an item's children. It is called for every item,
  open or closed. An item has a chevron when it returns at least one child.
- `row(item)` draws the row and `textValue(item)` is the row's name as plain text.

The state is the caller's too. Selection is `selected` with `onSelect`, and expansion is `expanded` with
`onExpandedChange`. Both are controlled and there is no uncontrolled form: a caller that does not store what
`onExpandedChange` gives it has a tree that cannot open or close. `disabled` is a set of ids.

`onExpandedChange` is called with a copy of `expanded` in which one `id` has changed: that of the row that was
opened or closed. An `id` the caller listed for a row with no children stays in the set. `TreeView` does not
pass such an `id` on to React Aria as expanded, with one exception that is under Keyboard, so a caller may list
every `id` and ArrowLeft still works on a leaf.

`onSelect` is called with the `id` of the chosen row, or with `undefined` when the selection is cleared.

`required` is for a caller that has no use for an empty selection. With it the tree never clears a chosen row
and never calls `onSelect` with `undefined`: Escape does not clear the row, and neither does a press or Enter on
it. The tree can still start with no row chosen; `required` only keeps a chosen row from being cleared. Three of
the five callers pass it: the target tree, wherever it is shown, the destination picker of a closing workplace
and the scope sheet of a grant. The move dialog of the structure page and the scope tree of attendance do not,
and there a chosen row can be cleared. What Escape does in each kind of tree is under Keyboard.

`TreeView` has no search box, no checkboxes, no drag and drop and no lazy loading of children. Callers put a
search field above it and filter `roots` and `childrenOf`. Every visible row is in the document: nothing is
virtualised. The tree does not scroll and does not limit its height; callers that need that wrap it in a box of
their own.

It takes no `className` and has no ref.

## Looks and sizes

There is one look.

| Part | Look |
|---|---|
| Root | 4 px padding at the top, 8 px at the sides, 12 px at the bottom (`--space-1`, `--space-2`, `--space-3`). No border and no fill. |
| Row | A 6 px radius (`--radius`) and the pointer cursor. |
| Row layout | At least 40 px high (`--row-h`). Its parts in one line, centred vertically, 8 px apart (`--space-2`). 8 px padding at the end. The padding at the start is `calc((level - 1) * var(--space-5) + var(--space-2))`: 8 px at the top level, and 24 px more for each level below it. |
| Chevron and its placeholder | A 24 px square (`--space-5`), `--steel`, no border and no fill. |
| Text | Inherited. The tree sets no font size. |

The level comes from `--tree-item-level`, which React Aria sets on each row.

The chevron points right on a closed item and turns 90 degrees on an open one, over 120 ms. With
`prefers-reduced-motion: reduce` it turns at once.

`density` changes the padding of the root and nothing else:

| `density` | What changes |
|---|---|
| `dense` | The root has no padding at the top and bottom and 4 px at the sides (`--space-1`). Rows stay 40 px high. |
| `default`, or not set | Nothing. `default` writes `data-density="default"`, which no rule reads. |

## States

A row:

| State | What changes |
|---|---|
| Rest | No fill. |
| Hover (`data-hovered`) | A `--muted` fill. React Aria sets the attribute only on a row that can be selected, so a disabled row has no hover fill. |
| Keyboard focus (`data-focus-visible`) | The `--focus` ring as a box shadow: a 2 px `--surface` ring, then a 2 px `--primary` ring. The row's outline is removed, so the global focus outline is never drawn on a row. |
| Pressed | No look. React Aria sets `data-pressed`; no rule reads it. |
| Selected (`data-selected`) | A `--primary-soft` fill and `--primary` text. The fill stays while the row is hovered. Row content that sets a colour of its own keeps it. |
| Open (`data-expanded`) | The chevron is turned. |
| Disabled (its `id` is in `disabled`) | No look: no rule reads `data-disabled`. The row keeps the pointer cursor and loses only the hover fill. It cannot be selected, it cannot take focus, and its chevron does nothing, so a user can neither open nor close a disabled branch; only the caller can, through `expanded`. The caller says why in the row. |
| Read-only | Does not exist. |
| Invalid | Does not exist. |

The whole tree:

| State | What changes |
|---|---|
| Loading (`loading`) | No row is rendered, even when there are roots. The state block holds a `<div>` with `role="status"` and `aria-busy="true"`, with 16 px padding (`--space-4`), and inside it one bar: 40 px high (`--row-h`), `--border-soft`, with a 6 px radius (`--radius`). The bar does not move, and the block holds no text. |
| Error (`error`) | No row is rendered. The root gets `data-state="error"`. The state block holds a `<div>` with `role="alert"` that shows `error` at 13 px (`--text-sm`) in `--danger-solid`, inside 16 px padding. |
| Empty | With no roots and `empty` given, the state block shows `empty` at 13 px in `--steel`, centred, inside 16 px padding. With no roots and no `empty`, the state block's row and cell are still rendered, with nothing in them. There is no built-in empty text. |

`error` wins over `loading`, and `loading` wins over `empty`. `error` and `loading` count when they are truthy.
`empty` counts when it is anything but `null` or `undefined`: a `false` or an empty string draws an empty padded
block.

`TreeView` also passes `aria-busy` to the root while `loading`. React Aria's `Tree` forwards only `id`, the
labelling attributes, global attributes, event handlers and `data-` attributes to its element, so by its source
`aria-busy` is dropped and the tree grid itself is not marked busy. The unit test looks for `aria-busy="true"`
anywhere in the markup, which the loading block satisfies.

In each of these states the tree grid has no rows, so the grid itself is the tab stop, unless the state block
holds a tabbable element. A focused tree grid with no rows shows nothing. The module removes the root's outline
with a single-class rule, and the global focus outline is a single pseudo-class rule. The two weigh the same,
and the module's rule comes later: the entry module imports `app.css` statically and reaches the tree only
through lazy imports, so the tree's stylesheet loads after `app.css`. This was read from the stylesheets and the
imports, not checked in a browser.

## Keyboard

`TreeView` has one key handler of its own, for ArrowLeft on a closed row under a disabled parent: see below the
table. Every other key is React Aria's.

| Key | What it does |
|---|---|
| Tab, Shift+Tab | The tree is one tab stop. Focus first enters on the selected row; with none selected, on the first row, or on the last when it comes from after the tree. Later it returns to the row that had focus last. Tab leaves the tree. |
| ArrowDown, ArrowUp | Moves focus to the next or the previous visible row. It does not wrap and does not select. A disabled row is skipped. |
| ArrowRight | On a closed row with children, opens it. |
| ArrowLeft | On an open row, closes it. On a closed row, or on a row with no children, moves focus to its parent. Under a disabled parent, focus stays on the row. The details, and what a top-level row does, are below the table. |
| Home, End | Moves focus to the first or the last row that is not disabled. |
| PageUp, PageDown | By the source, moves focus to the first or the last row that is not disabled, as Home and End do. React Aria moves by a page of rows only in a collection that scrolls, and the tree element never scrolls. No test was found that presses them in a tree. |
| Typing | Moves focus to a row whose `textValue` starts with what was typed. |
| Enter, Space | Selects the focused row. On the row that is already selected, clears the selection, unless the tree has `required`: then the row stays selected. |
| Escape | Without `required`: with a row selected, clears the selection, and the tree keeps the key press to itself; with none selected, the tree does nothing and the key goes on to whatever encloses it. With `required`: the tree never takes the key, so it always goes on to whatever encloses the tree. A dialog or a sheet there answers by its own rules: see [Dialog](dialog.md) and [Sheet](sheet.md). |

`TreeView` does not pass `expanded` on to React Aria as it is. React Aria moves ArrowLeft to the parent only
from a row it does not hold as expanded, and on a row with no children that it does hold as expanded the key
does not reach the parent. So a row with children is passed on as expanded when its `id` is in `expanded`, and
a row with no children is not passed on, whatever the caller lists. ArrowLeft on such a row moves focus to its
parent. Callers do list such rows: the target tree, the destination picker of a closing workplace and the move
dialog of the structure page start with every `id` in `expanded`, leaves included. The scope sheet of a grant
and the scope tree of attendance pass every shown `id` while a search is on, and the scope tree of attendance
starts with the selected row's own `id` in it.

ArrowLeft does not reach a parent in two cases.

- **A top-level row** has no parent. In `arrow` mode focus goes to the last focusable element inside the row, if
  there is one: on a closed branch whose content holds no control, that is its chevron. In `tab` mode nothing
  happens. This is read from the source: the browser tests press ArrowLeft only on rows below the top level.
- **A row under a disabled parent.** A disabled row cannot take focus, and by the source React Aria's move to
  one ends with no row focused. `TreeView` keeps focus on the row instead, in two ways:
  - a row with no children under a disabled parent is passed on to React Aria as expanded, the one exception
    to the rule above. It then takes the same path as a top-level row: with no control in its content, it keeps
    focus. React Aria sets `aria-expanded` and `data-expanded` only on a row with children, so the row gets
    neither;
  - a closed row with children cannot be treated that way, because a row with children that is passed on as
    expanded is open. `TreeView` stops its ArrowLeft in a capture handler on the tree grid, before the row
    hears the key. Nothing happens: focus stays on the row and does not go to its chevron. An open row with
    children closes first, as anywhere, and the next ArrowLeft is the one that is stopped.

  Both were driven in a browser, in `arrow` mode and with rows whose content holds no control. What `tab` mode
  does, and what a row with no children does when its content holds a control, is read from the source.

`required` changes two keys. A caller that ignores `onSelect(undefined)` keeps its row selected, and a tree
without `required` then takes every Escape pressed inside it, so Escape from the chosen row never closes a
dialog or a sheet around the tree. `required` is for such a caller. With it:

- **Escape** is never the tree's. From a chosen row it closes a dismissable dialog around the tree, and the row
  stays chosen. In a sheet it does what Escape does anywhere else in that sheet: a clean sheet closes, and a
  sheet that holds unsaved input shows its unsaved line on the first press and closes on the second. A pick is
  unsaved input while the tree is shown: the tree carries the chosen row's id as `data-form-value` (empty when none
  is chosen), so a sheet that works out its own dirty state warns before Escape throws the pick away. A tree that
  closes on a pick takes its value with it. The destination trees of the dissolve sheet close on a pick, so its
  members block keeps the plan, where everyone goes and each person sent elsewhere, as `data-form-value` on its
  summary line: a destination or a person sent elsewhere there is unsaved input after its tree has closed. A
  person whose destination is where everyone goes is left out of that value, since the plan is the same with or
  without them. See [Sheet](sheet.md#dirty-and-how-a-sheet-closes). The closed tree takes the focused row with it
  too, and "Same as everyone" goes away once pressed, so after either the members block puts focus back on the
  button that opened the tree. It does so on the next frame: moved while the key that picked is still being
  handled, focus would carry that Enter to the button and open the tree again. The tests check this for a pick
  by Enter and for "Same as everyone" pressed by Enter or by the pointer.
- **Enter or a press** on the chosen row leaves it chosen. By the source the same holds for Space; the tests
  use Enter and the pointer only.

The callers that pass `required` are named under Anatomy. The target tree passes it wherever it is shown: in
the sheets where a department is merged or dissolved, on the bulk move page itself, where there is no overlay
to close, and in the dialog of that page that adds departments.

A tree without `required` keeps the Escape of the table: the first press clears the selection and the next one
goes on. The move dialog of the structure page stores the cleared selection, so its second Escape closes the
dialog. The scope tree of attendance ignores it: see the known gaps.

A pointer press on a row does what Enter does. A press on the chevron opens or closes the item and does not
select it.

`keyboardNavigationBehavior` decides how a control inside a row is reached:

| Value | What it does |
|---|---|
| `arrow`, React Aria's default when the prop is left out | ArrowRight, on a row that is already open or has no children, moves focus to the next focusable element inside the row, and ArrowLeft moves it back. Tab does not stop inside a row. |
| `tab` | Tab moves through the tabbable elements of the focused row before it leaves the tree. A key pressed in such an element, other than Tab, does not reach the tree. The scope tree of attendance uses this, because its rows hold links. |

The chevron is a button with `tabindex="-1"`: it is not a tab stop in either mode. In `arrow` mode it is a
focusable element inside the row, so by the source ArrowRight on an open row moves focus to it. That was not
driven in a browser for this page.

`apps/web/src/ui/timeline-lanes/collections.browser.test.tsx` presses ArrowDown, ArrowUp, End, Home and one
letter in a browser and checks where focus lands. `apps/web/src/ui/tree/tree.browser.test.tsx` presses
ArrowLeft, ArrowRight, ArrowDown, Enter, Escape, Tab and Shift+Tab, and types two letters. The component's own
tests press no other key: not Space, PageUp or PageDown. Every one of these presses is in Chromium and in no
other browser.

The component checks no `isComposing` flag and no key code 229, in its ArrowLeft handler or anywhere else, and
listens for no composition event. What React Aria does with a key the Korean input method owns differs by key:

- ArrowUp, ArrowDown, Home, End, PageUp, PageDown, Escape and Tab go through a handler that skips a key event
  whose `isComposing` flag is set.
- ArrowLeft and ArrowRight on a row, Enter and Space, and type-ahead have no such check.
- Type-ahead reads the `key` of every keydown. It takes a key as typed text when its name is one character long
  or does not start with a Latin letter, and compares what was typed with the start of each row's `textValue`.

A row is not a text field. No test in this repository presses a key in a tree with the Korean input method
active, and this page did not work out which key events a browser sends to a row in that case. The nearest
proof is in `apps/web/src/ui/tree/tree.browser.test.tsx`: it sends a row a made-up Escape keydown with
`isComposing` set and key code 229, in a tree with `required` inside a dialog, and the dialog stays open. That
says nothing about a real input method, and nothing about a tree that clears its selection on Escape.

## Accessibility contract

| Part | Role | Accessible name | Also exposed |
|---|---|---|---|
| Root | `treegrid` | `label`, through `aria-label`. Required. | |
| Row | `row` | `textValue(item)`, through `aria-label`. It replaces the row's content as the name. | `aria-level`, `aria-posinset` and `aria-setsize`. `aria-expanded` on a row with children. `aria-selected` on a row that can be selected. `aria-disabled="true"` on a disabled row. |
| Cell | `gridcell` | None. | `aria-colindex="1"`. |
| Chevron | `button` | React Aria's word for expand or collapse, then the row's name. | It is not in the tab order. |
| Loading block | `status` | None, and it holds no text. | `aria-busy="true"`. |
| Error block | `alert` | None. The error text is its content. | |

- **The row's name:** because `aria-label` replaces the content, `textValue` must hold everything the row shows:
  the name, the kind, the count, and the reason a row is disabled.
- **Selection:** `aria-selected` on the row. React Aria also speaks a change through its own live region while
  focus is in the tree: the row's `textValue` and its word for selected on the first pick, and its words for not
  selected when the selection is cleared. By the source, moving the selection straight from one row to another
  says nothing.
- **Opening and closing:** `aria-expanded` on the row changes. Nothing is announced.
- **Loading and error:** the error has the `alert` role. The loading block has the `status` role and no text, so
  there are no words to announce.
- **Text that is not from the catalog:** the chevron's name and the selection messages are React Aria's own
  translations, in the locale the app gives React Aria: `ko-KR` for the Korean catalog and `en-US` otherwise
  (`apps/web/src/main.tsx`).

Known gaps:

- A disabled row cannot take focus: the arrow keys skip it and Tab does not land on it. Its reason is in the row
  and in its name, but a keyboard user moving through the tree is never taken to it. ArrowLeft from a row under
  it stays on that row: see Keyboard.
- A disabled row has no look of its own and keeps the pointer cursor.
- A user can neither open nor close a disabled branch. The caller still can, through `expanded`, and must open it
  if its children are to be seen.
- The tree grid is not marked busy while loading: see States.
- An empty, loading or failed tree shows no focus look: see States.
- A tree without `required` takes Escape for itself while a row is selected: it clears the selection, stops the
  event and prevents its default. `Dialog` closes on an Escape that reaches React Aria's overlay, so with focus
  in such a tree inside a dialog, the first Escape clears the selection and does not close the dialog. A caller
  that ignores `onSelect(undefined)` keeps the row selected, and the tree then takes every Escape pressed inside
  it. Four of the five callers ignore it. Three of them pass `required`, which ends this for them: see
  Keyboard. Two callers render the tree without `required`:
  - the move dialog of the structure page stores the cleared selection, so its first Escape clears the pick
    and its second closes the dialog. `apps/web/src/ui/tree/tree.browser.test.tsx` drives a fixture of that
    shape, a tree without `required` in a dialog, and not the move dialog itself;
  - the scope tree of attendance ignores `onSelect(undefined)`, so its tree takes every Escape pressed inside
    it while a row is selected. It is on a page, with no overlay to close. No test was found that presses
    Escape in it.

  No caller shows a tree without `required` in a sheet, and none of the tests listed below renders one there.
- The error text is `--danger-solid` at 13 px, which needs 4.5:1. The tree has no fill, so the pair depends on
  the surface behind it. Computed from the token values, in the light theme it is 4.83:1 on `--surface`, 4.38:1
  on `--canvas` and 4.19:1 on `--muted`, so it passes on `--surface` only. In the dark theme it is at least
  5.45:1 on all three.

The WCAG 2.2 criteria that apply:

| Criterion | How the tree answers it |
|---|---|
| 1.3.1 Info and Relationships | A `treegrid` of rows, each with its level, its position and the size of its set. |
| 1.4.1 Use of Color | A selected row is a fill and a text colour; `aria-selected` says it to assistive technology. A disabled row has no look at all, so the words in the row must say it. |
| 1.4.3 Contrast (Minimum) | Selected text is `--primary` on `--primary-soft`: computed from the token values, 6.34:1 in the light theme and 4.91:1 in the dark. The gap about the error text is against this criterion. |
| 1.4.11 Non-text Contrast | The focus ring is `--primary` next to a `--surface` ring: computed from the token values, 7.09:1 in the light theme and 5.54:1 in the dark. The selected fill, `--primary-soft`, is about 1.1:1 against `--surface` in both themes, so the fill alone does not mark the row; the text colour does. |
| 2.1.1 Keyboard | The tables above. The gaps about a disabled row and a disabled branch are against this criterion. |
| 2.1.2 No Keyboard Trap | Tab leaves the tree. |
| 2.4.3 Focus Order | One tab stop, entered on the selected row. |
| 2.4.7 Focus Visible | The ring on a row. The gap about an empty, loading or failed tree is against this criterion. |
| 2.5.7 Dragging Movements | The tree has no drag. The move dialog of the structure page uses it as the way to move a department without dragging. |
| 2.5.8 Target Size (Minimum) | A row is at least 40 px high. The chevron is 24 px by 24 px, which is the minimum. |
| 4.1.2 Name, Role, Value | The table above. |
| 4.1.3 Status Messages | The selection messages and the `alert`. The loading block has the `status` role and no text. |

The gallery entry is `apps/web/src/ui/tree/tree.gallery.tsx`. It shows one tree with three levels open, a closed
branch, a long name and a selected leaf, and one tree with no roots and no `empty` text. It does not show a
disabled row, `loading`, `error`, an `empty` text, `density`, `required` or `keyboardNavigationBehavior`.

Tests:

| Test | What it checks |
|---|---|
| `apps/web/src/ui/tree/tree.test.tsx` | The static markup: the rows of open branches; the `status` block while loading; an empty tree that keeps its `aria-label`; the `alert` block with `data-state="error"`. |
| `apps/web/src/ui/timeline-lanes/collections.browser.test.tsx` | In a browser: the keys named for it under Keyboard; an empty tree, found by its name, that shows its `empty` text; a failed tree that exposes an `alert`. |
| `apps/web/src/ui/tree/tree.browser.test.tsx` | In a browser, a tree inside a `Dialog`, built by a fixture. With `required`: Escape from a chosen row closes the dialog and the row stays chosen, whether it was chosen from the start, by the pointer or by Enter; a press or Enter on the chosen row leaves it chosen. Without `required`: the first Escape clears the selection and the second closes the dialog. ArrowLeft on a row with no children moves focus to its parent though its `id` is in `expanded`, and an open row closes first. ArrowLeft stays on a row under a disabled parent, with no children or closed, and ArrowDown, Tab, Shift+Tab, ArrowRight and type-ahead still work afterwards. Closing and opening one row changes only its `id` in the caller's set. A made-up Escape flagged as composing leaves the dialog open. |
| `apps/web/src/features/org/ui/target-tree.browser.test.tsx` | In a browser, the target tree in a `Sheet` and in a `Dialog`, built by a fixture and not on the screens that show it. With nothing chosen, Escape from a row or from Cancel closes the sheet. A pick alone is unsaved input: Escape from the chosen row shows the unsaved line first, then closes. In a sheet that is told it is dirty, the same holds from a chosen row with no children, from a chosen open row, and from an expanded disclosure button. In the dialog, where no row is ever chosen, Escape from a row closes it, and so does a pick. ArrowLeft moves to the parent department, and stays on a department, with no children or closed, under a workplace that cannot be chosen. |
| `apps/web/src/features/entity/ui/close-target-picker.browser.test.tsx` | In a browser, the destination picker itself. Opened again with a destination chosen, Escape from that row closes the dialog, focus returns to the button and the destination is kept. ArrowLeft moves from a department to its parent department or to its workplace. On a closed workplace, whose parent is the disabled top row, ArrowLeft stays, and ArrowRight opens it again. |
| `apps/web/src/ui/side-panel/side-panel.browser.test.tsx` | In a browser, a tree with `required` inside a `SidePanel`, built by a fixture: Escape from an open row closes the panel. |
| `apps/web/src/ui/pane-grid/pane-grid-focus.browser.test.tsx` | In a browser, a tree with `required` in the record pane of a `PaneGrid`, built by a fixture: Escape from an open row closes the pane. |
| `apps/web/src/features/access/ui/scope-picker.browser.test.tsx` | In a browser, the scope sheet of a grant itself, with the structure read answered by the test: after a row is picked by the pointer or by Enter, the first Escape shows the unsaved line and the second closes the sheet; with nothing picked, Escape closes it at once. |
| `apps/web/src/features/org/ui/dept-dissolve-sheet.browser.test.tsx` | In a browser, the dissolve sheet itself, with its reads answered by the test. Escape is pressed where the gesture before it left focus. Untouched, the sheet closes at once. A new destination for everyone, or one person sent elsewhere, shows the unsaved line on the first Escape and closes on the second, and a person sent elsewhere still counts while another person's tree is open. A person put back with everyone, or everyone sent back to where one person was sent, leaves nothing unsaved. A destination picked by Enter, for everyone or for one person, moves focus to the button that opened its tree while Enter is still held, and the tree stays closed once it is let go. "Same as everyone", pressed by the pointer or by Enter, leaves focus on that person's "Send … elsewhere" button; after Enter no tree is open. |

The first three are the component's own tests. Every browser test in the table launches Chromium and no other
browser, except the pane grid's, which launches the engine the run selects in `e2e/browser.ts`, Chromium by default. Between them they press neither Space, PageUp nor PageDown, press ArrowLeft only on rows below the top
level, render no tree in `tab` mode and no row with a control in its content, and press Escape in a tree without
`required` only inside a dialog. Escape from the target tree is driven in the fixture's sheet and dialog, not in
the real sheets that merge or dissolve a department or on the bulk move page. The dissolve sheet's test presses
Escape outside its trees. Two unit tests of views,
`features/org/ui/target-tree.test.tsx` and `features/attendance/ui/scope-tree.test.tsx`, replace `TreeView`
with a stub. Journey specs reach a tree by its `treegrid` role, for example `e2e/structure-dept.spec.ts` and
`e2e/access-roles.spec.ts`.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component).

The same spec takes a full-page screenshot of the gallery at 1440, 1024 and 390 px in both themes and compares it
with a baseline image, under the same skip. This entry is in the gallery. No baseline image for those
screenshots is checked in on this branch.

## Phone behaviour at 390 px

Nothing in the tree's rules changes with the width of the screen. The module has no media query and no container
query. The global tree rules have one media query, `prefers-reduced-motion`, which is not about width.

- A row is at least 40 px high and the chevron is 24 px square at every width. Nothing grows to the 44 px touch
  size: neither stylesheet reads `--target-touch`.
- Each level indents its rows by 24 px. A row at the fifth level has 104 px of start padding. With the root's
  8 px side padding its chevron starts 112 px from the tree's edge and its content 144 px, after the 24 px
  chevron and the 8 px gap. With `density="dense"` the side padding is 4 px, so they start at 108 px and 140 px.
- The row layout is one line that does not wrap. Whether the row content wraps or is cut off is the caller's
  markup to decide. The tree has no rule for content wider than itself.
- A tap on a row selects it. A tap on the chevron opens or closes the item.

## Copy rules

- `TreeView` holds no text of its own, owns no message id and imports no catalog. There is no built-in loading,
  empty or error text.
- `label`, the result of `textValue`, the row content, `empty` and `error` come from the message catalog in
  `packages/i18n`, through the caller. The `en` catalog is the source and the `ko` catalog must define every id.
- `label` names the tree for assistive technology. It is never visible. A visible title is the caller's.
- `textValue` is plain text and holds everything the row shows. Put the name first: type-ahead matches the start.
- A disabled row says why, in the row and in `textValue`.
- `error` says what failed, in words. Its look is a colour and nothing else.
- The chevron's name and the selection messages are React Aria's and are not in the catalog: see the
  accessibility contract.

## Props

<!-- ds:props apps/web/src/ui/tree/tree.tsx -->

### TreeView

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `childrenOf` | yes | `(item: T) => T[]` |  |  |
| `expanded` | yes | `Set<string>` |  |  |
| `label` | yes | `string` |  |  |
| `onExpandedChange` | yes | `(keys: Set<string>) => void` |  |  |
| `onSelect` | yes | `(id: string \| undefined) => void` |  |  |
| `roots` | yes | `T[]` |  |  |
| `row` | yes | `(item: T) => ReactNode` |  | The row's content after the chevron. |
| `textValue` | yes | `(item: T) => string` |  |  |
| `density` | no | `"default" \| "dense"` |  |  |
| `disabled` | no | `ReadonlySet<string>` |  |  |
| `empty` | no | `ReactNode` |  |  |
| `error` | no | `ReactNode` |  |  |
| `id` | no | `string` |  |  |
| `keyboardNavigationBehavior` | no | `"arrow" \| "tab"` |  | Let Tab reach interactive content within a row. |
| `loading` | no | `boolean` |  |  |
| `required` | no | `boolean` |  | For a caller that drops an empty selection: a chosen row cannot be cleared, so Esc is left to what holds the tree (a dialog or a sheet closes). |
| `selected` | no | `string` |  |  |

<!-- /ds:props -->

`T` is the caller's item type: any object with a string `id`.

## Tokens it reads

The module:

<!-- ds:tokens apps/web/src/ui/tree/tree.module.css -->

| Token | Read by |
| --- | --- |
| `--border-soft` | `background` |
| `--danger-solid` | `color` |
| `--focus` | `box-shadow` |
| `--muted` | `background` |
| `--primary` | `color` |
| `--primary-soft` | `background` |
| `--radius` | `border-radius` |
| `--row-h` | `height` |
| `--space-1` | `padding` |
| `--space-2` | `gap`, `padding` |
| `--space-3` | `padding` |
| `--space-4` | `padding` |
| `--steel` | `color` |
| `--text-sm` | `font-size` |

<!-- /ds:tokens -->

The global tree rules in `app.css`:

<!-- ds:tokens apps/web/src/app.css .tree -->

| Token | Read by |
| --- | --- |
| `--row-h` | `min-height` |
| `--space-2` | `gap`, `padding-inline-end`, `padding-inline-start` |
| `--space-5` | `height`, `padding-inline-start`, `width` |
| `--steel` | `color` |
| `--tree-item-level` | `padding-inline-start` |

<!-- /ds:tokens -->

`--tree-item-level` is not a token from `packages/tokens`: React Aria sets it on each row to the row's level, and
`app.css` registers it as a custom property.
