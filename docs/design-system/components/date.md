<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Date

The date family enters one calendar date: a text input that reads a date as people type it, with a calendar that
opens from a button beside it.

The family lives in `apps/web/src/ui/date`: `DateField` in `date-field.tsx`, `DateInput` in `date-input.tsx` and
`DateCalendar` in `date-calendar.tsx`. A date is a string, `YYYY-MM-DD`, with no time and no time zone. An empty
date is `""`.

## When to use it, and when not

| Component | Use it for |
|---|---|
| `DateField` | A date in a form: the label, the input, the calendar, and optionally quick picks, bounds with their reasons, and a weekend suggestion. |
| `DateInput` | The input and the calendar alone, where something else owns the label: inside a [`Field`](field.md), in a table cell, in a filter row. |
| `DateCalendar` | Nothing directly. `DateInput` loads it when the calendar is asked for, and nothing else imports it. |

| Do not use it for | Use instead |
|---|---|
| A native `<input type="date">` | `DateField` or `DateInput`. A test, `date-gate.test.ts`, fails when the web source has a native date input. |
| The date a whole view is shown as of | `AsOfControl` (`ui/asof-control`). |
| A range | Two date fields. No range component exists: the access-log filters use two `DateInput`s. |
| A time of day, or a date with a time | Nothing exists. No component under `apps/web/src/ui` exports a time or a date-time input. |
| A deadline shown with the days left | `DeadlineChip` (`ui/deadline-chip`). |
| Free text | `TextInput`: see [Field](field.md). |

## Anatomy

`DateField` renders, top to bottom:

| Part | Element | Holds |
|---|---|---|
| Field | [`Field`](field.md) | The label with the marker and `note`, the control row, the hint line and the error line. |
| Quick picks | `<div role="group">` | One `<button type="button" aria-pressed>` per entry of `presets`. Left out when there are none. |
| Quick pick | `<button>` | The preset's `label`, then a `<span>` with the date it stands for, with its weekday, then the preset's `disabledReason`. |
| Input and calendar | `DateInput` | See below. It follows the quick picks in the same wrapping row. |
| Hint line | The hint `<p>` of `Field` | In this order, joined by middle dots: `echo` (only while a date is set), `basis`, the reason of `minFrom` when it sets the floor, the out-of-range sentence when a preset is outside the bounds and no `minFrom` reason is shown, and the unavailable-date sentence when `disabledDates` has entries. |
| Error line | The error `<p>` of `Field` | `error`. Without it, for a set date that is outside the bounds or blocked: the caller's reason for that bound, or the family's own sentence. Then `remedy`, in a `<span>`. |
| Weekend suggestion | `<p>` | Shown when `suggestWeekday` is set and the date is a Saturday or a Sunday. A sentence, then a `<button class="link">` that changes the date to the next Monday. |

`DateInput` renders, in one wrapping row:

| Part | Element | Holds |
|---|---|---|
| Input | `<input type="text" class="field__input">`, through `TextInput` | The date as text. `className` is added to it. |
| Calendar button | `<button type="button">` | A calendar icon, hidden from assistive technology. |
| Calendar | A popover holding a `<section role="dialog">`, placed under the start of the button | `DateCalendar`, rendered only while open. |
| Problem line | `<div role="alert">` | Why the typed text was refused. On its own line under the input. |

`DateCalendar` renders, inside the dialog:

| Part | Element | Holds |
|---|---|---|
| Header | `<header>` | A previous-month `<button>`, the month heading, a next-month `<button>`. |
| Grid | `<table role="grid">` | A row of short weekday names, then one row per week. |
| Day | `<td role="gridcell">` holding a `<div role="button">` | The day number. |

How the bounds work:

- `min` and `max` are the earliest and the latest date allowed. `minFrom` is a second floor that carries its
  reason: the later of `min` and `minFrom.date` is used.
- `disabledDates` are single dates inside the bounds that cannot be picked.
- `today` decides where the calendar opens when no date is set: on today, or on the nearest bound when today is
  outside them. `DateField` requires it. `DateInput` defaults it to today's date in Korea.

How typed text is read:

| Typed | Read as |
|---|---|
| `2026-10-12`, `2026.10.12`, `2026/10/12`, `2026. 10. 12.`, `2026 10 12` | Year, month, day. Hyphens, dots, slashes and spaces all separate, one trailing dot is allowed, and the month and the day may have one digit. |
| `20261012` | Eight digits with no separator. Fewer digits are refused. |
| `10/12/2026` | Month, day, year. Only in the English locale. |

