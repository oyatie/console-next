<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Field

A field is one labelled form control: `Field` ties a visible label, a required-or-optional marker, a hint, an
error and a warning to whatever native control the caller renders inside it.

The family lives in `apps/web/src/ui/field`: `Field`, `FieldSet`, `Marker` and `TextInput` in `field.tsx`,
`TextArea` in `text-area.tsx`, `SelectInput` in `select-input.tsx` and `DerivedValue` in `derived-value.tsx`.

## When to use it, and when not

| Component | Use it for |
|---|---|
| `Field` | The label, hint and messages around one control. |
| `TextInput` | One line of free text inside a `Field`. |
| `TextArea` | Several lines of free text inside a `Field`. |
| `SelectInput` | A native select inside a `Field`. |
| `FieldSet` | Related fields that are disabled together, with an optional legend. |
| `Marker` | The required-or-optional word on a label that is built outside `Field`. |
| `DerivedValue` | A value the server computed, shown with what it was computed from. |

| Do not use it for | Use instead |
|---|---|
| A date | `DateField` (`ui/date`). |
| A number typed through a mask, such as a registration or phone number | `MaskedField` (`ui/masked-field`). |
| One choice from a fixed list | `ChoiceField` (`ui/choice`), which picks its control by the number of options, or `SelectField` (`ui/select`) in a row with no room for radio cards. |
| A box that finds things in the current view | `SearchField` (`ui/search`). It is built on `TextInput`. |
| A statement to tick | `Check`: see [Button](button.md). For several, `Checks` (`ui/choice`). |
| A raw `<input>`, `<select>` or `<textarea>` in a view | `TextInput`, `SelectInput` or `TextArea`. Views do not render raw controls. |

## Anatomy

`Field` renders, top to bottom:

| Part | Element | Holds |
|---|---|---|
| Label | `<label for>` | `label`, then the marker, then `tag`. |
| Marker | `<span data-marker>` inside the label | The word for required or optional. Left out when `required` is `null`. |
| Control row | `<div>` | The control, then `unit`. |
| Hint | `<p data-hint="field">` | `hint`, then `example`. A middle dot separates them. |
| Error | `<p>` | `error`. |
| Warning | `<p>` | `warning`. |

The hint, error and warning lines are rendered only when they have something to show.

The control is a render prop. `children` is called with the attributes that tie the control to the rest, and the
caller spreads them on the control:

| Attribute | Value |
|---|---|
| `id` | The `id` prop, or a generated one. The label points at it. |
| `aria-describedby` | The ids of the hint, error and warning lines that are present, in that order. |
| `aria-invalid` | `true` when `error` is set. Otherwise absent. |
| `required` | `true` only when the `required` prop is `true`. |

The other components:

| Component | Element | Parts |
|---|---|---|
| `TextInput` | `<input class="field__input">` | None. Every other attribute goes to the input. |
| `TextArea` | `<textarea class="field__input field__area">` | None. Every other attribute goes to the textarea. |
| `SelectInput` | `<select class="field__input">` | `children`: the options. |
| `FieldSet` | `<fieldset>` | A `<legend>` with `label` and the marker, when `label` is given, then `children`. `required={null}` leaves the marker out of the legend, for a group whose fields carry their own. Every other attribute goes to the fieldset. |
| `Marker` | `<span data-marker>` | The word for required or optional. |
| `DerivedValue` | `<div role="group">` | A label row with the label, a tag and an Edit button; the value; one line of explanation; a Revert button. |

In `DerivedValue` the tag says the value was computed, or that it was overridden. The Edit button appears when
`onOverride` is given and nothing is overridden. The explanation line shows `override` when it is set and `basis`
otherwise. The Revert button appears when the value is overridden and `onRevert` is given.

## Looks and sizes

There is one look and one size. No prop changes either.

| Part | Look |
|---|---|
| Label | 13 px medium, `--ink`. It wraps. |
| Marker | 12 px regular, `--steel`. |
| Control | 40 px high (`--row-h`), 12 px side padding, a 1 px `--control-border` border, a 6 px radius, `--surface` fill. It fills the row. |
| `TextArea` | The same box, at least 80 px high (`calc(var(--row-h) * 2)`), 8 px top and bottom padding. It can be resized vertically. |
| Unit | 13 px, `--steel`, on one line after the control. |
| Hint | 12 px, `--steel`. |
| Error | 13 px, `--danger-tx`. |
| Warning | 13 px, `--warn-tx`. |
| Derived value | Medium weight, tabular numbers. |
| Derived tag | 22 px high (`--chip-h`), 12 px medium. Computed: `--derived-bg` and `--derived-tx`. Overridden: `--warn-bg` and `--warn-tx`. |

The text typed into a control inherits the body size, 14 px.

## States

