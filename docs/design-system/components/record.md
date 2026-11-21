<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Record

The record kit is the set of parts a personnel record page is built from: titled sections, fact rows with their
edit marks, compact row tables, the register strip, the section links, the dated history beside the record, and
the small parts those use.

It lives in `apps/web/src/ui/record`: eight modules and one stylesheet, `record.module.css`.

| Module | Exports |
|---|---|
| `record-section.tsx` | `RecordSection`, `SubHead`, `SectionLine`, `Gate`, `Tag`, `Kbd`. It also re-exports `Masked`. |
| `field-row.tsx` | `FieldRow`, `FieldMark` and the type `MarkKind`. |
| `rows.tsx` | `RecordRows` and the type `RowColumn`. |
| `strip.tsx` | `Strip`, `StripItem`. |
| `sec-nav.tsx` | `SecNav`. |
| `spine.tsx` | `Spine` and the type `SpineItem`. |
| `inline.tsx` | `RowInput`, `Saving`, `EditRow`. |
| `masked.tsx` | `Masked`. |

Every part is used by the people feature, `features/people/ui`. Most of them meet on the employee card:
`card-body.tsx` and the section files beside it. The statutory views use `RecordRows`, and `ui/palette` uses `Kbd`.

## When to use it, and when not

| Component | Use it for |
|---|---|
| `RecordSection` | One section of a record: a surface with a head (number, title, a note, tools) and a body of rows. |
| `SubHead` | A labelled divider inside a section body, with a tool at its end: the head of a list within the section. |
| `SectionLine` | One muted line in a section: nothing recorded, or a rule that applies. |
| `Gate` | A closed part of a record: what it is, why it is closed and how to open it, inside a dashed box. |
| `Tag` | A small state word on a row or a dated item: planned, correction, void, imported. |
| `Kbd` | A key cap shown beside the command the key runs. |
| `Masked` | A masked value, as text. |
| `FieldRow` | One fact: its label, its value, an optional line under the value and one mark at the end. |
| `FieldMark` | The mark at the end of a fact row: the fact's edit button, with the way the edit is recorded said beside it, or a lock line for a fact that is not edited there. |
| `RecordRows` | The rows of one section as a compact table with no selection: career, education, contracts, leave. |
| `Strip`, `StripItem` | A row of labelled cells, each a button that jumps to its field: the nine items of the employee register. |
| `SecNav` | Links to the sections of the same page, each with its number key and an optional count. |
| `Spine` | The box beside the record: what holds today, then the dated items in the order given. |
| `RowInput` | The text input of a quick edit inside a fact row. |
| `Saving` | The typed value while its save is in flight. |
| `EditRow` | A block edited in place among a section's rows, with the tint and the bar of a row being edited. |

| Do not use it for | Use instead |
|---|---|
| Facts about a thing that is not a personnel record | `KeyValue`: see [Key-value](key-value.md). |
| A titled surface that is not a record section | `Card`: see [Card](card.md). |
| A sub-heading that assistive technology must find as a heading | `SectionHead`: see [Card](card.md). `SubHead` is not a heading element. |
| Many records with the same columns, or rows that can be selected | `Table` (`ui/table.tsx`). `RecordRows` has no selection, no row detail and no empty text. |
| The edit and the overflow menu of a row, or the add of a list | `RowActions` and `ListAdd`: see [Record actions](record-actions.md). |
| An edit that is blocked and must say why | `RowActions` with `why`, or `DisabledReason`: see [Disabled reason](disabled-reason.md). `FieldMark` has no blocked state. |
| The state of a record in a table cell or beside a title | `Chip`: see [Chip](chip.md). |
| An input for an identifier with a fixed shape | `MaskedField`: see [Masked field](masked-field.md). `Masked` only shows text. |
| A labelled form field with a hint and an error | `Field` with `TextInput`: see [Field](field.md). `RowInput` has no label, hint or error. |
| Tabs, or links between pages | `Tabs`, `PageTabs` or `TabNav` (`ui/tabs`). `SecNav` links to sections of one page. |
| A refusal the server sent | `BlockedPanel` (`ui/blocker`). `Gate` holds only what the caller writes in it. |
| The empty state of a whole view | `EmptyState` (`ui/empty-state.tsx`). |
| Dated records in a scheduled lane and a past lane | `TimelineLanes` (`ui/timeline-lanes`). |

A card inside a record section. `app.css` has a global rule, `[data-embed] .card`, that sets `border: 0`,
`box-shadow: none`, `background: none`, `padding-inline: 0` and `position: static`. A second rule makes a `panel`
inside `[data-embed]` static. They reach markup that writes the global `card` and `panel` classes by hand, inside
an element with `data-embed`: the contract section of the people card does this. They do not reach the `Card`
component, whose classes come from its own stylesheet: see [Card](card.md). The wrapper changes nothing on a
`Card`.

## Anatomy

### RecordSection

| Part | Element | Holds |
|---|---|---|
| Root | `<section id tabindex="-1">` | `id` is the caller's. `aria-labelledby` points at the title. It can take focus from a script and is not a tab stop. |
| Head | `<div>` | The number, the title, the note, a spacer and the tools, in a row that wraps. |
| Number | `<span aria-hidden="true">` | `no`, when it is given. |
| Title | `<h2 id="{id}-h">` | `title`. The level is always 2; no prop changes it. |
| Note | `<span>` | `meta`, when it is truthy. |
| Spacer | An empty `<span>` | Pushes the tools to the end of the row. |
| Tools | None of its own | `tools`, as passed. |
| Body | `<div>` | `children`. It carries `data-two` when `two` is set. |

### SubHead

A `<div>` holding a `<span>` with `children`, then `tools` as passed. The hairline between them is drawn by the
stylesheet. The text is not in a heading element.

### SectionLine

A `<div>` holding `children`.

### Gate

A `<div>` holding `icon` as passed, then a `<div>` with `children`. It has no role and no text of its own.