The text is kept as typed until the person leaves the input or presses Enter. Then it is read. A date that is
allowed is written back in the locale's form (year, month, day with dots in Korean; month, day, year with slashes
in English) and `onChange` is called once with the `YYYY-MM-DD` value. Text that is not a date, and a date that is
outside the bounds or blocked, stays in the input as typed: the problem line appears, `onInvalid(true)` is called
and `onChange("")` empties the value. Emptying the input calls `onChange("")` and `onInvalid(false)`.

`onDraftChange` changes that last step. A caller that passes it receives every keystroke as text, and a refused
date does not empty the value: the caller keeps the text and validates it.

## Looks and sizes

There is one look and one size. No prop changes either.

| Part | Look |
|---|---|
| Input | The control box of [`Field`](field.md): 40 px high (`--row-h`). Its width is the browser's own for a text input (`width: auto`) and at least `10.5rem`, which is 168 px at the browser's default root size. |
| Calendar button | At least 44 px square (`--target-touch`), a 1 px `--control-border` border, a 10 px radius (`--radius-lg`), `--surface` fill, an 18 px icon in `--ink`. |
| Quick pick | A button at least 32 px high (`--target`), 12 px side padding, a 1 px `--control-border` border, a 10 px radius, 13 px medium text. The date it stands for is 12 px regular `--steel`. |
| Problem line | 13 px, `--danger-tx`. |
| Weekend suggestion | A box with 8 px by 12 px padding, a 1 px `--info-bd` border, a 6 px radius, `--info-bg` fill and 13 px `--info-tx` text. |
| Calendar popover | 332 px wide (`calc(var(--target-touch) * 7 + var(--space-3) * 2)`) and never wider than the viewport less 24 px. 12 px padding, a 1 px `--border` border, a 10 px radius, `--surface` fill, `--shadow-pop`. |
| Month buttons | 44 px square, no border, a 6 px radius, an 18 px icon. |
| Month heading | 14 px medium (`--text-body`), centred. |
| Weekday names | A row 40 px high (`--row-h`), 12 px medium `--steel`. |
| Day | 44 px square, a 10 px radius, 13 px `--ink` text. |

Two values in the stylesheet are not tokens: the input's `10.5rem` minimum width and the popover's `z-index: 18`.

## States

