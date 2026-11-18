<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# ApprovalCard

An approval card is where one person decides one item at the step they hold: what approving does is stated above
the decisions, reject and request changes stand beside approve at the same height, and each of those two opens a
reason form before it commits.

It lives in `apps/web/src/ui/approval-card`: the component in `approval-card.tsx` and its styles in
`approval-card.module.css`.

## When to use it, and when not

Use it for one approval item on which the server offers this person approve and reject, with or without request
changes. One feature renders it: the approval viewer, `features/approvals/ui/approval-viewer.tsx`, and only when
the server offers both commands. The viewer is shown in two places: on a page of its own, and in the record column
of the approvals list (`features/approvals/ui/approvals-page.tsx`), which is a pane of `FlexibleColumns`
(`ui/flexible-columns`). The column is where the card's `data-escape-scope` attribute matters: see Keyboard.

Two rules for the caller:

- Give the card a `key` that is the item's id. The open form is the card's own state, and a new key is what stops
  it from carrying over to the next item. The viewer keys the panel that holds the card.
- Pass `returnLabel`, `returnConsequence` and `onReturn` together, or none of them. The type refuses one or two.
  Without them the card offers approve and reject only.

| Do not use it for | Use instead |
|---|---|
| A commit that is not a decision on someone else's request: saving a form, applying a bulk edit | [`ActionBar`](action-bar.md). |
| An exception to a soft rule, with a reason and the route the server chose | `OverrideSheet` (`ui/override-sheet`). |
| Confirming a section of values that were filled in for the person | `SectionConfirm` (`ui/section-confirm`). |
| A box that only holds content | [`Card`](card.md). |
| The list of items that wait for a decision | `Table` (`ui/table.tsx`), as the approvals list does. |
| The chain of approvers | [`ChainStepper`](chain-stepper.md), in `children` or beside the card. The card draws no chain. |
| The reason codes and the memo | `ReasonField` (`ui/reason`), returned from `reason`. The card owns no codes and no rule about which code needs a memo. |
| One command that a rule blocks, anywhere else | [`DisabledReason`](disabled-reason.md). |

## Anatomy

The card has three shapes: deciding, a reason form, and recorded.

**Deciding** is the shape at rest.

| Part | Element | Holds |
|---|---|---|
| Card | `<article class="card">` | Everything. It carries `aria-busy="true"` while `pending` is set. |
| Progress | `<div>` | `progress`. Left out when it is not given. |
| Body | `<div>` | The eyebrow, the step, the title and `children`, in that order. |
| Eyebrow | `<div>` | `eyebrow`. Always rendered. |
| Step | `<span>` | `step`. Always rendered. |
| Title | `<h2>` | `title`. |
| Children | None of its own | `children`, as passed. |
| Consequence | `<div role="note">` | `consequence`. |
| Bar | `<div>` | In this order: the blocked reason, a `<span>`, only with `approveBlocked`; the meta, a `<span>`, only with `meta`; a spacer `<span>`; the reject button; the request-changes button, only with `onReturn`; the approve button. |

**A reason form** opens when reject or request changes is pressed. It takes the place of the consequence and the
bar. The body above it stays.

| Part | Element | Holds |
|---|---|---|
| Form | `<section>` | The four parts below. It is named by its heading through `aria-labelledby`. |
| Form heading | `<h3 tabindex="-1">` | `rejectLabel` or `returnLabel`. |
| Reason | None of its own | What `reason` returns for the open form, `"reject"` or `"return"`. |
| Consequence | `<div role="note">` | `rejectConsequence` or `returnConsequence`. |
| Bar | `<div>` | A back button; a spacer `<span>`; the missing-reason text, a `<span>`, only while the reason is not complete; the commit button, which shows the same label as the heading. |

The reason is complete when `reasonComplete` is `true`, or, when it is a function, when it returns `true` for the
open form.

**Recorded** is the shape whenever `receipt` is given, whatever else is passed. The component tests `receipt` for
truth, so any falsy value is not given: `false`, `null`, `undefined`, `0` or an empty string.

| Part | Element | Holds |
|---|---|---|
| Card | `<article class="card">` | The two parts below. |
| Progress | `<div>` | `progress`. Left out when it is not given. |
| Done | `<div>` | `next` in a `<div>` of its own, when given, then `receipt` as passed. |

The recorded card renders no eyebrow, step, title, `children`, consequence or button.

Every button is a React Aria `Button`, a native `<button type="button">`, with the global `btn` classes. The card
does not use the `Button` of `ui/button`.

