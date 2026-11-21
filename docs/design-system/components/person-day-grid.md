<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Person-day grid

`PersonDayGrid` is a grid with one row for each person and one column for each day, in which a person selects a
range of cells and types into one of them.

It lives in `apps/web/src/ui/person-day-grid/person-day-grid.tsx`, which exports the component and the types
`DayColumn`, `Cell` and `Range`. The selection is worked out by the helpers in
`apps/web/src/ui/sheet-grid/range.ts`, which `SheetGrid` uses too.

## When to use it, and when not

Use it for a month of person-days: people down the side, days across the top, and totals for each person at the
end of the row.

The grid owns no data. The caller passes what each cell draws, how it looks and what it is called, holds the
selection and the text being typed, and handles its own keys before the grid sees them.

One feature uses it: the month timesheet of attendance (`features/attendance/ui/month-grid-view.tsx`). That was
found by searching `apps`, `e2e` and `scripts` for an import of the module. The only other import is the gallery.

| Do not use it for | Use instead |
|---|---|
| One month as weeks, with a cell for each day | `MonthGrid`: see [Month grid](month-grid.md). |
| Rows of records with a column for each field, typed as text or picked from a list of options | `SheetGrid` (`ui/sheet-grid`). |
| Cells where people compose Korean text | `SheetGrid`. It keeps an input mounted in the focused cell, so the first syllable of a composition is not lost. `PersonDayGrid` does not: see Keyboard. |
| A list of records that is read, and chosen from a row at a time | `Table` (`ui/table.tsx`), or `LongTable` (`ui/long-table`) for a list that pages from the server. |
| One person's day drawn as a bar | `ShiftBar` (`ui/shift-bar`). |
| Entering one date | `DateField`: see [Date](date.md). |

## Anatomy

| Part | Element | Holds |
|---|---|---|
| Box | `<div>` | The table. It is the scroll container, in both directions. |
| Grid | `<table role="grid">` | `aria-label` from `label`, `aria-rowcount`, `aria-colcount`, `aria-multiselectable="true"`, `aria-activedescendant` and `tabindex="0"`. The key handler and the focus handler are here. |
| Head row | `<tr aria-rowindex="1">` in `<thead>` | The lead headers, the day headers, the tail headers, in that order. |
| Lead header, tail header | `<th>` | The column's `header`. `data-w` carries the column's `width`. |
| Day header | `<th>` | Two `<span>`s: the day's `label`, then its `sub` on a second line. `data-tone` and `aria-selected`. |
| Spacer row | `<tr aria-hidden>` holding one `<td aria-hidden>` across every column | Nothing. It stands for the rows above or below the ones rendered, and has their height. |
| Person row | `<tr aria-rowindex>` in `<tbody>` | The cells below. The first row of each group carries `data-group` with the group's name. |
| Lead cell | `<th>` | What the lead column's `cell` returns. `data-w`, and `data-first` on the first lead cell, which no rule reads. |
| Day cell | `<td>` | What `cell` returns, or the editor. It carries an `id`, `aria-selected`, `aria-label` from `describe`, `data-tone`, `data-look`, and `data-focus` on the focused cell. |
| Editor | `<input>` | The text being typed. It is drawn only in the cell that `editing.cell` names, and takes focus with the caret at the end when it appears. |
| Tail cell | `<td>` | What the tail column's `cell` returns. `data-w`. |

The types the props use:

| Type | Shape |
|---|---|
| `DayColumn` | `{ key, label, sub, tone? }`. `key` is the column's key. `tone` is `"holiday"` or `"rest"`. |
| `SideColumn<R>`, a lead or tail column | `{ key, header, cell, width }`. `cell` takes the row. `width` is `"code"`, `"name"` or `"total"`. The type is not exported. |
| `Cell` | `{ row, col }`: the key of a row and the key of a day. |
| `Range` | `{ anchor, focus }`: two `Cell`s. The anchor is where the selection began and the focus is the cell that moves. |
| `CellLook`, what `look` returns | `"draft"`, `"refused"`, `"saved"`, `"locked"` or `undefined`. The type is not exported. |

`cell`, `look` and `describe` take the row and the day's position in `days`, a number, not the day's key.

**Groups.** `groupOf` gives each row a group. The first row of each group gets `data-group` and a rule above it.
No head row is drawn and the group's name is never shown: it is the value of an attribute. The comment on the
prop speaks of a head; the code draws the rule only.

**What the caller owns.**