| State | What changes |
|---|---|
| Rest | The looks under Looks and sizes. A set date is shown as text in the locale's form, and the calendar is closed. |
| Empty | The input shows its placeholder, message `uiDate.placeholder`: the shape of a date in the locale. |
| Hover | The calendar button, a quick pick and a month button take a `--muted` fill. The input has no hover look, and neither has a day. The weekend button takes the `link` look, so on hover its underline takes the text colour. |
| Keyboard focus | The calendar button, the month buttons and a day: a 2 px `--primary` outline, 2 px away, from the family's own rules. The input, a quick pick and the weekend button: the same outline, from the global rule. The weekend button also shows the `link` focus look. |
| Pressed down | No look. There is no `:active` rule and none reads `data-pressed`. |
| Chosen quick pick (`aria-pressed="true"`) | `--primary` border and text on a `--primary-soft` fill. The date it stands for turns `--primary` too. A quick pick is pressed when its date equals the value. |
| Quick pick that cannot be used | `--muted` fill, `--steel` text, a not-allowed cursor, `aria-disabled="true"`. It stays visible and focusable, and pressing it does nothing. A quick pick is off when it has a `disabledReason`, or its date is outside the bounds, or its date is in `disabledDates`. |
| Selected day | `--primary` fill, `--on-primary` text. |
| Today | A 1 px `--primary` outline inside the day's edge, unless the day is selected. The library decides which day is today from the browser's clock and time zone. The `today` prop does not set it. |
| Day outside the bounds, or of another month | `--steel` text and a default cursor. It cannot be picked. |
| Blocked day (`disabledDates`) | No look. The library marks it `data-unavailable`, and the stylesheet styles `data-disabled` and `data-outside-month` only. A blocked day looks like one that can be picked and keeps the pointer cursor; pressing it does nothing. |
| Invalid, typed text | The problem line appears under the input and the input gets `aria-invalid="true"`. Inside a `Field` its border turns `--danger-solid`; outside one the border does not change, because that rule is `Field`'s. The line shows after the person leaves the input or presses Enter, never while they type. It also shows at once when the value passed in is not a date and, in a `DateInput` used alone, when it is a date the bounds refuse. |
| Invalid, set value | `DateField` only. A value that is outside the bounds or blocked, or an `error` from the caller, shows in the error line of `Field`, with `remedy` after it. The typed-text line never carries `remedy`. |
| Disabled | `DateInput` only: `disabled` disables the input and the calendar button natively. Neither has a disabled look. The input is as [Field](field.md#states) describes. The button's disabled rule keys on `aria-disabled="true"`, which a natively disabled button does not carry, so the rule never applies. `DateField` has no `disabled` prop. |
| Read-only | Does not exist. |
| Loading | The calendar's code is loaded on demand. It starts loading when the pointer enters the calendar button or the button takes focus. If the calendar is opened before it has arrived, the dialog shows a `Skeleton` placeholder named by message `common.loading`. Typing works throughout. |
| Failed to load | The dialog shows message `uiDate.calendar.failed` in a `<div role="alert">`. The input still works and keeps what was typed. |

`showErrors={false}` hides the problem line. `DateField` also hides it while its own error line is showing for a
set value, so one problem is never shown twice.

## Keyboard

| Key | Where | What it does |
|---|---|---|
| Tab, Shift+Tab | The family | Each quick pick, the input and the calendar button are tab stops, in that order. Leaving the input reads what was typed. |
| Typing | Input | Changes the text only. Nothing is read and `onChange` is not called. `onDraftChange`, when given, is called with the text. |
| Enter | Input | Reads what was typed, as leaving the input does. It never submits the form: the default is prevented. Then the caller's `onKeyDown` runs. |
| Enter while the Korean input method is composing | Input | Left to the input method. Nothing is read, the key does not reach handlers further up, and the caller's `onKeyDown` is not called. |
| Any other key | Input | Passed to the caller's `onKeyDown`. |
| Enter, Space | Quick pick | Sets the date. Does nothing on a quick pick that cannot be used. |
| Enter, Space | Calendar button | Opens the calendar. Focus moves to the selected day, or to the day the calendar opens on. |
| Left, Right | Calendar | Moves one day. |
| Up, Down | Calendar | Moves one week. |
| Home, End | Calendar | Moves to the first or the last day of the month. |
| Page Up, Page Down | Calendar | Moves one month. With Shift, one year. |
| Enter, Space | A day | Picks the day, closes the calendar and returns focus to the calendar button. On a blocked day it does nothing and the calendar stays open. |
| Escape | Calendar | Closes the calendar and returns focus to the calendar button. The date does not change. |
| Enter, Space | Weekend button | Changes the date to the next Monday. Native. |

Whether the input method is composing is decided from the event's `isComposing` flag or key code 229. `TextInput`
makes that check first, and `DateInput` makes it again before it reads the text.

The calendar's keys are handled by React Aria, not by the family. Focus cannot move past `min` or `max`. It can
move onto a blocked day.

## Accessibility contract

| Part | Role | Accessible name | Also exposed |
|---|---|---|---|
| Input in a `DateField` | `textbox` | The label, through `<label for>`. The marker and `note` are inside the label, so they are part of the name. | The hint line, the error line and the problem line as its description. `aria-invalid`. `required`. |
| `DateInput` alone | `textbox` | `label`, through `aria-label`. Inside a `Field`, the caller spreads the control attributes on it and the `Field` label names it. With neither, it has no name. | The caller's `aria-describedby`, then the problem line. `aria-invalid` when the caller passes it or a problem shows. |
| Quick picks | `group` | Message `uiDate.presets`, which includes the field's label. | Nothing. |
| Quick pick | `button` | Its text: the label, the date it stands for and the reason. | `aria-pressed`. When it cannot be used: `aria-disabled="true"`, the field's hint and error lines as its description, and `disabledReason` as its `title`. |
| Calendar button | `button` | Message `uiDate.calendar.open`. | The same description as the input, less the problem line. The library sets `aria-expanded` on it. |
| Calendar popover | `dialog` | Message `uiDate.calendar.label`. | Nothing. |
| Month buttons | `button` | Messages `uiDate.calendar.previous` and `uiDate.calendar.next`. | Nothing the family sets. |
| Day | `button` inside a `gridcell` | The full date with its weekday, written by the library in the app's locale. | `aria-disabled="true"` on a day outside the bounds and on a blocked day. `aria-selected` on the cell of the selected day. |
| Weekend button | `button` | Message `uiDate.weekend.use`, which names the day it changes to. | Nothing. |

What is announced:

- The problem line of the input is a `role="alert"`: it is announced when it appears.
- The failed-to-load message in the dialog is a `role="alert"`.
- The loading placeholder is a `role="status"` named by `common.loading`.
- The error line of `Field` is not a live region. A set value that turns invalid is read as the input's
  description when the input has focus, and is not announced.
- The weekend suggestion is not a live region. It appears without an announcement.
- The visible month heading is hidden from assistive technology. The library writes a visually hidden heading
  with the calendar's name in its place.

Known gaps:

- A blocked day has no look: see States.
- A disabled calendar button has no disabled look: see States.
- A chosen quick pick differs from the others by colour only: border, fill and text. `aria-pressed` exposes it.
- Every calendar button has the same name. It does not include the field's label, so two date fields on a page
  have two buttons that are told apart only by their description, which is empty when the field has no hint and
  no error.
- `DateInput` sets `autocomplete="off"` and has no prop to change it.

The WCAG 2.2 criteria that apply:

| Criterion | How the family answers it |
|---|---|
| 1.3.1 Info and Relationships | `<label for>` and `aria-describedby` through `Field`; a named group around the quick picks; a grid of named days. |
| 1.3.5 Identify Input Purpose | Not answered: `autocomplete` is fixed to `off`. |
| 1.4.1 Use of Color | An invalid date is a sentence. A selected day is the one filled day, and `aria-selected` exposes it. A chosen quick pick is colour only: see the gaps. |
| 1.4.3 Contrast (Minimum), 1.4.11 Non-text Contrast | Every colour is a token; none is written in the family. Control edges are `--control-border`. |
| 2.1.1 Keyboard | Everything the pointer can do, the keyboard can do. A date can always be typed without the calendar. |
| 2.4.3 Focus Order | Opening the calendar moves focus into it, and closing it returns focus to the calendar button. |
| 2.4.7 Focus Visible | The focus looks under States. |
| 2.5.8 Target Size (Minimum) | The calendar button, the month buttons and the days are 44 px. A quick pick is at least 32 px high. The input is 40 px high. |
| 3.3.1 Error Identification | The refused text is named in words: the month or the day that does not exist, a shape that is not a date, a date outside the bounds, a blocked date. |
| 3.3.2 Labels or Instructions | The visible label, the placeholder that shows the shape of a date, and the hint line with the bounds and their reasons. |
| 3.3.3 Error Suggestion | The format error names the shape to type. A bound's reason is the caller's, through `minFrom`, `minReason` and `maxReason`. The weekend suggestion offers the next Monday. |
| 4.1.2 Name, Role, Value | The table above. |
| 4.1.3 Status Messages | The problem line and the failed-to-load message are alerts. The error line of `Field` and the weekend suggestion are not announced. |

What the gallery shows of this family:

| Shown | Where |
|---|---|
| `DateField` empty with quick picks; with a Sunday set and the weekend suggestion; with a value before `min`, its error and a `remedy`; with `minFrom` and a quick pick that cannot be used. All four with `basis`. | `apps/web/src/ui/date/date.gallery.tsx` |
| `DateInput` inside a `Field` | `apps/web/src/gallery/sections/forms.gallery.tsx` |

These entries do not show `disabledDates`, `note`, `echo`, `maxReason`, a disabled `DateInput`, or the typed-text
problem line. The calendar is closed in all of them, so the gallery never shows the calendar, its loading
placeholder or its failed message.

What tests the family:

| Test | Covers |
|---|---|
| `date-input.test.tsx` | When typed text is read, what is refused and with which message, `onInvalid`, `onDraftChange`, and that a calendar pick honours the bounds. |
| `date-input.browser.test.tsx` | In a browser: the calendar's bounds and blocked days, arrow keys, Enter, and focus returning to the button. |
| `days.test.ts` | Date arithmetic and how typed text is read. |
| `date-gate.test.ts` | No native date input and no ad hoc locale date formatting in the web source; no ISO date written in a catalog message. |
| `apps/web/src/ui/canonical.test.tsx` | What `DateField` puts in its one hint line, the error line for a blocked date that is set, and the problem line of `DateInput` as an alert that keeps the caller's description. |
| `e2e/mock/date-calendar.spec.ts` | The calendar's code loading on hover and on focus, and a load that fails. |

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component).

