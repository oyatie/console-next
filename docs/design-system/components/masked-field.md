<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Masked field

A masked field is a labelled input for a number with a fixed shape: the value is kept as plain digits and shown
with its separators as the person types.

It lives in `apps/web/src/ui/masked-field`: `MaskedField` in `masked-field.tsx`, and the caret arithmetic in
`caret.ts`.

## When to use it, and when not

Use it for an identifier or a phone number that is made of digits and has a known shape: a business or corporate
registration number, a resident registration number, an insurance workplace number, an industry code, a phone
number. The shapes are the entries of `FORMATS` in `apps/web/src/lib/pure/formats.ts`.

| Do not use it for | Use instead |
|---|---|
| Free text, an email address, or a value with letters | `TextInput` in a `Field`: see [Field](field.md). The mask drops everything that is not a digit. |
| An amount or a quantity | `TextInput` in a `Field`, with the unit in `unit`: see [Field](field.md). |
| A date | `DateField`: see [Date](date.md). |
| A postal address | `AddressField` (`ui/address-field`). |
| A code picked from an official list | `CodePicker` (`ui/code-picker`). |
| A masked value that is disabled or read-only | No component exists for it: `MaskedField` has neither prop. |

## Anatomy

| Part | Element | Holds |
|---|---|---|
| Field | [`Field`](field.md) | The label with the marker, the control row, then the hint with the example, the error and the warning. |
| Row | `<span>` | The input, then `status`, on one line. |
| Input | `<input class="field__input code">` | The digits, shown through the format. |
| Status | the caller's | `status`: a result beside the value, such as a chip from a lookup. |

The input is a native `<input>` written in the component, not `TextInput`. It gets the control attributes of
`Field` (`id`, `aria-describedby`, `aria-invalid`, `required`) and three fixed ones: `inputmode="numeric"`,
`autocomplete="off"` and `spellcheck="false"`. It sets no `type`, so it is a text input.

`MaskedField` takes eleven props and passes nothing else through. It has no `id`, `name`, `ref`, `disabled`,
`readOnly`, `placeholder`, `onKeyDown` or `onFocus`.

The format is the `format` prop, a `MaskFormat`:

| Member | What it does |
|---|---|
| `max` | The most digits the value holds. Typing and pasting stop there. |
| `display` | Turns the digits into the text shown, with separators. |
| `parse` | Optional. Turns typed or pasted text into digits. Without it, every digit is kept and everything else is dropped. The phone format uses it to read a number that starts with `+82`. |

`value` and `onChange` carry digits only, never the separators. `onChange` is called only when the digits change.

## Looks and sizes

There is one look and one size. No prop changes either.

