<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# KeyValue

`KeyValue` is a list of facts as label and value pairs, with at most one action on each fact. `StatRow`, in the
same module, is a row of counts.

Both live in `apps/web/src/ui/key-value/key-value.tsx`, which also exports the type `KeyValueItem`.

## When to use it, and when not

| Component | Use it for |
|---|---|
| `KeyValue` | Facts about one thing, read top to bottom. The labels share a fixed column, so the values line up down a card or a panel. A fact can carry one verb at the end of its row: fix, correct, change. |
| `StatRow` | A few counts side by side, each one a count the view acts on. It is not for a number that is only there to look good. |

| Do not use it for | Use instead |
|---|---|
| A form to fill in | `Field`: see [Field](field.md). `KeyValue` has no marker, hint or error for a control. |
| Many records with the same columns | `Table` (`ui/table.tsx`). |
| A short list of rows, each with a mark and a value at its end | `ItemList` (`ui/item-list`). |
| A fact of a personnel record, with its register number, its sub line and its mark | `FieldRow` (`ui/record`). |
| A value the server computed, with what it was computed from | `DerivedValue`: see [Field](field.md). |
| Progress toward a total | `Meter` (`ui/meter`). |
| The count on a filter | `Count` (`ui/count`). |
| The loading shape of a view | `Skeleton` (`ui/skeleton`). The list's own `loading` draws one bar. |
| A hand-written `kv`, `stats` or `stat` class | `KeyValue` or `StatRow`. See the next paragraph. |

`app.css` has global `kv`, `stats`, `stat`, `stat__label` and `stat__value` classes for hand-written markup. They
lay things out differently: the global `kv` sizes its label column to the widest label, and the global `stats` is
a wrapping row with no border. `KeyValue` and `StatRow` do not use them: every class they write comes from
`key-value.module.css`, apart from the global `sr-only` on one hidden element. Views still write the global
classes by hand. The design-system check counts each hand-written use, and the count may only go down.

## Anatomy

`KeyValue` renders:

| Part | Element | Holds |
|---|---|---|
| Root | `<dl>` | `aria-label` from `label`, `data-acts` when a fact has an action, `data-density`, `data-readonly`, and `aria-busy` while loading. |
| Row | `<div>`, one for each item | The cells below. It has `display: contents`, so its cells sit in the root's grid. It carries `data-readonly` when the list or the item is read-only. |
| Label | `<dt>` | The item's `label`. |
| Value | `<dd>` | The item's `value`. |
| Action | `<dd>` | The item's `action`. |
| State block | `<div>` holding a visually hidden `<dt>` with `label`, and one `<dd>` | The loading bar, the error or the empty text. It replaces every row. |

The action column exists when any item has an `action` other than `null` or `undefined`. A `false` left by a
`condition && …` expression counts, and opens the column. When the column exists, every row gets an action cell.
The cell is an empty `<dd>` for a row with no action and for a read-only row.

An item, `KeyValueItem`, has:

| Member | Required | Type | Holds |
|---|---|---|---|
| `key` | yes | `string` | The React key. Unique within the list. |
| `label` | yes | `ReactNode` | The label. |
| `value` | yes | `ReactNode` | The value. |
| `action` | no | `ReactNode` | The one verb on this fact. |
| `readOnly` | no | `boolean` | Leaves the action out for this fact. |

`StatRow` renders:

| Part | Element | Holds |
|---|---|---|
| Root | `<dl>` | `aria-label` from `label`. |
| Stat | `<div>`, one for each item | The label over the value. |
| Label | `<dt>` | The item's `label`. |
| Value | `<dd>` | The item's `value`. |

An item of `StatRow` has `key`, `label` and `value`.

Neither component takes `className` or passes another attribute through.

## Looks and sizes

`KeyValue` is a grid:

| Part | Look |
|---|---|
| Label column | `calc(var(--panel-w) / 4)` wide, 110 px. Fixed. |
| Value column | The rest of the width (`minmax(0, 1fr)`). |
| Action column | As wide as its widest action (`auto`). Each action sits at the end of its cell. |
| Gaps | 8 px between rows (`--space-2`), 12 px between columns (`--space-3`). Cells line up on the text baseline. |
| Text | 13 px (`--text-sm`). |
| Label | `--steel`. |
| Value | The colour it inherits. It may break anywhere (`overflow-wrap: anywhere`). |

`density` changes the text and the gaps:

| `density` | What changes |
|---|---|
| `dense` | 12 px text (`--text-xs`). 4 px between rows (`--space-1`), 8 px between columns (`--space-2`). |
| `default`, or not set | Nothing. `default` writes `data-density="default"`, which no rule reads. |

`StatRow` has one look and no size or density prop:

| Part | Look |
|---|---|
| Row | One line of equal columns, one for each item. A 1 px `--border` border and a 6 px radius (`--radius`). |
| Stat | 8 px padding top and bottom (`--space-2`), 12 px at the sides (`--space-3`). The label and the value are 4 px apart (`--space-1`). A 1 px `--border-soft` line on the left of every stat but the first. |
| Label | 12 px (`--text-xs`), `--steel`. |
| Value | 16 px (`--text-lg`), `--fw-strong`, tabular numbers. It may break anywhere. |

## States

`KeyValue`:

| State | What changes |
|---|---|
| Rest | The look above. |
| Hover | The value of the row under the pointer takes `--ink`. That is the colour a value already inherits from `body`, so the hover changes nothing unless something around the list sets another text colour. The rule also names a `data-hovered` attribute, which the component never writes. |
| Focus | No part of the list is focusable by itself. While focus is anywhere inside a row, that row's action cell gets the `--focus` ring as a box shadow: a 2 px `--surface` ring, then a 2 px `--primary` ring. The rule is `:focus-within`. It applies to focus from the pointer as well as the keyboard, and to focus on a control in the value, and it draws the ring on the action cell, not on the control that has focus. A list with no action column has no focus rule. The focused control also takes the global focus outline when the browser shows it. |
| Pressed | Does not exist. |
| Selected | Does not exist. |
| Disabled | Does not exist. |
| Read-only (`readOnly` on the list or on an item) | The action is not rendered. The list and the row carry `data-readonly`, which no rule reads, so there is no look. The action column stays when any item has an action. No ARIA attribute is set. |
| Invalid | Does not exist for a fact. A list that failed to load has the error state. |
| Loading (`loading`) | The root gets `aria-busy="true"`. The state block replaces the rows: its `<dd>` has `role="status"` and holds one bar, 32 px high (`--space-6`), `--border-soft`, with a 4 px radius (`--radius-sm`), inside 12 px padding. The bar does not move, and the block holds no visible text. |
| Error (`error`) | The state block replaces the rows: its `<dd>` has `role="alert"` and `data-state="error"`, and shows `error` at 13 px in `--danger-solid`, inside 12 px padding. |
| Empty | With no items and `empty` given, the state block shows `empty` at 13 px in `--steel`, centred, inside 12 px padding. With no items and no `empty`, the list is an empty `<dl>`. There is no built-in empty text. |

`error` wins over `loading`, and `loading` wins over `empty`. `error` and `loading` hide the items even when there
are some. `empty` shows only when there are none.

The state block is laid out in the label column, not across the list. Its wrapper `<div>` has no class and no
rule, so it is a single item of the grid and takes the first column, 110 px wide. Its `<dd>` also keeps the
browser's default start margin for a `<dd>`, 40 px in the HTML standard's style sheet: the loading, error and
empty rules do not reset it, and no global rule does.

`StatRow` has no states: no hover, no focus, no loading, no error and no empty text. With no items it is an empty
bordered `<dl>`.

## Keyboard

None. `KeyValue` and `StatRow` handle no key.

Tab moves through the controls the caller put in values and actions, in document order: a row's value before its
action, then the next row.

Neither component takes text, so there is no rule for a key the Korean input method owns. The module has no
`keydown` handler, no `isComposing` check, no key code 229 check and no composition event.

## Accessibility contract

| Component | Elements | Accessible name |
|---|---|---|
| `KeyValue` | A `<dl>` with no `role` attribute. Each label is a `<dt>` and each value a `<dd>`, grouped in a `<div>`. | `label`, through `aria-label` on the `<dl>`. Optional. Nothing else names the list. |
| `StatRow` | The same. | The same. |

- **Two definitions in a row:** when the action column exists, a row has two `<dd>`: the value, then the action.
  The action cell of a row with no action is an empty `<dd>`.
- **The action's name:** the caller's. A list where every row has the same verb gives every button the same name
  unless the caller adds the fact to it. The gallery does, with an `aria-label` made of the fact's label and the
  verb.
- **A label for a control:** `label` is a node, so it can hold a `<label for>` when the value is a control.
  `KeyValue` adds nothing to tie them: the caller sets the `id` and the `for`.
- **Read-only:** not exposed. The action is simply absent.
- **Loading:** the root is `aria-busy`. The `<dd>` has `role="status"` and holds no text, so there are no words
  to announce. The hidden `<dt>` beside it holds `label`, and is empty when `label` is not given.
- **Error:** the `<dd>` has `role="alert"`, and the error text is its content.
- **Announced:** nothing else. A value or a count that changes is not announced: neither component has a live
  region for it.

Known gap: the loading and the error state put `role="status"` and `role="alert"` on a `<dd>`. ARIA in HTML
allows no role on a `<dd>`. In the axe-core version this repository installs, the `definition-list` rule, a
WCAG 1.3.1 rule that the gallery scan runs, accepts only `definition`, `term` and `listitem` as an explicit role
on a child of a `<dl>`, so by its source it reports a list in either state. The gallery shows the loading state.