## Phone behaviour at 390 px

Nothing in the family's own rules changes with the width of the screen. Its two stylesheets have no media query
and no container query.

- The calendar popover is 332 px wide, or the viewport less 24 px when that is narrower. At 390 px it is 332 px.
- The calendar button, the month buttons and the days are 44 px at every width: they read `--target-touch`. A
  quick pick stays at least 32 px high and the input stays 40 px high.
- The quick picks, the input and the calendar button wrap: the row that holds them wraps, and so does the row
  inside `DateInput`. The input does not shrink below `10.5rem`.
- In the Korean locale the input asks for the numeric keypad, and eight digits with no separator are read as a
  date. In other locales it asks for the text keyboard.

## Copy rules

- The label, `note`, `basis`, `echo`, `error`, `remedy`, the reasons (`minFrom.reason`, `minReason`, `maxReason`)
  and each preset's `label` and `disabledReason` are the caller's text. They come from the message catalog in
  `packages/i18n`. The `en` catalog is the source and the `ko` catalog must define every id.
- `minFrom.reason` is shown in the hint line before the person types and again as the error. `minReason` and
  `maxReason` are shown in the error only. Without a reason, the family's own sentence, `uiDate.outOfRange`, is
  shown.
- A date is shown through the formatters in `@console/i18n/format`, never through `toLocaleDateString`:
  `date-gate.test.ts` fails on that. A catalog message never contains a written-out ISO date.