### Tag

A `<span>` with `data-k` set to `kind`, holding `children`.

### Kbd

A `<kbd aria-hidden="true">` holding `k`. It is always hidden from assistive technology.

A second component named `Kbd` exists in `apps/web/src/ui/kbd`. It takes `keys` where this one takes `k`. Both
render a hidden `<kbd>`, with different sizes: that one is at least 24 px wide, 20 px high, and puts 4 px before
itself.

Neither file says when to use which. Both are in use, inside buttons and in lines of key hints. What the two
stylesheets show:

- The one in `ui/kbd` is made to follow a label inside a button. It brings its own 4 px of space, and it has a
  rule for a primary button, where it loses its fill and takes the button's text colour. Inside a button, use
  that one.
- This one has no margin and no rule inside a button. The roster puts it inside links styled as primary buttons,
  where it keeps its `--kbd-bg` fill and its `--steel` text.
- Outside a button nothing in the code decides. `SecNav` and the palette use this one.

### Masked

A `<span>` holding `children`. `record-section.tsx` re-exports it, so it can be imported from either module.

### FieldRow

| Part | Element | Holds |
|---|---|---|
| Root | `<div>` | `id`, `data-edit` when `edit` is set, `data-wide` when `wide` is set. |
| Label | `<span>` | The register number, then `label`. |
| Register number | `<span title>` | `no`, when it is given. Its `title` is the message `uiRecord.registerItem`. |
| Value | `<span>` | `children`, then the sub line. |
| Sub line | `<span>` | `sub`, when it is truthy. |
| Action | `<span>` | `mark`. The element is always rendered, and is empty when there is no mark. |

The label and the value are sibling `<span>` elements. Nothing ties one to the other.

### FieldMark

`kind` picks one of two shapes.

With `kind="lock"` it is a `<span>`: a 12 px lock icon marked `aria-hidden`, then `text`, or the message
`uiRecord.mark.lock` when `text` is not given. It is not a control. `field`, `name`, `onPress` and `ref` are not
used.

With any other kind it is:

| Part | Element | Holds |
|---|---|---|
| Wrapper | `<span>` | The class line, then the button. |
| Class line | `<span id>` | The way the edit is recorded: the message `uiRecord.mark.{kind}`. Shown for `cor`, `corTwo`, `first` and `verb`, and only when `text` is not given. |
| Button | `<button type="button">`, the `Button` of React Aria Components | A 12 px pencil icon, then the verb, then a 12 px chevron for `verb`. Both icons are `aria-hidden`. `ref` goes to this element. |

The verb is `text`, or the message `uiRecord.edit` when `text` is not given. So every button kind reads the same
word, and the class line says how the edit is recorded.

`MarkKind` is `"rc" | "cor" | "corTwo" | "first" | "inline" | "verb" | "lock"`:

| Kind | Meaning | Class line | `data-k` on the button |
|---|---|---|---|
| `rc` | The fact can be changed or corrected. | None | `rc` |
| `cor` | The fact can only be corrected. | `uiRecord.mark.cor` | `cor` |
| `corTwo` | The fact can only be corrected, and a second person confirms. | `uiRecord.mark.corTwo` | `cor` |
| `first` | The fact has no value yet. | `uiRecord.mark.first` | `first` |
| `inline` | The fact is edited in its row. | None | `inline` |
| `verb` | The fact changes through a personnel action. | `uiRecord.mark.verb` | `verb` |
| `lock` | The fact is not edited here. | The lock line itself | Not a button |

### RecordRows

| Part | Element | Holds |
|---|---|---|
| Table | `<table aria-label>` | `label` names it. |
| Head | `<thead>` with one `<th scope="col">` for each column | Each column's `header`. The head is left out when no column has a truthy `header`. |
| Row | `<tr>` | One for each entry of `rows`, keyed by `rowId`. It carries `data-void` when `isVoid` returns true for it. |
| Cell | `<td>` | What the column's `cell` returns. It carries `data-end` for an `end` column. |
| Container | `<div>` around the table | Only with `mobileLayout`. |

A column, `RowColumn<R>`, has:

| Member | Required | Type | Holds |
|---|---|---|---|
| `cell` | yes | `(r: R) => ReactNode` | The cell of a row. |
| `header` | no | `ReactNode` | The column's head cell. |
| `end` | no | `boolean` | The column of row tools: fitted to its content and aligned to the end. |
| `card` | no | `"title" \| "status" \| "fact" \| "action" \| "omit"` | The cell's part in the card layout. Used only with `mobileLayout`. |

There are no row headers: every body cell is a `<td>`. With no rows the component still renders the table, with an
empty body. Callers leave it out when a list is empty.

With `mobileLayout="cards"` (every experience) or `mobileLayout="console-cards"` (non-`baseline` experiences) each cell also carries `data-card`, set to the column's `card`, and `data-label`, set
to the column's `header` when that is a string. A column with no `card` gets no `data-card`. `Table` works a part
out for such a column and writes a `role` on every cell; `RecordRows` does neither.

### Strip

A `<div>` holding `children`.

### StripItem

The shared `Button` with `variant="ghost"`: a `<button type="button">` holding a `<span>` with `label`, then a
`<span>` with `children`. A press calls `onPress`.

### SecNav

| Part | Element | Holds |
|---|---|---|
| Root | `<nav aria-label>` | Named by the message `uiRecord.sections`. |
| Link | `<a href="#{id}">`, one for each item | A `Kbd`, the item's `title`, then the count. It carries `aria-current="true"` when the item's `id` equals `current`. |
| Count | `<span>` | The item's `count`, when it is given. |

The links are direct children of the `<nav>`; there is no list element. A click calls `onJump` with the item's
`id` and cancels the link's own navigation, so the address does not change.

The key cap shows the item's `no`: the number of the section, which is the digit the screen binds to it. It is not
taken from the `id` or from the link's position in `items`, so a link keeps its number when an item before it is
left out.

