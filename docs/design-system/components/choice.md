<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Choice

The choice family picks from a fixed list: one option shown as a segmented control, radio cards, pills, a select
or grouped rows, and a list of statements to tick.

The family lives in `apps/web/src/ui/choice`: `ChoiceField` and `ChoiceAdd` in `choice-field.tsx`, `ChipChoice` in
`chip-choice.tsx`, `Checks` in `checks.tsx` and `GroupedChoice` in `grouped-choice.tsx`.

## When to use it, and when not

| Component | Use it for |
|---|---|
| `ChoiceField` | One choice from a fixed list of up to 15 options in a form. It picks the control from the options. |
| `ChoiceAdd` | The dashed pill that ends a `ChoiceField` chips row and adds an option that is not listed. |
| `ChipChoice` | One pick from a short list as pills, where the group needs no hint and no error text: a reason, a purpose, a print mode. |
| `Checks` | Statements a person confirms one by one. With `required={false}`, a free pick of several items. |
| `GroupedChoice` | One pick from rows under group headings: a workplace under its company. |

Nothing is preselected in any of them: `value` starts `null`, or empty for `Checks`. `Checks` has no "tick all".

| Do not use it for | Use instead |
|---|---|
| More than 15 options, or a list the server searches | `ServerPicker` (`ui/server-picker`). `ChoiceField` throws above 15 options, or above 24 with `look="chips"`. |
| One choice in a row with no room for radio cards | `SelectField` (`ui/select`). |
| A reason code with a memo | `ReasonField` (`ui/reason`). |
| A code from an official code list | `CodePicker` (`ui/code-picker`). |
| Switching the view or the mode of something, outside a form | `Segmented` or `ToggleButton`: see [Button](button.md). They have no required marker and no error. |
| One statement to tick | `Check`: see [Button](button.md). |
| A status word that does nothing when pressed | [`Chip`](chip.md). |

## Anatomy

`ChoiceField` draws one of four controls. The options decide which:

| Options | `look` | Control |
|---|---|---|
| Up to 5, none with a `description` or a `disabled` reason | not set | Segmented control |
| Up to 5, any with a `description` or a `disabled` reason | not set | Radio cards |
| Up to 24, none with a `description` | `chips` | Pills |
| 6 to 15 | not set | Native select |
| More than 15, or more than 24 with `look="chips"` | | None: the component throws an error. |

`look="chips"` is ignored when any option has a `description`: up to 5 options become radio cards and 6 to 24
become a select.

The segmented control, the cards and the pills share one structure, built on the `RadioGroup` of React Aria
Components:

| Part | Element | Holds |
|---|---|---|
| Group | `<div role="radiogroup">` | Everything below. |
| Label | `<span>` | `label`, then the marker, then `note`. |
| Marker | `<span data-marker>` inside the label | The word for required or optional. |
| Row | `<div>` | The options, then `add`. `data-columns` carries `columns`. |
| Option | `<label>` | A visually hidden `<input type="radio">`, then the parts below. |
| Dot | `<span aria-hidden>` | Cards only. The radio mark. |
| Tick | `<svg aria-hidden>` | Pills only. A check, hidden until the pill is chosen. Its space is always kept, so choosing a pill moves nothing. |
| Option label | `<span>` | The option's `content`, or its `label`. |
| Description | `<span>` | The option's `description`. |
| Reason | `<span>` | The option's `disabled` text: why it cannot be chosen now. |
| Hint | `<span>` | `hint`. |
| Error | `<span>` | `error`. Rendered only when `error` is set. |
| Footer | the caller's | `footer`, last in the group. |

`add` and `footer` are rendered inside the group element.

The select is a different structure: a [`Field`](field.md) around a native `<select class="field__input">`. Its
first option is an empty, disabled placeholder. An option with a `disabled` reason is a disabled `<option>` whose
text is the label, a middle dot and the reason. The select takes `label`, `required`, `options`, `value`,
`onChange`, `error` and `hint`. It does not render `note`, `footer`, `add`, `columns`, or an option's
`description` or `content`. When a list grows past 5 options and the control becomes a select, those are dropped
without a warning.

The other components:

| Component | Element | Parts |
|---|---|---|
| `ChoiceAdd` | `<button type="button">` | A plus icon, hidden from assistive technology, then `label`. |
| `ChipChoice` | `<div role="radiogroup">` | A label `<span>` with `label` and, when `required`, the marker. Then a row `<div>` with one `<label>` per option: a hidden radio input and the option's `label`. |
| `Checks` | `<div role="group">` | A label `<span>` with `label` and, when `required`, the marker. Then one `<label>` per item: a hidden `<input type="checkbox">`, a box `<span aria-hidden>` that holds a check icon when ticked, and a `<span>` with the item's `label`. Then the error `<span>`, when `error` is set. |
| `GroupedChoice` | `<div role="radiogroup">` | A label `<span>` with `label`, the marker and `hint`. Then a bordered `<div>` with one `<div>` per group: a heading row (`<div>` with the title in `<b>`, then `meta`) and one `<label>` per option: a hidden radio input, a dot, the option's `label` and its `meta`. |

`id` on `ChipChoice` and `GroupedChoice` goes to the group element, so a caller can find the group and move focus
into it. `ChoiceField` and `Checks` take no `id`.

## Looks and sizes

Every radio group and the checkbox group share three things: the group label is 13 px medium (`--text-sm`,
`--fw-medium`), the marker is 12 px regular `--steel`, and the gap between label, options and messages is 8 px
(`--space-2`).

`ChoiceField`:

| Control | Look |
|---|---|
| Segmented control | One box with a 1 px `--control-border` border, a 6 px radius and a `--surface` fill, as wide as its segments. Each segment is at least 32 px high (`--target`), with 16 px side padding, medium weight and a 1 px line between segments. Text inherits the body size, 14 px. Segments wrap inside the box when the row is too narrow. |
| Radio cards | A grid with an 8 px gap. Each card has 12 px padding, a 1 px `--border` border, a 6 px radius and a `--surface` fill. The dot is 16 px with a 2 px `--control-border` border. The label is medium; the description is 12 px `--steel`; the reason is 12 px `--warn-tx`. `columns={2}` or `columns={3}` makes the grid that many equal columns; without it the cards stack. |
| Pills | A wrapping row with an 8 px gap. Each pill is at least 32 px high, with 12 px side padding, a 1 px `--control-border` border, a 16 px radius (`calc(var(--target) / 2)`) and 13 px text on one line. |
| `ChoiceAdd` | A pill with a dashed border and `--steel` text. |
| Select | The control box of [`Field`](field.md): 40 px high (`--row-h`). |
| `note` | 12 px regular `--steel`, beside the label. |
| Hint | 12 px `--steel`. |
| Error | 13 px `--danger-tx`. |

`columns` has no effect on a segmented control or on pills: no rule reads `data-columns` there.

The others:

| Component | Look |
|---|---|
| `ChipChoice` | A wrapping row of chips with an 8 px gap. Each chip is at least 32 px high, with 12 px side padding, a 1 px `--control-border` border, a 6 px radius (`--radius`) and medium weight. Text inherits the body size, 14 px, and can wrap. It takes these rules from the stylesheet of `ui/reason`, not from this folder. |
| `Checks` | A box with 12 px padding, a 1 px `--border` border, a 6 px radius and a `--surface` fill. Each item is at least 32 px high with 13 px text. The tick box is 16 px with a 2 px `--control-border` border and a 4 px radius. |
| `GroupedChoice` | A list in a 1 px `--border` box with a 6 px radius. A heading row has a `--muted` fill, 8 px by 12 px padding and 13 px text. An option row is at least 32 px high, with 13 px text and 28 px of left padding (`calc(var(--space-3) + var(--space-4))`). The dot is 16 px with a 1 px `--control-border` border. `hint` and `meta` are 12 px `--steel`. |

No prop picks a size. `look="chips"` and `columns` on `ChoiceField` are the only props that change a look.

## States