| State | What changes |
|---|---|
| Hover | Nothing on a control: there is no hover rule for it. The Edit and Revert buttons of `DerivedValue` take the `link` look, so on hover their underline takes the text colour. |
| Keyboard focus | The global rule for every focusable element: a 2 px `--primary` outline, 2 px away. The control has no focus rule of its own. The Edit and Revert buttons also show the `link` focus look: the underline takes the text colour. |
| Required | The marker says so, and the control gets the native `required` attribute. |
| Invalid (`error` set) | The control gets `aria-invalid="true"`, its border turns `--danger-solid`, and the error line appears under it. This depends on the caller spreading the control attributes. |
| Warning (`warning` set) | The warning line appears. The border does not change and `aria-invalid` is not set: a warning never blocks. |
| Disabled | No look. `field__input` has no disabled rule, and the global rules set the text colour, the fill and the border of every control, which overrides the browser's own disabled colours. A disabled `TextInput` or `TextArea` therefore looks like an enabled one; only the cursor differs. A disabled `SelectInput` is dimmed by Chromium and not by Firefox. Do not rely on the look to show that a control is disabled. A `FieldSet` with `disabled` disables every control inside it natively. |
| Read-only | No look. |
| Overridden (`DerivedValue`) | The tag changes colour and word, the explanation shows the override, and Edit goes. Revert appears when `onRevert` is given. |

## Keyboard

| Key | Where | What it does |
|---|---|---|
| Tab, Shift+Tab | Any control | Moves focus to and from the control. The label, hint, error and warning are not focusable. |
| Enter | `TextInput` | Never submits the form. The default is prevented, then the caller's `onKeyDown` runs. Free text is not a commit gesture. |
| Enter while the Korean input method is composing | `TextInput` | Left to the input method. The key is not prevented, it does not reach handlers further up, and the caller's `onKeyDown` is not called. Enter that confirms a syllable only confirms it. |
| Any other key | `TextInput` | Passed to the caller's `onKeyDown`. |
| Enter | `TextArea` | Adds a line. Native; `TextArea` handles no key and intercepts nothing from the input method. |
| Arrow keys, typing | `SelectInput` | The native select behaviour. |
| Enter, Space | Edit and Revert in `DerivedValue` | Press the button. Native. |

`TextInput` decides that the input method is composing from the event's `isComposing` flag, or from key code 229.

## Accessibility contract

| Component | Role | Accessible name | Also exposed |
|---|---|---|---|
| Control in a `Field` | The native control's own: `textbox`, `combobox` and so on. | The label, through `<label for>`. The marker and `tag` are inside the label, so they are part of the name. | The hint, error and warning as its description. `aria-invalid` and `required`. |
| `FieldSet` | `group` | The legend, when `label` is given. With no `label` the group has no name. | Disabled, when set. |
| `DerivedValue` | `group` | Its `label`, through `aria-labelledby`. | The Edit button is named by message `uiField.override.label`, which includes the field's label. The Revert button is named by its own text. |

What is announced:

- Nothing is announced when an error or a warning appears. The lines are not live regions. They are read as the
  control's description when the control has focus.
- A failed submit is announced by `Form`, not by `Field`: see [Button](button.md#accessibility-contract).
- The label is always visible. `Field` has no way to hide it.

The WCAG 2.2 criteria that apply:

| Criterion | How the family answers it |
|---|---|
| 1.3.1 Info and Relationships | `<label for>`, `aria-describedby`, and `<fieldset>` with `<legend>`. |
| 1.3.5 Identify Input Purpose | Left to the caller: `TextInput` passes `autocomplete` through and sets none. |
| 1.4.1 Use of Color | Invalid is a border colour and an error line in text. Required is a word, not a colour or a symbol. |
| 1.4.3 Contrast (Minimum), 1.4.11 Non-text Contrast | Every colour is a token; none is written in the family. The control's edge is `--control-border` on `--surface`. |
| 2.1.1 Keyboard | Native controls. |
| 2.4.6 Headings and Labels | Every control has a visible label. |
| 2.4.7 Focus Visible | The global 2 px focus outline. |
| 2.5.8 Target Size (Minimum) | The control is 40 px high. |
| 3.3.1 Error Identification | The error is text, under the control, tied to it by `aria-describedby`. |
| 3.3.2 Labels or Instructions | The label, the marker, the hint and the worked example. |
| 4.1.2 Name, Role, Value | The table above. |
| 4.1.3 Status Messages | Not answered by `Field`: an error that appears while focus is elsewhere is not announced. `Form` covers a failed submit. |

What the gallery shows of this family:

| Shown | Where |
|---|---|
| `Field` required and optional, with a unit, a hint, an example and an error; `TextInput`; `SelectInput`; `DerivedValue` computed and overridden | `apps/web/src/ui/field/field.gallery.tsx` |
| `Field` with `TextInput`, `SelectInput` and `TextArea` inside a `Form` | `apps/web/src/gallery/sections/forms.gallery.tsx` |

These two entries do not show `FieldSet`, `Marker` used alone, a `Field` with `required={null}`, `tag` or
`warning`, or a disabled or read-only control. Some of those appear in the entries of other components and views,
which use the family; none is shown here for its own sake.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component).

## Phone behaviour at 390 px

Nothing in the family changes with the width of the screen. `field.module.css` has no width rule.

- The control is 40 px high at every width. It does not grow to the 44 px touch size; the family does not read
  `--target-touch`.
