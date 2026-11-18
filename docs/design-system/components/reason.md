<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# ReasonField

`ReasonField` asks why a command is being run: one reason code, picked from a row of chips, and a memo under it
that becomes required when the code is Other.

It lives in `apps/web/src/ui/reason`:

| File | Holds |
|---|---|
| `reason-field.tsx` | `ReasonField` and the type `ReasonCode`. |
| `reason.ts` | The type `Reason` and the function `reasonProblem`. |
| `reason.module.css` | The styles. `ChipChoice` in `ui/choice` reads the same file: see [Choice](choice.md). |

## When to use it, and when not

Use it where a command must record a reason as a code and a memo together: granting or changing access, deleting
or editing a role, rejecting or returning an approval, deciding rows of an import, rolling an import back, asking
for access from a refused screen. Those are the call sites on this branch.

The caller owns the value and the list of codes. `ReasonField` draws what it is given, reports each change through
`onChange`, and shows its two built-in errors once the caller sets `showErrors`. `showErrors` is false by
default, and without it neither built-in error is shown.

| Do not use it for | Use instead |
|---|---|
| One pick from a short list, with no memo | `ChipChoice` or `ChoiceField`: see [Choice](choice.md). |
| A reason code alone, where the note is a field of the form | `ReasonCodeField` (`reference/reason/ui/reason-code-field.tsx`). It reads the server's list for a domain itself. |
| A long list of codes | `ReasonCodeField`, which becomes a server picker above its limit. `ReasonField` draws every code as a chip and has no limit. |
| Free text with no code | `Field` with `TextArea`: see [Field](field.md). |
| A reason that must be disabled or read-only | No component exists for it: `ReasonField` has neither state. |

## Anatomy

| Part | Element | Holds |
|---|---|---|
| Root | `<div>` | The group, the memo field, then `footer`. |
| Group | `<div role="radiogroup">`, the `RadioGroup` of React Aria Components | The group label, the chips and the error line. |
| Group label | `<span>` | `label`, then the marker. The marker always says required. |
| Chips | `<div>` | One chip for each entry of `codes`. |
| Chip | `<label>`, the `Radio` of React Aria Components | A visually hidden `<input type="radio">`, then the code's `label`. |
| Error line | `<span>` | `error`, or the message `uiReason.pick` when `error` is not given. Rendered only while the group is invalid. |
| Memo field | [`Field`](field.md) | Its label is the message `uiReason.memo`, with a marker. Its hint is the count, from the message `uiReason.count`. Its error is the message `uiReason.memoRequired`. |
| Memo | `<textarea class="field__input field__area">` | `value.memo`. It has `maxLength` set to `memoMax`. It is written as a raw element with the classes `TextArea` writes. |
| Footer | None of its own | `footer`, as passed. |

The chips keep the order of `codes`, except that the code equal to `other` is moved to the end.

No chip is checked until `value.code` equals the code of an entry of `codes`. `null` means no choice. A code that
is not in the list is a third case: see States.

The types:

| Type | Shape | Meaning |
|---|---|---|
| `ReasonCode` | `{ code: string; label: string }` | One entry of the list. `label` is the text on its chip. |
| `Reason` | `{ code: string \| null; memo: string }` | The value. `code` is `null` until a chip is chosen. |

`ReasonField` is controlled. Choosing a chip calls `onChange` with the new code and the same memo. Typing calls it
with the same code and the new memo. A memo is kept when the code changes.

`reasonProblem(reason, other)` says what still blocks a reason. `ReasonField` uses it for its errors, and callers
use it to decide whether to send.

| Returns | When |
|---|---|
| `"pick"` | `code` is `null`. This comes first, whatever the memo holds. |
| `"memo"` | `code` equals `other` and the memo is empty once its surrounding white space is removed. |
| `null` | Otherwise. |

A comment in `reason.ts` says the server enforces the same rule. That was not checked for this page.

`ReasonField` takes no `id`, no `ref` and no `className`, and passes no other attribute through.

## Looks and sizes

There is one look and one size. No prop changes either.

