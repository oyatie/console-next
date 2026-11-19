<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Select

`SelectField` is one choice from a short list: a labelled button that shows the pick, or a placeholder, and opens
the options in a popover.

It lives in `apps/web/src/ui/select`: `select-field.tsx` with `select-field.module.css`. It is built on the select
of React Aria Components. It is not a native `<select>`; that one is `SelectInput`, on the [Field](field.md) page.

## When to use it, and when not

Use it for one choice from a short list in a row that has no room for the options themselves. On this branch it
is a pick in a form or in a plan row, and a filter in a toolbar, where the callers pass `hideLabel`.

| Do not use it for | Use instead |
|---|---|
| One choice in a form that has room for the options | `ChoiceField`: see [Choice](choice.md). It draws up to 5 options on the page, or up to 24 as pills with `look="chips"` when none has a description. From 6 to 15 options without pills it becomes a native select, which hides them as this one does. |
| A native select inside a `Field`, with its marker and hint | `SelectInput`: see [Field](field.md). |
| More than 15 options, or a list the server searches | `ServerPicker` (`ui/server-picker`). 15 is `PICK_SIZE_THRESHOLD` in `ui/server-picker/size.ts`. `SelectField` does not check the count itself; the role picker checks it before it chooses between the two. |
| Several choices at once | `Checks`: see [Choice](choice.md). `SelectField` holds one value. |
| A list of commands | `MenuButton` or `ActionMenu`: see [Menu](menu.md). A select holds a value; it runs nothing. |
| Switching between views | `Segmented`: see [Button](button.md), or `Tabs` (`ui/tabs`). |
| A panel of other content beside a trigger | `PopoverButton` (`ui/popover`). |

## Anatomy

| Part | Element | Holds |
|---|---|---|
| Root | `<div>` | Everything below. It carries `data-form-value` with the current `value`, or an empty string for `null`. |
| Label | `<span>` | `label`. With `hideLabel` it carries the global `sr-only` class: still in the page, not visible. |
| Trigger | `<button type="button">` | The icon, the value and the chevron. The component draws the element itself, through the `render` prop of React Aria's button, so that it can add `aria-invalid`. |
| Icon | Whatever the caller passes | `icon`, before the value. Left out when not given. |
| Value | `<span>` | The `label` of the chosen option, or `placeholder` when nothing is chosen. |
| Chevron | `<svg>`, 14 px, `aria-hidden` | A down chevron at the end of the trigger. |
| Error | `<span>` | `error`, under the trigger. Rendered only when `error` is not `null` or `undefined`. It is React Aria's `Text` in the `errorMessage` slot of the select, which gives it an id and puts that id in the trigger's `aria-describedby`. |
| Hidden select | `<select>` in an `aria-hidden` wrapper | React Aria's own native select, out of sight and out of the tab order. It exists for native form validation and browser autofill. |
| Popover | `<div role="dialog">` | The list. React Aria renders it in a portal on `<body>`, below the trigger and aligned to its start edge. |
| List | `<div role="listbox">` | One option per entry of `options`, in the order given. |
| Option | `<div role="option">` | The option's label in a `<span>`, then its description in a `<span>` when it has one. |

An option is plain data: `SelectOption` is `{ id, label, description? }`. The trigger shows the `label` only; the
description appears in the list. Typed letters are matched against `label`.

How the value works:

- The component is controlled. `value` is the `id` of the chosen option, or `null` for none. Nothing is
  preselected by the component.
- A `value` that matches no option shows the placeholder, as `null` does.
- `onChange` is called with the `id` of the new option, as a string. It is not called when the user picks the
  option that is already chosen; the list just closes.
- Once an option is chosen the user cannot clear it. A list that needs an "all" case carries it as an option; the
  toolbar filters do.
- Choosing an option closes the list.

The popover asks for no placement of its own: React Aria's select gives it `bottom start`, and it sits 8 px from
the trigger. The 8 px is React Aria's default offset in the installed version (`react-aria-components` 1.22.1).

`data-form-value` is read by the sheet when it works out whether closing would lose an edit: see
[Sheet](sheet.md).

The component passes no other attribute through. It has no `ref`, no `name`, no `id` and no way to disable it.

## Looks and sizes

There is one look and one size. No prop changes either.

