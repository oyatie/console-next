<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# ChainStepper

A chain stepper shows a chain of people who act in turn, such as an approval or an exit, as an ordered list: who
has acted, whose turn it is and who waits.

It lives in `apps/web/src/ui/chain-stepper`: the component in `chain-stepper.tsx` and its styles in
`chain-stepper.module.css`.

## When to use it, and when not

There are two layouts, picked by `variant`.

| Layout | Use it for |
|---|---|
| Vertical list (default) | The whole chain on a record or in a dialog: every step, with when it happened, its deadline and what happens next. |
| `variant="chips"` | One line in a table row: the steps around the current one, and a count of the rest. |

The stepper only displays. The caller works out each step's state and passes the steps in order.

The vertical list is used in five places: `features/approvals/ui/approval-viewer.tsx`,
`features/org/ui/change-chain.tsx`, `features/people/ui/exit-axis.tsx`, the override sheet (`ui/override-sheet`)
and the routing preview of the composer (`ui/composer/routing.tsx`). The chips are used in one: the route column
of the approvals list, `features/approvals/ui/approvals-page.tsx`.

| Do not use it for | Use instead |
|---|---|
| The steps of a task one person works through on a page | [`StepLine`](step-line.md). |
| The stages of one record's life, by label and not by person | `GateRail` (`ui/gate-rail.tsx`). |
| A first-run checklist with an action on each step | `SetupRail` (`ui/setup-rail`). |
| The decision on the current step | [`ApprovalCard`](approval-card.md). The stepper has no controls. |
| A deadline on its own | `DeadlineChip` (`ui/deadline-chip`). Inside a step it goes in `deadline`. |
| The state of a record as one word | [`Chip`](chip.md). |

## Anatomy

A step is a `ChainStep` object:

| Field | Required | Holds |
|---|---|---|
| `key` | yes | The React key of the step. It must be unique among the steps of one stepper. |
| `who` | yes | Who acts at this step, by name and role. Any node. |
| `state` | yes | `done`, `current`, `waiting` or `failed`. |
| `meta` | no | When it happened, or whose turn it is. Vertical list only. |
| `note` | no | What happens once this step is done. Vertical list only, and only on a `current` step. |
| `deadline` | no | A `DeadlineChip` for this step. Vertical list only. |

**The vertical list:**

| Part | Element | Holds |
|---|---|---|
| List | `<ol aria-label>` | One item for each step, in the order given. |
| Step | `<li data-state>` | The parts below. A `current` step carries `aria-current="step"`. |
| Number | `<span aria-hidden="true">` | The step's place in the list, counted from 1. |
| Who | `<span>` | A visually hidden `<span class="sr-only">` with the state word, then `who`. |
| Meta | `<span>` | `meta`, then `deadline`. Left out when neither is given. |
| Note | `<span>` | `note`. Rendered only when the step is `current`. |

Nothing separates the parts of a step in the markup. Its text content is the number, the state word, `who`, then
the meta and the note, with no space between them. The state words end in a colon, so `who` follows the colon
directly. A test that matches a step's text should match a part of it. In the chips the state word is the name of
the icon and not text, so a chip's text content is `who` alone.

**The chips:**

| Part | Element | Holds |
|---|---|---|
| List | `<ol aria-label title>` | The step chips, then the count chip. `title` holds the whole chain as text. |
| Step chip | `<li class="chip chip--<tone>" data-state>` | A 12 px icon, an `<svg role="img" aria-label>` named with the state word, then `who`. A `current` step carries `aria-current="step"`. |
| Count chip | `<li class="chip chip--neutral">` | Message `uiChainStepper.more` with the number of steps that are not shown. Rendered only when some are not shown. |

The chips do not render `meta`, `note` or `deadline`.

Which steps the chips show:

- At most `max` steps, 3 by default.
- The window is placed by the first step that is `current` or `failed`. It starts `max - 2` steps before that
  step. With the default that is the step before it, the step itself and the step after it.
- The window never runs past either end of the chain. Near an end it slides inward and still holds `max` steps.
  A chain of `max` steps or fewer is shown whole.