| Part | Look |
|---|---|
| Root | A column with 12 px between the group, the memo field and the footer (`--space-3`). |
| Group | A column with 8 px between the label, the chips and the error line (`--space-2`). |
| Group label | 13 px (`--text-sm`), weight 600 (`--fw-medium`), `--ink`. It wraps. The marker is 12 px regular `--steel` text, from `ui/field`. |
| Chips | A wrapping row with 8 px gaps. |
| Chip | At least 32 px high (`--target`), 12 px side padding (`--space-3`), a 1 px `--control-border` border, a 6 px radius (`--radius`), a `--surface` fill, weight 600. Its text inherits the body size, 14 px, and the text colour. The cursor is a pointer. |
| Chosen chip | A `--primary` border, a `--primary-soft` fill, `--primary` text, and a 1 px `--primary` outline inside the edge (`outline-offset: -2px`). |
| Error line | 13 px, `--danger-tx`. |
| Memo field | The looks of `Field` and `TextArea` on the [Field](field.md) page: a box at least 80 px high that fills the row and can be resized vertically, a 12 px `--steel` hint, a 13 px `--danger-tx` error. |

## States

| State | What changes |
|---|---|
| Rest | The looks above. |
| Hover | A chip that is not chosen takes a `--muted` fill. A chosen chip does not change. The memo has no hover look. |
| Keyboard focus | A chip shows the `--focus` ring as a box shadow: 2 px of `--surface`, then 2 px of `--primary`. The memo shows the global rule: a 2 px `--primary` outline, 2 px away. |
| Pressed | No look. React Aria sets `data-pressed` on a chip; no rule reads it. |
| Selected | The chosen chip: the look above. Its hidden radio is checked. |
| Required | The group is always required: its marker says so and it has `aria-required="true"`. The memo's marker says optional until the chosen code equals `other`. Then it says required and the textarea gets the native `required` attribute. |
| Invalid group | When `showErrors` is set and `value.code` is `null`, or when `error` is given, with or without `showErrors`. The group gets `aria-invalid="true"`, every chip that is not chosen takes a `--danger-solid` border, and the error line appears under the chips. |
| Invalid memo | When `showErrors` is set, the chosen code equals `other` and the memo is blank. The textarea gets `aria-invalid="true"` and a `--danger-solid` border, and the error appears under the count. |
| Disabled | Does not exist. There is no prop for it and the stylesheet has no disabled rule. The field stays editable while the caller's command is pending. |
| Read-only | Does not exist. |
| Loading | Does not exist. The caller passes the codes once it has them. |
| Empty | With no codes there are no chips: the label, then the memo field. The chips row has no minimum height and nothing says that the list is empty. The group is still required. |

The two built-in errors never show together: `reasonProblem` reports a missing code before a missing memo. A
server `error` can show beside the memo error.

When `other` matches no entry of `codes`, no chip is moved and the memo never becomes required.

A code that is not in the list. When `value.code` is a string that matches no entry of `codes`, such as a code
retired after it was chosen:

- no chip is checked;
- no chip is in the tab order, so Tab does not reach the group. A pointer can still choose a chip;
- `reasonProblem` never returns `"pick"`. Unless the code equals `other` and the memo is blank, it returns `null`,
  so no built-in error shows and a caller that sends on `null` sends the code.

The caller has to set the code back to `null` when the list no longer holds it. This is read from the code of
`ReasonField` and of the installed React Aria (`react-aria-components` 1.22.1), not run in a browser.

The memo's native `required` in a form. This too is read from the code, not run in a browser.

- In a plain `<form>` without `noValidate`, the browser checks the form before `onSubmit` runs. With Other chosen
  and an empty memo it stops the submit and shows its own message. A caller that sets `showErrors` in `onSubmit`
  has not set it by then, so the built-in memo error does not show. A memo of white space only is not empty to
  the browser: the submit goes through and the built-in error shows.
- The browser never stops a submit for a missing code. The group passes `validationBehavior="aria"`, so React
  Aria does not put `required` on the radios.
- In the shared `Form` (`ui/button`), unless the caller passes `noValidate`, the form itself collects every
  control the browser reports as invalid, lists them in its error summary, and does not call `onSubmit` while
  there is one. An empty required memo is listed there with the message `uiField.valueMissing`. A missing code is
  not.