- The selection. `range` is the selection, and `onRange` asks for a new one. The grid never keeps it.
- The editor. `editing` is the open editor: its text and the cell it belongs to. `onEdit(text)` asks to open it or
  to change its text, and `onEdit(null)` asks to cancel it. `onCommit(then)` asks to keep what was typed.
- What happens after a commit. The grid only calls `onCommit` with `"down"`, `"right"` or `"stay"`. The caller
  writes the value, closes the editor and moves the selection. The comment on the prop says the grid then moves;
  the code leaves the move to the caller.
- Its own keys. `onKey` is called first for every key pressed while the editor is closed.
- Loading more rows. `total` is the server's count of rows and `rows` is what has been loaded. The grid has no way
  to ask for more.

**Rows are windowed.** Only the rows in view, and eight more on each side, are rendered. The rest are the two
spacer rows.

- The spacers and the window are worked out from the height the stylesheet gives a row, `--row-h-compact`, which
  is 32 px. The grid reads that token from its own box when it mounts and when the window is resized, so a
  container or a visual style that sets the token moves the rows and the arithmetic together. The token must be a
  plain pixel value: a `calc()` is not read, and the grid keeps the last height it read.
- On a table row that height is a least height. A cell whose content and borders together are taller than the row
  makes the row grow, and the spacers and the window then no longer match the rows drawn. Every cell has a 1 px
  border below, and the cells of a group's first row a 2 px border above. Keep what a cell draws within
  `--row-h-compact` less the cell's borders. The attendance view puts a `size="sm"` button in a lead cell, and
  that button is at least `--target` high, which is 32 px. Whether that row grows was read from the CSS, not
  measured.
- The grid reads the height of its box when it mounts, when the window is resized and when the box scrolls. A
  box that changes size with the window still (a panel opening beside it) is not followed until the next scroll.
- Columns are not windowed. Every day is rendered.
- The editor is drawn inside its row. A row scrolled out of the window is not rendered, so its input is removed
  with it. Nothing in the component commits or cancels at that point. Whether the browser fires the input's blur,
  which commits, when the input is removed was not tested.

### The range helpers

`range.ts` is plain functions with no React in it, so the grid and its caller work out the same answer.

A corner of a range is the key of a row and the key of a column, never an index. A re-sort, a filter, a row added
above or a row removed therefore never moves the selection, or what is being typed, onto another person. Each
helper that needs positions takes `axes`: `{ rows, cols }`, the keys in the order they are drawn now.

| Helper | Returns |
|---|---|
| `at(row, col)` | A range of that one cell. |
| `indexOf(cell, axes)` | Where the cell is drawn now, as `{ r, c }`, or `null` when its row or its column is not shown. |
| `rectIn(range, axes)` | The range as `{ top, bottom, left, right }` in the present order, or `null` when either corner is not shown. |
| `spanIn(range, axes)` | The keys of the rows the range covers now, as one string. An empty string when the range is not shown. |
| `rectSize(rect)` | `{ people, days, cells }`, all 0 for `null`. The grid does not use it. The attendance view does, for its line that counts the selection. |
| `inRect(rect, r, c)` | Whether that position is inside the rectangle. |
| `moveRange(range, key, shift, axes, page, wholeGrid)` | The range after a movement key, or `null` for any other key and for a grid with no rows or no columns. |

`moveRange` takes the arrow keys, Home, End, Page Up and Page Down. `page` is how many rows a page key moves,
10 unless given. `wholeGrid` makes Home and End go to the first and the last cell of the grid; without it they
stay in the row. `PersonDayGrid` passes neither. A move stops at the edge of the grid. With `shift` and a range
that is shown, the anchor stays and the focus moves; otherwise the range becomes the one cell moved to. A focus
that is no longer shown starts again from the first cell.

The grid uses `spanIn` for one rule. A range that covers several rows is the people between its corners. When
those people change while the range itself has not, because rows were re-sorted or one arrived between them, the
grid asks for the range to collapse to its focus cell, so that it does not silently cover someone else. A range
within one row never collapses, and rows that load below the range change nothing.

## Looks and sizes

There is one look and one size. No prop changes either, apart from the width a lead column asks for.