`current` is whatever the caller passes. `SecNav` does not watch the scroll position.

### Spine

| Part | Element | Holds |
|---|---|---|
| Root | `<aside aria-label>` | `title` names it. |
| Head | `<div>` | The title, then `tools` as passed. |
| Title | `<h2>` | `title`. The level is always 2. |
| Body | `<div>` | Everything below. |
| Now box | `<div>` | A `<div>` with `nowKey`, then `now`. |
| Next | None of its own | `next`, as passed. |
| Empty | None of its own | `empty`, as passed. Rendered only when `items` is empty. |
| List | `<ol>` | One `<li>` for each item, in the order given. The `<ol>` is rendered even when there are no items. |
| Item | `<li data-t>` | A dot, a `<span aria-hidden="true">`, then a `<div>` holding the item's `when`, `what` and `meta`, each in a `<div>`. `data-t` is the item's `tone`. |
| Foot | `<div>` | `foot`, when it is truthy. |

An item, `SpineItem`, has:

| Member | Required | Type | Holds |
|---|---|---|---|
| `key` | yes | `string` | The React key. |
| `tone` | yes | `"plan" \| "fix" \| "rev" \| "new" \| "end"` | Planned, a correction, a change, a first entry, an end. It colours the dot. |
| `when` | yes | `ReactNode` | The date line. |
| `what` | yes | `ReactNode` | What happened. |
| `meta` | no | `ReactNode` | A line under it. |

### RowInput

`TextInput` from [Field](field.md) with one extra class: an `<input>`. It takes every attribute of an input but
`className`. It has no label: the caller names it, as the people card does with `aria-label`.

### Saving

A `<span>` holding `children`, then an empty `<span role="img">` named by `label`.

### EditRow

A `<div>` holding `children`. It takes every attribute of a `<div>` but `className`, and a `ref`.

## Looks and sizes

No component has a size prop. The props that change a look are `two` on `RecordSection`, `wide` and `edit` on
`FieldRow`, `kind` on `FieldMark` and `Tag`, `tone` on an item of `Spine`, and `mobileLayout` on `RecordRows`.

Sections:

| Part | Look |
|---|---|
| `RecordSection` | `--surface` fill, a 1 px `--border` border, a 10 px radius (`--radius-lg`), `--shadow`. |
| Its head | 8 px gaps (`--space-2`). Padding of 10 px top and bottom (`calc(var(--space-2) + 2px)`) and 16 px at the sides (`--space-4`). A 1 px `--border` line under it. |
| Its title | 14 px (`--text-body`), weight 700 (`--fw-strong`). It never wraps. |
| Its number | A box at least 24 px wide (`--space-5`) and 20 px high (`calc(var(--space-5) - var(--space-1))`), with a 4 px radius, a `--muted` fill and 12 px `--steel` text of weight 700. |
| Its note | 12 px (`--text-xs`), `--steel`. |
| Its body | Padding of 2 px on top (`calc(var(--space-1) / 2)`), 16 px at the sides and 12 px at the bottom (`--space-3`). |
| Its body with `two` | Two equal columns, 28 px apart (`calc(var(--space-6) - var(--space-1))`). |
| `SubHead` | 12 px text of weight 600 (`--fw-medium`), `--steel`, with 0.4 px tracking (`--tracking-label`). 12 px above it. A 1 px `--border-soft` line fills the row after the text, and the tools come after the line. |
| `SectionLine` | A wrapping row with 8 px gaps and 8 px of padding top and bottom. 13 px (`--text-sm`), `--steel`. |
| `Gate` | Two columns, the icon and the text, 12 px apart. 12 px of padding, a 1 px dashed `--control-border` border, a 6 px radius (`--radius`), a `--canvas` fill, 13 px text, 8 px above it. |

Fact rows:

| Part | Look |
|---|---|
| `FieldRow` | Three columns: the label at 115.2 px (`calc(var(--space-6) * 3.6)`), the value in the rest (`minmax(0, 1fr)`), the action as wide as its content (`auto`). An 8 px gap. Cells line up at the top. 7 px of padding top and bottom (`calc(var(--space-2) - 1px)`), 13 px text, at least 36 px high (`calc(var(--space-6) + var(--space-1))`). A 1 px `--border-soft` line above each row. The first row of a body has none, and in a `two` body the second has none either. |
| Label | `--steel`. It never wraps. |
| Register number | An 18 px box (`calc(var(--space-4) + 2px)`) with 3 px side padding, a 4 px radius, a `--muted` fill and 12 px `--steel` text of weight 700. |
| Value | It may break anywhere (`overflow-wrap: anywhere`). |
| Sub line | On its own line, 12 px, `--steel`. |
| `wide` | The row spans every column of the body (`grid-column: 1 / -1`). |
| `edit` | A `--primary-soft` fill, and `--selected-bar`: a 3 px `--primary` bar inside the row's left edge. The row is drawn 16 px wider than its place in the body on each side (`margin: 0 calc(var(--space-4) * -1)`), which is the side padding of the body. In a one-column body, and on a `wide` row, the fill reaches both edges of the section. In a `two` body at 1024 px and up it reaches the near edge and runs 16 px into the 28 px gap, and the bar of a right-column row is drawn in the gap. Read from the CSS, not measured in a browser. |
| `FieldMark` button and lock line | At least 24 px high (`--space-5`), 4 px side padding, no border, a 4 px radius, no fill. 12 px text of weight 600, `--steel`. A 2 px gap between icon and text. It never wraps. |
| `FieldMark` class line | 12 px, `--steel`, 4 px before the button. It never wraps. |

What `kind` changes on a `FieldMark`:

| `data-k` | Look |
|---|---|
| `rc`, `first` | `--primary` text. |
| `cor` (kinds `cor` and `corTwo`) | A 1 px dashed `--control-border` border and `--ink` text. |
| `verb` | Underlined text (`text-underline-offset: 2px`). |
| `inline` | No rule of its own: the `--steel` text above. |
| `lock` | The `--steel` text above, with the default cursor. |