| Part | Look |
|---|---|
| Root | A column with a 4 px gap (`--space-1`). It can shrink (`min-width: 0`). |
| Label | 13 px (`--text-sm`), weight 600 (`--fw-medium`), `--ink`. |
| Trigger | As wide as the root. At least 32 px high (`--target`), 12 px side padding (`--space-3`), a 1 px `--control-border` border, a 6 px radius (`--radius`), `--surface` fill. `--ink` text at the body size, 14 px, weight 600. A row with an 8 px gap (`--space-2`). |
| Value | Takes the free width. One line; text that does not fit ends in an ellipsis. |
| Icon and chevron | `--steel`. Neither shrinks. The chevron is pushed to the end. |
| Error | 13 px (`--text-sm`), `--danger-tx`. |
| Popover | The width of the trigger (`--trigger-width`), and at least 366.67 px (`calc(var(--panel-w) / 1.2)`), or the width of the viewport less 24 px (`--space-3` twice) where that is the smaller of the two. `--surface` fill, a 1 px `--border` border, a 10 px radius (`--radius-lg`), `--shadow-pop`, and `overflow: auto`. |
| List | 4 px of padding (`--space-1`). |
| Option | A column. 8 px top and bottom padding (`--space-2`) and 12 px at the sides (`--space-3`), a 6 px radius (`--radius`). No minimum height: one line comes to 37 px at the body's line height of 1.5, and a label with a description to 55 px. |
| Option label | Weight 600 (`--fw-medium`). |
| Description | 12 px (`--text-xs`), `--steel`. |

Three things about these rules are worth knowing:

- The trigger is 32 px high. A control of the Field family is 40 px (`--row-h`), so a `SelectField` beside a
  `Field` is lower than it.
- `--trigger-width` is not a token from `packages/tokens`. React Aria sets it on the popover to the width of the
  trigger.
- React Aria sets `z-index` and `max-height` on the popover element itself when it places it. The popover's own
  `overflow: auto` is what scrolls a list taller than that height.

There is no open or close animation: the module has no transition and reads neither `data-entering` nor
`data-exiting`.

## States

The trigger:

| State | What changes |
|---|---|
| Rest, with a value | The look above. |
| Placeholder (nothing chosen) | The border is dashed, and the placeholder text is `--steel` at weight 400 (`--fw-body`). |
| Hover | Nothing but the pointer cursor. There is no hover rule. |
| Keyboard focus (`data-focus-visible`) | A ring: `--focus`, 2 px of `--surface` then 2 px of `--primary`. The global 2 px `--primary` outline applies too, since the trigger does not remove it; both put 2 px of `--primary` 2 px outside the border. A press on the label also focuses the trigger and shows the ring. |
| Open | No look. React Aria sets `data-pressed` and `aria-expanded="true"` on the trigger and `data-open` on the root; no rule reads them. The chevron does not turn. |
| Pressed | No look. Neither the module nor `app.css` has a rule for `:active` or `data-pressed`. |
| Selected | Does not exist on the trigger. The pick is the trigger's text. |
| Invalid (`error` set) | The border turns `--danger-solid`, and the error line appears under the trigger. With nothing chosen the border is dashed and `--danger-solid`. The trigger carries `aria-invalid="true"`, and the error line is its description. |
| Required | No look. See below. |
| Disabled | Does not exist. `SelectField` has no `disabled` prop. |
| Read-only | Does not exist. |
| Loading | Does not exist. |
| Empty (no options) | Looks like any other trigger. A press does nothing: React Aria does not open an empty list. Nothing says why. |

An option:

| State | What changes |
|---|---|
| Rest | No fill. |
| Focused (`data-focused`) | `--muted` fill. |
| Hover | The focused look. React Aria moves focus to the option under the pointer; there is no separate hover rule. |
| Keyboard focus | No extra rule: the same `--muted` fill as hover. The option sets `outline: none` against the global focus outline: see the note under this table. |
| Selected (`data-selected`) | `--primary-soft` fill and `--primary` text. The description stays `--steel`. There is no check mark. |
| Focused and selected | The selected look only. Both rules set the fill, and the selected rule comes later in the file. |
| Pressed | No look. |
| Disabled | Does not exist. `SelectOption` has no such field. |

The `outline: none` of an option, and of the list, is a rule of one class. The global `:focus-visible` rule in
`app.css` is a rule of one pseudo-class. The two weigh the same, and the module's rule comes later: the entry
module imports `app.css` statically and reaches this component only through lazy imports, so the module's
stylesheet loads after `app.css`. So a focused option shows no outline, and neither does the focused list. This
was read from the stylesheets and the imports, not checked in a browser.

`error` turns the invalid look and `aria-invalid` on whenever it is not `null` or `undefined`. An empty string or
`false` counts as an error and draws the red border with an empty line under it; pass `undefined` for no error.