The form is a `<section>`, not a `<form>`. Nothing is submitted, and Enter in a field of the reason commits
nothing.

## Looks and sizes

There is one look and one size. No prop picks a variant.

| Part | Look |
|---|---|
| Card | The global `card` class: a `--surface` fill, a 1 px `--border` border, a 10 px radius (`--radius-lg`) and the `--shadow` shadow. `width: min(100%, var(--card-w))`: as wide as its container, up to 640 px. A column that clips what overflows it. |
| Progress | A row, 12 px (`--space-3`) between its items. 8 px (`--space-2`) top and bottom and 16 px (`--space-4`) side padding, 13 px (`--text-sm`) `--steel` text, and a 1 px `--border-soft` line under it. |
| Body | A column, 8 px (`--space-2`) between its parts, with 16 px (`--space-4`) padding. |
| Eyebrow | A row, 8 px (`--space-2`) between its items. 12 px (`--text-xs`) `--steel` text with `--tracking-label` letter spacing (0.4 px). |
| Step | A tag as wide as its text, at the start of the body's column: a `--primary-soft` fill, `--primary` text, 12 px (`--text-xs`) medium (`--fw-medium`), 8 px (`--space-2`) side padding and a 4 px radius (`--radius-sm`). |
| Title | 20 px (`--text-xl`), bold (`--fw-strong`), no margin. |
| Consequence | A box 16 px (`--space-4`) in from the card's sides: a `--surface` fill, a 1 px `--ink` border, a 6 px radius (`--radius`), 12 px (`--space-3`) padding and 14 px (`--text-body`) text. Its children are a column, 4 px (`--space-1`) apart. A `<p>` inside has no margin, and a `<p>` that follows another `<p>` is 13 px (`--text-sm`) and `--steel`. |
| Bar | A row that wraps, 8 px (`--space-2`) between items, centred on the cross axis. Padding: 12 px (`--space-3`) on top, 16 px (`--space-4`) at the sides and the bottom. The spacer takes the spare width of its row, so the buttons sit at the end. |
| Buttons | The global `btn` look, at least 40 px high (`--row-h`). A plain `btn` is at least 36 px (`calc(var(--row-h) - var(--space-1))`); the card's stylesheet raises the ones that are direct children of the bar. |
| Meta | 12 px (`--text-xs`), `--steel`. |
| Missing-reason text | 13 px (`--text-sm`), `--steel`, at most `calc(var(--panel-w) / 1.5)` wide, which is about 293 px. |
| Blocked reason | The same text, on a full row of its own before the meta and the buttons, with no width limit and `text-align: right`. |
| Form | A column, 12 px (`--space-3`) between its parts, with a 1 px `--border-soft` line and 16 px (`--space-4`) of padding on top. Every direct child other than the consequence and the bar takes 16 px (`--space-4`) side margins and no margin above or below. |
| Form heading | 16 px (`--text-lg`), bold (`--fw-strong`), with `outline: none`. |
| Done | A column, 12 px (`--space-3`) between its parts, with 16 px (`--space-4`) padding. `next` comes first and sits at the start of its row. |

The buttons take these classes:

| Button | Classes |
|---|---|
| Reject, request changes, back | `btn` |
| Approve | `btn btn--primary` |
| The commit of the request-changes form | `btn btn--primary` |
| The commit of the reject form | `btn btn--danger` |

Reject, request changes and approve share one minimum height and sit side by side while the row has room. Approve
differs only in its `btn--primary` colours.

## States

| State | What happens |
|---|---|
| Rest | The deciding shape. |
| Hover | The card has no hover look. A button takes the global hover fill of its class: `--muted` for `btn`, `--primary-hover` for `btn--primary`, `--danger-tx` for `btn--danger`. |
| Keyboard focus | A button shows the global 2 px `--primary` outline, 2 px away. The form heading takes focus when a form opens, and its rule sets `outline: none`. That rule has the same specificity as the global `:focus-visible` rule and comes after it: the card's stylesheet reaches the app only with a lazily loaded screen, after `app.css`. So the heading shows no focus indicator. This was read from the stylesheets and the routes, not checked in a browser. |
| Pressed down | No look. Neither `approval-card.module.css` nor `app.css` has an `:active` rule or a `data-pressed` rule. |
| Selected | Does not exist. An open form is not marked on the button that opened it: that button is not rendered while the form is open. |
| Disabled | The native `disabled` attribute, drawn by the global `.btn[disabled]` rule: half opacity and a `not-allowed` cursor. Approve is disabled while `approveBlocked` is set. The commit of a form is disabled until the reason is complete. Every button is disabled while `pending` is set. In the first two cases the reason is visible text in the bar; while `pending`, nothing says why. |
| Read-only | Does not exist. No prop shows the item without its decisions, other than `receipt`. |
| Invalid | None of its own. A reason that is not complete is not drawn as an error: the commit is disabled and the missing-reason text is `--steel`. What `reason` returns brings its own invalid look. |
| Loading | `pending` sets `aria-busy="true"` on the card and disables every button. There is no spinner and no text. The three values of `pending` render alike: the component only tests whether it is set. |
| Empty | `progress`, `meta`, the blocked reason, the request-changes button and `next` are left out when they are not passed. The eyebrow and the step are always rendered, so an empty `step` leaves an empty `<span>` in the body's column. The viewer passes the label of the current step of the route, which is `undefined` when no step is current. |