`RecordRows`:

| Part | Look |
|---|---|
| Table | Full width, collapsed borders, 13 px text. |
| Cell | 6 px of padding top and bottom (`calc(var(--space-1) + 2px)`), 8 px on the right, none on the left. A 1 px `--border-soft` line above. Aligned to the left and to the top. |
| Head cell | 12 px, `--steel`, weight 600, no line above. It never wraps. |
| `end` cell | `width: 1%`, so it takes only what its content needs. Aligned to the right, no right padding. It never wraps. |
| Void row | Every cell is `--steel` and struck through. |

With `mobileLayout` the table also carries the global `table` class, so the rules for `.table th` and `.table td`
in `app.css` apply to it as well. Cells are at least 40 px high (`--row-h`). Each body cell has a bottom line as
well as the kit's top line. The head cells have a `--border` line under them, a `--surface` fill and 0.4 px
tracking, and stick to the top.

`Strip` and `SecNav`:

| Part | Look |
|---|---|
| `Strip` | A grid of nine columns with literal widths: `0.75fr 0.55fr 0.95fr 0.95fr 1.05fr 1.35fr 1.5fr 0.85fr 0.75fr`. Items fill it in order; a tenth item starts a second row. |
| `StripItem` | 13 px text at a line height of 1.35, aligned to the left. The value wraps. The kit's rule also asks for a column, the label over the value, 2 px apart and aligned to the start; 8 px of padding; a 1 px `--border-soft` line on the left of every item but the first; no radius; regular weight (`--fw-body`). The shared button's class sets the same properties, and the kit's values apply: see the ties below. |
| Its label | 12 px, `--steel`. It never wraps. |
| `SecNav` | A wrapping row with 2 px gaps. |
| Its link | 30 px high (`calc(var(--space-6) - 2px)`), 8 px side padding, a 6 px radius, 13 px `--steel` text, no underline. It never wraps. Weight 600, from the global rule for links. |
| Its count | 12 px. |

`Spine`:

| Part | Look |
|---|---|
| Box | The same surface as a section. It is `position: sticky`, 16 px (`--space-4`) from the top of its scroller. |
| Head | The same padding and line as a section head. The title is 14 px, weight 700, and fills the row. |
| Body | Padding of 12 px on top, 16 px at the sides and 8 px at the bottom. |
| Now box | A 1 px `--primary-bd` border, a `--primary-soft` fill, a 6 px radius, padding of 8 px and 12 px, 13 px text, 12 px under it. Its key line is 12 px `--primary` text of weight 600. |
| Item | A 14 px column for the dot (`calc(var(--space-3) + 2px)`), then the text, 8 px apart. 13 px text, 12 px under each item. A 1 px `--border` line runs down from the dot to the next item, and is left out under the last. |
| Dot | A 12 px circle with a 2 px border and a `--surface` fill. |
| Date line | 12 px, `--steel`, a wrapping row with 6 px gaps. |
| What | A `<b>` inside it has weight 600. |
| Meta line | 12 px, `--steel`. |
| Foot | 12 px, `--steel`, a wrapping row with 4 px gaps, under a 1 px `--border-soft` line. |

The dot by `tone`:

| `tone` | Dot |
|---|---|
| `plan` | A dashed `--info-tx` border. |
| `fix` | A `--warn-solid` border. |
| `rev` | A `--primary` border. |
| `new` | Filled `--ok-solid`. |
| `end` | Filled `--steel`. |

The small parts:

| Part | Look |
|---|---|
| `Tag` | 18 px high (`calc(var(--space-4) + 2px)`), 5 px side padding, a 4 px radius, a 1 px border, 12 px text of weight 600. It never wraps. |
| `Tag` with no `kind` | `--border` border, `--steel` text, `--muted` fill. |
| `Tag` `fix` | `--warn-bd` border, `--warn-tx` text, `--warn-bg` fill. |
| `Tag` `rev` | `--primary-bd` border, `--primary` text, `--primary-soft` fill. |
| `Tag` `plan` | `--info-bd` border, `--info-tx` text, `--info-bg` fill. |
| `Tag` `void` | The colours of a tag with no kind, with a dashed border. |
| `Kbd` | A box at least 18 px wide and 18 px high, with 4 px side padding, a 4 px radius, a 1 px `--border` border that is 2 px at the bottom, a `--kbd-bg` fill and 12 px `--steel` monospace text (`--font-mono`). |
| `Masked` | 13 px monospace text with 0.5 px letter spacing, written as a literal. |
| `RowInput` | The box of a `TextInput`, as wide as its cell up to 330 px (`calc(var(--panel-w) * 0.75)`). 28 px high (`calc(var(--space-6) - var(--space-1))`), not the 40 px of `field__input`: see the ties below. |
| `Saving` | A `--ok-bg` fill behind the value, with 4 px side padding and a 4 px radius. The tick is a 12 px ring, 4 px after the value: a 2 px `--control-border` border with a `--primary` top edge. |
| `EditRow` | A column with 8 px gaps, 8 px above and below, 8 px of padding top and bottom. The same fill and bar as a `FieldRow` with `edit`, drawn 16 px wider than its place on each side. No rule makes it span the columns of a `two` body. Its one call site, the row editor of the people card, is rendered in one-column bodies, where the fill reaches both edges of the section. |

Three sets of rules in this stylesheet meet a global rule of the same weight. In each, the kit's rule wins
because it comes later: the entry module imports `app.css` statically and reaches the kit only through lazy
imports, so the kit's stylesheet loads after `app.css`. This was read from the stylesheets and the imports, not
measured in a browser.

- `StripItem`: its class and the `btn` class of the shared button both set the display, the alignment, the gap,
  the padding, the border, the radius, the minimum height and the weight, and the `btn--ghost` class sets the
  border colour. The kit's values apply: the item is a column with 8 px of padding and no minimum height, not a
  centred row with 12 px side padding and a 36 px minimum height.