`required` is `true` unless the caller passes `false`. It sets `data-required` on the root and the native
`required` attribute on the hidden select, and nothing else: no marker word beside the label, no rule in the
stylesheet, and no attribute on the trigger. Whether the invalid look shows is decided by `error` alone.

## Keyboard

On the trigger, with the list closed:

| Key | What it does |
|---|---|
| Tab, Shift+Tab | Moves focus to and from the trigger. |
| Enter, Space, ArrowDown | Opens the list and focuses the chosen option, or the first option when nothing is chosen. |
| ArrowUp | Opens the list and focuses the chosen option, or the last option when nothing is chosen. |
| ArrowLeft, ArrowRight | Without opening the list, chooses the option before or after the chosen one, or the first option when nothing is chosen, and calls `onChange`. |
| Typing | Without opening the list, chooses an option whose label starts with what was typed, and calls `onChange`. What was typed is forgotten after one second. |

Opened by a pointer, the list focuses the chosen option. With nothing chosen, focus goes to the list itself, and
no option has it until the pointer or an arrow key moves.

In the open list:

| Key | What it does |
|---|---|
| ArrowDown, ArrowUp | Moves to the next or previous option. It does not wrap at either end. |
| Home, End | Moves to the first or last option. |
| Page Up, Page Down | Moves by a page of options. |
| Typing | Moves to an option whose label starts with what was typed. It does not choose it. |
| Enter, Space | Chooses the focused option and closes the list. |
| Escape | Closes the list and changes nothing. Focus returns to the trigger. |
| Tab, Shift+Tab | Do not move focus out of the list: see below. |

A press outside the list also closes it.

Tab in the open list is read from React Aria's source in the installed version (`react-aria-components` 1.22.1).
It was not tried in a browser for this page.

- The list handles both keys and lets the event go on. Tab puts focus on the last element inside the list that
  is in the tab order, when focus is not in it already. Shift+Tab puts focus on the list element.
- The popover is the dialog here, so React Aria contains focus in it. Its own Tab handler then moves focus
  among the elements of the popover that are in the tab order, and stops the browser's default.
- The one element in the popover's tab order is the focused option, or the list itself while no option has
  focus. The hidden dismiss buttons and the popover element are not in it.

So Tab and Shift+Tab cannot take focus out of the popover. Where focus is seen to rest after either key was not
confirmed.

These keys are React Aria's; the component has no key handler. It does not check `isComposing`, key code 229 or
a composition event, so it has no rule of its own for a key the Korean input method owns. The trigger is a
button and the list holds no text field. In the installed version, React Aria's handlers for the arrow keys,
Home, End, Page Up, Page Down and Escape, and for the keys that open the list, skip a key event whose
`isComposing` flag is set.

Its type-ahead does not read that flag. It goes by the name of the key, on every keydown that carries no Ctrl,
Alt or Meta key:

- A name longer than one character that starts with a letter from A to Z is ignored. `Process`, the name a
  browser gives a key that an input method is handling, is one of these.
- Any other name is added to what was typed, apart from a space typed first. That covers a single character, a
  single Hangul character included. What was typed is then compared with the start of each option's label.

Two things were not tested for this page: which of the two a Korean keyboard sends while the trigger or the
list has focus, and whether a single Hangul consonant or vowel matches the start of a label that begins with a
whole syllable. So this page does not say that an option with a Korean label can be reached by typing. The
three specs named at the end of the accessibility section use the pointer, and the component's own browser test
opens the list and picks with Enter; it types no letter.

## Accessibility contract

| Part | Role | Accessible name | Also exposed |
|---|---|---|---|
| Trigger | `button` | The shown value, or the placeholder, and then `label`: `aria-labelledby` points at the value first and the label second. | `aria-haspopup="listbox"`, `aria-expanded`, and `aria-controls` while open. While `error` is set: `aria-invalid="true"`, and the error line as its description, through `aria-describedby`. Without an error it has neither attribute. |
| Popover | `dialog` | `label`, through `aria-labelledby`. | React Aria gives a modal popover this role unless it holds a dialog of its own. |
| List | `listbox` | `label`, through `aria-labelledby`. | |
| Option | `option` | Its label, through `aria-labelledby`. | `aria-selected`. The description is its description, through `aria-describedby`. |
| Label | None. It is a `<span>`, not a `<label>`. | | A press on it focuses the trigger. |
| Error | None. | | It is the trigger's description while it shows. It is not a live region. |
| Hidden select | Hidden from assistive technology: its wrapper is `aria-hidden`, and it is out of the tab order. | | |

- **Hidden label:** `hideLabel` hides the label from sight only. It stays in the page and stays part of the
  trigger's name, so `label` is real copy either way.
