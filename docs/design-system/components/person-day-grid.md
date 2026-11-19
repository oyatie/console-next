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
found by searching `apps`, `e2e` and `scripts` for an import of the module. The other imports are the gallery, the
component's own test and two browser-test fixtures: `person-day-grid.browser-fixture.tsx` beside the component and
`apps/web/src/ui/ime-keys.browser-fixture.tsx`.

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
| Box | `<div>` | The table. It is the scroll container, in both directions. The grid sets the offsets of the sticky side columns on it, as custom properties in its `style`: see Looks and sizes. |
| Grid | `<table role="grid">` | `aria-label` from `label`, `aria-rowcount`, `aria-colcount`, `aria-multiselectable="true"`, `aria-activedescendant` and `tabindex="0"`. The key handler and the focus handler are here. The key handler acts only on a key pressed on the table itself. |
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
- The editor. `editing` is the open editor: its text and the cell it belongs to. With no editor open,
  `onEdit(key)` asks to open it on a typed character, and `onEdit("")` asks to open it on what the cell holds.
  Only the caller knows what that is: the grid passes no value, and the caller puts the text in `editing.value`.
  With an editor open, `onEdit(text)` is its new text. `onEdit(null)` asks to close it unsaved. `onCommit(then)`
  asks to keep what was typed.
- What happens after a commit. The grid only calls `onCommit` with `"down"`, `"right"` or `"stay"`. The caller
  writes the value, closes the editor and moves the selection. The comment on the prop says the grid then moves;
  the code leaves the move to the caller.
- Its own keys. `onKey` is called first for every key pressed on the table itself while the editor is closed. A
  key pressed on a link or a button inside a cell is not passed to it.
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
  That is the height, which decides the rows drawn. The offsets of the sticky side columns do follow such a
  change: see Looks and sizes.
- Columns are not windowed. Every day is rendered.
- The editor is drawn inside its row. A row scrolled out of the window is not rendered, so its input is removed
  with it. Nothing in the component commits or cancels at that point, and nothing gives the grid the focus: the
  grid takes the focus only when `editing` becomes `null`. Whether the browser fires the input's blur, which
  commits, when the input is removed was not tested.

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
| Lead column | Held at the left of the box, past the lead columns before it: see the sticky side columns below. `--surface` fill, aligned left, 8 px side padding, one line, `--fw-body`. |
| Lead column, `width: "code"` | `64px` wide, `--font-mono`. |
| Lead column, `width: "name"` | At least `96px` wide. Its own rule sets `left: 64px`, which stands for a `name` lead column that takes no measured offset: one in first place, and a fifth on its side. For the second, third and fourth lead column the measured offset replaces it. See the sticky side columns below. |
| Lead column, `width: "total"` | No rule reads it. |
| Tail column | Held at the right of the box, past the tail columns after it, while the box has room: see the sticky side columns below. `--surface` fill, a 1 px `--border` line on its left, 8 px side padding, aligned right, one line, at least `64px` wide. No rule reads `width` on a tail column. |
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

### The sticky side columns

The lead columns and the tail columns stand side by side: each is held past the ones outside it.

- **Measured offsets.** A column is as wide as what it holds, so the grid measures. It reads the widths of the
  head row's cells and sets custom properties on the box: `--lead-1`, `--lead-2` and so on for the second lead
  column onwards, each the width of the lead columns before it, and `--tail-0`, `--tail-1` and so on for the
  tail columns counted from the last one inwards, each the width of the tail columns after it.
- **When it measures.** After every render, and whenever the box or the table changes size without one: a
  `ResizeObserver` watches both.
- **What the stylesheet reads.** `--lead-1` to `--lead-3` are the `left` of the second, third and fourth cell
  of a row when that cell is a lead cell. `--tail-0` to `--tail-3` are the `right` of the last four cells when
  they are tail cells. Until the grid has set them, they have the values the stylesheet declares on the box:
  `64px` for each lead offset and `0` for each tail offset.