- `RowInput`: its class sets a height of 28 px, and `field__input` sets 40 px (`--field-h`). The input is 28 px
  high.
- `RecordRows` with `mobileLayout`: the kit's rule and the global `.table th` and `.table td` rules both set the
  cell padding. It is the kit's: 6 px top and bottom with 8 px on the right and none on the left, not 12 px at
  the sides and none above or below. In the card layout a heavier rule sets it to 8 px: see the phone section.
  The exception is the right padding of an `end` cell, which ties with that rule: see the known gaps.

## States

| State | What exists |
|---|---|
| Rest | The looks above. |
| Hover | A `FieldMark` button and a `SecNav` link take a `--muted` fill. The current link does not change: its rule has the same weight as the hover rule and comes later. A `StripItem` takes a `--muted` fill from the hover rule of the shared button. The lock line of `FieldMark` does not change. Rows, sections and items of the spine have no hover look. |
| Focus | The stylesheet has no focus rule. A `FieldMark` button, a `StripItem`, a `SecNav` link and a `RowInput` show the global rule: a 2 px `--primary` outline, 2 px away. A `RecordSection` takes focus only from a script; whether the outline shows around it then is the browser's decision for `:focus-visible`. |
| Pressed | No look. React Aria sets `data-pressed` on a `FieldMark` button; no rule reads it. |
| Current | The `SecNav` link whose `id` equals `current` has `aria-current="true"`, a `--primary-soft` fill and `--primary` text. Its rule also sets weight 600, which every link already has. |
| Being edited | A `FieldRow` with `edit`, and an `EditRow`: the tint and the bar under Looks and sizes, which also says how far the tint reaches in a `two` body. No ARIA attribute is set. |
| Selected | Does not exist. `RecordRows` has no selection. |
| Disabled | Does not exist. No component of the kit has a disabled prop. `RowInput` passes `disabled` to the input, which has no disabled look: see [Field](field.md). |
| Read-only | `FieldMark` with `kind="lock"` is the mark of a fact that is not edited here: text and a lock icon, not a button. A `FieldRow` with no mark says nothing. |
| Invalid | Does not exist in the kit. The stylesheet has no rule for `aria-invalid`, so a `RowInput` outside a `Field` looks the same when it is given `aria-invalid`. Inside the control of a `Field` it takes a `--danger-solid` border from the rule of `ui/field`. The one call site is outside a `Field`. |
| Loading | `Saving` is the only one: the value on a `--ok-bg` fill with the tick after it. The tick does not move: the stylesheet has no animation. No component has a loading state for a read. |
| Void | A `RecordRows` row for which `isVoid` returns true: `--steel`, struck through. |
| Empty | `Spine` shows `empty` when `items` is empty. `RecordRows` has no empty text. `SectionLine` is the part a caller uses to say that a section holds nothing. |

## Keyboard

The kit handles no key. A search of the folder for a key handler, `isComposing`, key code 229 and composition
events finds none.

| Part | Key | What it does |
|---|---|---|
| `FieldMark` button | Tab, Shift+Tab | Moves focus to and from it. |
| | Enter, Space | Presses it: `onPress` runs. |
| `StripItem` | Tab, Shift+Tab | Each item is a tab stop. |
| | Enter, Space | Presses it: `onPress` runs. Native. |
| `SecNav` link | Tab, Shift+Tab | Each link is a tab stop. |
| | Enter | Follows the link, which calls `onJump`. Native. Space does nothing on a link. |
| `RowInput` | Enter | The rule of `TextInput`: the form is never submitted, then the caller's `onKeyDown` runs. |
| | Enter while the Korean input method is composing | Left to the input method: `TextInput` does not call the caller's `onKeyDown`. See [Field](field.md#keyboard). |
| `RecordSection` | | Not a tab stop. A script can focus it. |

The lock line, `Tag`, `Kbd`, `Masked`, `Saving`, `FieldRow`, `RecordRows` and `Spine` take no focus of their own.
Controls a caller puts inside them keep their own keys.

`Kbd` shows a key and binds nothing. The digit beside a `SecNav` link is not handled by `SecNav`: the screen binds
it, and passes the same digit as the item's `no`. The people card binds 1 to 8, J, K and H through `useKeys`
(`lib/react/use-keys.ts`). That hook ignores a key the input method is composing, leaves a key typed in a field to
the field, and matches letters and digits by the physical key, so a Korean input mode does not change which key
matches. The card binds none of these keys while its print view is open: that view replaces the card and is not a
dialog, so the hook's own wait for an open dialog does not cover it.

The people card numbers its sections 1 to 8 and gives each the id `s` and its number. One function,
`cardSections` (`features/people/domain/keys.ts`), lists the numbers of the sections shown; the links and the digit
keys both read it. A section that is not shown has no link, the links after it keep their numbers, and its digit
does nothing. On a record that shows the employment section alone, 2 is the one digit that acts.

A button takes no text, so no input method composes on a `FieldMark` button or a `StripItem`. React Aria's press
handling, in the installed version (`react-aria-components` 1.22.1), has no composition check of its own.

## Accessibility contract