- **Modality:** while the list is open, everything outside the popover is `inert`, and React Aria locks the scroll
  of the document.
- **Announced:** nothing through a live region. Opening moves focus into the list; choosing moves it back to the
  trigger, whose name now starts with the new value. The error line is not announced when it appears: it is the
  description of the trigger.
- **Hidden dismiss buttons:** React Aria puts a visually hidden button at the start and at the end of the popover.
  Each closes the list. Neither is in the tab order. React Aria names them with its own text for "dismiss", in the
  locale the app gives React Aria.
- **Icons:** `icon` is decoration. The caller marks it `aria-hidden`; the component does not. The chevron is
  marked by the component.

The WCAG 2.2 criteria that apply:

| Criterion | How the component answers it |
|---|---|
| 1.3.1 Info and Relationships | A `listbox` of `option`s behind a button that says it opens one, all named by the label. While an error shows, the error line is the trigger's description and the trigger carries `aria-invalid="true"`. |
| 1.4.1 Use of Color | The placeholder state is a dashed border and a lighter weight as well as a colour. Invalid is a border colour and an error line in words. The chosen option is a fill and a text colour only on screen, and `aria-selected` in the markup. |
| 1.4.3 Contrast (Minimum), 1.4.11 Non-text Contrast | Every colour is a token. The trigger's edge is `--control-border` on `--surface`. |
| 1.4.10 Reflow | The minimum width of the list is capped at the viewport less 24 px. At 320 px, the width the criterion is judged at, the list is 296 px wide and inside the screen, and a label too long for it wraps: see Phone behaviour. |
| 2.1.1 Keyboard | The tables above. |
| 2.1.2 No Keyboard Trap | Escape closes the list and returns focus to the trigger. |
| 2.4.3 Focus Order | Focus moves into the list on open and back to the trigger on close. |
| 2.4.7 Focus Visible | The trigger shows a ring. A focused option shows a `--muted` fill. A focused option that is also the chosen one shows nothing of its own: see States. |
| 2.5.8 Target Size (Minimum) | The trigger is at least 32 px high. An option is at least 37 px high. |
| 3.3.1 Error Identification | The error is text, under the trigger, and it is the trigger's description. The trigger is marked `aria-invalid="true"` for as long as the error shows. |
| 3.3.2 Labels or Instructions | The label is visible unless `hideLabel` is set, and the placeholder says what to pick. Whether a pick is required is not shown. |
| 4.1.2 Name, Role, Value | The table above. The value is part of the trigger's name. |

Known gaps:

- `aria-invalid` sits on an element whose role is `button`. WAI-ARIA 1.2 lists it among the global states and
  marks its global use as deprecated. The lint rule `jsx-a11y/role-supports-aria-props` does not list the
  attribute for that role, and the component switches the rule off on that one line. How a screen reader speaks
  the state on a button was not tested: the browser test reads the attribute and the computed description, and
  runs no screen reader.
- Required is neither shown nor exposed. `Field` writes a marker word beside its label; `SelectField` has none,
  and the trigger carries no `aria-required`.
- A focused option that is also the chosen one has no focus look, and every option has `outline: none`. When the
  list opens with a value chosen, focus is on that option, so keyboard focus is not visible until it moves. See
  States.
- No option has a keyboard-only focus look: focus and hover look the same.
- The chosen option is marked on screen by colour alone.
- A trigger with no options does nothing when pressed and does not say why.
- The names of the hidden dismiss buttons are React Aria's text, not messages from `packages/i18n`.
- What the shared `Form` reports for an empty required `SelectField` was not tested for this page. `Form` checks
  every `<select>` inside it, and the hidden one is one of them. The three files on this branch that put a
  `SelectField` straight into a `Form` all pass `noValidate` and do their own checks.

What the gallery shows: nothing. `ui/select` has no gallery file, and no gallery entry renders a `SelectField`. A
trace of the imports of every `*.gallery.tsx` finds one entry that imports a module using it, the approvals
entry, and that entry renders a part of the module that has no `SelectField`.

Tests: `ui/select` has one test file, `select-field.browser.test.tsx`, with `select-field.browser-fixture.tsx`
beside it. It runs in Chromium on a form shaped like the statutory filing dialog, and checks that the trigger
carries `aria-invalid="true"` and has the error line as its description while the error shows, and neither before
the form is committed nor after a pick, once by keyboard and once by pointer. At 360 px and at 320 px it opens a
list of short labels and a list of long ones, and checks that the list is the viewport less 24 px wide, that the
list and every option lie inside the screen, and that nothing runs past its own edge. At 1440 px it checks that
the list is as wide as a trigger wider than 366.67 px, and 366.67 px wide under a narrower one. There is no jsdom
unit test.

