<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# DeadlineChip

`DeadlineChip` shows how many days are left to a deadline, or how many days it is overdue, as a tinted chip, and
can put what is due and its legal basis beside it.

It lives in `apps/web/src/ui/deadline-chip/deadline-chip.tsx`, which also exports the type `ClockSeverity`. Its
tones and its block layout are in `deadline-chip.module.css` beside it; the shape of the chip is the global
`chip` class in `apps/web/src/app.css`.

## When to use it, and when not

Use it for a deadline counted in days: a task in the inbox, a privacy request, a step of an exit. It is written
for a count of days and a severity that the server works out; the known gaps say where a caller does otherwise.
Use the chip alone in a table cell or at the end of a row, and the block where the deadline needs its subject and
its basis in words.

It is also handed to other components as a value: a step of a `ChainStepper` (`ui/chain-stepper`) takes one as its
`deadline`. Pass the chip alone there: the stepper puts it inside a `<span>`, where the block's `<div>` is not
allowed.

| Do not use it for | Use instead |
|---|---|
| A state that is not a deadline | `Chip`: see [Chip](chip.md). |
| A deadline with no count of days: unknown, or due without delay | Plain text or `Chip`: see [Chip](chip.md). `days` is required, so the component cannot show one. The list of privacy requests prints catalog text instead (`account.privacy.withoutDelay`, `account.privacy.noClock`). `FilingDeadline` (`reference/statutory/ui/filing-deadline.tsx`) shows a statutory deadline, with or without a count of days, with `Chip`. |
| A date a person picks | `DateField`: see [Date](date.md). |
| A message about a late item, with a reason or a remedy | `Banner`: see [Banner](banner.md). |
| Anything that must be announced when it changes | `Banner` with `live`. `DeadlineChip` has no live region. |

## Anatomy

The component has two forms. Which one is drawn depends on `children` and `basis`.

With neither, it is one element:

| Part | Element | Holds |
|---|---|---|
| Chip | `<span>` with the global `chip` class and one tone class of the module | The label. |

With either, it is a block:

| Part | Element | Holds |
|---|---|---|
| Block | `<div>` | The parts below, in a two-column grid. |
| Chip | `<span>`, as above | The label. |
| What is due | `<span>` | `children`. Left out when `children` is not given. |
| Basis line | `<span>` | `basis`, then the interest note. Left out when it would hold neither. |
| Interest note | `<span>` | The text of `uiDeadlineChip.interest`. Only when `severity` is `over` and `interestAccruing` is set. |

The label comes from `days` and nothing else:

| `days` | Label |
|---|---|
| More than 0 | `uiDeadlineChip.left`, with the number. |
| 0 | `uiDeadlineChip.today`. |
| Less than 0 | `uiDeadlineChip.over`, with the number made positive. |

The tone comes from `severity` and nothing else. The component never compares the two: `severity="far"` with a
negative `days` draws a grey chip that says overdue.

Three things to know:

- `children` and `basis` are tested for truthiness. An empty string counts as not given.
- The interest note needs the block. With no `children` and no `basis` the component returns the chip alone, and
  `interestAccruing` is dropped without a trace, on `over` too.
- The block is a `<div>`, so it cannot go inside a paragraph or a line of text. The chip alone is a `<span>` and
  can.

`DeadlineChip` does not render `Chip`. It writes the global `chip` class itself and adds a tone class from its
own module, because `Chip` has no tone for a deadline. It takes no `className`, passes no other attribute through
and has no ref, so it cannot be given an `id` or an ARIA attribute.

## Looks and sizes

`severity` picks the colours:

| `severity` | Fill | Border | Text | Where the values come from |
|---|---|---|---|---|
| `far` | `--muted` | `--border` | `--steel` | The same three tokens as the `neutral` tone of `Chip`. |
| `due` | `--due-bg` | `--due-bd` | `--due-tx` | Role tokens that `packages/tokens/tokens.css` points at `--accent-bg`, `--accent-bd` and `--accent-tx`. |
| `over` | `--over-bg` | `--over-bd` | `--over-tx` | Role tokens that point at `--danger-bg`, `--danger-bd` and `--danger-tx`. |