## Keyboard

| Key | What it does |
|---|---|
| Tab, Shift+Tab | Moves through what can take focus, in document order: `progress`, the body with `children`, then the bar. In the deciding shape the bar's order is reject, request changes, approve. In a form it is the reason's own controls, back, then the commit. A disabled button is skipped. |
| Enter, Space | Presses the focused button. |
| Escape | With a form open and `pending` not set: closes the form, as back does. Focus can be anywhere inside the card, `children` included. |

The card moves focus twice:

- When a form opens, focus goes to the form heading.
- When a form closes, by back or by Escape, focus returns to the button that opened it.

Those are its only `focus()` calls, and both are in the effect that runs when the open form changes. It does not
move focus when a commit is pressed, when `pending` is set or cleared, or when `receipt` arrives.

Escape is a native `keydown` listener on the `<article>`, in the bubble phase, added only while a form is open
and `pending` is not set. A key pressed anywhere inside the card reaches it: in the form, in `progress` or in
`children`. It does nothing when a handler that ran before it has called `preventDefault`. Otherwise it calls
`preventDefault` and `stopPropagation` and closes the form.

Which handlers run before it was read from the code and is not tested:

- A listener in the capture phase runs first, and so does a native listener on an element inside the card. Either
  can keep an Escape from the card with `preventDefault`.
- A React `onKeyDown` inside `children` or `reason` does not run first. React handles it at the root of the app,
  which a bubbling key reaches after the `<article>`. Such a handler cannot stop the card with `preventDefault`,
  and the card's `stopPropagation` keeps that Escape from reaching it at all. A React `onKeyDownCapture` does run
  first.

While the listener is on, the card also carries a `data-escape-scope` attribute. One other component reads that
attribute: `FlexibleColumns` (`ui/flexible-columns`), whose own Escape handler closes an open pane and leaves a key
pressed inside such an element alone. That handler is on `document` in the capture phase, so it sees the key
before the card does. In the record column of the approvals list the first Escape closes the form and the next one
closes the column. While `pending` is set the listener and the attribute are both gone, so the card no longer
keeps an Escape from the columns.

A key the Korean input method owns: the Escape listener returns at once when `event.isComposing` is true. That is
all the code checks. It has no key code 229 check, which `Field` (`ui/field`), `Composer` (`ui/composer`) and
`MaskedField` (`ui/masked-field`) pair with `isComposing` in their own key handlers. What an Escape pressed during
a composition does, in the reason's memo for one, is untested: no approvals spec presses a key during a
composition. A search of the component's folder for `isComposing`, `keyCode`, `229` and `composition` finds that
one line. The card binds no other key, and Enter and Space on a button are the library's.

## Accessibility contract

- **Role:** `article`, from the element. The form is a `<section>` with a name, which makes it a region. Each
  consequence box has `role="note"`. The buttons are native buttons.
- **Accessible name:** the card has none: the `<article>` has no `aria-label` and no `aria-labelledby`. The form is
  named by its heading. Each button is named by its text.
- **Description:** approve is described, through `aria-describedby`, by the consequence box, or by the blocked
  reason while `approveBlocked` is set. The commit of a form is described by the missing-reason text until the
  reason is complete, and by the form's consequence box after that.
- **Announced:** nothing by the card itself. It has no live region. Opening a form moves focus to its heading,
  which is what a screen reader reads at that point. `aria-busy` is the only thing set while a command runs. The
  receipt is announced only if what the caller passes announces itself: the viewer passes a `<p role="status">`.