- **The first lead column** takes no property. It keeps `left: 0` from the base rule, or `left: 64px` when its
  `width` is `"name"`. So by the stylesheet a `name` column in first place is held 64 px from the left edge of
  the box, not at it. The attendance view puts a `code` column first. The browser fixture of the grid alone puts
  a `name` column first, and no test reads where it is drawn.
- **Lead columns are always held.**
- **Tail columns are held from the outside in.** The room is the width of the box less the lead columns. A day
  counts as the narrowest day column, so an open editor or a long draft, which widens its own column, changes
  nothing.
  - The last tail column is held while the box has room for one day and that column.
  - Each tail column inside it is held while the box has room for a week of days, seven, and every tail column
    from that one outwards.
  - Once one is not held, none inside it is.
  - A tail column that is not held gets `auto` as its offset and scrolls with the days. It is where the row
    ends.
  - A lone tail column is always held. In a box narrower than the lead columns, one day and that column, no
    day column shows whole between the two sides.
- **At most four sticky columns a side are placed.** The stylesheet has a rule for the second to the fourth
  lead column and for the last four tail columns, and its comment says a fifth needs its own rule. The grid
  still sets a property for a fifth, and no rule reads it. So a fifth lead column keeps the `left` a first one
  has: `0`, or `64px` for a `name` column. A fifth tail column from the end keeps `right: 0`, where the last one
  is held, whether or not the box has room. The attendance view passes one `code` column, up to two `name`
  columns and four tail columns.
- A `code` longer than 64 px widens its column, since in a table a cell's `width` is a least width. The offsets
  are measured, so the columns after it move with it. No test has such a code.

`apps/web/src/ui/person-day-grid/person-day-grid.browser.test.tsx` covers this in a browser, with the attendance
view's two and three lead columns and four totals. In the head row and in a person's row, it reads that no side
column in view is covered at its centre and that neighbours on a side touch. It reads that at the start of the
sideways scroll in every box below, 300 px in wherever the box scrolls, and at the end of the row in the boxes
1000 px and 640 px wide. At the end of the row in the three narrowest cases it reads less: see below the table.

| Width of the box | Lead columns | Totals held |
|---|---|---|
| 1000 px | Two or three | All four, with a week of days or more between the two sides. They stay held while an editor is open. |
| 640 px | Two | The outer two, with a week of days in view. The other two end the row. |
| 452 px | Three | The last one, with a day or more in view beside it. |
| 358 px | Two | The last one, with a day or more in view beside it. |
| 358 px | Three | None. All four scroll with the days and end the row. |
| 2200 px, wide enough for every column | Three | All four. Nothing scrolls sideways, and every column is where the table puts it. |

Scrolled to the end of the row, the three narrowest cases assert the same three things. No total is covered at
its centre, and each touches the total before it. All four totals start to the left of the box's right edge. The
last one ends at that edge. A fault that names a lead column is left out of the check there, so the test does
not assert where the lead columns are, or what covers them.

- For 452 px with three lead columns and for 358 px with two, the test's comment says that all four totals show
  whole there, over the lead columns, which a box that narrow cannot also show. That is the comment's wording.
  The assertions are the three above, and none reads the overlap.
- For 358 px with three lead columns, where no total is held, the test has no such comment. It asserts the
  three things above and nothing about the lead columns: that the totals lie over them there is not asserted.

The same test holds a lone total at the right edge of a box 390 px and 180 px wide, at the start of the sideways
scroll, part way and at the end.

## States