| Part | Look |
|---|---|
| Box | `flex: 1`, `min-height: 0`, `max-height: 100%`, `overflow: auto`, `overscroll-behavior: contain`. It scrolls down only inside a parent that bounds its height. |
| Table | As wide as its content and at least as wide as the box. 13 px text (`--text-sm`), tabular numbers. |
| Head cells | Stick to the top of the box. `--surface` fill, a 1 px `--border` line below, 4 px padding top and bottom (`--space-1`), 8 px at the sides (`--space-2`), `--fw-medium`, `--steel`. |
| Lead column | Sticks to the left. `--surface` fill, aligned left, 8 px side padding, one line, `--fw-body`. |
| Lead column, `width: "code"` | `64px` wide, `--font-mono`. It sticks at the left edge. |
| Lead column, `width: "name"` | At least `96px` wide. It sticks `64px` from the left edge. |
| Lead column, `width: "total"` | No rule reads it. |
| Tail column | Sticks to the right edge. `--surface` fill, a 1 px `--border` line on its left, 8 px side padding, aligned right, one line, at least `64px` wide. No rule reads `width` on a tail column. |
| Day header | At least `44px` wide, centred, with a pointer cursor. `sub` is on its own line at 12 px (`--text-xs`). |
| Person row | `--row-h-compact` high, 32 px. Every cell has a 1 px `--border` line below. |
| Group rule | A 2 px `--control-border` line above every cell of the first row of a group. |
| In a visual style | Where a visual style is chosen (any `data-experience` but `baseline`), the line below a row and the group rule are drawn inside the cell and take no room, so a cell's content box is the whole row height. A link placed directly in a lead cell is as tall as the row and at least `--target` wide, so it is still a whole pointer target when it is scrolled half under the sticky head. Today's look keeps its borders and its text-height links. |
| Day cell | Centred, 4 px side padding, one line, with the `cell` cursor. |
| Editor | The width of its cell and at least `88px`. No border, `--surface` fill, `--ink` text, the cell's font, centred, `outline: none`. |

`tone` on a day:

| `tone` | Day header | Day cells |
|---|---|---|
| `"holiday"` | `--danger-tx` text. | `--danger-bg` fill. |
| `"rest"` | Nothing. | `--canvas` fill. |

What `look` returns for a cell:

| `look` | Look |
|---|---|
| `"draft"` | A 1 px dashed `--primary` outline with `outline-offset: -4px`, so it is drawn inside the cell. |
| `"refused"` | A 2 px solid `--danger-solid` outline with `outline-offset: -3px`, and `--danger-tx` text. |
| `"locked"` | `--steel` text over a hatch: 1 px `--border` lines at 45 degrees, 5 px apart. |
| `"saved"` | Nothing. No rule reads it. |

The widths `64px`, `96px`, `44px` and `88px` are written in the stylesheet as they are, not as tokens. So are the
outline widths and offsets and the hatch's spacing.

The sticky offsets are written once for each kind of column. Every `name` column sticks 64 px from the left, and
every tail column sticks at the right edge: no rule offsets a second one. The offsets fit one `code` column, then
one `name` column, and one tail column. The attendance view passes one `code` column, up to two `name` columns
and four tail columns. How columns that share an offset draw when the table is wider than the box was read from
the CSS, not measured in a browser. The same holds for a `code` longer than 64 px: in a table a cell's `width` is
a least width, and the `name` column still sticks at 64 px.

## States

| State | What changes |
|---|---|
| Rest | The looks above. |
| Hover | Does not exist. The stylesheet has no hover rule. The cursor is `cell` over a day cell and a pointer over a day header. A lead cell selects its row when pressed and keeps the default cursor. |
| Grid has keyboard focus | A 2 px `--primary` outline on the table with `outline-offset: -2px`, so it is drawn just inside the table's edge. The rule is `:focus-visible` on the table. |
| Focused cell (`data-focus`) | A 2 px `--primary` outline with `outline-offset: -2px`, just inside the cell's edge. It marks the focus corner of the range, and is drawn whether or not the grid has focus. |
| Selected (`aria-selected="true"`) | Every day cell in the range takes a `--primary-soft` fill, in place of a tone's fill. The header of every day in the range takes the same fill. |
| Pressed, dragging | No look. A drag is seen only as the selection growing. |
| Editing | The cell holds the editor in place of its content. |
| Draft, refused, locked | The looks under Looks and sizes. |
| Disabled | Does not exist. |
| Read-only | Does not exist as a state of the grid. `"locked"` is a look and nothing more: typing in a locked cell still opens the editor, and the caller decides at the commit. The attendance view refuses there and says why. |
| Invalid | `"refused"` is the look. No ARIA attribute is set. |
| Loading | Does not exist. The attendance view wraps the grid in `QueryState` (`lib/react/query-state`), which stands in for it while the month is read. |
| Empty | Does not exist. With no rows the table is its head row. It can take focus, selects nothing, and its keys do nothing. The attendance view shows an `EmptyState` in place of the grid. |