| State | What changes |
|---|---|
| Rest | The looks under Looks and sizes. Nothing is chosen until the person chooses. |
| Hover | A segment, a pill, a `ChipChoice` chip and a `GroupedChoice` row take a `--muted` fill. A card's border turns `--control-border`. A `Checks` item, `ChoiceAdd` and the select have no hover look. A disabled option does not react. |
| Keyboard focus | A segment: a 2 px `--primary` outline, 3 px inside its edge. A card, a pill and a `ChipChoice` chip: the `--focus` ring, 2 px of `--surface` then 2 px of `--primary`. A `GroupedChoice` row: a 2 px `--primary` outline, 2 px inside its edge. A `Checks` item: the `--focus` ring around the tick box. `ChoiceAdd` and the select: the global rule, a 2 px `--primary` outline 2 px away. |
| Pressed down | No look. No rule reads `data-pressed`. |
| Selected | A segment: `--primary-soft` fill, `--primary` text and a 1 px `--primary` outline inside its edge. A card: `--primary` border, `--primary-soft` fill, the same outline, and the dot filled by a 5 px `--primary` border. A pill: `--primary` border and text, `--primary-soft` fill, medium weight, the same outline, and the tick shown. A `ChipChoice` chip: `--primary` border and text, `--primary-soft` fill and the same outline. A `GroupedChoice` row: `--primary-soft` fill, `--primary` text, medium weight and the filled dot. A ticked `Checks` box: `--primary` fill and border with an `--on-primary` check. |
| Disabled option, `ChoiceField` | The option stays listed and its reason is shown. As a card: `--muted` fill, a not-allowed cursor, a `--steel` label and the reason in `--warn-tx`. As a pill: no disabled rule exists; the pill looks like the others, with the reason after its label. In the select: a disabled `<option>` with the reason in its text. A disabled option never appears in a segmented control: a `disabled` reason turns the control into cards. |
| Disabled option, `ChipChoice` | No look and no reason. The stylesheet it reads has no disabled rule, so a disabled chip looks like an enabled one and keeps the pointer cursor. It cannot be chosen and is skipped by the keyboard. |
| Disabled, `Checks` | `isDisabled` disables every box: each item is at 60% opacity with a default cursor. One item cannot be disabled alone. |
| Disabled, whole group | Does not exist for `ChoiceField`, `ChipChoice` or `GroupedChoice`. `GroupedChoice` has no disabled option either. |
| Read-only | Does not exist. |
| Invalid | `ChoiceField` with `error`: the error line appears; the segmented box and each unchosen card take a `--danger-solid` border; the select takes it through `Field`. Pills do not change: no invalid rule covers them, so only the error line shows. `ChipChoice` with `invalid`: each unchosen chip takes a `--danger-solid` border, and there is no text. `Checks` with `error`: each unticked box takes a `--danger-solid` border and the error line appears. `GroupedChoice` has no invalid state. |
| Required | The marker says so. `ChoiceField` always shows a marker, for required or optional. `ChipChoice` and `Checks` show one only when required. `GroupedChoice` is always required. |
| Loading | Does not exist. No component has a loading prop, a busy state or loading text. |
| Empty | With no options and no `add`, the segmented row and the pills row keep the height of one row of options (`min-height: var(--target)`), so the form does not move when a list arrives late. The empty segmented box has a transparent border. Nothing says that the list is empty or still loading. `ChipChoice`, `Checks` and `GroupedChoice` have no empty rule. |

## Keyboard

| Key | Where | What it does |
|---|---|---|
| Tab, Shift+Tab | A radio group: `ChoiceField`, `ChipChoice`, `GroupedChoice` | The group is one tab stop. Focus lands on the chosen option. With nothing chosen, it lands on the first option going forward and the last going backward. |
| Right, Down | A radio group | Moves to the next option and chooses it. It skips disabled options and wraps from the last to the first. |
| Left, Up | A radio group | The same, backward. |
| Space | A radio group | Chooses the focused option. Native. |
| Tab, Shift+Tab | `Checks` | Each box is its own tab stop. |
| Space | `Checks` | Ticks or clears the focused box. Native. |
| Arrow keys, typing | The select of `ChoiceField` | The native select behaviour. |
| Tab | `ChoiceAdd` | It is its own tab stop, after the options. |
| Enter, Space | `ChoiceAdd` | Presses it. Native. |
| Arrow keys | `ChoiceAdd` | The pill sits inside the group element, so the group's arrow-key handler receives the key: focus moves to an option and that option is chosen. |

In `GroupedChoice` the arrow keys run through every row as one list. A group heading is not a stop.

The family handles no key itself and takes no text. Its files have no `isComposing` check, no key code 229 check
and no composition handler, so it has no rule of its own for a key the Korean input method owns. The arrow-key
handler comes from React Aria, and it ignores a key pressed while an input method is composing.

## Accessibility contract

