<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Month grid

`MonthGrid` draws one month as a table of weeks, one cell for each day, and lets the caller draw what each day
holds.

It lives in `apps/web/src/ui/month-grid/month-grid.tsx`, which also exports the type `DayTone`.

## When to use it, and when not

Use it to show what each day of one month holds: a schedule, a holiday, a rest day. The caller passes the weeks,
the weekday names and the content of each cell. The component knows no calendar rule: it does not work out the
weeks, the holidays, today, or which month comes next.

It can also let a person choose a day, when `onSelect` is passed.

One feature uses it: the schedule calendar of attendance (`features/attendance/ui/calendar-view.tsx`). That was
found by searching `apps`, `e2e` and `scripts` for an import of the module. The only other import is the gallery.
That view passes neither `selected` nor `onSelect`, so in the product the grid is read and not chosen from.

| Do not use it for | Use instead |
|---|---|
| Entering a date in a form | `DateField` or `DateInput`: see [Date](date.md). Their calendar has month buttons, bounds and blocked days. `MonthGrid` has none of them. |
| People down the side and days across the top | `PersonDayGrid`: see [Person-day grid](person-day-grid.md). |
| Editing values in cells | `SheetGrid` (`ui/sheet-grid`), or `PersonDayGrid` for a month of person-days. A `MonthGrid` cell cannot be typed into. |
| Many records with the same columns | `Table` (`ui/table.tsx`). |
| A short list of dated items | `ItemList` (`ui/item-list`). The attendance calendar lists the month's holidays that way, beside the grid. |
| Moving to another month | Nothing in this component. The caller owns the month and re-renders the grid with new `weeks`. |

## Anatomy

| Part | Element | Holds |
|---|---|---|
| Grid | `<table role="grid">` | `aria-label` from `label`. |
| Head row | `<thead>`, one `<tr>` | One weekday header for each entry of `weekdays`. |
| Weekday header | `<th scope="col">` | The weekday name, as given. |
| Week | `<tr>` in `<tbody>`, one for each entry of `weeks` | Its days. |
| Day | `<td>` | The day number, then the caller's content. It carries `data-date` with the date, `tabindex`, `data-out="true"` when `inMonth` says the date is outside the month, `data-tone` from `tone`, and `aria-selected` when `onSelect` is passed. |
| Day number | `<span>` | The day of the month, as a number with no leading zero. It is read from the date's text, from the ninth character on. |
| Cell slot | Whatever `cell(date)` returns, after the day number | The caller's content. It may be `null`. |

What the caller passes:

- `weeks` is rows of dates, each `YYYY-MM-DD`. The prop's comment says seven to a row. The component does not
  check the count, but the Home and End keys and the Up and Down keys count in sevens.
- `weekdays` is the column headers, in the same order as a week. The attendance view starts its weeks on Sunday.
  The component accepts any order.
- A week is keyed by its first date, so each week must start on a different date.
- Days of the neighbouring months are passed like any other day. `inMonth` only mutes them.

There is no slot for a title, a month heading or a legend. `MonthGrid` takes no `className` and passes no other
attribute through.

## Looks and sizes

There is one look and one size. No prop changes either.

| Part | Look |
|---|---|
| Grid | The full width of its container. `table-layout: fixed`, so the seven columns are equal. Borders are collapsed. |
| Weekday header | 12 px (`--text-xs`), `--fw-medium`, `--steel`, aligned left. 4 px padding top and bottom (`--space-1`), 8 px at the sides (`--space-2`). |
| Day | `calc(var(--row-h) * 2.5)` high, which is 100 px. On a table cell that is a least height: a cell with more content grows, and its whole week grows with it. 4 px padding top and bottom, 8 px at the sides. A 1 px `--border-soft` border, `--surface` fill, 12 px text, content at the top. Text may break anywhere (`overflow-wrap: anywhere`). |
| Day number | On its own line. 13 px (`--text-sm`), `--ink`, tabular numbers. |
| Day outside the month | `--steel` text on a `--canvas` fill. The day number turns `--steel` too. |

`tone` sets the fill of a day:

| `tone` | Fill |
|---|---|
| `"rest"` | `--canvas`. |
| `"holiday"` | `--danger-bg`. |
| Not set | `--surface`. |

A day outside the month takes `--canvas` whatever its tone: that rule comes after the tone rules and has the same
weight. A holiday in a neighbouring month therefore shows no holiday fill.