One form element was found around a `ReasonField` on this branch: the plain `<form>` of the access request on a
refused screen (`lib/react/denied.tsx`). The search covered the files of the ten call sites, the access, import
and approvals features, the routes, and `Sheet`, `Dialog`, `ApprovalCard` and `Composer`.

## Keyboard

| Key | Where | What it does |
|---|---|---|
| Tab, Shift+Tab | Chips | The group is one tab stop. Focus lands on the chosen chip. With nothing chosen, it lands on the first chip going forward and on the last going backward. When `value.code` is a code that is not in the list, no chip is a tab stop: see States. |
| Right, Down | Chips | Moves to the next chip and chooses it. It wraps from the last to the first. |
| Left, Up | Chips | The same, backward. |
| Space | Chips | Chooses the focused chip. Native. |
| Tab | Memo | The memo is the next tab stop after the chips. |
| Enter | Memo | Adds a line. Native. |
| Typing past `memoMax` | Memo | The browser stops the input at `maxLength`. |

An arrow key chooses as it moves. Arrowing onto the Other chip makes the memo required at once.

`ReasonField` handles no key. A search of the folder for a key handler, `isComposing`, key code 229 and
composition events finds none. The memo is a plain `<textarea>`, so a key the Korean input method owns goes to the
input method: Enter that confirms a syllable is not intercepted. How a browser applies `maxLength` to text that is
still being composed was not determined for this page.

The arrow keys on the chips are React Aria's. In the installed version (`react-aria-components` 1.22.1) that
handler ignores a key pressed while an input method is composing.

## Accessibility contract

| Part | Role | Accessible name | Also exposed |
|---|---|---|---|
| Group | `radiogroup` | The group label, through `aria-labelledby`: `label`, then the marker's word. | `aria-required="true"`, `aria-orientation="horizontal"`, and `aria-invalid="true"` while invalid. |
| Chip | `radio` | The code's `label`. | Checked or not. |
| Error line | None | | While the group is invalid, React Aria makes it the description of the group and of each radio, through `aria-describedby`. |
| Memo | `textbox` | The message `uiReason.memo`, then the marker's word, through its `<label>`. | Its description is the count, then the memo error when there is one. `required` while the code is Other. `aria-invalid="true"` with the memo error. `maxlength`. |

Announced: nothing. No part is a live region. An error is read as a description when its control takes focus.

Known gaps:

- An error that appears is not announced, and `ReasonField` moves no focus to it. Both are the caller's.
- The memo turns from optional to required when Other is chosen. The marker's word changes; nothing announces it.
- The count changes on every keystroke and is not announced. It is read with the memo's description.
- There is no disabled or pending state.
- With no codes the group is required and holds nothing to choose.
- A caller cannot move focus to the group: there is no `id` and no `ref`.
- A `value.code` that is not in `codes` takes every chip out of the tab order, and `reasonProblem` does not report
  it: see States.
- In a plain form the browser's own message for an empty required memo comes before the built-in one, and the
  built-in one does not show. A missing code is never caught by the browser: see States.
- Without `showErrors` neither built-in error shows. Two call sites on this branch never pass it: the rollback
  panel of an import, which disables its button while `reasonProblem` reports a problem, and the approval viewer.

The WCAG 2.2 criteria that apply:

| Criterion | How the component answers it |
|---|---|
| 1.3.1 Info and Relationships | A radio group with a label; a labelled textarea; each error tied to its control as a description. |
| 1.4.1 Use of Color | Chosen is the checked state, and the chosen chip has an inner outline as well as its colours. Invalid is an error line in words as well as a border colour. Required is a word. |
| 1.4.3 Contrast (Minimum) | Computed from the token values, the chosen chip, `--primary` on `--primary-soft`, is 6.34:1 in the light theme and 4.91:1 in the dark. The error line has no fill of its own; `--danger-tx` on `--surface` is 6.47:1 and 8.99:1. |
| 1.4.11 Non-text Contrast | A chip's edge is `--control-border`: 3.65:1 on `--surface` in the light theme and 3.61:1 in the dark. The invalid edge, `--danger-solid`, is 4.83:1 and 6.19:1. |
| 2.1.1 Keyboard | The table above. The exception is a `value.code` that is not in the list: then Tab does not reach the chips. See the known gaps. |
| 2.4.7 Focus Visible | A ring on the focused chip; the global outline on the memo. |
| 2.5.8 Target Size (Minimum) | A chip is at least 32 px high. |
| 3.3.1 Error Identification | Each error is text under the part it is about. |
| 3.3.2 Labels or Instructions | A visible label with a marker on the group and on the memo, and the count under the memo. |
| 3.3.3 Error Suggestion | The two built-in messages say what to do. |
| 4.1.2 Name, Role, Value | The table above. |
| 4.1.3 Status Messages | Not answered: no error and no count is announced. |

What the gallery shows, in `apps/web/src/ui/reason/reason.gallery.tsx`: three fields in a grid. Nothing chosen
and no errors; Other chosen with an empty memo and `showErrors`, so the memo error shows; a code chosen with a
memo and `showErrors`, with no error. It does not show the error for a missing code, a server `error`, or a
`footer`.

No call site on this branch passes `error` or `footer`. Ten call sites were found by searching for the component's
name.

Tests: `reason.test.ts` has one test, of `reasonProblem`: no code, Other with a blank memo, Other with a memo, and
another code with no memo. Nothing in the folder renders the component. One feature test reaches it on static
markup: `features/access/ui/bulk-form.test.tsx` checks that the message for a missing code is in the markup after
a blocked press. A search of `e2e` for the `uiReason.` ids found nothing; the specs of the screens that use the
field were not read.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component).

## Phone behaviour at 390 px

Nothing changes with the width of the screen. `reason.module.css` has no media query and no container query, and
neither has the stylesheet of `Field`.

- The chips wrap onto more rows. A chip has no rule against wrapping, so a long label wraps inside it.
- The memo fills the row.
- A chip is at least 32 px high at every width. The stylesheet does not read `--target-touch`.

## Copy rules

The built-in text is in the `uiReason.` ids of `packages/i18n`. The `en` catalog is the source and the `ko`
catalog defines every id.

| Message id | Used for |
|---|---|
| `uiReason.memo` | The label of the memo. |
| `uiReason.count` | The hint under the memo. It takes the length of the memo and `memoMax`. |
| `uiReason.pick` | The error for a missing code. It takes `label`. |
| `uiReason.memoRequired` | The error for Other with a blank memo. |
| `uiField.required`, `uiField.optional` | The marker's word, through `Marker`. |

- `label` is the caller's. It is also put inside the sentence of `uiReason.pick`, so it has to read as a noun
  there.
- The text on a chip is the `label` of its code. The caller supplies it with the list; `ReasonField` translates
  nothing.
- `other` is the code of the list's Other entry. The caller names it; the component does not guess it.
- `memoMax` is a number from the caller. The count is the memo's length as the string reports it, the same
  measure `maxLength` uses.
- `error` is the caller's text for a refusal about the reason, such as a code that was retired. It takes the
  place of the built-in message for a missing code.
- The gallery's sample text is in the gallery catalog, which production builds leave out.

## Props

<!-- ds:props apps/web/src/ui/reason/reason-field.tsx -->

### ReasonField

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `codes` | yes | `readonly ReasonCode[]` |  |  |
| `label` | yes | `string` |  |  |
| `memoMax` | yes | `number` |  |  |
| `onChange` | yes | `(next: Reason) => void` |  |  |
| `other` | yes | `string` |  |  |
| `value` | yes | `Reason` |  |  |
| `error` | no | `ReactNode` |  | A server error for this reason (e.g. a retired code). |
| `footer` | no | `ReactNode` |  |  |
| `showErrors` | no | `boolean` | `false` |  |

<!-- /ds:props -->

`ReasonCode` and `Reason` are under Anatomy. `reason.ts` exports no component, so it has no table.

## Tokens it reads

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

The memo field's tokens are on the [Field](field.md) page. The global focus outline on the memo reads `--primary`.