| Component | Role | Accessible name | Also exposed |
|---|---|---|---|
| `ChoiceField`, as a radio group | `radiogroup` | The label `<span>`, through `aria-labelledby`. The marker and `note` are inside it, so they are part of the name. | `aria-required` when required. `aria-invalid` when `error` is set. `aria-orientation`: vertical for cards, horizontal otherwise. The hint and the error as its description. |
| An option of it | `radio` | Everything inside its `<label>`: the label or `content`, the description and the disabled reason. | Checked or not. Disabled, natively. The group's hint, and its error when invalid, as its description. |
| `ChoiceField`, as a select | The native select's own, `combobox`. | The label, through `<label for>`, with the marker. | What [`Field`](field.md) ties to a control: the hint and error as its description, `aria-invalid`, `required`. |
| `ChoiceAdd` | `button` | `label`. | Nothing. |
| `ChipChoice` | `radiogroup` | The label `<span>`, with the marker when required. | `aria-required` when required. `aria-invalid` when `invalid` is true. `aria-orientation="horizontal"`. No description. |
| `Checks` | `group` | The label `<span>`, with the marker when required. | Each box is a `checkbox` named by the item's `label`. An item's `description` is the id of an element on the page, not text: it becomes the box's `aria-describedby`. The error is added to each box's description when `error` is set. |
| `GroupedChoice` | `radiogroup` | The label `<span>`. The marker and `hint` are inside it, so they are part of the name. | `aria-required`, always. |
| A row of it | `radio` | The option's `name`, through `aria-label`, when given. Otherwise the row's text: its label and `meta`. | Checked or not. |

What is announced:

- Nothing is announced when an error appears. The error lines are not live regions. An error is read as the
  description of the group, and of each option, when focus is there.
- The family adds no live region. A choice is the checked state of a native radio or checkbox input.

Known gaps:

- A heading in `GroupedChoice` is a plain `<div>`. It is not a group and not a heading, so nothing ties a row to
  the heading above it. A caller that needs the heading in a row's name puts it in the option's `name`.
- `ChipChoice` shows invalid as a border colour and `aria-invalid` only. It has no slot for an error message.
- A disabled pill in `ChoiceField` and a disabled chip in `ChipChoice` have no disabled look.
- `Checks` passes `required` to the library's checkbox group, which reads it as "at least one box". That every
  statement is ticked is the caller's check, shown through `error`.
- `GroupedChoice` cannot show an error and cannot be optional.

The WCAG 2.2 criteria that apply:

| Criterion | How the family answers it |
|---|---|
| 1.3.1 Info and Relationships | Each group is a `radiogroup` or a `group` named by its label, with native radio and checkbox inputs. The headings of `GroupedChoice` are not exposed: see the gaps. |
| 1.4.1 Use of Color | Chosen is the checked state, and each look adds a cue that is not a colour: an inner outline on a segment, a card and a chip, a filled dot on a card and a row, a tick and medium weight on a pill, a check in a box. Invalid is an error line in text, except in `ChipChoice`, where it is a border colour only. Required is a word. |
| 1.4.3 Contrast (Minimum), 1.4.11 Non-text Contrast | Every colour is a token; none is written in the family. The edges of the segmented box, pills, chips, dots and tick boxes are `--control-border`. A card's own edge is `--border`; its dot carries the control edge. A disabled `Checks` item is drawn at 60% opacity. |
| 2.1.1 Keyboard | Native radio, checkbox, select and button elements. |
| 2.4.7 Focus Visible | The focus looks under States. |
| 2.5.8 Target Size (Minimum) | Segments, pills, chips, rows and check items are at least 32 px high. A card is taller: 12 px of padding around its text. |
| 3.3.1 Error Identification | `ChoiceField` and `Checks` show the error as text under the options, tied to the group as its description. `ChipChoice` and `GroupedChoice` show no error text. |
| 3.3.2 Labels or Instructions | Every group has a visible label. The marker says required or optional where it is shown. |
| 4.1.2 Name, Role, Value | The table above. |
| 4.1.3 Status Messages | Not answered: an error that appears is not announced. `Form` covers a failed submit: see [Button](button.md#accessibility-contract). |

What the gallery shows of this family:

| Shown | Where |
|---|---|
| `ChoiceField` as a segmented control, as radio cards with a `footer`, and as a select with an error | `apps/web/src/ui/choice/choice.gallery.tsx` |
| `Checks` untouched, with an error, and disabled | `apps/web/src/ui/choice/checks.gallery.tsx` |
| `ChoiceField` as pills with a `note` and a `ChoiceAdd`, and as cards in two columns with a disabled option | `apps/web/src/gallery/sections/structure.gallery.tsx` |

No gallery file renders `ChipChoice` or `GroupedChoice`.

The folder has one test, `choice.browser.test.tsx`: choosing a pill shows its tick and moves no pill. Nothing in
the folder tests `ChipChoice`, `Checks`, `GroupedChoice`, the select, or the option limits.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component).

