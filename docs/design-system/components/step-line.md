<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# StepLine

A step line shows the steps of a page-wide task in one row: a numbered box and a label for each step, a check in
the box once the step is done, and a rule between steps.

It lives in `apps/web/src/ui/step-line`: the component in `step-line.tsx` and its styles in
`step-line.module.css`.

## When to use it, and when not

Use it for a task that one person works through in a fixed order on one page, to show where they are: pick
people, edit, check, apply.

The step line only displays. The caller works out the state of every step and passes the steps in order. A step
cannot be pressed.

Five feature views use it:

| View | Where it puts the line |
|---|---|
| `features/people/ui/grid-page.tsx`, `features/people/ui/renew-page.tsx`, `features/import/ui/import-page.tsx` | In the `tools` of the page head (`ui/page-head`). |
| `features/people/ui/bulk-page.tsx` | In the `subtitle` of the composer (`ui/composer`), after the phase line. In its page layout the composer passes that to the page head as `sub`. |
| `features/payroll/ui/run-page.tsx` | In the page's content, under the facts of the run. |

| Do not use it for | Use instead |
|---|---|
| People who act in turn, with times and deadlines | [`ChainStepper`](chain-stepper.md). |
| The stages of one record's life, or a step that failed | `GateRail` (`ui/gate-rail.tsx`). It has a failed look; the step line has none. |
| A first-run checklist with an action on each step | `SetupRail` (`ui/setup-rail`). |
| Views a person switches between | `Tabs` or `PageTabs` (`ui/tabs`). |
| How much of a quantity is used | `Meter` (`ui/meter`). |
| Whether a page is in setup or in operation | `PhaseLine` (`ui/page-head/phase-line.tsx`). |

## Anatomy

A step is a `Step` object: a `key`, a `label` string and a `state` of `done`, `current` or `waiting`. `key` is
the React key of the step and must be unique among the steps of one line.

| Part | Element | Holds |
|---|---|---|
| List | `<ol aria-label>` | One item for each step, in the order given. |
| Step | `<li data-state>` | The number and the label. A `current` step carries `aria-current="step"`. |
| Number | `<span aria-hidden="true" data-n>` | For a `done` step, a 14 px check icon, an `<svg>`. For any other step, nothing: the stylesheet draws the number from `data-n`, the step's place counted from 1, as generated content. |
| Label | `<span>` | `label`. |
| Rule | The `::before` of every step but the first | A line. It is generated content of the step that follows it. |

There is no slot. A label is a string, not a node, and a step takes nothing else.

## Looks and sizes

There is one look and one size. No prop picks a variant.

| Part | Look |
|---|---|
| List | A row that wraps, 8 px (`--space-2`) between steps and between wrapped rows, centred on the cross axis. 13 px (`--text-sm`) text. No margin, no padding, no list marker. |
| Step | A row: the rule, the number, the label, 4 px (`--space-1`) apart. `--steel` text. |
| Rule | 32 px wide (`--space-6`), 1 px high, `--control-border`, with an 8 px (`--space-2`) margin after it, on top of the step's 4 px gap. |
| Number | A 24 px box (`--space-5`) with a 10 px radius (`--radius-lg`) and a 1 px `--control-border` border. 12 px (`--text-xs`) bold (`--fw-strong`) tabular numerals, centred. |

`state` picks the colours:

| `state` | Step text | Number box |
|---|---|---|
| `done` | `--steel` | `--ok-solid` fill and border. A `--surface` check, drawn with a stroke 3 wide, in place of the number. |
| `current` | `--ink`, medium (`--fw-medium`) | `--primary` fill and border, `--on-primary` number. |
| `waiting` | `--steel` | No fill, `--control-border` border, `--steel` number. |

`waiting` has no rule of its own: it is the look of a step with no other state. There is no failed state. A
`state` the component does not know is drawn like `waiting`.

## States

The step line has no states of its own beyond the three step states above.

| State | What happens |
|---|---|
| Rest | Each step in the look of its `state`. |
| Hover, keyboard focus, pressed down, selected | Do not exist. Nothing in the line can take focus or be pressed, and its stylesheet has no rule for any of them. |
| Disabled, read-only | Do not exist. The line has no control. |
| Invalid | Does not exist. |
| Loading | Does not exist. There is no pending prop and no placeholder. |
| Empty | With no steps the line renders an empty `<ol>` that still has its name. Nothing checks for it. |

Nothing requires one step to be `current`. Two callers pass a line with none:

- `features/import/ui/import-page.tsx` passes every step as `done` once the import has finished.
- `features/payroll/ui/run-page.tsx` passes every step as `done` for a complete run, and every step as `waiting`
  for a void run. A browser test asserts both: see the tests below.

Nothing limits `current` to one step either. Every step passed as `current` gets `aria-current="step"` and the
current look.

## Keyboard

None. The step line cannot take focus and handles no key. No key moves between steps.

The step line takes no text and handles no key, so it has no rule for a key the Korean input method owns. A search
of the component's folder for `isComposing`, `keyCode`, `229` and `composition` finds nothing.

## Accessibility contract