| State | What changes |
|---|---|
| Rest | The looks above. |
| Hover | Does not exist. The stylesheet has no hover rule. The cursor is `cell` over a day cell and a pointer over a day header. A lead cell selects its row when pressed and keeps the default cursor. |
| Grid has keyboard focus | A 2 px `--primary` outline on the table with `outline-offset: -2px`, so it is drawn just inside the table's edge. The rule is `:focus-visible` on the table. The grid has it after an edit that ends by a key, when it takes the focus back. After a press on the grid that ends an edit, the grid has the focus without this outline, as after any press. |
| Focused cell (`data-focus`) | A 2 px `--primary` outline with `outline-offset: -2px`, just inside the cell's edge. It marks the focus corner of the range, and is drawn whether or not the grid has focus. |
| Selected (`aria-selected="true"`) | Every day cell in the range takes a `--primary-soft` fill, in place of a tone's fill. The header of every day in the range takes the same fill. |
| Pressed, dragging | No look. A drag is seen only as the selection growing. |
| Editing | The cell holds the editor in place of its content. The stylesheet gives the editor `min-width: 88px` and a day header `min-width: 44px`, so while an editor is open its column is wider than the day columns, and the columns to its right move as it opens and closes. The width was not measured. The box scrolls sideways so that the widened column is in view: see Keyboard. |
| Draft, refused, locked | The looks under Looks and sizes. |
| Disabled | Does not exist. |
| Read-only | Does not exist as a state of the grid. `"locked"` is a look and nothing more: typing in a locked cell still opens the editor, and the caller decides at the commit. The attendance view refuses there and says why, unless the text committed is the draft the cell had when the editor opened, or empty for a cell that had none: an edit left unchanged writes nothing and refuses nothing. |
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
| Any key pressed on the table itself | Goes to the caller's `onKey` first. When that returns `true`, the grid does nothing more. |
| Arrow keys | Moves the focus one cell. The selection becomes that cell. |
| Home, End | Moves to the first or the last day of the row. |
| Page Up, Page Down | Moves ten rows. |
| Shift with an arrow key, Home, End or a page key | Extends the range. The anchor stays and the focus moves. |
| Enter, F2 | Asks the caller to open the editor on what the cell holds, `onEdit("")`. The grid does not know the cell's value and passes none: the caller puts the text in `editing.value`. The attendance view puts a draft's text there, and nothing for a cell with no draft. |
| One printable character, with no Ctrl, Alt or Meta | Asks the caller to open the editor with that character, `onEdit(key)`. The default is prevented. Space counts. |
| Escape | Collapses the range to its focus cell. |
| Any other key | Left alone. |

- A movement key stops at the edge of the grid, and its default is prevented even when nothing moves.
- Movement reads Shift and nothing else. Ctrl+Home is Home: no key goes to the first or the last cell of the grid.
- When the range's focus is not shown, a movement key starts from the first cell, and Enter, F2, Escape and typing
  do nothing.
- While `editing` is set, the table's handler returns before `onKey` is called. That holds even when the
  editor's row is not rendered.
- The handler acts only on a key pressed on the table itself. A key pressed in a link or a button inside a cell
  is that control's: the handler returns at once, the caller's `onKey` is not called, and the key's default is
  left alone. Enter on a link follows the link.
- Focus landing on such a control runs the table's focus handler too, which asks for the first cell when no
  focus cell is shown.
- A pointer press on a control in a lead cell reaches the lead cell and selects the row, unless the control
  stops the press.
- The attendance view stops `keydown` and `pointerdown` on the button it puts in a lead cell, so a press on the
  button does not select the row. It stops neither on the name link it puts there: a press on the link selects
  the row, and the link's keys are its own. `person-day-grid.browser-editing.ts` runs the keys in a browser:
  Enter on the name link follows it and opens no editor, and `p`, Backspace, Delete, `]`, a digit, F2 and Arrow
  Down pressed on the link change nothing in the grid.
- The attendance view listens for a paste on the window and acts only while the table itself has the focus. A
  paste with the editor, a name link or the button focused is not the grid's. The same test pastes on the link,
  where no paste preview opens, and on the grid, where one does.
- A change of focus row scrolls the box up or down so that the row is in view below the sticky head row. A row
  scrolled out of view by hand is not brought back by a key that keeps the focus row, such as Arrow Left.