## Phone behaviour at 390 px

Nothing in the family's own rules changes with the width of the screen. The four stylesheets it reads have no
media query and no container query.

- Every target is as tall at 390 px as at 1440 px: at least 32 px. Nothing grows to the 44 px touch size; the
  family does not read `--target-touch`. The select is 40 px.
- The segmented control wraps its segments inside its box. Pills and chips wrap onto more rows.
- A pill keeps its text on one line and has no maximum width, so a label wider than the row overflows it. A
  `ChipChoice` chip has no such rule, so its text can wrap.
- Cards with `columns` keep two or three columns at every width. The columns share the width equally and can
  become narrower than their text (`minmax(0, 1fr)`). No rule stacks them on a narrow screen.
- A `Checks` statement wraps beside its box. A `GroupedChoice` row keeps its `meta` at the end of the row.

How many columns a form has at 390 px is decided by the layout around these components.

## Copy rules

- Labels, option labels, descriptions, hints, errors and disabled reasons are the caller's text. They come from
  the message catalog in `packages/i18n`. The `en` catalog is the source and the `ko` catalog must define every
  id.
- An option's `disabled` value is the reason itself, shown to the person. An option that cannot be chosen is
  listed with its reason, never hidden. `ChipChoice` is the exception: its `disabled` is a boolean with no reason.
- The family uses one message id of its own: `uiChoice.placeholder`, the empty first option of the select. It
  carries the field's label. The other `uiChoice.` ids in the catalog are used by other components.
- The marker words are `uiField.required` and `uiField.optional`, owned by [`Field`](field.md).
- In the select, the middle dot between an option's label and its reason is written in the component, not in the
  catalog.
- `note` is a short remark beside the label. `footer` is the way out when the list lacks what the person needs,
  such as asking an administrator to add an option.
- A `GroupedChoice` option's `name` is its whole accessible name. The caller writes it from catalog text.
- The gallery's sample labels are in the gallery catalog, which production builds leave out.

## Props

<!-- ds:props apps/web/src/ui/choice/choice-field.tsx -->

### ChoiceAdd

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `label` | yes | `string` |  |  |
| `onPress` | yes | `() => void` |  |  |
| `id` | no | `string` |  |  |

### ChoiceField

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `label` | yes | `string` |  |  |
| `onChange` | yes | `(value: string) => void` |  |  |
| `options` | yes | `readonly ChoiceOption[]` |  |  |
| `required` | yes | `boolean` |  |  |
| `value` | yes | `string \| null` |  |  |
| `add` | no | `ReactNode` |  |  |
| `columns` | no | `2 \| 3` |  |  |
| `error` | no | `ReactNode` |  |  |
| `footer` | no | `ReactNode` |  |  |
| `hint` | no | `ReactNode` |  |  |
| `look` | no | `"chips"` |  |  |
| `note` | no | `ReactNode` |  |  |

<!-- /ds:props -->

`ChoiceOption` is `{ value, label, description?, content?, disabled? }`. `label` is plain text; `content` replaces
it on screen in a segment, a card or a pill. `disabled` is the reason the option cannot be chosen now.

<!-- ds:props apps/web/src/ui/choice/chip-choice.tsx -->

### ChipChoice

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `label` | yes | `string` |  |  |
| `onChange` | yes | `(v: string) => void` |  |  |
| `options` | yes | `readonly { value: string; label: string; disabled?: boolean \| undefined; }[]` |  |  |
| `value` | yes | `string \| null` |  |  |
| `id` | no | `string` |  |  |
| `invalid` | no | `boolean` |  |  |
| `required` | no | `boolean` | `true` |  |

<!-- /ds:props -->

<!-- ds:props apps/web/src/ui/choice/checks.tsx -->

### Checks

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `items` | yes | `readonly { id: string; label: ReactNode; description?: string \| undefined; }[]` |  |  |
| `label` | yes | `string` |  |  |
| `onChange` | yes | `(value: string[]) => void` |  |  |
| `value` | yes | `readonly string[]` |  |  |
| `error` | no | `ReactNode` |  |  |
| `isDisabled` | no | `boolean` |  |  |
| `required` | no | `boolean` | `true` | False for a free pick (no marker, none needed). |

<!-- /ds:props -->

<!-- ds:props apps/web/src/ui/choice/grouped-choice.tsx -->