- **Role:** `list`, from the `<ol>`, with a `listitem` for each step.
- **Accessible name:** `aria-label` on the list, from `label`. The prop is required.
- **Current step:** `aria-current="step"` on the item.
- **What a step reads as:** its label and nothing else. The number box is hidden from a screen reader, with the
  number or the check inside it. The place of a step comes from the order of the list.
- **Announced:** nothing. The line has no live region. A step that becomes current or done is not announced.

Known gaps:

- Nothing tells a screen reader that a step is done. The check is inside the hidden box, and there is no hidden
  word and no attribute for it. A step before the current one can be taken as done; when no step is current, as
  on the import page after it has finished, nothing in the line says where the task stands.
- A step cannot be marked as failed.

The WCAG 2.2 criteria that apply:

| Criterion | How the step line answers it |
|---|---|
| 1.1.1 Non-text Content | The number and the check have no text alternative. The number repeats the list order. The check does not repeat anything a screen reader gets: see the first gap. |
| 1.3.1 Info and Relationships | An ordered list and `aria-current="step"`. The done state is on screen only. |
| 1.4.1 Use of Color | A done step has a check where the number was. The current step has a filled box and heavier, darker text. Neither rests on colour alone. |
| 1.4.3 Contrast (Minimum), 1.4.11 Non-text Contrast | Every colour is a token; none is written in the component. |
| 1.4.10 Reflow | The row wraps. |
| 2.1.1 Keyboard | Nothing to operate. |

The component has no gallery file of its own. The gallery shows one line, with a done step and a current step, in
`apps/web/src/gallery/sections/structure.gallery.tsx`. It does not show a waiting step or a line that wraps.

These tests assert its output. They were found by searching `e2e` and `apps/web/src` for the component's name,
`aria-current="step"` and the message ids its callers name the list with.

- `apps/web/src/ui/step-line/step-line.test.tsx`, the first of its two tests: for a line of three steps it finds
  the labels of the first two in the markup, `aria-current="step"`, and the `done` and `current` states. The
  second test in that file is for `GateRail`.
- `features/payroll/ui/run-header.browser.test.tsx`, for a staged, an issued and a void run: the list is found by
  its name and has six items, with no button or link inside. One item is current for the staged run and none for
  the other two. All six are `done` for the issued run and none for the other two.
- `e2e/states/payroll-runs.spec.ts`, on the run page at 1440 and 390 px: the list has six items, holds every
  stage label, has no link or button, and its current step reads `payroll.stage.attendance`. The list is absent
  while the run is loading, failed, refused or missing.
- On the import page, `e2e/people.spec.ts`, `e2e/import/zip-headers.spec.ts`, `e2e/import/any-layout.spec.ts`,
  `e2e/import/two-entities.spec.ts` and `e2e/parity/employee-e7.capture.spec.ts` assert the text of the element
  that has `aria-current="step"`: `import.step.preview` or `import.step.dryrun`. They look for it in the whole
  page, not in the list.

None of these asserts the check, the drawn number, the rule, a `waiting` step by its state or the wrapping.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component).

## Phone behaviour at 390 px

Nothing in `step-line.module.css` changes with the width of the screen. It has no media query and no container
query.

- The row wraps: a step that does not fit drops to the next row.
- The rule belongs to the step that follows it, so it wraps with that step. A wrapped row starts with a rule.
- Nothing in the line is a touch target.

A search of the stylesheets under `apps/web/src` for the component's name finds no view that restyles it. Where
the line sits at phone width is up to what holds it. The `tools` slot of the page head, which three of the five
callers use, is itself a row that wraps (`.tools` in `ui/page-head/page-head.module.css`), inside the head's
title row, which wraps too. So there the line shares a wrapping row with any other tool the caller passes.

## Copy rules

- The step line holds no text of its own and owns no message id. It does not import the message catalog.
- `label`, the name of the list, and the `label` of each step come from the message catalog in `packages/i18n`,
  through the caller. The `en` catalog is the source and the `ko` catalog must define every id.
- The callers name the list with `bulk.page.steps`, `renew.steps`, `import.steps` and `payroll.stages.title`. The
  gallery uses `common.steps`.
- A step's label is a word or two that names the step. It must make sense without its number: the number is not
  read out.
- The gallery's sample labels are in the gallery catalog, which production builds leave out.

## Props

`Step` is the object described under Anatomy.

<!-- ds:props apps/web/src/ui/step-line/step-line.tsx -->

### StepLine

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `label` | yes | `string` |  |  |
| `steps` | yes | `readonly Step[]` |  |  |

<!-- /ds:props -->

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/step-line/step-line.module.css -->

| Token | Read by |
| --- | --- |
| `--control-border` | `background`, `border` |
| `--fw-medium` | `font-weight` |
| `--fw-strong` | `font-weight` |
| `--ink` | `color` |
| `--ok-solid` | `background`, `border-color` |
| `--on-primary` | `color` |
| `--primary` | `background`, `border-color` |
| `--radius-lg` | `border-radius` |
| `--space-1` | `gap` |
| `--space-2` | `gap`, `margin-right` |
| `--space-5` | `height`, `width` |
| `--space-6` | `width` |
| `--steel` | `color` |
| `--surface` | `color` |
| `--text-sm` | `font-size` |
| `--text-xs` | `font-size` |

<!-- /ds:tokens -->