- The box scrolls sideways so that the focus cell's column shows whole between the lead columns and the totals
  in view. The grid reads where the column is from the head row, which is always drawn. It does so each time a
  range is set, not only when the column changes, and when an editor opens or closes.
  - A movement key brings the focus cell back into view after the box was scrolled by hand, even a key with
    nowhere further to go.
  - An editor that opens widens its column, and the box scrolls until the column shows whole.
  - A press on a day cell that shows in part brings the rest of it into view.
  - A press on a lead cell is left out. It selects the row with the focus on the last day, and the box stays
    where the person has it. The next key brings the focus cell into view.
  - Scrolling the box by hand is not followed. The focus cell can be out of view, or under a sticky column,
    until the next range is set.
  - A column wider than the room between the two sides is placed with its start at the lead columns. Its end
    stays under the totals or outside the box.

  `person-day-grid.browser.test.tsx` covers the first four in a browser, with the arrow keys, Home and End in
  the attendance view. The last two were read from the code.

While the editor is open, keys go to the input. The table says what a plain key does. A key the input method
owns commits nothing and cancels nothing: see the keys the Korean input method owns, below.

| Key | What it does |
|---|---|
| Enter | Calls `onCommit("down")`. The default is prevented. |
| Tab, Shift+Tab | Calls `onCommit("right")`. The default is prevented. Shift is not read, so Shift+Tab also asks to move right. |
| Escape | Calls `onEdit(null)`: cancel. |
| Any other key | Types into the input. |

A plain key is stopped at the input, whichever key it is, so it does not reach the table's handler. The caller's
`onKey` does not run while the editor is open, for a plain key or for one the input method owns.

Leaving the input in any other way commits too: its blur calls `onCommit("stay")`. So does a pointer press on
another day cell, a day header or a lead cell, which commits and then selects.

**A press in the editor's own cell is the editor's.** The cell that holds the open editor does not select, so
nothing commits, and it does not ask for the editor again on a double-click.

- A press inside the input places the caret, and a double-click there selects a word, as in any input.
- The cell is taller and wider than the input's line of text. A press on the cell beside the input has the
  default of its `mousedown` cancelled, so the input keeps the focus and the editor stays. The grid moves no
  caret there.
- `person-day-grid.browser-editing.ts` runs both in a browser: after each press the editor has the focus and its
  text, and nothing is committed. Text typed after a double-click on a word replaces the word.

**A press that ends an edit selects the pressed cell alone.** It commits and then selects, and it starts no
drag. The closing editor narrows its column, which moves other cells under the held pointer, and a drag would
take them for the range. The same test covers it for the cell below the editor and for a cell to its right, and
that a press with no editor open still starts a drag.

**A double-click beside an open editor can open the wrong cell.** A double-click is two presses. The first one
closes the editor, and the cells in the editor's column and to the right of it move left under the pointer. The
second press, and the double-click, can then land on a neighbouring cell, and the editor opens there. Cells to
the left of the editor's column do not move, and those are the ones the browser test double-clicks.

**When an edit ends by a key, the grid takes the focus again.** The editor notes, as it leaves, whether it held
the focus. Once `editing` is `null`, the grid then focuses the table, without scrolling, so the next key lands on
the grid.

- After Enter, Tab or Escape in the editor, the table has the focus and shows its keyboard focus outline.
- After a press on the grid that ends the edit, the grid does not focus itself. The press gives the table the
  focus, as any press does, without the outline.
- After a press outside the grid, the blur commits and the focus stays where the person put it.
- `person-day-grid.browser-editing.ts` runs each in a browser, and that one edit is still one step to undo:
  taking the focus back does not commit a second time.