- The family uses these message ids: `uiDate.placeholder`, `uiDate.presets`, `uiDate.calendar.open`,
  `uiDate.calendar.label`, `uiDate.calendar.previous`, `uiDate.calendar.next`, `uiDate.calendar.failed`,
  `uiDate.outOfRange`, `uiDate.disabled`, `uiDate.bad.format`, `uiDate.bad.month`, `uiDate.bad.day`,
  `uiDate.weekend` and `uiDate.weekend.use`. The loading placeholder uses `common.loading`.
- `datePresets` in `date-text.ts` builds the common quick picks, with labels `uiDate.preset.today`,
  `uiDate.preset.nextMonday` and `uiDate.preset.nextMonthFirst`.
- The other `uiDate.` ids in the catalog (`uiDate.today`, `uiDate.ahead`, `uiDate.ago`) are used by other
  components, not by this family.
- The calendar's month title, weekday names and day names are not in the catalog. React Aria writes them in the
  locale the app sets, Korean or English.
- The marker words are `uiField.required` and `uiField.optional`, owned by [`Field`](field.md).
- The gallery's sample text is in the gallery catalog, which production builds leave out.

## Props

`date-field.tsx` exports `DateField` and re-exports `DateInput`, so one block holds both tables.

<!-- ds:props apps/web/src/ui/date/date-field.tsx -->