- The control fills the width it is given and can shrink. The label wraps. The unit stays on one line.
- Typed text is 14 px at every width.
- A `FieldSet` can shrink below the width of its content, so a long value inside it does not push the page wide.

How many fields sit side by side at 390 px is decided by the layout around them, not by `Field`.

## Copy rules

- The label, hint, example, unit, error and warning are the caller's text. They come from the message catalog in
  `packages/i18n`. The `en` catalog is the source and the `ko` catalog must define every id.
- A label carries the marker, so whether a field is required is never left unsaid. The rule is to pass
  `required={null}` in two cases only: a search or filter box, which is neither required nor optional, and a
  `FieldSet` whose fields carry their own markers. The code does not enforce it, and call sites exist that pass
  `null` on an ordinary field, the sign-in form among them.
- Pass `example` as the example alone. The family adds the "e.g." prefix through message `uiField.example`.
- The unit goes in `unit`, after the control, not in the label.
- An error from the server is shown in the same place as any other: the caller maps the refused field to `error`.
- The family owns these message ids: `uiField.required`, `uiField.optional`, `uiField.example`,
  `uiField.derived`, `uiField.overridden`, `uiField.override`, `uiField.override.label` and `uiField.revert`.

## Props

<!-- ds:props apps/web/src/ui/field/field.tsx -->

### Field

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `children` | yes | `(control: ControlProps) => ReactNode` |  |  |
| `label` | yes | `ReactNode` |  |  |
| `required` | yes | `boolean \| null` |  | `null`: a search or filter box, which is neither required nor optional, so it carries no marker. |
| `error` | no | `ReactNode` |  |  |
| `example` | no | `string` |  | A worked example, shown with an "e.g." prefix. |
| `hint` | no | `ReactNode` |  |  |
| `id` | no | `string` |  |  |
| `tag` | no | `ReactNode` |  | Extra marks after the label, e.g. a derived-value tag. |
| `unit` | no | `ReactNode` |  |  |
| `warning` | no | `ReactNode` |  | A soft check that failed (amber, never blocks): e.g. a check digit that does not match. |

### FieldSet

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `required` | yes | `boolean \| null` |  |  |
| `label` | no | `ReactNode` |  |  |

Also accepts the attributes of `FieldsetHTMLAttributes` (`@types/react`) and `RefAttributes` (`@types/react`).

### Marker

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `required` | yes | `boolean` |  |  |

### TextInput

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `ref` | no | `Ref<HTMLInputElement>` |  |  |

Also accepts the attributes of `InputHTMLAttributes` (`@types/react`).

<!-- /ds:props -->

<!-- ds:props apps/web/src/ui/field/text-area.tsx -->

### TextArea

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `ref` | no | `Ref<HTMLTextAreaElement>` |  |  |

Also accepts the attributes of `TextareaHTMLAttributes` (`@types/react`).

<!-- /ds:props -->

<!-- ds:props apps/web/src/ui/field/select-input.tsx -->

### SelectInput

Accepts the attributes of `SelectHTMLAttributes` (`@types/react`).

<!-- /ds:props -->

<!-- ds:props apps/web/src/ui/field/derived-value.tsx -->

### DerivedValue

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `label` | yes | `string` |  |  |
| `value` | yes | `ReactNode` |  |  |
| `basis` | no | `ReactNode` |  |  |
| `onOverride` | no | `() => void` |  |  |
| `onRevert` | no | `() => void` |  |  |
| `override` | no | `ReactNode` |  |  |

<!-- /ds:props -->

## Tokens it reads

The family's own stylesheet:

<!-- ds:tokens apps/web/src/ui/field/field.module.css -->

| Token | Read by |
| --- | --- |
| `--chip-h` | `height` |
| `--danger-solid` | `border-color` |
| `--danger-tx` | `color` |
| `--derived-bg` | `background` |
| `--derived-tx` | `color` |
| `--fw-body` | `font-weight` |
| `--fw-medium` | `font-weight` |
| `--ink` | `color` |
| `--radius-sm` | `border-radius` |
| `--space-1` | `gap`, `margin-bottom` |
| `--space-2` | `gap`, `padding` |
| `--steel` | `color` |
| `--text-sm` | `font-size` |
| `--text-xs` | `font-size` |
| `--warn-bg` | `background` |
| `--warn-tx` | `color` |

<!-- /ds:tokens -->

The control box, `field__input` in `app.css`:

<!-- ds:tokens apps/web/src/app.css .field__input -->

| Token | Read by |
| --- | --- |
| `--control-border` | `border` |
| `--radius` | `border-radius` |
| `--row-h` | `height` |
| `--space-3` | `padding` |
| `--surface` | `background` |

<!-- /ds:tokens -->

The extra rule for `TextArea`, `field__area` in `app.css`:

<!-- ds:tokens apps/web/src/app.css .field__area -->

| Token | Read by |
| --- | --- |
| `--row-h` | `min-height` |
| `--space-2` | `padding` |
| `--space-3` | `padding` |

<!-- /ds:tokens -->

The Edit and Revert buttons in `DerivedValue` take the `link` look: see the `link` table in
[Button](button.md#tokens-it-reads). The focus outline is a global rule and is not listed: it reads `--primary`.