Where a journey spec of the timesheet goes on to a key on the grid after Enter, it gives the grid the focus
itself first. It calls `focus()` on the grid and then presses the save key, Ctrl or Meta with S, as
`e2e/attendance-long-span.spec.ts` and `e2e/attendance-approvals.spec.ts` do. Or it clicks a cell before the
next key, as `e2e/attendance-records.spec.ts` and `e2e/session-recovery.spec.ts` do. None was found that presses
a key on the grid straight after Enter: the files under `e2e` that reach a grid or a grid cell in attendance
were searched for a press of Enter, and the lines after each were read.

**Keys the Korean input method owns.**

- The editor asks the shared helper `isImeKey` (`apps/web/src/lib/pure/ime.ts`) whether a key is the input
  method's. It is when the `isComposing` flag is set, when the key code is 229, or when the key is `Process`.
  `TextInput` uses the same helper. The editor listens to no composition event.
- No such key commits or cancels. An Enter that carries the flag, or key code 229 alone, does not commit the
  cell. What differs between such keys is whether the key is stopped.
- **Not stopped:** Enter, a letter and every other key the input method owns, except Escape and Tab. The editor
  returns without acting on the key and without stopping it. The key goes on to the table's handler, which
  returns at once because the key was not pressed on the table, and the caller's `onKey` is not called. By the
  code the key then goes on to any handler above the grid. No test reads that.
- **Stopped:** an Escape or a Tab the input method owns, which is one pressed while a syllable is composing. The
  shared helper `leaveImeKey` stops it in the capture phase, so it reaches no handler on the input, on the table
  or above them in the bubble phase. The helper cancels the Escape's own action and leaves the Tab's to the
  browser.
- The editor cancels the composing Tab's own action as well, so the focus stays in the editor. Left to the
  browser, that Tab moves the focus out of the editor to the next tab stop, a name link in the attendance view.
- `apps/web/src/ui/ime-keys.browser.test.tsx` sends Enter, Tab and Escape to the editor, marked with the flag
  and marked with key code 229 alone. Nothing commits, the editor stays open with its text and the focus, and a
  handler above the grid hears no Escape and no Tab. A plain Enter then commits.
- `person-day-grid.browser-editing.ts` starts a composition in the editor through the browser's input-method
  interface and presses Tab. The focus stays in the editor and nothing is committed. Once the composition has
  ended, a plain Tab commits and moves right. The composition is of Latin text, not of Korean syllables. Both
  tests run in Chromium.
- Typing to open the editor has no check at all: the table's handler does not ask `isImeKey`. Until the first
  key opens it, the grid holds no input, so a composition has nowhere to begin. The handler opens the editor
  with `key` when `key` is one character long, as plain text and not as a composition. A key reported as
  `Process` is longer than one character and is ignored. What a browser reports for the first key of a syllable
  while focus is on the table was not tested.
- The timesheet takes Korean words as values. Its journey specs type digits and punctuation, and enter the Korean
  values by paste. No spec under `e2e` was found that composes into this grid: the attendance specs and helpers
  there were searched, in any letter case, for `composition`, `isComposing`, `imeSet` and `insertText`. The one
  match inserts digits into another grid.

With the pointer:

| Action | What it does |
|---|---|
| Press a day cell | Selects that cell. With an editor open in another cell, commits first. |
| Shift and press a day cell | Extends the range from its anchor. |
| Press and drag across day cells | Extends the range to the cell under the pointer. The drag ends when the pointer is released anywhere in the window. A press that ends an edit starts no drag. |
| Double-click a day cell | Asks the caller to open the editor on what the cell holds, `onEdit("")`, as Enter does. |
| Press or double-click the cell that holds the open editor | Nothing in the grid. The press is the editor's: see above. |
| Press a day header | Selects that day for every loaded row. The focus lands on the last loaded row, and the box scrolls down to it. |
| Press a lead cell | Selects every day of that row. The focus lands on the last day, and the box does not scroll sideways to it. |

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
  have cells with an `id`. The grid scrolls the focus row into view when it changes, and the focus column
  sideways when a range is set: see Keyboard. Once the box is scrolled so that the focus row is more than eight
  rows out of view, the row is not rendered and `aria-activedescendant` names an `id` that is not in the
  document.