### DateField

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `label` | yes | `string` |  |  |
| `onChange` | yes | `(value: string) => void` |  |  |
| `required` | yes | `boolean \| null` |  |  |
| `today` | yes | `string` |  |  |
| `value` | yes | `string` |  | `YYYY-MM-DD`, or "" while empty. |
| `basis` | no | `ReactNode` |  |  |
| `disabledDates` | no | `readonly string[]` |  |  |
| `echo` | no | `ReactNode` |  |  |
| `error` | no | `ReactNode` |  |  |
| `inputRef` | no | `Ref<HTMLInputElement>` |  |  |
| `max` | no | `string` |  |  |
| `maxReason` | no | `ReactNode` |  | Why a date after `max` is refused (e.g. that a date after today cannot be recorded), shown in place of the generic line. |
| `min` | no | `string` |  |  |
| `minFrom` | no | `{ date: string; reason: ReactNode; }` |  |  |
| `minReason` | no | `ReactNode` |  | Why a date before `min` is refused (the caller's rule), in the error only; `minFrom` also states it beforehand. |
| `note` | no | `ReactNode` |  |  |
| `onInvalid` | no | `(invalid: boolean) => void` |  | Whether the typed text was refused (see DateInput): an optional field's form holds its save on it. |
| `presets` | no | `readonly DatePreset[]` |  |  |
| `remedy` | no | `ReactNode` |  |  |
| `showErrors` | no | `boolean` | `true` |  |
| `suggestWeekday` | no | `boolean` | `false` |  |

### DateInput

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `onChange` | yes | `(value: string) => void` |  |  |
| `value` | yes | `string` |  |  |
| `aria-describedby` | no | `string` |  |  |
| `aria-invalid` | no | `true` |  |  |
| `className` | no | `string` |  |  |
| `disabled` | no | `boolean` |  |  |
| `disabledDates` | no | `readonly string[]` | `[]` |  |
| `id` | no | `string` |  |  |
| `inputRef` | no | `Ref<HTMLInputElement>` |  |  |
| `label` | no | `string` |  |  |
| `max` | no | `string` |  |  |
| `maxReason` | no | `ReactNode` |  | Why a date after `max` is refused (the caller's rule), in place of the generic out-of-range line. |
| `min` | no | `string` |  |  |
| `minReason` | no | `ReactNode` |  |  |
| `onBlur` | no | `FocusEventHandler<HTMLInputElement>` |  |  |
| `onDraftChange` | no | `(text: string) => void` |  | Keep incomplete text in specialized import rows; ordinary fields only receive valid business dates. |
| `onInvalid` | no | `(invalid: boolean) => void` |  | Whether the last committed text was refused (unreadable, outside the bounds, blocked): an optional field's form holds its save on it. |
| `onKeyDown` | no | `KeyboardEventHandler<HTMLInputElement>` |  |  |
| `required` | no | `boolean` | `false` |  |
| `showErrors` | no | `boolean` | `true` |  |
| `today` | no | `string` | `todayKst()` |  |

<!-- /ds:props -->

`DatePreset` is `{ label, date, disabledReason? }`.

<!-- ds:props apps/web/src/ui/date/date-calendar.tsx -->

### DateCalendar

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `blocked` | yes | `ReadonlySet<string>` |  |  |
| `focused` | yes | `string` |  |  |
| `onPick` | yes | `(date: string) => void` |  |  |
| `max` | no | `string` |  |  |
| `min` | no | `string` |  |  |
| `value` | no | `string` |  |  |

<!-- /ds:props -->

## Tokens it reads

`DateField` and `DateInput`:

<!-- ds:tokens apps/web/src/ui/date/date.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border` |
| `--control-border` | `border` |
| `--danger-tx` | `color` |
| `--fw-body` | `font-weight` |
| `--fw-medium` | `font-weight` |
| `--info-bd` | `border` |
| `--info-bg` | `background` |
| `--info-tx` | `color` |
| `--ink` | `color` |
| `--muted` | `background` |
| `--primary` | `border-color`, `color`, `outline` |
| `--primary-soft` | `background` |
| `--radius` | `border-radius` |
| `--radius-lg` | `border-radius` |
| `--shadow-pop` | `box-shadow` |
| `--space-1` | `gap` |
| `--space-2` | `gap`, `margin-left`, `padding` |
| `--space-3` | `gap`, `max-width`, `padding`, `width` |
| `--steel` | `color` |
| `--surface` | `background` |
| `--target` | `min-height` |
| `--target-touch` | `min-height`, `min-width`, `width` |
| `--text-sm` | `font-size` |
| `--text-xs` | `font-size` |

<!-- /ds:tokens -->

`DateCalendar`:

<!-- ds:tokens apps/web/src/ui/date/date-calendar.module.css -->

| Token | Read by |
| --- | --- |
| `--fw-medium` | `font-weight` |
| `--ink` | `color` |
| `--muted` | `background` |
| `--on-primary` | `color` |
| `--primary` | `background`, `outline` |
| `--radius` | `border-radius` |
| `--radius-lg` | `border-radius` |
| `--row-h` | `height` |
| `--space-1` | `gap` |
| `--space-2` | `margin-bottom` |
| `--steel` | `color` |
| `--target-touch` | `grid-template-columns`, `height`, `width` |
| `--text-body` | `font-size` |
| `--text-sm` | `font-size` |
| `--text-xs` | `font-size` |

<!-- /ds:tokens -->

The input is the control box of `Field`: see the `field__input` table in [Field](field.md#tokens-it-reads). The
weekend button takes the `link` look: see the `link` table in [Button](button.md#tokens-it-reads). The loading
placeholder is `Skeleton` (`ui/skeleton`), which has its own stylesheet. The focus outline of the input and of a
quick pick is a global rule and is not listed: it reads `--primary`.