| Component | Role | Accessible name | Also exposed |
|---|---|---|---|
| `RecordSection` | `region`: a `<section>` with a name | `title`, through `aria-labelledby`, which points at the `<h2>`. The number is hidden. | A level 2 heading. |
| `SubHead`, `SectionLine`, `Gate`, `Tag`, `Masked` | None | None | Their text. |
| `Kbd` | Hidden | | Nothing. |
| `FieldRow` | None | None | Its text, in the order label, value, sub line, mark. |
| `FieldMark` button | `button` | `name`, or the message `uiRecord.markOf` filled with `field` and the verb. | The class line is its description, through `aria-describedby`, when it is shown. |
| `FieldMark` lock line | None | None | Its text. |
| `RecordRows` | `table` | `label`, through `aria-label`. | Column headers. No row headers. |
| `Strip` | None | None | |
| `StripItem` | `button` | Its content: the label, then the value. | |
| `SecNav` | `navigation` | The message `uiRecord.sections`. | Links. The current one has `aria-current="true"`. A link's name is its title, then the count as a bare number. |
| `Spine` | `complementary` | `title`, through `aria-label`. | A level 2 heading with the same text, and an ordered list. |
| `RowInput` | `textbox` | The caller's. | |
| `Saving` | The tick is an `img` | `label`. | |
| `EditRow` | None, unless the caller passes one | The caller's. | |

Announced: nothing. No component of the kit is a live region or calls `announce`. The tick of `Saving` is named
but not announced when it appears.

Known gaps:

- `FieldRow` does not tie a label to its value. Both are `<span>` elements, and no role or attribute relates them.
- The meaning of a register number is in a `title` attribute only. A `title` shows on pointer hover; the `<span>`
  takes no focus, so a keyboard or a touch user does not get it.
- `SubHead` looks like a heading and is a `<div>` with a `<span>`.
- `RecordSection` and `Spine` always write an `<h2>`, whatever the heading level around them.
- `Kbd` is always hidden. Text that leans on the key cap loses it: a line made of a key cap and a word is read as
  the word alone.
- The `tone` of a spine item is the colour and the border of a hidden dot. The item's text must say what the item
  is.
- A void row is exposed as a look only: `data-void` is not an ARIA attribute. The caller adds the word, as the
  people card does with a `Tag`.
- `Spine` renders an empty `<ol>` when it has no items.
- `Saving` is called a spinner in the code and does not move. Its appearance and its end are not announced.
- In a `two` body, the rule that removes the top line of the second row is not limited to the two-column layout.
  Below 1024 px, where the body is one column, there is no line between the first row and the second.
- With `mobileLayout`, in the card layout, the `end` cell keeps `width: 1%` and its right alignment from the kit's
  rule. Its `white-space: nowrap` and its right padding meet the card rule's values with the same weight. This is
  read from the CSS, not measured.
- In a `two` body at 1024 px and up, the tint of a row being edited does not reach the far edge of the section. It
  stops 16 px into the 28 px gap, and the bar of a right-column row is drawn in the gap. The personal section of
  the people card is a `two` body whose rows are edited in place. Read from the CSS.
- The kit has no rule that scrolls or clips a `RecordRows` table wider than its section.
- Two components are named `Kbd`, with different looks, and nothing says which to use where.
- `StripItem`, `RowInput` and the cells of a `RecordRows` with `mobileLayout` take the kit's values by load order
  alone, not by a heavier rule: see Looks and sizes. None of the three values has been measured.

The WCAG 2.2 criteria that apply:

| Criterion | How the kit answers it |
|---|---|
| 1.3.1 Info and Relationships | Sections, headings, the table and its column headers, the navigation and the ordered list are real elements. The gaps about `FieldRow`, `SubHead`, the fixed heading level and the void row are against this criterion. |
| 1.4.1 Use of Color | A void row is struck through as well as greyed. The `void` tag has a dashed border. The other tag kinds, and the tones of the spine, differ by colour, so their text must carry the meaning. The current link also has `aria-current`. |
| 1.4.3 Contrast (Minimum) | Computed from the token values, every pair of a text colour and a fill that the stylesheet sets together is at least 4.87:1, in both themes. The lowest is `--primary` on `--muted` in the dark theme: an `rc` mark under the pointer. |
| 1.4.10 Reflow | Below 1024 px a `two` body is one column and the strip is three columns. A value breaks anywhere. A label never wraps and its column keeps its width. A `RecordRows` table without `mobileLayout` does not reflow. |
| 1.4.11 Non-text Contrast | The dashed border of a `cor` mark and of a `Gate` is `--control-border`. Computed from the token values, it is 3.65:1 on `--surface` and 3.31:1 on `--canvas` in the light theme, and 3.61:1 and 3.93:1 in the dark. The dots of the spine are at least 3.77:1 on `--surface`. |
| 2.1.1 Keyboard | Every control is a native button, link or input. |
| 2.1.4 Character Key Shortcuts | The kit binds no key. The screen that binds single keys answers this criterion. |
| 2.4.1 Bypass Blocks, 2.4.6 Headings and Labels | Each section is a named region with a heading, and the section links are a named navigation. |
| 2.4.3 Focus Order | A section can take focus, so a jump can move focus to it. The caller moves it. |
| 2.4.7 Focus Visible | The global outline. The kit has no focus rule. |
| 2.4.11 Focus Not Obscured (Minimum) | A section has `scroll-margin-top: var(--record-sticky, var(--space-4))`. A screen that holds a head in view sets `--record-sticky` to clear it, and a section scrolled to stops below the head. The people card does. |
| 2.5.3 Label in Name | The name of a `FieldMark` button is built from the visible verb and the field. With `name`, keeping the verb in it is the caller's job. |
| 2.5.8 Target Size (Minimum) | A `FieldMark` button is at least 24 px high. A `SecNav` link is 30 px high. A `StripItem` holds two lines of text and is taller than 24 px. |
| 4.1.2 Name, Role, Value | The table above. |
| 4.1.3 Status Messages | Not answered. Nothing in the kit is announced. |

What the gallery shows: `ui/record` has no gallery file. Two entries of other components reach the kit, found by
following the imports of every `*.gallery.tsx`. `features/statutory/ui/filing-table.gallery.tsx` renders a
`RecordRows` with `mobileLayout="cards"`. `features/structure/ui/structure-copy.gallery.tsx` imports the key map,
which uses `Kbd`. No gallery entry shows a section, a fact row, a mark, the strip, the section links, the spine, a
tag, or the inline parts.