- **Counts.** `aria-rowcount` is the server's total. `aria-rowindex` counts loaded rows in the order they are
  drawn now.
- **Groups.** A group is not exposed. Its name is a `data-group` attribute and its mark is a line.
- **Announced:** nothing by the component. It has no live region. A screen reader reads the cell that becomes the
  active descendant. The size of a range is not announced by the grid: the attendance view writes it in its own
  `role="status"` line.

Known gaps:

- A focused cell that is a draft or a refusal has no focus outline: see States. In a range of drafts nothing
  marks which cell is the focus.
- The box does not follow the focus cell sideways after it is scrolled by hand, or after a press on a lead cell
  puts the focus on the last day. Until the next range is set, the focus cell can be out of view or under a
  sticky column. A column wider than the room between the sticky columns keeps its end covered. See Keyboard.
- A row scrolled out of view by hand is not brought back by a key that keeps the focus row: see Keyboard.
- When the editor's row is scrolled out of the window, its input is removed and the grid does not take the
  focus: see Anatomy.
- A double-click on a cell in the open editor's column, or to the right of it, can open the editor on a
  neighbouring cell: the first press closes the editor, and the cells move under the pointer. See Keyboard.
- Any pointer button selects, and `pointercancel` does not end a drag: see Keyboard.
- A cell taller than the row height puts the spacers and the window out of step with the rows: see Anatomy.
- Typing to open the editor does not handle the Korean input method. The table's handler has no check, and the
  first key of a syllable has no input to compose in: see Keyboard.
- Enter, F2 and a double-click open the editor on a draft's text only. The grid passes no value, and the
  attendance view opens a cell with no draft empty, whatever the cell shows.
- The group's name is never shown or exposed.
- A locked cell and a refused cell carry no ARIA state.
- The header cells have no `scope`, and the lead and tail cells cannot be reached with the grid's keys.
- The rows drawn do not follow a change of the box's height while the window keeps its size, until the next
  scroll: see Anatomy.
- At most four sticky columns a side are placed. A fifth takes no measured offset and keeps the one its other
  rules give: see Looks and sizes. That was read from the stylesheet, not run in a browser.
- A `name` column in first place is held 64 px from the left edge of the box by its own rule: see Looks and
  sizes. That was read from the stylesheet, not run in a browser.
- A lone tail column is held in a box of any width. In a box with no room for a day between it and the lead
  columns, no day column shows whole: see Looks and sizes.