How the outlines combine: the focused cell, a draft and a refusal each set `outline`, and a cell has one outline.
The draft and the refused rules come after the focus rule and weigh the same, so a focused cell that is a draft
or a refusal shows the draft's or the refusal's outline and no focus outline. A test pins the order for the
refusal on purpose, so that a focused refused cell still shows its refusal.

## Keyboard

The table is the one tab stop. A cell never takes focus: the focused cell is the range's focus corner, named by
`aria-activedescendant`. When the grid takes focus and no focus cell is shown, it asks for the first cell to be
selected.

While the editor is closed:

| Key | What it does |
|---|---|
| Tab, Shift+Tab | Moves into the grid and out of it. A link or a button the caller put in a cell is a tab stop of its own. |
| Any key | Goes to the caller's `onKey` first. When that returns `true`, the grid does nothing more. |
| Arrow keys | Moves the focus one cell. The selection becomes that cell. |
| Home, End | Moves to the first or the last day of the row. |
| Page Up, Page Down | Moves ten rows. |
| Shift with an arrow key, Home, End or a page key | Extends the range. The anchor stays and the focus moves. |
| Enter, F2 | Asks the caller to open the editor with empty text, `onEdit("")`. The grid does not pass the cell's present value. |
| One printable character, with no Ctrl, Alt or Meta | Asks the caller to open the editor with that character, `onEdit(key)`. The default is prevented. Space counts. |
| Escape | Collapses the range to its focus cell. |
| Any other key | Left alone. |

- A movement key stops at the edge of the grid, and its default is prevented even when nothing moves.
- Movement reads Shift and nothing else. Ctrl+Home is Home: no key goes to the first or the last cell of the grid.
- When the range's focus is not shown, a movement key starts from the first cell, and Enter, F2, Escape and typing
  do nothing.
- While `editing` is set, the table's handler returns before anything else, and `onKey` is not called. That holds
  even when the editor's row is not rendered.
- The handler does not look at where a key was pressed. A key pressed in a link or a button inside a cell reaches
  it, unless that control stops the key. The caller's `onKey` is called for it first, like any other key.
- So a key pressed on such a control is handled as a key pressed on the grid. When `onKey` does not take it, a
  movement key moves the selection, and, while a focus cell is shown, Enter, F2, Space or another printable key
  calls `onEdit` for the focus cell. In each case the handler prevents the key's default. For Enter on a link,
  that default is to follow the link. Focus landing on the control runs the table's focus handler too, which asks
  for the first cell when no focus cell is shown. Whether the control's own action still runs was not tested in a
  browser.
- A pointer press on a control in a lead cell reaches the lead cell in the same way and selects the row.
- The attendance view stops `keydown` and `pointerdown` on the button it puts in a lead cell. It does not stop
  them on the name link it puts there, so by the code Enter on that link opens the editor on the focus cell.
- A change of focus row scrolls the box up or down so that the row is in view. Nothing scrolls the box sideways:
  a focus cell in a day column outside the box, or under a sticky column, stays where it is.

While the editor is open, keys go to the input:

| Key | What it does |
|---|---|
| Enter | Calls `onCommit("down")`. The default is prevented. |
| Tab, Shift+Tab | Calls `onCommit("right")`. The default is prevented. Shift is not read, so Shift+Tab also asks to move right. |
| Escape | Calls `onEdit(null)`: cancel. |
| Any other key | Types into the input. The key is stopped there, so the caller's `onKey` does not run while the editor is open. |

Leaving the input in any other way commits too: its blur calls `onCommit("stay")`. So does a pointer press on a
day cell, a day header or a lead cell, which commits and then selects.

The editor stops keys only. A pointer press inside the input reaches the handler of the day cell that holds it,
and is handled as a press on that cell: the grid calls `onCommit("stay")` and then `onRange`. A double-click
inside the input calls `onEdit("")`. The attendance view closes the editor at every commit, so by the code a
press there to place the caret closes the editor. That was read from the code, not run in a browser.

When the editor closes, nothing returns focus to the table. The component calls `focus()` on the editor's input
and nowhere else, and the input is removed while it holds focus. Where a journey spec of the timesheet presses a
grid key after Enter, it first focuses the grid again or clicks a cell.

**Keys the Korean input method owns.**

- In the editor, a `keydown` whose `isComposing` flag is set is left alone: no commit, no cancel, and the key is
  not stopped. It reaches the table's handler, which returns at once because the editor is open. An Enter
  `keydown` that carries the flag therefore does not commit the cell.