Known gap: the error text is `--danger-solid`, where `Field` uses `--danger-tx` for its error. Neither component
has a fill, so the pair depends on the surface behind the list. Computed from the token values, in the light
theme `--danger-solid` is 4.83:1 on `--surface`, 4.38:1 on `--canvas` and 4.19:1 on `--muted`. The text is 13 px
and needs 4.5:1, so it passes on `--surface` only. In the dark theme it is at least 5.45:1 on all three.

The WCAG 2.2 criteria that apply:

| Criterion | How the components answer it |
|---|---|
| 1.3.1 Info and Relationships | `<dl>`, `<dt>` and `<dd>`. The first gap above is against this criterion. |
| 1.4.1 Use of Color | The error is text in a colour, with no icon, so its words must say that something failed. Read-only has no look at all. |
| 1.4.3 Contrast (Minimum) | Labels are `--steel` at 13 px, or 12 px when dense and in `StatRow`. The second gap above is against this criterion. |
| 1.4.10 Reflow | A value breaks anywhere. The label column keeps its width. `StatRow` goes to two columns on a narrow screen: see the phone section. |
| 2.1.1 Keyboard | Neither component has anything of its own to operate. |
| 2.4.7 Focus Visible | The global focus outline on the caller's control, and the ring on the row's action cell. |
| 4.1.2 Name, Role, Value | The table above. |
| 4.1.3 Status Messages | The error has the `alert` role. The loading block has the `status` role and no text. A changed value is not announced. |

The gallery entry is `apps/web/src/ui/key-value/key-value.gallery.tsx`. It shows a list of three facts, two with
an action and one without, a loading list, and a `StatRow` of four counts. It does not show `empty`, `error`,
`readOnly` or `density`.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component).

## Phone behaviour at 390 px

`KeyValue` does not change with the width of the screen. It has no media query and no container query.

- The label column stays 110 px at every width. The value takes what is left and breaks anywhere.
- A label has no wrapping rule of its own. It inherits `word-break: keep-all` from `body`, so it breaks between
  words only, and one word wider than the column overflows it.
- The action column fits its content at every width.

`StatRow` has one media query, `(max-width: 767px)`:

- The stats go two to a row instead of all on one line.
- The left stat of each row has no dividing line. There is no line between one row and the next.
- With an odd number of stats, the last one is alone in the left column.

The query is written as a literal width. It is not the shared phone breakpoint that `app.css` uses, which is
`width < 768px`; the two differ only between 767 px and 768 px. It is a query on the screen, not on the
container: a `StatRow` in a narrow column of a wide screen stays on one line.

Neither component has a target of its own. The size of an action is that control's: the module does not read
`--target-touch`.

## Copy rules

- Neither component holds text of its own or owns a message id. There is no built-in loading, empty or error
  text.
- Labels, values, `label`, `empty`, `error` and the labels of actions come from the message catalog in
  `packages/i18n`, through the caller. The `en` catalog is the source and the `ko` catalog must define every id.
- A value is never blank. A fact with no value shows the caller's dash and its reason.
- A fact has at most one action. Name the action with the fact, so that two rows do not carry the same name.
- `label` is a plain string that names the list.
- `error` says what failed, in words. Its look is a colour and nothing else.
- Format a number before passing it. Both components print a value as given.
- A stat is a count the view acts on. Its label says what is counted.

## Props

<!-- ds:props apps/web/src/ui/key-value/key-value.tsx -->

### KeyValue

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `items` | yes | `readonly KeyValueItem[]` |  |  |
| `density` | no | `"default" \| "dense"` |  |  |
| `empty` | no | `ReactNode` |  |  |
| `error` | no | `ReactNode` |  |  |
| `label` | no | `string` |  |  |
| `loading` | no | `boolean` |  |  |
| `readOnly` | no | `boolean` |  |  |

### StatRow

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `items` | yes | `readonly { key: string; label: ReactNode; value: ReactNode; }[]` |  |  |
| `label` | no | `string` |  |  |

<!-- /ds:props -->

The members of `KeyValueItem` are under Anatomy.

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/key-value/key-value.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border` |
| `--border-soft` | `background`, `border-left` |
| `--danger-solid` | `color` |
| `--focus` | `box-shadow` |
| `--fw-strong` | `font-weight` |
| `--ink` | `color` |
| `--panel-w` | `grid-template-columns` |
| `--radius` | `border-radius` |
| `--radius-sm` | `border-radius` |
| `--space-1` | `gap` |
| `--space-2` | `gap`, `padding` |
| `--space-3` | `gap`, `padding` |
| `--space-6` | `height` |
| `--steel` | `color` |
| `--text-lg` | `font-size` |
| `--text-sm` | `font-size` |
| `--text-xs` | `font-size` |

<!-- /ds:tokens -->

The global `kv` and `stats` rules in `app.css` are not listed, because the components do not use them. The global
`sr-only` class on the hidden `<dt>` reads no token. The focus outline is a global rule and is not listed: it
reads `--primary`.