- While an editor is open its column is wider than the day columns: the stylesheet gives the editor
  `min-width: 88px` and a day header `min-width: 44px`. The columns to the right of it move as it opens and
  closes. The width was not measured.
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
| 2.1.1 Keyboard | Every day cell can be reached, selected and edited with keys. Lead and tail cells are not reached by the grid's keys. A link or a button the caller puts in a cell is a tab stop and keeps its own keys: the grid acts only on a key pressed on the table. A browser test runs Enter on the attendance view's name link. |
| 2.4.3 Focus Order | When an edit ends by a key, the grid takes the focus again, so the next key lands where the person was working. A browser test covers Enter, Tab and Escape. Not answered when the editor's row is scrolled out of the window: the input is removed and the grid does not take the focus. |
| 2.4.7 Focus Visible | Not met for a focused draft or refused cell. |
| 2.4.11 Focus Not Obscured (Minimum) | When a key moves the focus cell, or an editor opens in it, the box scrolls so that the cell shows whole below the head row and between the sticky columns. A browser test covers both directions. Not answered after the box is scrolled by hand or a lead cell is pressed, until the next key, nor for a column wider than the room between the sticky columns: see the gaps. |
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
| `apps/web/src/ui/person-day-grid/person-day-grid.browser.test.tsx`, with its probes in `person-day-grid.browser-probes.ts` | In a browser, served with the real stylesheet. The grid alone, with 400 people: the rows drawn and the spacers stand for every row at a row height of 32, 24 and 40 px; Arrow Down keeps the focus cell in view below the head row; a box taller than 600 px is filled with rows before the first scroll; a lone total stays at the right edge of a box 390 px and 180 px wide. The attendance view, with twelve people over 31 days: the sticky side columns stand side by side, and the totals held are the ones the table under Looks and sizes names; the focus cell stays in view between the sticky columns through the arrow keys, Home, End, an opening editor, a hand scroll and a press on a cell that shows in part; a press on a lead cell leaves the box where it is. |
| `apps/web/src/ui/person-day-grid/person-day-grid.browser-editing.ts`, the editing cases of the test above | In the attendance view: the grid has the focus again after an edit ends by Enter, Tab or Escape; after a press on the grid that ends an edit it has the focus without the focus outline; a press outside the grid keeps the focus there; a Tab pressed during a composition keeps the focus in the editor; a press that ends an edit selects the pressed cell alone; Enter on a name link follows it, and keys and a paste on the link are not the grid's; a press inside the open editor, or on its cell beside the text, keeps the editor; Enter, F2 and a double-click open the editor on a draft's text, and an edit left unchanged writes nothing. |
| `apps/web/src/ui/ime-keys.browser.test.tsx` | In a browser: Enter, Tab and Escape sent to the editor as keys the input method owns commit nothing and close nothing, and no handler above the grid hears the Escape or the Tab. A plain Enter then commits. |
| `apps/web/src/lib/pure/ime.test.ts` | The two helpers the editor uses: which keys the input method owns, and that an Escape or a Tab it owns is stopped while its Enter and a plain Escape or Tab go on. |
| `apps/web/src/ui/sheet-grid/range.test.ts` | Moving, extending and stopping at the edge; a cell staying on its person; a focus that is gone starting again from the first cell; the rows a range covers. |
| `scripts/check-ds.test.ts` | That the refused outline is a 2 px solid `--danger-solid` line, that the lead column reads `--fw-body`, and that the stylesheet names none of a short list of token names that do not exist. |
| `e2e/states/attendance-month.spec.ts` | The month timesheet in each of its states at 1440 px and 390 px, ending with the fit check and an axe scan. With 400 rows: the box is the only thing that scrolls down, the head row sticks, and the last row can be reached. At both widths, on the way to the undo sheet: a double click on a cell, typing, Enter, and a save of that one cell. |
| `e2e/attendance-records.spec.ts`, `e2e/attendance-grid-safety.spec.ts`, `e2e/attendance-grammar.spec.ts` | Against the real server: typing into a cell, Enter, extending with Shift, the feature's keys, and an editor that stays with its person while rows change under it. |
| `e2e/attendance-paste-native.spec.ts` | Against the real server: with the editor open, a paste made through the keyboard puts its text into the editor and opens no paste preview, and Enter then keeps what the editor holds as a draft. End is pressed inside the editor. |

The table names the main specs, not every one. Other specs under `e2e` click a cell, type and press Enter on the
way to something else.

The browser test presses Home, End and F2 on the grid and Tab in its editor. No test was found that presses a
page key on the grid, or Shift+Tab in its editor. One spec, `e2e/attendance-paste-native.spec.ts`, presses End
inside the editor, where it is the input's own key. The component's tests, the attendance view's and every file
under `e2e` were searched for the page keys and for Shift+Tab: the matches are in other views.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component).

## Phone behaviour at 390 px

The stylesheet has no media query and no container query. What changes with the width is which tail columns are
held, and the grid decides that from the width of its box, not of the screen: see Looks and sizes.

- The grid keeps every column and scrolls in both directions inside its box. There is no narrower form.
- The lead columns are always held and keep their widths. A lone tail column is always held too.
- Of several tail columns, a narrow box holds the last one only, and only while a day fits beside it. By the
  least widths in the stylesheet, a `code` column, a `name` column, one day and the last tail column take
  268 px: `64px`, `96px`, `44px` and `64px`. A box 358 px wide has room for that, and not for the week of days
  that a second tail column needs. Holding the last one leaves at most 134 px for days, which is three day
  columns of `44px`. The columns are as wide as what they hold, so the room is less wherever a name or a header
  is wider.