- That flag is the only check. The editor does not check key code 229 and listens to no composition event. A
  `keydown` with the flag unset is handled as an ordinary key whatever its key code. `TextInput` and `SheetGrid`
  check both the flag and key code 229.
- Typing to open the editor has no check at all. Until the first key opens it, the grid holds no input, so a
  composition has nowhere to begin. The handler opens the editor with `key` when `key` is one character long, as
  plain text and not as a composition. A key reported as `Process` is longer than one character and is ignored.
  What a browser reports for the first key of a syllable while focus is on the table was not tested.
- The timesheet takes Korean words as values. Its journey specs type digits and punctuation, and enter the Korean
  values by paste. No spec was found that composes into this grid: the attendance specs and helpers under `e2e`
  were searched, in any letter case, for `composition`, `isComposing`, `imeSet` and `insertText`. The one match
  inserts digits into another grid.

With the pointer:

| Action | What it does |
|---|---|
| Press a day cell | Selects that cell. |
| Shift and press a day cell | Extends the range from its anchor. |
| Press and drag across day cells | Extends the range to the cell under the pointer. The drag ends when the pointer is released anywhere in the window. |
| Double-click a day cell | Asks the caller to open the editor with empty text. |
| Press a day header | Selects that day for every loaded row. The focus lands on the last loaded row, and the box scrolls to it. |
| Press a lead cell | Selects every day of that row. |

A tail cell and a lead or tail header do nothing when pressed. Selecting a whole row or a whole day in one step
is pointer only; with the keys the same range is made with Shift.

The handlers do not read which button of the pointer was pressed, so a press with any button selects. Only a
`pointerup` on the window ends a drag. `pointercancel` is not handled: after one, the drag stays set until the
next `pointerup`, and while it is set the range extends to any day cell the pointer enters.

## Accessibility contract

| Part | Role | Accessible name | Also exposed |
|---|---|---|---|
| Grid | `grid` | `label`, through `aria-label`. The prop is required. | `aria-rowcount`: `total` plus one for the head row. `aria-colcount`: every column. `aria-multiselectable="true"`. `aria-activedescendant`: the focused cell. |
| Head row, person row | Row | None. | `aria-rowindex`: 1 for the head row, 2 for the first loaded row, 3 for the next, and so on. |
| Lead header, tail header | A `<th>` with no `scope` | Its content. | Nothing. |
| Day header | A `<th>` with no `scope` | Its content: `label`, then `sub`. | `aria-selected`, true for a day in the range. |
| Lead cell | A `<th>` with no `scope` | Its content. | Nothing. It is never the active descendant. |
| Day cell | Grid cell | `describe(row, day)`, through `aria-label`. It replaces the cell's visible content as the name. | `aria-selected`. |
| Tail cell | Grid cell | Its content. | Nothing. It is never the active descendant. |
| Editor | `textbox` | The same `describe(row, day)`, through `aria-label`. | Nothing. |
| Spacer rows | Hidden with `aria-hidden`. | | |

- **`describe` is everything a day cell says.** The grid adds no state to it. A draft, a refusal, a lock and a
  mark are exposed only when the caller's text names them: `look` sets no `aria-invalid`, no `aria-readonly` and
  no description.
- **The active descendant.** It is worked out from the range's focus over every loaded row. Only rendered rows
  have cells with an `id`. The grid scrolls the focus row into view when it changes. Once the box is scrolled so
  that the focus row is more than eight rows out of view, the row is not rendered and `aria-activedescendant`
  names an `id` that is not in the document.
- **Counts.** `aria-rowcount` is the server's total. `aria-rowindex` counts loaded rows in the order they are
  drawn now.
- **Groups.** A group is not exposed. Its name is a `data-group` attribute and its mark is a line.
- **Announced:** nothing by the component. It has no live region. A screen reader reads the cell that becomes the
  active descendant. The size of a range is not announced by the grid: the attendance view writes it in its own
  `role="status"` line.

Known gaps:

- A focused cell that is a draft or a refusal has no focus outline: see States. In a range of drafts nothing
  marks which cell is the focus.
- The focus cell is not scrolled into view sideways, and the sticky columns can cover it.
- Focus is not returned to the grid when the editor closes.
- A pointer press inside the open editor is handled as a press on its day cell, which commits: see Keyboard.
- A key pressed on a link or a button in a cell is handled by the grid, with its default prevented, unless the
  control stops the key: see Keyboard.