- With no `current` or `failed` step, the last `max` steps are shown.
- The count is every step that is not shown, before the window and after it. The count chip is always last.
- With `max` of 1 the window is the step after the current or failed one, not that step, unless it is the last
  of the chain. No caller passes `max`.

The `title` of the chips list names every step, shown or not: the state word and `who`, joined by arrows. A `who`
that is not a plain string is left out, and only its state word appears.

## Looks and sizes

Each layout has one size. No prop picks one.

**The vertical list** is a column, 8 px (`--space-2`) between steps.

| Part | Look |
|---|---|
| Step | A grid of three columns, `max-content minmax(0, 1fr) fit-content(50%)`: the number, who, the meta. 12 px (`--space-3`) between columns, 4 px (`--space-1`) between rows, centred on the cross axis. 13 px (`--text-sm`) text. |
| Number | A 24 px box (`--space-5`) with a 10 px radius (`--radius-lg`) and a 1 px border. 12 px (`--text-xs`) tabular numerals, centred. |
| Who | Takes the spare width and can shrink to nothing. A long word breaks anywhere. |
| Meta | 12 px (`--text-xs`). A row that wraps, 8 px (`--space-2`) between items, aligned to the end. Never wider than half the step. A long word breaks anywhere. |
| Note | A row of its own, from the second column to the end, in `--ink`. |

`state` picks the colours of a step:

| `state` | Step text | Number box |
|---|---|---|
| `done` | `--steel` | `--ok-bg` fill, `--ok-bd` border, `--ok-tx` number |
| `current` | `--ink`, medium (`--fw-medium`) | `--primary` fill and border, `--on-primary` number |
| `waiting` | `--steel` | No fill, `--border` border, `--steel` number |
| `failed` | `--danger-tx` | `--danger-bg` fill, `--danger-bd` border, `--danger-tx` number |

`waiting` has no rule of its own: it is the look of a step with no other state.

**The chips** are one row, 4 px (`--space-1`) between chips, that does not wrap and is never wider than its
container. Each chip takes the global `chip` look: see [Chip](chip.md).

| `state` | Tone class | Icon |
|---|---|---|
| `done` | `chip--ok` | A check |
| `current` | `chip--info` | A circle with a dot |
| `waiting` | `chip--neutral` | An empty circle |
| `failed` | `chip--danger` | A cross |

- The icon is 12 px, with 4 px (`--space-1`) after it.
- A step chip shrinks when the row is too narrow, and its text ends in an ellipsis. The count chip never shrinks.
- The stylesheet sets the current chip to medium weight (`--fw-medium`). The global `chip` rule already gives
  every chip that weight, so the current chip is no heavier than the others. Its icon and its tone set it apart.

A state the component does not know still renders. The chips draw it with the empty circle and the neutral tone.
The vertical list draws it with the base look. In both, its state word is the message id itself, because the
catalog lookup falls back to the id.

## States

| State | What happens |
|---|---|
| Rest | Each step in the look of its `state`, above. |
| Hover | No look. The chips list has a `title`, which a browser shows as a tooltip under a mouse pointer. |
| Keyboard focus | Does not exist. Nothing in the stepper can take focus, and its stylesheet has no focus rule. |
| Pressed down, selected | Do not exist. |
| Disabled, read-only | Do not exist. The stepper has no control to disable. |
| Invalid | Does not exist. `failed` is the state of a step, not a validation state. |
| Loading | Does not exist. There is no pending prop and no placeholder. |
| Empty | With no steps the stepper renders an empty `<ol>` that still has its name; in the chips layout its `title` is empty too. Nothing checks for it. The approval viewer and the approvals list render the stepper only when the route has steps. A step with no `meta` and no `deadline` has no meta element. |

## Keyboard

None. The stepper cannot take focus and handles no key.

The tooltip of the chips list is a `title` on an element that cannot take focus, so no key opens it.

The stepper takes no text and handles no key, so it has no rule for a key the Korean input method owns. A search of
the component's folder for `isComposing`, `keyCode`, `229` and `composition` finds nothing.

## Accessibility contract

- **Role:** `list`, from the `<ol>`, with a `listitem` for each step.
- **Accessible name:** `aria-label` on the list: `label`, or message `uiChainStepper.label` when `label` is not
  given.