The button that opens a form and the commit of that form can have the same name. The opener's text is built in;
the commit's is `rejectLabel` or `returnLabel`. The viewer passes the built-in messages as both. The two are never
rendered together.

The heading levels are fixed: `<h2>` for the title and `<h3>` for a form. No prop changes them.

Known gaps:

- A disabled button has the native `disabled` attribute, so it cannot take focus. A keyboard user cannot land on a
  blocked approve or on a commit that is not ready, and the description on the button is not read from it. The
  reason is visible text that comes before the button in the reading order. [`DisabledReason`](disabled-reason.md)
  keeps a blocked control focusable; the card does not use it.
- The form heading takes focus and shows no focus indicator: see States.
- When `receipt` arrives, the buttons are removed, including the one that held focus, and the card places focus
  nowhere.
- When a command starts, the button that was pressed gets the native `disabled` attribute while it holds focus.
  When `pending` clears with no receipt, as after a command the server refused, the card calls no `focus()`.
  Where a browser leaves focus on a button that was disabled and is enabled again was not checked.
- The card has no slot for the error of a command that failed. The caller places it. The viewer puts
  `CommandError` (`lib/react/command-error`) first in `children`, above its opinion field.
- A running command has no words: no status text and no spinner, only `aria-busy` and disabled buttons.
- The recorded card has no heading and no name. The title is not rendered once `receipt` is given.
- The Escape listener checks `isComposing` and not key code 229: see Keyboard. Whether an Escape that belongs to
  a composition closes the form is untested.

The WCAG 2.2 criteria that apply:

| Criterion | How the card answers it |
|---|---|
| 1.3.1 Info and Relationships | The title and the form are headings, each consequence is a note, and each commit points at its consequence or its reason with `aria-describedby`. |
| 1.3.2 Meaningful Sequence | The document order is the order on screen: the body, the consequence, then the buttons. |
| 1.4.1 Use of Color | The danger fill of the reject commit repeats its label. A disabled button is paler, and its reason is in words beside it, except while `pending`. |
| 1.4.3 Contrast (Minimum) | Every colour is a token; none is written in the component. A disabled button is drawn at half opacity; the criterion does not cover an inactive control. |
| 1.4.10 Reflow | The card is never wider than its container, and the bar wraps. |
| 2.1.1 Keyboard | Native buttons, and Escape for the form. |
| 2.4.3 Focus Order | Focus goes to the form heading when a form opens and back to its opener when it closes. Not answered when the receipt arrives, and not checked after a refused command: see the gaps. |
| 2.4.6 Headings and Labels | The title and the form heading are the caller's words. The form heading repeats the commit's label. |
| 2.4.7 Focus Visible | The global outline on the buttons. Not answered for the form heading. |
| 2.5.8 Target Size (Minimum) | The buttons are at least 40 px high (`--row-h`), above the 24 px minimum. |
| 3.3.4 Error Prevention (Legal, Financial, Data) | The type requires `consequence` and `rejectConsequence`, and `returnConsequence` with request changes, and each is drawn before its commit. Reject and request changes take two presses. Approve takes one. |
| 4.1.2 Name, Role, Value | The roles, names and descriptions above. |
| 4.1.3 Status Messages | Left to the caller, through `receipt`. A running command has no status message. |

The gallery shows three cards in `apps/web/src/ui/approval-card/approval-card.gallery.tsx`: deciding, approve
blocked, and recorded with a `next` link. All three pass `progress` and `meta`. A form opens there when reject or
request changes is pressed. Pressing a commit there sets `pending`, and nothing clears it. The gallery does not
show a card without request changes.

The component has no test file of its own. Two browser specs drive it through the approval viewer against a
mocked server. They were found by searching `e2e` and `apps/web/src` for the `uiApprovalCard` message ids, the
viewer's exports and the names of the card's buttons. That search finds no other test that presses the card's
buttons.

`e2e/mock/approval-viewer.spec.ts`, on the viewer's own page:

- At 1440 and 390 px, in both themes: the commit of a form is disabled until a reason is picked, back returns to
  the decisions, approve replaces the buttons with the receipt, axe passes before, with a form open and after, and
  at 390 px the page does not scroll sideways.
- Escape closes each form and returns focus to its opener, also when focus is in a field inside `children`.
- Each commit sends its reason code, and a memo when the code needs one.
- Approve stays disabled until the receipt arrives.
- After the server refuses an approve, the error shows as an alert and a second press of approve is recorded.
- The request-changes button is absent when the server does not offer that command.