- Any pointer button selects, and `pointercancel` does not end a drag: see Keyboard.
- A cell taller than the row height puts the spacers and the window out of step with the rows: see Anatomy.
- Typing to open the editor does not handle the Korean input method, and the editor checks `isComposing` only.
- Enter and F2 open the editor empty, not on the cell's present value. The caller could put the value in
  `editing.value`; the attendance view does not.
- The group's name is never shown or exposed.
- A locked cell and a refused cell carry no ARIA state.
- The header cells have no `scope`, and the lead and tail cells cannot be reached with the grid's keys.
- The grid does not follow a change of its box's size while the window keeps its size: see Anatomy.
- Columns of one kind share a sticky offset: see Looks and sizes.
- The editor is at least `88px` wide and a day column at least `44px`, so by the CSS a narrow column widens while
  its editor is open. That was not measured.
- The editor sets `outline: none` and shows no focus outline. That rule and the global `:focus-visible` rule
  weigh the same, and the grid's comes later: the entry module imports `app.css` statically and reaches the grid
  only through lazy imports, so the grid's stylesheet loads after `app.css`. This was read from the stylesheets
  and the imports, not checked in a browser.
- Drag selection was written for a pointer that hovers. The stylesheet sets no `touch-action`, and selection by
  touch was not checked.

Contrast, computed from the token values in `packages/tokens/tokens.css`:

| Pair | Light | Dark |
|---|---|---|
| Head text (`--steel`) on `--surface` | 6.04:1 | 7.31:1 |
| Holiday header (`--danger-tx`) on `--surface` | 6.47:1 | 8.99:1 |
| Refused text (`--danger-tx`) on `--danger-bg`, a holiday | 5.91:1 | 8.63:1 |
| Refused text on `--primary-soft`, selected | 5.79:1 | 7.97:1 |
| Locked text (`--steel`) on `--canvas`, a rest day | 5.48:1 | 7.96:1 |
| Locked text on `--primary-soft`, selected | 5.40:1 | 6.48:1 |
| Focus outline (`--primary`) on `--primary-soft`, selected | 6.34:1 | 4.91:1 |
| Focus outline on `--surface` | 7.09:1 | 5.54:1 |

The locked rows do not count the hatch lines drawn behind the text. The refused outline and the group rule are
held to 3:1 by a test: see below.

The WCAG 2.2 criteria that apply:

| Criterion | How the component answers it |
|---|---|
| 1.3.1 Info and Relationships | A table with the grid role, a row count and row indexes. Groups are not in the structure, and the headers have no `scope`. |
| 1.4.1 Use of Color | A draft, a refusal and a lock each have a shape: a dashed outline, a solid outline, a hatch. A tone is a fill; the day's `sub` and the cell's name must say the same, and that is the caller's. The selection is a fill, exposed as `aria-selected`. |
| 1.4.3 Contrast (Minimum) | The pairs above. The caller's content takes the caller's colours. |
| 1.4.10 Reflow | The grid scrolls in both directions inside its box. It is a data table, which the criterion excepts. |
| 1.4.11 Non-text Contrast | A test holds the refused outline and the group rule to 3:1 in both themes. The focus outline is above 3:1 on the two fills computed above. A focus cell has the selected fill whenever both corners of its range are shown. |
| 2.1.1 Keyboard | Every day cell can be reached, selected and edited with keys. Lead and tail cells are not reached by the grid's keys. A movement key, Enter, F2, Space or a printable key pressed on a control the caller puts in a cell goes to the grid, with its default prevented, unless the control stops the key. |
| 2.4.3 Focus Order | Not met when the editor closes: focus is not returned to the grid. |
| 2.4.7 Focus Visible | Not met for a focused draft or refused cell. |
| 2.4.11 Focus Not Obscured (Minimum) | Not answered sideways: see the gaps. |
| 2.5.7 Dragging Movements | A range can be made without a drag: Shift and a press, or the keys. Both need a keyboard. A press on a day header or a lead cell selects a whole day or row. |
| 2.5.8 Target Size (Minimum) | A day cell is at least 44 px wide and 32 px high. |
| 4.1.2 Name, Role, Value | The table above. The state behind a look is not exposed. |
| 4.1.3 Status Messages | Not answered by the component: nothing is announced. |

The gallery entry is `apps/web/src/ui/person-day-grid/person-day-grid.gallery.tsx`. It shows five people over ten
days, with one `code` column and one tail column, a range of four cells, two holidays, one rest day and one
refused cell. The selection works. It does not show the editor, a draft, a locked cell, a group, a `name` column
or a second tail column.

What tests it:

| Test | Covers |
|---|---|
| `apps/web/src/ui/person-day-grid/person-day-grid.test.tsx` | The role, the row count, a row index, the selected cells and the active descendant. That the editor and the focus stay in their person's row through a re-sort, a row added above and a filter, and go to nobody when that person is not shown. In a browser, with the real stylesheet and tokens: the refused outline is 2 px, solid and at least 3:1 against the cell's fill, in both themes, on a plain day, a holiday, a rest day and a selected focused cell; the group rule is 2 px, solid and at least 3:1. |
| `apps/web/src/ui/sheet-grid/range.test.ts` | Moving, extending and stopping at the edge; a cell staying on its person; a focus that is gone starting again from the first cell; the rows a range covers. |
| `scripts/check-ds.test.ts` | That the refused outline is a 2 px solid `--danger-solid` line, that the lead column reads `--fw-body`, and that the stylesheet names none of a short list of token names that do not exist. |
| `e2e/states/attendance-month.spec.ts` | The month timesheet in each of its states at 1440 px and 390 px, ending with the fit check and an axe scan. With 400 rows: the box is the only thing that scrolls down, the head row sticks, and the last row can be reached. At both widths, on the way to the undo sheet: a double click on a cell, typing, Enter, and a save of that one cell. |
| `e2e/attendance-records.spec.ts`, `e2e/attendance-grid-safety.spec.ts`, `e2e/attendance-grammar.spec.ts` | Against the real server: typing into a cell, Enter, extending with Shift, the feature's keys, and an editor that stays with its person while rows change under it. |
| `e2e/attendance-paste-native.spec.ts` | Against the real server: with the editor open, a paste made through the keyboard puts its text into the editor and opens no paste preview, and Enter then keeps what the editor holds as a draft. End is pressed inside the editor. |

The table names the main specs, not every one. Other specs under `e2e` click a cell, type and press Enter on the
way to something else.

No test was found that presses Home, End, a page key or F2 on the grid, or Tab in its editor. One spec,
`e2e/attendance-paste-native.spec.ts`, presses End inside the editor, where it is the input's own key. The
component's own test was searched for those key names, and every file under `e2e` for a press of them, alone or
with Shift: the other matches are in other views.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component).

## Phone behaviour at 390 px

Nothing in the component's rules changes with the width of the screen. The stylesheet has no media query and no
container query.

- The grid keeps every column and scrolls in both directions inside its box. There is no narrower form.
- The sticky columns keep their widths. One `code` column, one `name` column and one tail column take at least
  224 px of the width: `64px`, `96px` and `64px`. On a 390 px screen that leaves at most 166 px for days, which is
  three day columns of `44px` and part of a fourth, less whatever the page around the grid takes.
- A day cell stays at least 44 px wide and 32 px high. The 44 px is the literal `44px`: the module does not read
  `--target-touch`.
- The editor opens from a key or from a double click. Focus on the table is not focus on a text control. Whether
  a double tap opens the editor on a phone, and whether a finger can drag a selection, was not checked.

The state spec named above runs the timesheet at 390 px with the fit check and the axe scan. Its undo-sheet
states double-click a cell, type and press Enter at 390 px, with a mouse and a keyboard. No spec was found that
uses touch: `e2e` was searched for `hasTouch`, `tap(`, `touchscreen` and `isMobile`.

## Copy rules

- The component holds no text of its own and owns no message id.
- `label`, the headers, each day's `label` and `sub`, what the cells draw and what `describe` returns are the
  caller's text, from the message catalog in `packages/i18n` or from the formatters in `@console/i18n/format`.
  The `en` catalog is the source and the `ko` catalog must define every id.
- `label` names the grid for assistive technology and is never visible. The attendance view passes
  `attendanceRecords.grid.label`.
- `describe` is the whole accessible name of a day cell, and of the editor in it. Start it with the person and the
  date, then the value. The attendance view builds it from `attendanceRecords.grid.cellLabel`, with
  `attendanceRecords.grid.draftOf` around a draft's text, and its specs find a cell by the person and the date at
  the start of the name.
- Say a draft, a refusal and a lock in `describe`. The grid exposes none of them by itself.
- A holiday's `sub` says that it is a holiday. The tone is a colour. The attendance view passes
  `attendanceRecords.grid.holidayShort` there, and the weekday on other days.
- The gallery's text is in the gallery catalog, under `section.personDayGrid`, `personDayGrid.label`,
  `personDayGrid.number` and `personDayGrid.total`. Production builds leave that catalog out.

## Props