- **State of a step:** in words, before `who`. The vertical list puts the state word in visually hidden text. The
  chips name the icon with it. The words are messages `uiChainStepper.state.done`, `.current`, `.waiting` and
  `.failed`.
- **Current step:** `aria-current="step"` on the item.
- **Place in the chain:** the order of the list. The number shown in the vertical list is hidden from a screen
  reader.
- **Announced:** nothing. The stepper has no live region. A step that changes state is not announced.

The chips list has both an `aria-label` and a `title`. The name comes from `aria-label`, so by the HTML
accessibility mapping the `title` is left to be the list's description. Whether a description on a list is read
is up to the screen reader.

Known gaps:

- In the vertical list the state word is hidden text. On screen, by the stepper's own rules, a `done` step and a
  `waiting` step differ only in the colours of the number box, and a `failed` step differs only in colour too. The
  visible words are the caller's, in `meta`.
- In the chips, the steps that are not shown are named only in the `title`. So is the rest of a name that a
  narrow row cut to an ellipsis: the `title` is on the list, and a chip has none of its own. A mouse pointer opens
  it. A keyboard and a touch screen do not. A `who` that is not a string is missing from it.
- The count chip reads as a plus sign and a number, with no noun.
- The current chip is not heavier than the others, though the stylesheet's comment says it is marked by weight.
- `max` of 1 leaves the current step out of the window: see Anatomy.
- Two steppers that both use the default name on one page have the same accessible name.

The WCAG 2.2 criteria that apply:

| Criterion | How the stepper answers it |
|---|---|
| 1.1.1 Non-text Content | Each chip icon has a text alternative, the state word. The number is decoration: the list order carries it. |
| 1.3.1 Info and Relationships | An ordered list, `aria-current="step"`, and the state of each step as text. |
| 1.4.1 Use of Color | The chips answer it with an icon for each state. The vertical list does not answer it by itself: see the first gap. |
| 1.4.3 Contrast (Minimum), 1.4.11 Non-text Contrast | Every colour is a token; none is written in the component. |
| 1.4.10 Reflow | The vertical list wraps who and meta and breaks long words. The chips stay on one line and shorten with an ellipsis. |
| 2.1.1 Keyboard | Nothing to operate. The tooltip's text cannot be reached from a keyboard: see the second gap. |

The gallery shows four steppers in `apps/web/src/ui/chain-stepper/chain-stepper.gallery.tsx`:

- a vertical list with done, current and waiting steps, the current one with a deadline and a note;
- a vertical list with a done step and a failed step that has a long meta;
- chips for a chain of four steps;
- chips for a chain of six.

Both chips examples have a current step and a count chip. The gallery does not show chips that all fit, a failed
chip or a chain with no current step.

These tests assert its output. They were found by searching `e2e` and `apps/web/src` for the component's name,
its message ids, `aria-current="step"`, the composer's routing preview and the name the approvals views give the
list, message `approvals.preview.route`. A test that reaches the stepper through another caller and names it some
other way is not in this list.

- `chain-stepper.test.tsx`: the chips keep the current step in the window, say its state in text and count the
  steps that are not shown; the `title` names all six steps; a chain of three shows no count chip; the vertical
  list renders every step and has no `title`.
- `chain-stepper.browser.test.tsx`: at 1280 and 390 px, in both themes, a long rejection note in `meta` wraps
  inside the list with no sideways overflow in the page, the list or its rows, and a short name with a role stays
  on one line.
- `features/approvals/ui/approvals-page.browser.test.tsx`: at 1440 and 390 px, in both themes, the chips in a
  row of the approvals list have the route's two steps and mark the current one.
- `e2e/mock/approvals.spec.ts`, against a mocked server:
  - at 1440 and 390 px, in both themes, the vertical list in the record column is found by its name, has one
    item for each step of the route, and its current step holds the role and the name;
  - at 1440 px only, the chips in the row mark the same current step, and the last item reads "+2";
  - a row whose route is empty renders no list;
  - for a route whose steps are all done, nothing in the row or in the record column has `aria-current="step"`,
    and the column's list still has one item for each step.