`e2e/mock/approvals-columns.spec.ts`, in the record column of the approvals list at 1440 px, with a card that has
no request changes:

- There is no request-changes button, and one `btn--primary` button, which is approve.
- Reject opens its form. Escape with focus on a reason radio closes the form, leaves the column open, keeps the
  text typed in the opinion field and returns focus to reject.
- A second Escape closes the column.

The same search finds tests of the opposite case, a document that draws no decision button:
`e2e/mock/approvals.spec.ts`, `e2e/mock/approval-document.spec.ts`, `e2e/mock/approval-refusal.spec.ts`,
`e2e/approval-document.spec.ts` and `features/approvals/ui/approvals-page.browser.test.tsx`.

None of these asserts `aria-busy`, the `aria-describedby` targets, the blocked reason's row, where focus is after
the receipt or after a refused command, or a key pressed during a composition.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component).

## Phone behaviour at 390 px

Nothing in `approval-card.module.css` changes with the width of the screen. It has no media query and no container
query. The component's own comment calls it a desktop card; the approval viewer shows it at every width.

- The card is as wide as its container below 640 px (`--card-w`).
- The bar wraps. The spacer pushes only the row it is in, so a button that drops to a new row starts at the start
  of that row, not at the end.
- The buttons are at least 40 px high (`--row-h`) at every width. They do not grow to the 44 px touch size; the
  component does not read `--target-touch`.
- The missing-reason text keeps its width limit of `calc(var(--panel-w) / 1.5)`.

## Copy rules

- The card owns these message ids, in `packages/i18n/src/catalogs/en/ui-approval-card.ts` and its `ko` twin:

| Message id | Where it shows |
|---|---|
| `uiApprovalCard.reject` | The button that opens the reject form. |
| `uiApprovalCard.return` | The button that opens the request-changes form. |
| `uiApprovalCard.back` | The back button of a form. |
| `uiApprovalCard.reasonMissing` | The missing-reason text, when `reasonMissing` is not passed. |
| `uiApprovalCard.name` | Not read by the component. The gallery uses it as the title of its section. |

- Everything else is the caller's, from the message catalog in `packages/i18n`. The `en` catalog is the source and
  the `ko` catalog must define every id.
- `approveLabel`, `rejectLabel` and `returnLabel` are a verb and its object. The viewer passes
  `uiApprovalCard.reject` and `uiApprovalCard.return` as the two form labels.
- `consequence` says what approving does and who can undo it. `rejectConsequence` and `returnConsequence` say what
  each of those does.
- `title` is the decision as a sentence.
- The built-in missing-reason message asks for a reason code. Pass `reasonMissing` when something else is missing.
- The gallery's sample names are in the gallery catalog, which production builds leave out.

## Props

`ApprovalCard` takes one of two shapes. The shape in which `onReturn` is required offers request changes, and
`returnLabel` and `returnConsequence` are required with it. The other shape offers approve and reject only, and
takes none of the three.

- `Form` is `"reject" | "return"`: the form that is open.
- `ApprovalPending` is `"approve" | "reject" | "return"`, or `undefined` when no command is running.
- Two descriptions cover more than their own row. The one on `approveLabel` is for `rejectLabel` and `returnLabel`
  too. The one on `rejectConsequence` is for `returnConsequence` too.

<!-- ds:props apps/web/src/ui/approval-card/approval-card.tsx -->

### ApprovalCard

**Shape 1 of 2**

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `approveLabel` | yes | `string` |  | Verb + object for each commit (approve the dissolution; reject the dissolution; ...). |
| `children` | yes | `ReactNode` |  | Content, preflight in words, diff, chain. |
| `consequence` | yes | `ReactNode` |  | What approving does and who can undo it. Required: the type forces the sentence above the decision. |
| `eyebrow` | yes | `ReactNode` |  | Kind and record id (org change · OC-2026-0418). |
| `onApprove` | yes | `() => void` |  |  |
| `onReject` | yes | `() => void` |  |  |
| `onReturn` | yes | `() => void` |  |  |
| `reason` | yes | `(form: Form) => ReactNode` |  | The reason field for the open form (codes + memo). |
| `reasonComplete` | yes | `((form: Form) => boolean) \| boolean` |  | The reason field is complete (a code; "other" with a memo). |
| `rejectConsequence` | yes | `ReactNode` |  | What reject / request changes do, shown above the form's commit. |
| `rejectLabel` | yes | `string` |  |  |
| `returnConsequence` | yes | `ReactNode` |  |  |
| `returnLabel` | yes | `string` |  |  |
| `step` | yes | `ReactNode` |  | The step this person holds (my step · delegated, 1 step). |
| `title` | yes | `ReactNode` |  | The decision as a sentence (dissolves the support team on 2 Nov). |
| `approveBlocked` | no | `ReactNode` |  | Why approve cannot be pressed now (e.g. the content changed while reviewing); shown next to it. |
| `meta` | no | `ReactNode` |  | Left of the decisions: when the card was opened and its content fingerprint. |
| `next` | no | `ReactNode` |  | The open-next-approval link, placed away from where approve was. |
| `pending` | no | `ApprovalPending` |  |  |
| `progress` | no | `ReactNode` |  | Queue position (1st of 3 left) and its bar. |
| `reasonMissing` | no | `ReactNode` |  | What is missing while it is not, beside the commit (defaults to choosing a reason code). |
| `receipt` | no | `ReactNode` |  | The server receipt once recorded; it replaces the decisions. |