The size is the chip's and there is one: see [Chip](chip.md#looks-and-sizes).

The block:

| Part | Look |
|---|---|
| Grid | Two columns: the first as wide as the chip (`max-content`), the second the rest (`1fr`). 4 px between rows (`--space-1`), 12 px between columns (`--space-3`). Parts line up on the text baseline. |
| What is due | In the second column, beside the chip. No look of its own: it inherits its text. |
| Basis line | In the second column: under what is due, or beside the chip when there are no `children`. 13 px (`--text-sm`), `--steel`. |
| Interest note | `--over-tx`, weight 600 (`--fw-medium`). A middle dot in `--steel` comes before it. The dot is CSS generated content, and it is drawn whether or not a `basis` comes before it. |

One thing about the tone rules is not what it seems. The global `chip` rule sets `border: 1px solid`, a shorthand
that resets the border colour to the text colour. The module's tone class then sets `border-color`. Both are
single-class rules, so the tone's border wins only when the module's stylesheet comes after `app.css`; if it does
not, the border takes the colour of the text. This page did not check the order in a build of this branch.

No prop picks a visual style.

## States

There are none. `DeadlineChip` has no hover, focus, pressed, selected, disabled, read-only, invalid, loading or
empty state. The three severities are looks the caller picks, not states the component enters.

## Keyboard

None. `DeadlineChip` is not focusable and handles no key. It takes no text, so it has no rule for a key the
Korean input method owns: the module has no `keydown` handler, no `isComposing` check, no key code 229 check and
no composition event.

## Accessibility contract

- **Role:** none. The chip and the parts of the block are `<span>` elements, and the block is a `<div>`.
- **Accessible name:** none. The text is read in place, in document order: the label, what is due, the basis, the
  interest note.
- **Announced:** nothing. A chip that appears, or whose days or severity change, is not announced: there is no
  live region and no `role="status"`.

The severity is colour and nothing else. The component adds no icon and no hidden text. While days are left the
label is the notation of `uiDeadlineChip.left`, which in the `en` catalog is `D-` and the number, with no word
for it. In that catalog today and overdue are words, so `over` normally has its own words. `far` and `due` with
the same number of days have the same label and differ only by colour.

The WCAG 2.2 criteria that apply:

| Criterion | How the component answers it |
|---|---|
| 1.4.1 Use of Color | Only in part. Overdue is said in the label. The difference between `far` and `due` is colour alone. |
| 1.4.3 Contrast (Minimum) | Each tone pairs a text token with its own fill token. The label is 12 px medium, which is not large text, so it needs 4.5:1. Computed from the token values: `far` is 5.24:1 in the light theme and 6.44:1 in the dark, `due` 8.75:1 and 10.14:1, `over` 5.91:1 and 8.63:1. The basis and the interest note have no fill, so their pairs depend on the surface behind the block; on `--surface` in the light theme the basis is 6.04:1 and the interest note 6.47:1. |
| 1.4.10 Reflow | The chip stays on one line. In the block, the second column takes the rest of the width and wraps. |
| 4.1.3 Status Messages | Not answered. Nothing is announced. |

Known gaps:

- `interestAccruing` is dropped when the component is given neither `children` nor `basis`.
- `far` and `due` differ by colour alone.
- The component does not check `severity` against `days`.
- The source says the days and the severity are the server's and are never worked out in the browser. Nothing
  enforces that, and on this branch only the inbox views keep to it: they pass the server's days and map the tone
  the server sends. The upcoming list of the home page passes the server's days and always `far`. The exit board
  passes the server's days and works the severity out in the browser, from those days and a number of days it
  reads from the server's settings (`exitDeadlineSeverity`, in
  `apps/web/src/features/people/domain/exit-legs.ts`). The privacy views work out both in the browser, from the
  due date and the date the server's answer is as of, and never pass `far` (`privacyReceipt`, in
  `apps/web/src/features/account/api.ts`).
- The border colour of a tone depends on the order of two stylesheets: see Looks and sizes.