### GroupedChoice

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `groups` | yes | `readonly ChoiceGroup[]` |  |  |
| `label` | yes | `string` |  |  |
| `onChange` | yes | `(v: string) => void` |  |  |
| `value` | yes | `string \| null` |  |  |
| `hint` | no | `ReactNode` |  |  |
| `id` | no | `string` |  |  |

<!-- /ds:props -->

`ChoiceGroup` is `{ id, title, meta?, options }`, and each of its options is `{ value, label, meta?, name? }`.

## Tokens it reads

`ChoiceField` and `ChoiceAdd`:

<!-- ds:tokens apps/web/src/ui/choice/choice.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border` |
| `--control-border` | `border`, `border-color`, `border-left` |
| `--danger-solid` | `border-color` |
| `--danger-tx` | `color` |
| `--focus` | `box-shadow` |
| `--fw-body` | `font-weight` |
| `--fw-medium` | `font-weight` |
| `--ink` | `color` |
| `--muted` | `background` |
| `--primary` | `border`, `border-color`, `color`, `outline` |
| `--primary-soft` | `background` |
| `--radius` | `border-radius` |
| `--radius-lg` | `border-radius` |
| `--space-1` | `gap`, `margin-top` |
| `--space-2` | `gap` |
| `--space-3` | `gap`, `padding` |
| `--space-4` | `height`, `padding`, `width` |
| `--steel` | `color` |
| `--surface` | `background` |
| `--target` | `border-radius`, `min-height` |
| `--text-sm` | `font-size` |
| `--text-xs` | `font-size` |
| `--warn-tx` | `color` |

<!-- /ds:tokens -->

`Checks`:

<!-- ds:tokens apps/web/src/ui/choice/checks.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border` |
| `--control-border` | `border` |
| `--danger-solid` | `border-color` |
| `--danger-tx` | `color` |
| `--focus` | `box-shadow` |
| `--fw-medium` | `font-weight` |
| `--on-primary` | `color` |
| `--primary` | `background`, `border-color` |
| `--radius` | `border-radius` |
| `--radius-sm` | `border-radius` |
| `--space-1` | `gap`, `margin-top` |
| `--space-2` | `gap` |
| `--space-3` | `padding` |
| `--space-4` | `height`, `width` |
| `--surface` | `background` |
| `--target` | `min-height` |
| `--text-sm` | `font-size` |

<!-- /ds:tokens -->

`GroupedChoice`:

<!-- ds:tokens apps/web/src/ui/choice/grouped-choice.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border` |
| `--control-border` | `border` |
| `--fw-body` | `font-weight` |
| `--fw-medium` | `font-weight` |
| `--muted` | `background` |
| `--primary` | `border`, `color`, `outline` |
| `--primary-soft` | `background` |
| `--radius` | `border-radius` |
| `--radius-lg` | `border-radius` |
| `--space-1` | `gap` |
| `--space-2` | `gap`, `padding` |
| `--space-3` | `padding` |
| `--space-4` | `height`, `padding`, `width` |
| `--steel` | `color` |
| `--surface` | `background` |
| `--target` | `min-height` |
| `--text-sm` | `font-size` |
| `--text-xs` | `font-size` |

<!-- /ds:tokens -->

`ChipChoice` reads the stylesheet of `ui/reason`, which `ReasonField` shares. The table lists the whole file.
`ChipChoice` uses its `group`, `label`, `chips` and `chip` rules. The `reason` and `error` rules are not its own:
they account for `--danger-tx` and for the `gap` that reads `--space-3`.

<!-- ds:tokens apps/web/src/ui/reason/reason.module.css -->

| Token | Read by |
| --- | --- |
| `--control-border` | `border` |
| `--danger-solid` | `border-color` |
| `--danger-tx` | `color` |
| `--focus` | `box-shadow` |
| `--fw-medium` | `font-weight` |
| `--ink` | `color` |
| `--muted` | `background` |
| `--primary` | `border-color`, `color`, `outline` |
| `--primary-soft` | `background` |
| `--radius` | `border-radius` |
| `--space-1` | `gap` |
| `--space-2` | `gap` |
| `--space-3` | `gap`, `padding` |
| `--surface` | `background` |
| `--target` | `min-height` |
| `--text-sm` | `font-size` |

<!-- /ds:tokens -->

The select of `ChoiceField` is the control box of `Field`: see the `field__input` table in
[Field](field.md#tokens-it-reads). The focus outline of `ChoiceAdd` and of the select is a global rule and is not
listed: it reads `--primary`.