A rest day and a day outside the month have the same fill. They differ by the colour of their text and day number.

## States

| State | What changes |
|---|---|
| Rest | The looks above. The cursor is the default arrow. |
| Hover | Does not exist. The stylesheet has no hover rule. |
| Keyboard focus | A 2 px `--primary` outline with `outline-offset: -2px`, so it is drawn just inside the cell's edge. The rule is `:focus-visible`, so a day focused by a click shows it only when the browser decides to. |
| Pressed | Does not exist. |
| Can be chosen (`onSelect` passed) | Every day carries `aria-selected`, `"true"` or `"false"`, and the cursor is a pointer. |
| Selected (`selected` equals the date, and `onSelect` passed) | A 2 px `--primary` outline with `outline-offset: -2px`. It is the same outline as keyboard focus. |
| Disabled | Does not exist. Every day shown can take focus, and with `onSelect` every day can be chosen, a day outside the month included. |
| Read-only | Without `onSelect` the grid is read-only: no `aria-selected`, no pointer cursor, and Enter, Space and a click do nothing. Focus still moves between days. |
| Invalid | Does not exist. |
| Loading | Does not exist. The attendance view wraps the grid in `QueryState` (`lib/react/query-state`), which stands in for it while the month is read. |
| Empty | Does not exist. With no weeks the table has a head row and an empty body. A day with nothing in its slot shows its number alone. |

`selected` without `onSelect` has one effect: the tab stop starts on that day. Nothing marks it, because
`aria-selected` is written only when `onSelect` is passed and the selected look is keyed on `aria-selected`.

There is no mark for today. The component is not told which day today is.

## Keyboard

One day is the tab stop: the day last focused, else the selected day, else the first day `inMonth` accepts. A day
that is no longer among `weeks` is skipped in that order. When none of the three gives a day, the grid has no tab
stop.

| Key | What it does |
|---|---|
| Tab, Shift+Tab | Moves into the grid, onto the tab stop, and out again. Content the caller put in a cell that can take focus is a tab stop of its own. |
| Left, Right | Moves one day. Right on the last day of a week goes to the first day of the next week, and Left the other way. |
| Up, Down | Moves seven days, to the same weekday of the week before or the week after. Up in the first week and Down in the last week move nothing. |
| Home, End | Moves to the first or the last day of the week. |
| Enter, Space | With `onSelect`: calls it with the focused date. Without it: nothing, and the key keeps its default, so Space scrolls the page. |
| Any other key | Left alone. |

- Moves stop at the edges of the grid. They do not change the month: there is no Page Up or Page
  Down, and nothing is called when a move runs off the grid.
- An arrow key with no day to land on moves nothing. Up in the first week and Down in the last week leave focus
  on the same day, and so do Left on the first day shown and Right on the last.
- End in a last week shorter than seven days goes to the last day shown.
- Focus moves onto days outside the month like any other day.
- Every key the grid handles has its default prevented, an arrow that moves nothing included, so the page does
  not scroll at the grid's edges.
- The handler reads no modifier key. An arrow, Home or End pressed with Ctrl, Alt, Meta or Shift moves focus the
  same way, and the handler prevents the default of that combination too.
- A key pressed inside focusable content in a cell reaches the same handler, because the handler is on the cell
  and does not look at where the key was pressed. So for a link, a button or an input in a cell, the grid takes
  the arrow keys, Home and End, with their default prevented, and Enter and Space too when `onSelect` is passed,
  unless the control stops the key. A click on the control reaches the cell as well and, when `onSelect` is
  passed, calls it. That was read from the code, not run in a browser. The attendance calendar puts no control in
  a cell.

The component takes no text. It has one `keydown` handler and no composition event. The handler returns first on
a key the input method owns, which `isImeKey` (`lib/pure/ime.ts`) tells by `isComposing`, key code 229 or the key
name `Process`: that key moves nothing and keeps its default. So an arrow pressed while a syllable is composing in
a text field the caller put in a cell stays with the input method. Otherwise the handler compares `key` with the
names above, so a key that the Korean input method reports under another name is left alone.

The browser test presses these keys in Chromium, on a grid given the props the attendance calendar passes and on
one that can be chosen from: see the table of tests below. The unit test renders to a string. A search of `e2e`
for the grid's label id and for `data-date` found one spec, and it checks only that the grid is visible.

## Accessibility contract