| Part | Look |
|---|---|
| Input | The control box of [`Field`](field.md): 40 px high (`--field-h`), 12 px side padding, a 1 px `--control-border` border, a 6 px radius, `--surface` fill. Its text is the `code` look: the code face (`--font-code`; monospace, and the body face in the Console style) at 13 px (`--text-sm`). It fills the row and can shrink. |
| Status | 8 px after the input (`--space-2`), centred on the row's height. The row does not wrap, so the status stays on the input's line. |
| Label, marker, hint, example, error, warning | As [Field](field.md#looks-and-sizes) draws them. |

## States

| State | What changes |
|---|---|
| Rest | The value through the format. An empty value shows an empty input: there is no placeholder. |
| Hover | Nothing. There is no hover rule. |
| Keyboard focus | The global rule for every focusable element: a 2 px `--primary` outline, 2 px away. The component has no focus rule of its own. |
| Pressed down, selected | Do not exist. |
| Required | The marker says so, and the input gets the native `required` attribute. |
| Invalid (`error` set) | The input gets `aria-invalid="true"`, its border turns `--danger-solid`, and the error line appears under it. All three come from `Field`. |
| Warning (`warning` set) | The warning line appears, in `--warn-tx`. The border does not change and `aria-invalid` is not set: a warning never blocks. |
| Disabled | Does not exist. |
| Read-only | Does not exist. |
| Loading | Does not exist. `status` is where a caller shows the result of a lookup; the component gives it no busy state. |
| Empty | No look of its own. |
| Composing | While an input method is composing, the input shows the raw text and nothing is reformatted. See Keyboard. |

## Keyboard

| Key | What it does |
|---|---|
| Tab, Shift+Tab | Moves focus to and from the input. Anything focusable in `status` follows it. |
| A digit | Adds the digit. The separators appear by themselves, and the caret stays after the digit just typed, also in the middle of the value. A full-width digit is read as the same digit. |
| A digit when the value is full | At the end, dropped. In the middle, added, and the last digit falls off: the value is cut at `max` from the end. |
| Any other character | Dropped. The text stays as it was. The caret stays too, except just after a separator: there it moves to before the separator, as Backspace there does. |
| Backspace, Delete on a digit | Removes the digit. The rest is reformatted and the caret stays after the same digit. |
| Backspace just after a separator | Removes nothing: the separator comes back and the caret moves to before it. The next Backspace removes the digit there. |
| Delete just before a separator | Removes nothing: the separator comes back and the caret does not move, so pressing Delete again does the same. The digit after the separator cannot be removed this way. |
| Paste | Formatted and unformatted text are both read: digits are kept, everything else is dropped, and the result is cut at `max`. |
| Enter | Never submits the form: the default is prevented. |
| Enter while the Korean input method is composing | Left to the input method. The default is not prevented. Unlike `TextInput`, the key still reaches handlers further up. |

How the Korean input method is handled:

- While it is composing, the change event carries `isComposing`. The component then shows the raw text as typed
  and does not parse, reformat or move the caret, and `onChange` is not called.
- When composition ends (`compositionend`), the text is parsed like any other input: the digits are kept, the
  rest is dropped, and the caret goes after the same count of digits.
- Enter is decided from the event's `isComposing` flag or key code 229.

The component takes no `onKeyDown`, so a caller cannot add a key of its own.

## Accessibility contract

- **Role:** `textbox`, the native input's own.
- **Accessible name:** the label, through `<label for>`. The marker is inside the label, so it is part of the
  name.
- **Description:** the hint and example, the error and the warning, in that order, through `aria-describedby`.
- **State:** `aria-invalid="true"` when `error` is set. `required` when the field is required.
- **Announced:** nothing. The error and warning lines are not live regions; they are read as the input's
  description when it has focus. A separator that appears is not announced.

Known gaps:

- `status` is not tied to the input. It is not in the input's description and it is not a live region, so a
  lookup result that appears there is not announced and is not read with the field.
- `autocomplete` is fixed to `off`. A phone number field cannot declare `tel`.
- Delete just before a separator does nothing: see Keyboard.

The WCAG 2.2 criteria that apply:

| Criterion | How the component answers it |
|---|---|
| 1.3.1 Info and Relationships | `<label for>` and `aria-describedby`, through `Field`. |
| 1.3.5 Identify Input Purpose | Not answered: `autocomplete` is fixed to `off`. |
| 1.4.1 Use of Color | Invalid is a border colour and an error line in text. Required is a word. A warning line differs from an error line on screen by its colour and its words. |
| 1.4.3 Contrast (Minimum), 1.4.11 Non-text Contrast | Every colour is a token; none is written in the component. The input's edge is `--control-border` on `--surface`. |
| 2.1.1 Keyboard | A native input. |
| 2.4.7 Focus Visible | The global 2 px focus outline. |
| 2.5.8 Target Size (Minimum) | The input is 40 px high. |
| 3.3.1 Error Identification | The error is text, under the input, tied to it by `aria-describedby`. |
| 3.3.2 Labels or Instructions | The label, the marker, the hint and the worked example. There is no placeholder. |
| 4.1.2 Name, Role, Value | The list above. |
| 4.1.3 Status Messages | Not answered: an error, a warning or a `status` that appears is not announced. `Form` covers a failed submit: see [Button](button.md#accessibility-contract). |

The gallery shows five fields in `apps/web/src/ui/masked-field/masked-field.gallery.tsx`: an empty one with an
example; one with a warning and a status chip; one with an error; a phone number with a hint; and an optional one.

The folder has one test, `caret.test.ts`, for the caret arithmetic and full-width digits. No test in the folder
renders `MaskedField`. End-to-end specs fill masked fields and assert the formatted value: `e2e/entity-ops.spec.ts`
fills a registration number as plain digits and reads it back with its separators. Where the caret lands in the
rendered input, and composition, are not tested. The formats have their own test,
`apps/web/src/lib/pure/formats.test.ts`.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component).

## Phone behaviour at 390 px

Nothing changes with the width of the screen. `masked-field.module.css` has no media query and no container query.

- The input asks for the numeric keypad at every width: `inputmode="numeric"`.
- The input is 40 px high at every width. It does not grow to the 44 px touch size; the component does not read
  `--target-touch`.
- The input fills the row and gives way first: it can shrink to nothing (`min-width: 0`). `status` stays on the
  same line, so a long status leaves the input less room.
- Typed text is 13 px at every width.

## Copy rules

- The label, hint, example, error, warning and the content of `status` are the caller's text. They come from the
  message catalog in `packages/i18n`. The `en` catalog is the source and the `ko` catalog must define every id.
- The component owns no message id. The marker words (`uiField.required`, `uiField.optional`) and the "e.g."
  prefix of the example (`uiField.example`) are [`Field`](field.md)'s.
- Pass `example` as the example alone. `Field` adds the prefix.
- A check that can be wrong goes in `warning`, not `error`: a check digit that does not match warns and never
  blocks. `error` is for a value that is refused.
- The separators are not copy. They come from the format's `display`.
- The gallery's sample labels are in the gallery catalog, which production builds leave out.

## Props

<!-- ds:props apps/web/src/ui/masked-field/masked-field.tsx -->

### MaskedField

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `format` | yes | `MaskFormat` |  |  |
| `label` | yes | `string` |  |  |
| `onChange` | yes | `(digits: string) => void` |  |  |
| `required` | yes | `boolean` |  |  |
| `value` | yes | `string` |  |  |
| `error` | no | `ReactNode` |  |  |
| `example` | no | `string` |  |  |
| `hint` | no | `ReactNode` |  |  |
| `onBlur` | no | `() => void` |  |  |
| `status` | no | `ReactNode` |  | A live result beside the value, e.g. a status lookup chip. |
| `warning` | no | `ReactNode` |  |  |

<!-- /ds:props -->

`MaskFormat` is described under Anatomy.

## Tokens it reads

The component's own stylesheet:

<!-- ds:tokens apps/web/src/ui/masked-field/masked-field.module.css -->

| Token | Read by |
| --- | --- |
| `--space-2` | `gap` |

<!-- /ds:tokens -->

The control box, `field__input` in `app.css`:

<!-- ds:tokens apps/web/src/app.css .field__input -->

| Token | Read by |
| --- | --- |
| `--control-border` | `border` |
| `--field-h` | `height` |
| `--field-h-toolbar` | `height` |
| `--radius` | `border-radius` |
| `--space-2` | `background-position` |
| `--space-3` | `padding` |
| `--space-6` | `padding-inline-end` |
| `--surface` | `background` |

<!-- /ds:tokens -->

The text of the input, `code` in `app.css`:

<!-- ds:tokens apps/web/src/app.css .code -->

| Token | Read by |
| --- | --- |
| `--font-code` | `font-family` |
| `--text-sm` | `font-size` |

<!-- /ds:tokens -->

The label, marker, hint, error and warning read the tokens of `Field`: see [Field](field.md#tokens-it-reads). The
focus outline is a global rule and is not listed: it reads `--primary`.