Tests: the folder has none. `scripts/ds-runtime.test.ts` loads the stylesheet in a browser and checks that a
section's `scroll-margin-top` follows an inherited `--record-sticky`. `e2e/states/filings-list.spec.ts` checks at
390 px that the filing table is in its card layout and that a translated label fits its cell, and runs axe. Tests
of the people card reach the rest through the screen: `e2e/mock/layout-stability.spec.ts`, for one, looks for a
field mark by its accessible name. They were not all read for this page.

No workflow runs the accessibility scan of the gallery, and the kit is mostly absent from the gallery in any case.
The command for the scan is in [the guide](../README.md#add-or-change-a-component).

## Phone behaviour at 390 px

The stylesheet has two media queries, both `(max-width: 1023px)`, written as a literal width. They are not the
shared breakpoints of `ui/breakpoints.ts`. Both are queries on the screen, not on the container.

| Part | At 390 px |
|---|---|
| `RecordSection` with `two` | One column. The first and the second row have no line between them: see the known gaps. |
| `Strip` | Three equal columns. The rule that removes the left line names only the first item, so the items that start the second and the third row keep theirs. No rule draws a line between one row of items and the next. |
| `FieldRow` | No rule. The label column stays 115.2 px and a label does not wrap. The action column is as wide as its mark, which does not wrap either, so a mark with a class line takes its whole width from the value. The value breaks anywhere in what is left. |
| `SecNav` | No rule. The links wrap onto more rows. |
| `Spine` | No rule. It is still `position: sticky`; what that does in a one-column page depends on the caller's layout. |
| `RecordRows` | No rule. The table keeps its columns, and head cells and the `end` cell do not wrap. The worker register and the filing table of the statutory views put the table in a scroller of their own (`overflow-x: auto`). The leave section and the records section of the people card do not: the table is a direct child of the section body. |
| `RecordRows` with `mobileLayout="cards"` or `"console-cards"` | Card layout, when the container is 480 px wide or less (`"console-cards"` applies outside `baseline`). See below. |
| `RowInput` | As wide as its cell, up to 330 px. |

The card layout comes from `ui/long-table/table-cards.module.css`, which the kit composes. It is a container query,
`(max-width: 480px)` on the `<div>` around the table. Inside it:

- the head is hidden visually and stays in the document;
- each row is a bordered box of two columns, with 12 px under it;
- a cell is a column with 8 px of padding and no border, and its text may break anywhere;
- a `title`, `status` or `action` cell spans both columns, and a `title` is weight 600;
- a `fact` cell shows its `data-label` above its content, in 12 px `--steel`;
- an `omit` cell is not displayed;
- a cell with no `data-card` takes one column and shows no label.

Target sizes do not change with the width. The stylesheet does not read `--target-touch`: a mark is at least
24 px high and a section link 30 px, at every width.

## Copy rules

The kit's built-in text is in the `uiRecord.` ids of `packages/i18n`. The `en` catalog is the source and the `ko`
catalog defines every id.

| Message id | Used for |
|---|---|
| `uiRecord.sections` | The name of the `SecNav` navigation. |
| `uiRecord.registerItem` | The `title` of a register number. It takes the number. |
| `uiRecord.edit` | The verb on every `FieldMark` button. |
| `uiRecord.markOf` | The accessible name of a `FieldMark` button. It takes the field and the verb. |
| `uiRecord.mark.cor`, `uiRecord.mark.corTwo`, `uiRecord.mark.first`, `uiRecord.mark.verb` | The class line beside the button. |
| `uiRecord.mark.lock` | The lock line. |
| `uiRecord.mark.rc`, `uiRecord.mark.inline` | `FieldMark` shows neither. The legend of the people card shows them, by passing each as `text`. |

- Everything else is the caller's, from the same catalog: titles, labels, values, sub lines, tag words, the header
  and the cells of a table, the items of the spine, the `label` of `Saving`.
- `field` on `FieldMark` is the label of the row, as plain text. It goes into the button's name, so two rows never
  share one.
- `text` replaces the verb and removes the class line. `name` replaces the whole accessible name. Use them
  together for a mark with a verb of its own.
- `k` on `Kbd` is the key as it is printed on the keyboard. Callers pass it as a literal, not as a message.
- A tag says its state in a word. Its colour is not enough.
- A void row needs the word for void from the caller.
- `Masked` shows the text it is given. The caller passes the masked form, never the value.
- `label` on `RecordRows` and `title` on `Spine` name a table and a landmark. `title` is also visible.

## Props

<!-- ds:props apps/web/src/ui/record/record-section.tsx -->

### Gate

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `children` | yes | `ReactNode` |  |  |
| `icon` | yes | `ReactNode` |  |  |

### Kbd

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `k` | yes | `string` |  |  |

### Masked

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `children` | yes | `ReactNode` |  |  |

### RecordSection

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `children` | yes | `ReactNode` |  |  |
| `id` | yes | `string` |  |  |
| `title` | yes | `string` |  |  |
| `meta` | no | `ReactNode` |  |  |
| `no` | no | `number` |  |  |
| `tools` | no | `ReactNode` |  |  |
| `two` | no | `boolean` |  |  |

### SectionLine

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `children` | yes | `ReactNode` |  |  |

### SubHead

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `children` | yes | `ReactNode` |  |  |
| `tools` | no | `ReactNode` |  |  |

### Tag

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `children` | yes | `ReactNode` |  |  |
| `kind` | no | `"fix" \| "plan" \| "rev" \| "void"` |  |  |

<!-- /ds:props -->

<!-- ds:props apps/web/src/ui/record/field-row.tsx -->

### FieldMark

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `field` | yes | `string` |  |  |
| `kind` | yes | `MarkKind` |  |  |
| `name` | no | `string` |  |  |
| `onPress` | no | `() => void` |  |  |
| `ref` | no | `Ref<HTMLButtonElement>` |  |  |
| `text` | no | `string` |  |  |

### FieldRow

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `children` | yes | `ReactNode` |  |  |
| `label` | yes | `ReactNode` |  |  |
| `edit` | no | `boolean` |  |  |
| `id` | no | `string` |  |  |
| `mark` | no | `ReactNode` |  |  |
| `no` | no | `string` |  |  |
| `sub` | no | `ReactNode` |  |  |
| `wide` | no | `boolean` |  |  |

<!-- /ds:props -->

`MarkKind` is under Anatomy.

<!-- ds:props apps/web/src/ui/record/rows.tsx -->

### RecordRows

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `columns` | yes | `RowColumn<R>[]` |  |  |
| `label` | yes | `string` |  |  |
| `rowId` | yes | `(r: R) => string` |  |  |
| `rows` | yes | `R[]` |  |  |
| `isVoid` | no | `(r: R) => boolean` |  |  |
| `mobileLayout` | no | `"cards" \| "console-cards"` |  |  |

<!-- /ds:props -->

`R` is the type of a row. The members of `RowColumn` are under Anatomy.

<!-- ds:props apps/web/src/ui/record/strip.tsx -->

### Strip

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `children` | yes | `ReactNode` |  |  |

### StripItem

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `children` | yes | `ReactNode` |  |  |
| `label` | yes | `ReactNode` |  |  |
| `onPress` | yes | `() => void` |  |  |

<!-- /ds:props -->

<!-- ds:props apps/web/src/ui/record/sec-nav.tsx -->

### SecNav

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `current` | yes | `string` |  |  |
| `items` | yes | `{ id: string; no: number; title: string; count?: number \| undefined; }[]` |  |  |
| `onJump` | yes | `(id: string) => void` |  |  |

<!-- /ds:props -->

<!-- ds:props apps/web/src/ui/record/spine.tsx -->

### Spine

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `items` | yes | `SpineItem[]` |  |  |
| `now` | yes | `ReactNode` |  |  |
| `nowKey` | yes | `ReactNode` |  |  |
| `title` | yes | `string` |  |  |
| `empty` | no | `ReactNode` |  |  |
| `foot` | no | `ReactNode` |  |  |
| `next` | no | `ReactNode` |  |  |
| `tools` | no | `ReactNode` |  |  |

<!-- /ds:props -->

The members of `SpineItem` are under Anatomy.

<!-- ds:props apps/web/src/ui/record/inline.tsx -->

### EditRow

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `ref` | no | `Ref<HTMLDivElement>` |  |  |

Also accepts the attributes of `HTMLAttributes` (`@types/react`), except `className`.

### RowInput

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `ref` | no | `Ref<HTMLInputElement>` |  |  |

Also accepts the attributes of `InputHTMLAttributes` (`@types/react`), except `className`.

### Saving

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `children` | yes | `ReactNode` |  |  |
| `label` | yes | `string` |  |  |

<!-- /ds:props -->

<!-- ds:props apps/web/src/ui/record/masked.tsx -->

### Masked

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `children` | yes | `ReactNode` |  |  |

<!-- /ds:props -->

`Masked` has two tables on this page, because `record-section.tsx` re-exports it from `masked.tsx`.

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/record/record.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `background`, `border`, `border-block-end`, `border-bottom` |
| `--border-soft` | `background`, `border-left`, `border-top` |
| `--canvas` | `background` |
| `--control-border` | `border` |
| `--font-mono` | `font-family` |
| `--fw-body` | `font-weight` |
| `--fw-medium` | `font-weight` |
| `--fw-strong` | `font-weight` |
| `--info-bd` | `border-color` |
| `--info-bg` | `background` |
| `--info-tx` | `border-color`, `color` |
| `--ink` | `color` |
| `--kbd-bg` | `background` |
| `--muted` | `background` |
| `--ok-bg` | `background` |
| `--ok-solid` | `background`, `border-color` |
| `--panel-w` | `max-width` |
| `--primary` | `border-color`, `border-top-color`, `color` |
| `--primary-bd` | `border`, `border-color` |
| `--primary-soft` | `background` |
| `--radius` | `border-radius` |
| `--radius-lg` | `border-radius` |
| `--radius-sm` | `border-radius` |
| `--record-sticky` | `scroll-margin-top` |
| `--selected-bar` | `box-shadow` |
| `--shadow` | `box-shadow` |
| `--space-1` | `column-gap`, `gap`, `height`, `margin-left`, `margin-top`, `min-height`, `padding`, `padding-top` |
| `--space-2` | `gap`, `margin`, `margin-top`, `padding`, `padding-top` |
| `--space-3` | `gap`, `grid-template-columns`, `height`, `margin`, `margin-top`, `padding`, `padding-bottom`, `padding-left`, `padding-right`, `width` |
| `--space-4` | `height`, `margin`, `min-width`, `padding`, `padding-left`, `padding-right`, `scroll-margin-top`, `top` |
| `--space-5` | `height`, `min-height`, `min-width` |
| `--space-6` | `column-gap`, `grid-template-columns`, `height`, `min-height` |
| `--steel` | `background`, `border-color`, `color` |
| `--surface` | `background` |
| `--text-body` | `font-size` |
| `--text-sm` | `font-size` |
| `--text-xs` | `font-size` |
| `--tracking-label` | `letter-spacing` |
| `--warn-bd` | `border-color` |
| `--warn-bg` | `background` |
| `--warn-solid` | `border-color` |
| `--warn-tx` | `color` |

<!-- /ds:tokens -->

`--record-sticky` is not a token of `packages/tokens`. It is a custom property that the screen sets, registered in
this stylesheet with `@property` so that it inherits. Without it a section's scroll margin is `--space-4`.

The table does not list what the kit takes from other stylesheets: the `btn` rules behind a `StripItem`,
`field__input` behind a `RowInput`, the global `table` rules and the card rules of `ui/long-table` behind a
`RecordRows` with `mobileLayout`, and the global focus outline, which reads `--primary`.