**Shape 2 of 2**

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `approveLabel` | yes | `string` |  | Verb + object for each commit (approve the dissolution; reject the dissolution; ...). |
| `children` | yes | `ReactNode` |  | Content, preflight in words, diff, chain. |
| `consequence` | yes | `ReactNode` |  | What approving does and who can undo it. Required: the type forces the sentence above the decision. |
| `eyebrow` | yes | `ReactNode` |  | Kind and record id (org change · OC-2026-0418). |
| `onApprove` | yes | `() => void` |  |  |
| `onReject` | yes | `() => void` |  |  |
| `reason` | yes | `(form: Form) => ReactNode` |  | The reason field for the open form (codes + memo). |
| `reasonComplete` | yes | `((form: Form) => boolean) \| boolean` |  | The reason field is complete (a code; "other" with a memo). |
| `rejectConsequence` | yes | `ReactNode` |  | What reject / request changes do, shown above the form's commit. |
| `rejectLabel` | yes | `string` |  |  |
| `step` | yes | `ReactNode` |  | The step this person holds (my step · delegated, 1 step). |
| `title` | yes | `ReactNode` |  | The decision as a sentence (dissolves the support team on 2 Nov). |
| `approveBlocked` | no | `ReactNode` |  | Why approve cannot be pressed now (e.g. the content changed while reviewing); shown next to it. |
| `meta` | no | `ReactNode` |  | Left of the decisions: when the card was opened and its content fingerprint. |
| `next` | no | `ReactNode` |  | The open-next-approval link, placed away from where approve was. |
| `onReturn` | no | `undefined` |  |  |
| `pending` | no | `ApprovalPending` |  |  |
| `progress` | no | `ReactNode` |  | Queue position (1st of 3 left) and its bar. |
| `reasonMissing` | no | `ReactNode` |  | What is missing while it is not, beside the commit (defaults to choosing a reason code). |
| `receipt` | no | `ReactNode` |  | The server receipt once recorded; it replaces the decisions. |
| `returnConsequence` | no | `undefined` |  |  |
| `returnLabel` | no | `undefined` |  |  |

<!-- /ds:props -->

## Tokens it reads

The card's fill, border, radius and shadow come from the global `card` class, and the buttons' looks from the
global `btn` classes. Both are in `app.css` and are not listed here: see the token tables of [Card](card.md) and
[Button](button.md). The focus outline is a global rule too; it reads `--primary`.

<!-- ds:tokens apps/web/src/ui/approval-card/approval-card.module.css -->

| Token | Read by |
| --- | --- |
| `--border-soft` | `border-bottom`, `border-top` |
| `--card-w` | `width` |
| `--fw-medium` | `font-weight` |
| `--fw-strong` | `font-weight` |
| `--ink` | `border` |
| `--panel-w` | `max-width` |
| `--primary` | `color` |
| `--primary-soft` | `background` |
| `--radius` | `border-radius` |
| `--radius-sm` | `border-radius` |
| `--row-h` | `min-height` |
| `--space-1` | `gap` |
| `--space-2` | `gap`, `padding` |
| `--space-3` | `gap`, `padding` |
| `--space-4` | `margin`, `padding` |
| `--steel` | `color` |
| `--surface` | `background` |
| `--text-body` | `font-size` |
| `--text-lg` | `font-size` |
| `--text-sm` | `font-size` |
| `--text-xl` | `font-size` |
| `--text-xs` | `font-size` |
| `--tracking-label` | `letter-spacing` |

<!-- /ds:tokens -->