The gallery entry is `apps/web/src/ui/deadline-chip/deadline-chip.gallery.tsx`. It shows four chips alone: `far`,
`due`, `due` on the day, and `over`. It shows three blocks: `over` with what is due, a basis and the interest
note; `due` with what is due and a basis; `far` with what is due and no basis. The chips section,
`apps/web/src/gallery/sections/chips.gallery.tsx`, shows one more `due` chip. No entry shows a block with a basis
and no `children`, or `interestAccruing` on a chip alone.

Tests: `apps/web/src/ui/deadline-chip/deadline-chip.test.tsx` renders the component to static markup with the
`ko` catalog and checks the three labels and the interest note, the last in a block with `children`. No test
checks a tone class, the layout of the block, or what happens to `interestAccruing` on a chip alone.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component).

The same spec takes a full-page screenshot of the gallery at 1440, 1024 and 390 px in both themes and compares it
with a baseline image, under the same skip. This entry is in the gallery. No baseline image for those
screenshots is checked in on this branch.

## Phone behaviour at 390 px

Nothing in the component's own rules changes with the width of the screen. The module has no media query and no
container query.

- The chip never wraps its label (`white-space: nowrap`, from the global `chip` rule).
- In the block, the first column stays as wide as the chip. The second takes what is left, and what is due and
  the basis wrap inside it.
- Nothing can be pressed, so there is no target size.

## Copy rules

The built-in text is four messages, defined in `packages/i18n/src/catalogs/en/ui-deadline-chip.ts`. The `ko`
catalog must define the same ids: its file is typed against the `en` one.

| Message id | Used for | Takes |
|---|---|---|
| `uiDeadlineChip.left` | The label while days are left. | `days` |
| `uiDeadlineChip.today` | The label on the day. | Nothing. |
| `uiDeadlineChip.over` | The label after the day. The `en` text is a plural. | `days`, as a positive number |
| `uiDeadlineChip.interest` | The interest note. | Nothing. |

A fifth id, `uiDeadlineChip.name`, is the heading of the gallery entry. The component does not read it.

- `days` is meant to be the server's count of days left, negative once the day has passed. The component does
  not work it out from a date.
- `severity` is meant to be the server's too. The known gaps say where neither holds.
- `children` says what is due and when. `basis` says the event the clock started from and the legal article.
  Both are the caller's text, from the message catalog in `packages/i18n`. The `en` catalog is the source and the
  `ko` catalog must define every id.
- Format a date before passing it. The component prints `children` and `basis` as given.
- Do not put the separator before the interest note into `basis`: the stylesheet draws it.

## Props

<!-- ds:props apps/web/src/ui/deadline-chip/deadline-chip.tsx -->

### DeadlineChip

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `days` | yes | `number` |  |  |
| `severity` | yes | `ClockSeverity` |  |  |
| `basis` | no | `ReactNode` |  |  |
| `children` | no | `ReactNode` |  | What is due and the date, e.g. the settlement for a named person · due 29 Sep. |
| `interestAccruing` | no | `boolean` |  | The server says late-payment interest is accruing (shown only on `over`). |

<!-- /ds:props -->

The values of `ClockSeverity` are `far`, `due` and `over`.

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/deadline-chip/deadline-chip.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border-color` |
| `--due-bd` | `border-color` |
| `--due-bg` | `background` |
| `--due-tx` | `color` |
| `--fw-medium` | `font-weight` |
| `--muted` | `background` |
| `--over-bd` | `border-color` |
| `--over-bg` | `background` |
| `--over-tx` | `color` |
| `--space-1` | `gap` |
| `--space-3` | `gap` |
| `--steel` | `color` |
| `--text-sm` | `font-size` |

<!-- /ds:tokens -->

The chip also carries the global `chip` class. Its tokens are on the [Chip](chip.md#tokens-it-reads) page; of
those, the plain `chip` rule reads `--space-1`, `--space-2`, `--space-5`, `--radius-sm`, `--text-xs` and
`--fw-medium`, and the rest belong to tones this component does not use.