- With a third lead column of at least `96px`, the same sum is 364 px. A box 358 px wide holds no tail column:
  all of them scroll with the days and end the row.
- `person-day-grid.browser.test.tsx` runs the attendance view both ways in a browser, in a box 358 px wide, the
  width its cases take for a phone. With two lead columns the last total stays at the right edge with a day or
  more showing whole beside it. With three, no total is held. Either way, at the end of the row the test asserts
  that no total is covered at its centre, that all four start left of the box's right edge and that the last
  one ends at it. For two lead columns its comment says the totals lie over the lead columns there. For three it
  has no such comment, and that overlap is not asserted: see Looks and sizes.
- A day cell stays at least 44 px wide and 32 px high. The 44 px is the literal `44px`: the module does not read
  `--target-touch`.
- While an editor is open its column is wider: the stylesheet gives the editor `min-width: 88px`. By the least
  widths that is most of the room a 358 px box leaves for days. The box scrolls so that the column shows whole
  between the two sides. That was not run at this width.
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
| `onEdit` | yes | `(value: string \| null) => void` |  | With no editor open: a typed character starts an edit on that character, and "" (Enter, F2, a double-click) asks for one on what the cell holds, which only the caller knows. With one open: its new text. null closes it unsaved. |
| `onKey` | yes | `(e: KeyboardEvent<Element>) => boolean` |  | The feature's keys first (⌘D, ⌘↵, =, Delete, P …); true when handled. |
| `onRange` | yes | `(range: Range) => void` |  | The new selection. Never a commit: the grid commits the open editor itself before a person moves the selection, and its own collapse (the people under a range changed) leaves the editor and what is being typed alone. |
| `range` | yes | `Range \| null` |  | By row and column key; null (or a corner not shown) selects nothing. |
| `rowKey` | yes | `(r: R) => string` |  |  |
| `rows` | yes | `readonly R[]` |  |  |
| `tail` | yes | `readonly SideColumn<R>[]` |  |  |
| `total` | yes | `number` |  | Rows matching the scope on the server (aria-rowcount), loaded or not. |
| `groupOf` | no | `(r: R) => string` |  | A row group's head is drawn above the first row of each group. |

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
| `--border` | `--rules`, `background-image`, `border-bottom`, `border-left` |
| `--canvas` | `background` |
| `--control-border` | `--rules`, `border-top` |
| `--danger-bg` | `background` |
| `--danger-solid` | `outline` |
| `--danger-tx` | `color` |
| `--font-mono` | `font-family` |
| `--fw-body` | `font-weight` |
| `--fw-medium` | `font-weight` |
| `--ink` | `color` |
| `--lead-1` | `left` |
| `--lead-2` | `left` |
| `--lead-3` | `left` |
| `--primary` | `outline` |
| `--primary-soft` | `background` |
| `--row-h-compact` | `height`, `min-height` |
| `--rules` | `box-shadow` |
| `--space-1` | `padding` |
| `--space-2` | `padding` |
| `--steel` | `color` |
| `--surface` | `background` |
| `--tail-0` | `right` |
| `--tail-1` | `right` |
| `--tail-2` | `right` |
| `--tail-3` | `right` |
| `--target` | `min-width` |
| `--text-sm` | `font-size` |
| `--text-xs` | `font-size` |

<!-- /ds:tokens -->

`--lead-1` to `--lead-3` and `--tail-0` to `--tail-3` are not design tokens. They are the grid's own properties:
the stylesheet declares them on the box, and the grid sets them there from the measured column widths. See Looks
and sizes.

The focus outline of anything the caller puts in a cell is a global rule and is not listed: it reads `--primary`.