<!-- ds:props apps/web/src/ui/person-day-grid/person-day-grid.tsx -->

### GridCellBadge

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `children` | yes | `ReactNode` |  | Short 1-2 character badge text or glyph. |
| `tone` | yes | `CellBadgeTone` |  | Semantic visual tone for the cell badge. |

### PersonDayGrid

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `cell` | yes | `(r: R, day: number) => ReactNode` |  |  |
| `days` | yes | `readonly DayColumn[]` |  |  |
| `describe` | yes | `(r: R, day: number) => string` |  | The cell's text for screen readers (value, marks, draft state). |
| `editing` | yes | `{ value: string; cell: Cell; } \| null` |  | The open editor and the cell it belongs to: it is drawn only there, whatever has moved since. |
| `label` | yes | `string` |  |  |
| `lead` | yes | `readonly SideColumn<R>[]` |  |  |
| `look` | yes | `(r: R, day: number) => CellLook` |  |  |
| `onCommit` | yes | `(then: "down" \| "right" \| "stay") => void` |  | Commit the open editor; the grid then moves `then`. |
| `onEdit` | yes | `(value: string \| null) => void` |  |  |
| `onKey` | yes | `(e: KeyboardEvent<Element>) => boolean` |  | The feature's keys first (⌘D, ⌘↵, =, Delete, P …); true when handled. |
| `onRange` | yes | `(range: Range) => void` |  | The new selection. Never a commit: the grid commits the open editor itself before a person moves the selection, and its own collapse (the people under a range changed) leaves the editor and what is being typed alone. |
| `range` | yes | `Range \| null` |  | By row and column key; null (or a corner not shown) selects nothing. |
| `rowKey` | yes | `(r: R) => string` |  |  |
| `rows` | yes | `readonly R[]` |  |  |
| `tail` | yes | `readonly SideColumn<R>[]` |  |  |
| `total` | yes | `number` |  | Rows matching the scope on the server (aria-rowcount), loaded or not. |
| `activeRowId` | no | `string` |  | Active/selected employee row key highlighted with the selected row bar. |
| `footerRows` | no | `readonly GridFooterRow[]` |  | Optional summary rows rendered inside tfoot beneath the grid body. |
| `groupOf` | no | `(r: R) => string` |  | A row group's head is drawn above the first row of each group. |
| `tailGroupHeader` | no | `ReactNode` |  | Optional group header spanning all tail columns (2-row thead). |

<!-- /ds:props -->

The table prints the names of types. Their shapes are under Anatomy. `R` is the type of a row, which the caller
chooses.

Two descriptions say more than the code does. `groupOf` draws a rule above the first row of a group, not a head.
`onCommit` only tells the caller which way to move: the caller moves the selection.

`range.ts` exports no component, so it has no generated table. Its helpers are under Anatomy.

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/person-day-grid/person-day-grid.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `--rules`, `background-image`, `border`, `border-bottom`, `border-left`, `border-top` |
| `--canvas` | `background` |
| `--control-border` | `--rules`, `border-top` |
| `--control-selected` | `background` |
| `--danger-bg` | `background` |
| `--danger-solid` | `border`, `outline` |
| `--danger-tx` | `border`, `color` |
| `--faint` | `color` |
| `--font-mono` | `font-family` |
| `--fw-body` | `font-weight` |
| `--fw-medium` | `font-weight` |
| `--fw-semibold` | `font-weight` |
| `--fw-strong` | `font-weight` |
| `--ink` | `color` |
| `--on-control-selected` | `color` |
| `--primary` | `color`, `outline` |
| `--primary-bd` | `border` |
| `--primary-soft` | `background` |
| `--radius-sm` | `border-radius` |
| `--row-h-compact` | `height`, `line-height`, `min-height` |
| `--rules` | `box-shadow` |
| `--selected-bar` | `--rules` |
| `--space-1` | `padding` |
| `--space-1-5` | `padding` |
| `--space-2` | `padding` |
| `--space-5` | `padding-inline-start` |
| `--space-half` | `padding` |
| `--steel` | `color` |
| `--surface` | `background` |
| `--surface-2` | `background` |
| `--surface-rest` | `background` |
| `--surface-selected` | `background` |
| `--target` | `min-width` |
| `--text-sm` | `font-size` |
| `--text-xs` | `font-size` |
| `--warn-bg` | `background` |
| `--warn-tx` | `border`, `color` |

<!-- /ds:tokens -->

The focus outline of anything the caller puts in a cell is a global rule and is not listed: it reads `--primary`.