The component is also driven in a browser through the screens that use it. Three examples: `e2e/mock/approvals.spec.ts` opens the source filter and picks an
option; `selectFilingFact` in `e2e/helpers/statutory.ts` finds a trigger by the label inside its name and picks an
option; `e2e/ops-recovery.spec.ts` picks a role. All three use the pointer.

No workflow runs the accessibility scan of the gallery, and that scan would not reach this component anyway,
since the gallery does not show it. The scan is described in [the guide](../README.md#add-or-change-a-component).

## Phone behaviour at 390 px

`select-field.module.css` has no media query and no container query. One of its rules reads the width of the
viewport: the minimum width of the list.

- The trigger is as wide as its root and at least 32 px high at every width. It does not grow to the 44 px touch
  size; the module does not read `--target-touch`.
- The minimum width of the list is the smaller of 366.67 px and the viewport less 24 px, whatever the width of
  the trigger. Under a trigger narrower than that, the list is 366 px wide at 390 px, 336 px at 360 px and 296 px
  at 320 px. From a viewport of 390.67 px up, the minimum is 366.67 px, as at 1440 px.
- The 24 px is twice the 12 px that React Aria keeps between a popover and the edge of the screen by default in
  the installed version, so such a list sits 12 px from each side.
- The width itself has no cap: under a trigger wider than the minimum, the list is as wide as the trigger.
- Options are the same size as at 1440 px, except that a label too long for the narrower list wraps onto more
  lines. No rule sets an option's text on one line.
- React Aria places the popover against the trigger and sets its position and its maximum height itself.

How wide the trigger is at 390 px is decided by the layout around it.

## Copy rules

- The component owns no message id and imports no text.
- `label`, `placeholder`, `error`, and each option's `label` and `description` are the caller's, from the message
  catalog in `packages/i18n`. The `en` catalog is the source and the `ko` catalog must define every id.
- `label` names the trigger, the popover and the list. With `hideLabel` it is still the name, so it is real copy.
- `placeholder` is required. It says what to pick. In a filter it names the case that applies while nothing is
  picked, as the grants filter does with `accessGrants.role.all`.
- An option's `label` is what the trigger shows and what typed letters match. Keep it short: the trigger cuts it
  to one line.
- `description` is one short line under the label in the list. It never appears in the trigger.
- `error` says what is wrong in words. Pass `undefined` when there is no error.
- Whether a pick is required is not said by the component. Nothing adds a marker word to `label`.
- The one built-in text is the name of the hidden dismiss buttons. It comes from React Aria, not from the catalog.

## Props

<!-- ds:props apps/web/src/ui/select/select-field.tsx -->

### SelectField

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `label` | yes | `string` |  |  |
| `onChange` | yes | `(id: string) => void` |  |  |
| `options` | yes | `readonly SelectOption[]` |  |  |
| `placeholder` | yes | `string` |  |  |
| `value` | yes | `string \| null` |  |  |
| `error` | no | `ReactNode` |  |  |
| `hideLabel` | no | `boolean` | `false` |  |
| `icon` | no | `ReactNode` |  |  |
| `required` | no | `boolean` | `true` |  |

<!-- /ds:props -->

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/select/select-field.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border` |
| `--control-border` | `border` |
| `--danger-solid` | `border-color` |
| `--danger-tx` | `color` |
| `--focus` | `box-shadow` |
| `--fw-body` | `font-weight` |
| `--fw-medium` | `font-weight` |
| `--ink` | `color` |
| `--muted` | `background` |
| `--panel-w` | `min-width` |
| `--primary` | `color` |
| `--primary-soft` | `background` |
| `--radius` | `border-radius` |
| `--radius-lg` | `border-radius` |
| `--shadow-pop` | `box-shadow` |
| `--space-1` | `gap`, `padding` |
| `--space-2` | `gap`, `padding` |
| `--space-3` | `min-width`, `padding` |
| `--steel` | `color` |
| `--surface` | `background` |
| `--target` | `min-height` |
| `--text-sm` | `font-size` |
| `--text-xs` | `font-size` |
| `--trigger-width` | `width` |

<!-- /ds:tokens -->

`--trigger-width` is not a token from `packages/tokens`: React Aria sets it on the popover to the width of the
trigger. The hidden label takes the global `sr-only` class, which reads no token. The global focus outline on the
trigger is not listed: it reads `--primary`.