- `e2e/mock/approval-viewer.spec.ts`, `e2e/mock/approval-document.spec.ts` and `e2e/approval-document.spec.ts`
  assert the card that holds the stepper in the approval viewer, by text inside it. The first also asserts that
  the card comes before the document body and that a document with no route has no such card.
- `ui/composer/composer.test.tsx`: steps passed as the composer's routing render as an `<ol>` that holds `who`,
  inside the approvals section. `e2e/mock/composer.spec.ts`: a routed composer in the gallery shows a list in that
  section.

None of these asserts which steps the chips show for a chain with no current step: the mock spec asserts only
that nothing in the row is current. None asserts the window for a failed step or for a `max` other than 3.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component).

## Phone behaviour at 390 px

Nothing in `chain-stepper.module.css` changes with the width of the screen. It has no media query and no container
query.

- The vertical list keeps its three columns at every width. The meta takes at most half of the step, and who and
  meta wrap and break long words. The browser test above checks this at 390 px.
- The chips stay on one line. Step chips shrink and end in an ellipsis; the count chip keeps its width.
- Nothing in the stepper is a touch target.
- The tooltip of the chips list cannot be opened by touch.

A view can limit the width the chips get. The approvals list wraps them in an element of its own with
`min-width: 0` and `max-width: 100%`.

## Copy rules

- The stepper owns these message ids, in `packages/i18n/src/catalogs/en/ui-chain-stepper.ts` and its `ko` twin:

| Message id | Where it shows |
|---|---|
| `uiChainStepper.label` | The accessible name of the list, when `label` is not given. |
| `uiChainStepper.state.done`, `uiChainStepper.state.current`, `uiChainStepper.state.waiting`, `uiChainStepper.state.failed` | The state word: hidden text in the vertical list, the icon's name in the chips, and each step's prefix in the `title`. |
| `uiChainStepper.more` | The count chip. It takes `count`. |
| `uiChainStepper.mine` | Not read by the component. Two gallery files read it: the stepper's passes it as the `meta` of the current step, and the approval card's, `ui/approval-card/approval-card.gallery.tsx`, passes it as the card's `step`. A search of `apps/web/src` finds no feature that reads it. |
| `uiChainStepper.name` | Not read by the component. The gallery uses it as the title of its section. |

- The state words end in a colon in both catalogs, because each is read straight before `who`.
- `who`, `meta` and `note` are the caller's, from the message catalog in `packages/i18n`. The `en` catalog is the
  source and the `ko` catalog must define every id.
- `who` names the person and the role. In the chips it should be a plain string, or the `title` leaves it out.
- `meta` is where the visible state of a step goes: when it was approved, that it is someone's turn, that it was
  never reached.
- Pass `label` when a page has more than one chain, so that each list has its own name.
- The gallery's sample names are in the gallery catalog, which production builds leave out.

## Props

`ChainStep` is the object described under Anatomy.

<!-- ds:props apps/web/src/ui/chain-stepper/chain-stepper.tsx -->

### ChainStepper

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `steps` | yes | `ChainStep[]` |  |  |
| `label` | no | `string` |  |  |
| `max` | no | `number` | `3` |  |
| `variant` | no | `"chips"` |  |  |

<!-- /ds:props -->

## Tokens it reads

The chips take their fill, border, text colour, height and padding from the global `chip` classes in `app.css`,
which are not listed here: see the token table of [Chip](chip.md). The hidden state word uses the global `sr-only`
class, which reads no token.

<!-- ds:tokens apps/web/src/ui/chain-stepper/chain-stepper.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border` |
| `--danger-bd` | `border-color` |
| `--danger-bg` | `background` |
| `--danger-tx` | `color` |
| `--fw-medium` | `font-weight` |
| `--ink` | `color` |
| `--ok-bd` | `border-color` |
| `--ok-bg` | `background` |
| `--ok-tx` | `color` |
| `--on-primary` | `color` |
| `--primary` | `background`, `border-color` |
| `--radius-lg` | `border-radius` |
| `--space-1` | `gap`, `margin-inline-end` |
| `--space-2` | `gap` |
| `--space-3` | `gap` |
| `--space-5` | `height`, `width` |
| `--steel` | `color` |
| `--text-sm` | `font-size` |
| `--text-xs` | `font-size` |

<!-- /ds:tokens -->