| Part | Role | Accessible name | Also exposed |
|---|---|---|---|
| Grid | `grid` | `label`, through `aria-label`. The prop is required. | Nothing. |
| Weekday header | Column header, from `<th scope="col">` | Its text. | Nothing. |
| Day | Grid cell, from a `<td>` in the grid | Its content: the day number, then what the caller drew. | `aria-selected` when the grid can be chosen from. |

- **The date is not in the name.** A day is named by its number and the caller's content. The month and the year
  come from the grid's `label`, and the weekday from the column header. `data-date` is not exposed.
- **A day outside the month is not exposed as one.** `data-out` changes colour only. Its name is a bare number,
  so "27" in the first week reads like a day of this month.
- **A tone is not exposed.** `data-tone` changes the fill only. The rule is that the cell's own text names the
  kind of day, so the caller's `cell` must print it. The attendance view prints the holiday's name and the kind of
  day. The component does not check.
- **Focus** is real focus on the day, moved with a roving `tabindex`. There is no `aria-activedescendant`.
- **Announced:** nothing by the component. A screen reader reads the day that takes focus. Choosing a day changes
  `aria-selected` and makes no announcement.

Known gaps:

- The selected day and the day with keyboard focus look the same. While one day is selected and another has
  keyboard focus, two cells carry the same outline and nothing shows which is which.
- A day outside the month is told apart by colour alone, and assistive technology is not told at all.
- A holiday outside the month loses its fill: see Looks and sizes.
- With `onSelect`, a click or Enter on a day outside the month chooses it. Nothing stops it or moves the month.
- There is no hover look on a grid that can be chosen from. The pointer cursor is the only sign.
- Without `onSelect`, Space on a focused day scrolls the page.
- A control the caller puts in a cell has its arrow keys, Home and End taken by the grid, and with `onSelect` its
  Enter and Space too, unless it stops them. With `onSelect`, a click on it also chooses the day. See Keyboard.
- No modifier key is read, so an arrow, Home or End with a modifier is handled as the bare key.

Contrast, computed from the token values in `packages/tokens/tokens.css`:

| Pair | Light | Dark |
|---|---|---|
| Muted text (`--steel`) on `--canvas`, a day outside the month | 5.48:1 | 7.96:1 |
| Weekday header (`--steel`) on `--surface` | 6.04:1 | 7.31:1 |
| Outline (`--primary`) on `--surface` | 7.09:1 | 5.54:1 |
| Outline on `--canvas` | 6.44:1 | 6.03:1 |
| Outline on `--danger-bg` | 6.48:1 | 5.32:1 |
| Cell border (`--border-soft`) on `--surface` | 1.19:1 | 1.21:1 |

The header ratio assumes the grid sits on `--surface`. The component sets no fill behind the head row.

The WCAG 2.2 criteria that apply:

| Criterion | How the component answers it |
|---|---|
| 1.3.1 Info and Relationships | A table with column headers and one cell for each day. The month a day belongs to is not in the structure: see the gaps. |
| 1.4.1 Use of Color | A tone is a fill, and the caller's text must say the same. A day outside the month is colour alone. |
| 1.4.3 Contrast (Minimum) | The muted text is above 4.5:1 in both themes. The caller's content takes the caller's colours. |
| 1.4.10 Reflow | The grid takes the width it is given and has no sideways scroll of its own. Text breaks anywhere. Content that the caller keeps on one line is not handled: a cell sets no `overflow`. |
| 1.4.11 Non-text Contrast | The focus and selected outline is above 3:1 on every fill a day can have. The cell border is not: the day number, not the border, marks a day. |
| 2.1.1 Keyboard | Every day can be reached and, with `onSelect`, chosen. |
| 2.4.3 Focus Order | One tab stop, which stays on the day last focused. |
| 2.4.7 Focus Visible | The outline on the focused day. It cannot be told from the selected day: see the gaps. |
| 2.5.8 Target Size (Minimum) | A day is at least 100 px high and a seventh of the grid wide. |
| 4.1.2 Name, Role, Value | The table above. |

The gallery entry is `apps/web/src/ui/month-grid/month-grid.gallery.tsx`. It shows October 2026 in five weeks,
with rest days, three holidays, four days of the month before, and one day chosen. It always passes `onSelect`,
so it does not show the read-only grid, which is the only form the product uses.

What tests it:

| Test | Covers |
|---|---|
| `apps/web/src/ui/month-grid/month-grid.test.tsx` | That there is one tab stop, on the selected day or else the month's first day; that a day outside the month carries `data-out`; that a holiday carries its tone and the caller's words. |
| `apps/web/src/ui/month-grid/month-grid.browser.test.tsx` | In Chromium, on October 2026 in five Sunday-first weeks, with neither `selected` nor `onSelect` as in the attendance calendar: that Up in the first week and Down in the last week leave focus on the same day, from the tab stop and after a click, the corner days included, with the default prevented and the page not scrolled; that Up and Down keep the weekday; that Left and Right cross a week's end and stop at the first and the last day shown; Home and End; an arrow and Home with a modifier; that Page Up, Page Down, a letter and, with nothing to choose, Enter and Space are left to the browser; that Tab enters and leaves in one step and comes back to the day last focused; that with `onSelect` Enter, Space and a click choose the day; that a `selected` day with nothing to choose is the tab stop, is not marked and leaves Space to the browser; that on a grid whose last week has three days End goes to the last of them; that an arrow dispatched as the input method's, by `isComposing` or by key code 229, moves nothing and is not cancelled. |
| `e2e/states/attendance-schedule.spec.ts` | The attendance calendar in each of its states at 1440 px and 390 px, ending with the fit check and an axe scan. |
| `e2e/mock/attendance-calendar-stability.spec.ts` | That the grid, found by its name, stays on screen when the history read beside it fails and then recovers. |

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component).

## Phone behaviour at 390 px

Nothing in the component's rules changes with the width of the screen. The stylesheet has no media query and no
container query.

- The grid keeps seven equal columns at every width. On a 390 px screen a column is under 56 px wide, less
  whatever the page around the grid takes, and 16 px of that is the cell's side padding.
- Text in a cell breaks anywhere, so a long word makes the cell taller, not wider. The week's row grows to its
  tallest day. Content the caller keeps on one line, such as a chip, is not handled: a cell sets no `overflow`.
- A day stays at least 100 px high. The module does not read `--target` or `--target-touch`.
- The grid has no sideways scroll of its own and no narrower form, such as a list of days.

The attendance calendar puts the grid in a single column at 960 px and below. That rule belongs to the view, not
to the component.

## Copy rules

- The component holds no text of its own and owns no message id. The day number is a number, not a message.
- `label`, `weekdays` and everything `cell` draws are the caller's text, from the message catalog in
  `packages/i18n` or from the formatters in `@console/i18n/format`. The `en` catalog is the source and the `ko`
  catalog must define every id.
- `label` names the grid for assistive technology and is never visible. It should say which month is shown, and
  of what, because nothing else in the grid does. The attendance view passes `attendanceSchedule.calendar.label`,
  which takes the scope and the month.
- Print the kind of day in the cell. A tone alone is a colour.
- Keep cell text short. At phone width a column holds a few characters to a line.
- The gallery's text is in the gallery catalog, under `section.monthGrid` and ids that start with `monthGrid.`.
  Production builds leave that catalog out.

## Props

<!-- ds:props apps/web/src/ui/month-grid/month-grid.tsx -->

### MonthGrid

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `cell` | yes | `(date: string) => ReactNode` |  |  |
| `inMonth` | yes | `(date: string) => boolean` |  |  |
| `label` | yes | `string` |  |  |
| `weekdays` | yes | `readonly string[]` |  | The 7 column headers, in the weeks' order. |
| `weeks` | yes | `readonly (readonly string[])[]` |  | Rows of 7 `YYYY-MM-DD` dates. |
| `onSelect` | no | `(date: string) => void` |  |  |
| `selected` | no | `string` |  |  |
| `tone` | no | `(date: string) => DayTone \| undefined` |  |  |

<!-- /ds:props -->

`DayTone` is `"holiday" | "rest"`.

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/month-grid/month-grid.module.css -->

| Token | Read by |
| --- | --- |
| `--border-soft` | `border` |
| `--canvas` | `background` |
| `--danger-bg` | `background` |
| `--fw-medium` | `font-weight` |
| `--ink` | `color` |
| `--primary` | `outline` |
| `--row-h` | `height` |
| `--space-1` | `padding` |
| `--space-2` | `padding` |
| `--steel` | `color` |
| `--surface` | `background` |
| `--text-sm` | `font-size` |
| `--text-xs` | `font-size` |

<!-- /ds:tokens -->

The outline widths and offsets are written as `2px` and `-2px`, not as tokens.
