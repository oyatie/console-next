<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Approval card

An approval card is where one person decides one item at the step they hold: what approving does is stated above
the decisions, reject and request changes stand beside approve at the same height, and each of those two opens a
reason form before it commits.

It lives in `apps/web/src/ui/approval-card`: the component in `approval-card.tsx` and its styles in
`approval-card.module.css`.

## When to use it, and when not

Use it for one approval item on which the server offers this person approve and reject, with or without request
changes. One feature renders it: the decision panel of approvals, `features/approvals/ui/approval-decision-panel.tsx`.
The panel draws the card while the server offers both commands, while a decision it sent is on its way, and with the
receipt once the decision is recorded. Three screens draw the panel:

- The baseline viewer, `ApprovalDocumentView` in `features/approvals/ui/approval-viewer.tsx`, on a page of its own
  and in the record column of the baseline approvals list (`features/approvals/ui/approvals-page.tsx`), which is a
  pane of `FlexibleColumns` (`ui/flexible-columns`).
- The Console document page, `ApprovalViewerPage` in `approval-viewer.tsx`, with `docked`, in the decision column of
  `DocumentDecision` (`ui/patterns/document-decision.tsx`).
- The Console approvals list in `approvals-page.tsx`, with `docked` and `compact`, in the footer of the record pane
  of `Worklist` (`ui/patterns/worklist.tsx`), which is a pane of `PaneGrid` (`ui/pane-grid`).

The record columns are where the card's `data-escape-scope` attribute matters: see Keyboard.

Two rules for the caller:

- Give the card a `key` that is the item's id. The open form is the card's own state, and a new key is what stops
  it from carrying over to the next item. Each of the three screens keys the panel that holds the card by the
  document's id.
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
| Card | `<article class="card">` | Everything. It carries `aria-labelledby` pointing to the title and `aria-busy="true"` while `pending` is set. |
| Progress | `<div>` | `progress`. Left out when it is not given. |
| Body | `<div>` | The eyebrow, the step, the title and `children`, in that order. |
| Eyebrow | `<div>` | `eyebrow`. Always rendered. |
| Step | `<span>` | `step`. Always rendered. |
| Title | `<h2>` | `title`. |
| Children | None of its own | `children`, as passed. |
| Consequence | `<div role="note">` | `consequence`. |
| Bar | `<div>` | In this order: the blocked reason, a `<span>` with `staleBlocked`, or else `approveBlocked`, only when one of them is given; the meta, a `<span>`, only with `meta`; a spacer `<span>`; the reject button; the request-changes button, only with `onReturn`; the approve button. |

**A reason form** opens when reject or request changes is pressed. It takes the place of the consequence and the
bar. The body above it stays.

| Part | Element | Holds |
|---|---|---|
| Form | `<section>` | The four parts below. It is named by its heading through `aria-labelledby`. |
| Form heading | `<h3 tabindex="-1">` | `rejectLabel` or `returnLabel`. |
| Reason | None of its own | What `reason` returns for the open form, `"reject"` or `"return"`. |
| Consequence | `<div role="note">` | `rejectConsequence` or `returnConsequence`. |
| Bar | `<div>` | A back button; a spacer `<span>`; while `staleBlocked` is set, the blocked reason, a `<bdi>` with `staleBlocked`, and otherwise the missing-reason text, a `<span>`, only while the reason is not complete; the commit button, which shows the same label as the heading. |

The reason is complete when `reasonComplete` is `true`, or, when it is a function, when it returns `true` for the
open form.

**Recorded** is the shape whenever `receipt` is given, whatever else is passed. The component tests `receipt` for
truth, so any falsy value is not given: `false`, `null`, `undefined`, `0` or an empty string.

| Part | Element | Holds |
|---|---|---|
| Card | `<article class="card">` | The two parts below, named by the title through `aria-labelledby`. |
| Progress | `<div>` | `progress`. Left out when it is not given. |
| Done | `<div>` | Title `<h2 tabindex="-1">` (`title`), `next` in a `<div>` of its own when given, then `receipt` as passed. |

The recorded card keeps `title` as its heading and renders no eyebrow, step, `children`, consequence or button.

**Docked** (`docked`) changes the deciding and the recorded shapes. The `<article>` has no `card` class. A
`PaneHead` (`ui/pane-grid`), a `<header>` with `title` and `meta`, stands above the body in place of the `<h2>`: its
heading is an `<h2>`, with `tabindex="-1"` in the recorded shape. The eyebrow is not drawn. The body begins with a
row that holds `step` and `due`, drawn only when one of them is given. The bar leaves `meta` out. `compact` sets
`data-compact` on the `<article>`, which the stylesheet reads in the record pane of a Console screen.

Every button is a React Aria `Button`, a native `<button type="button">`, with the global `btn` classes. The card
does not use the `Button` of `ui/button`.

The form is a `<section>`, not a `<form>`. Nothing is submitted, and Enter in a field of the reason commits
nothing.

## Looks and sizes

No prop picks a look. The table below is the look of the baseline. A Console screen draws the card in a look of its
own, after the class table, and `compact` changes that look in a record pane.

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
| Buttons | The global `btn` look, at least 40 px high (`--control-h-lg`). A plain `btn` is at least 36 px (`--control-h`); the card's stylesheet raises the ones that are direct children of the bar. |
| Meta | 12 px (`--text-xs`), `--steel`. |
| Missing-reason text | 13 px (`--text-sm`), `--steel`, at most `calc(var(--panel-w) / 1.5)` wide, which is about 293 px. |
| Blocked reason | The same text, on a full row of its own before the meta and the buttons, with no width limit and `text-align: right`. |
| Form | A column, 12 px (`--space-3`) between its parts, with a 1 px `--border-soft` line and 16 px (`--space-4`) of padding on top. Every direct child other than the consequence and the bar takes 16 px (`--space-4`) side margins and no margin above or below. |
| Form heading | 16 px (`--text-lg`), bold (`--fw-strong`). |
| Done | A column, 12 px (`--space-3`) between its parts, with 16 px (`--space-4`) padding. The recorded `<h2>` title comes first, then `next` (at the start of its row), then `receipt`. |

The buttons take these classes:

| Button | Classes |
|---|---|
| Reject, request changes, back | `btn` |
| Approve | `btn btn--primary` |
| The commit of the request-changes form | `btn btn--primary` |
| The commit of the reject form | `btn btn--danger` |

Reject, request changes and approve share one minimum height and sit side by side while the row has room. Approve
differs only in its `btn--primary` colours.

**The Console look.** Under a Console experience (an element above the card with a `data-experience` other than
`baseline`), inside the decision column of `DocumentDecision` (`[data-pattern="document-decision"]`) or a record
pane (`[data-pane="record"]`), the stylesheet changes these parts:

| Part | Console look |
|---|---|
| Card | Full width, with no border, radius, shadow or fill. |
| Progress | 8 px (`--space-2`) top and bottom, 12 px (`--space-3`) side padding. |
| Body | 12 px (`--space-3`) padding, 8 px (`--space-2`) between its parts. |
| Eyebrow | No extra letter spacing. |
| Step | 2 px (`--space-half`) by 8 px (`--space-2`) padding, semibold (`--fw-semibold`). |
| Title | 13 px (`--text-sm`), semibold, `--lh-tight` line height. |
| Consequence | Plain text, not a box: no margin, border, radius or fill, 12 px (`--space-3`) padding at the sides and the bottom, 12 px (`--text-xs`) `--steel` text at `--lh-base`, and a following `<p>` the same size. It is drawn after the bar (`order: 1`). In a form it keeps its place before the bar and has no padding. |
| Bar | 8 px (`--space-2`) by 12 px (`--space-3`) padding, and no spacer. The meta takes a row of its own. Each button in the bar grows to share its row, approve twice as much as the others, with its label centred and kept on one line. In a form the bar has 8 px of padding on top only. |
| Form | 12 px (`--space-3`) padding and a `--border` line on top. Its parts have no side margins. |
| Form heading | 13 px (`--text-sm`), no margin. |
| Done | 12 px (`--space-3`) padding, 8 px (`--space-2`) between its parts. |

With `compact`, in a record pane, these change again:

| Part | Compact look |
|---|---|
| Card | Does not clip what overflows it. |
| Pane head | Pulled out over the footer's padding, 8 px (`--space-2`) at the top and 12 px (`--space-3`) at the sides, and at least `--row-h-compact` high. |
| Body | 4 px (`--space-1`) padding on top only, 4 px between its parts. A `<div>` in the body, as the opinion field is, lays out its first part and its second in a row 8 px (`--space-2`) apart: the first does not shrink or wrap, and the second takes the rest of the row. A text area is `--field-h` high, with 4 px (`--space-1`) by 8 px (`--space-2`) padding. |
| Consequence, bar | 4 px (`--space-1`) padding on top only. |
| Form | 8 px (`--space-2`) padding on top only. |
| Done | 8 px (`--space-2`) padding on top only, 6 px (`--space-1-5`) between its parts. |

## States

| State | What happens |
|---|---|
| Rest | The deciding shape. |
| Hover | The card has no hover look. A button takes the global hover fill of its class: `--surface-hover` for `btn`, `--primary-hover` for `btn--primary`, `--danger-tx` for `btn--danger`. |
| Keyboard focus | Buttons, the form heading, and the recorded heading take the global 2 px `--primary` `:focus-visible` outline, 2 px away. When focus moves programmatically on a keyboard-driven transition (opening a form or transitioning into `receipt`), the heading shows `:focus-visible`, while pointer-triggered transitions leave it without a ring. |
| Pressed down | No look. Neither `approval-card.module.css` nor `app.css` has an `:active` rule or a `data-pressed` rule. |
| Selected | Does not exist. An open form is not marked on the button that opened it: that button is not rendered while the form is open. |
| Disabled | The native `disabled` attribute, drawn by the global `.btn[disabled]` rule: half opacity and a `not-allowed` cursor. Approve is disabled while `approveBlocked` or `staleBlocked` is set. The commit of a form is disabled until the reason is complete, and while `staleBlocked` is set. Every button is disabled while `pending` is set. Except while `pending`, the reason is visible text in the bar: `staleBlocked` before `approveBlocked`, and in a form `staleBlocked` in place of the missing-reason text. While `pending`, nothing says why. |
| Read-only | Does not exist. No prop shows the item without its decisions, other than `receipt`. |
| Invalid | None of its own. A reason that is not complete is not drawn as an error: the commit is disabled and the missing-reason text is `--steel`. What `reason` returns brings its own invalid look. |
| Loading | `pending` sets `aria-busy="true"` on the card and disables every button. There is no spinner and no text. The three values of `pending` render alike: the component only tests whether it is set. |
| Empty | `progress`, `meta`, the blocked reason, the request-changes button and `next` are left out when they are not passed. Outside `docked`, the eyebrow and the step are always rendered, so an empty `step` leaves an empty `<span>` in the body's column. The panel passes the `orgChange.turn` message for the current step of the route as `step`, except with `compact`, and `undefined` when no step is current. |

## Keyboard

| Key | What it does |
|---|---|
| Tab, Shift+Tab | Moves through what can take focus, in document order: `progress`, the body with `children`, then the bar. In the deciding shape the bar's order is reject, request changes, approve. In a form it is the reason's own controls, back, then the commit. A disabled button is skipped. |
| Enter, Space | Presses the focused button. |
| Escape | With a form open and `pending` not set: closes the form, as back does. Focus can be anywhere inside the card, `children` included. |

The card moves focus in four cases:

- When a form opens, focus goes to the form heading.
- When a form closes, by back or by Escape, focus returns to the button that opened it.
- When `receipt` turns from falsy to truthy while `document.activeElement` is the `<body>`, focus goes to the heading
  of the recorded shape. The buttons are gone by then, so focus they held is on the `<body>`. Focus the person has
  put on a control outside the card, a find box for one, stays there. Focus never moves on a mount that already
  carries `receipt`, nor on a later render while `receipt` stays truthy.
- When a command ends with no receipt, as after one the server refused, focus returns to the commit that was
  pressed: approve, or the commit of the open form.

The card remembers a commit when it is pressed. After every render in which `pending` is not set, it reads
`document.activeElement`: if that is the `<body>` or the remembered button, and the button is not disabled, the
button takes focus and is forgotten. If focus is anywhere else, or the button is gone, as it is once `receipt` is
given, the button is forgotten and focus stays where it is. While the button is still disabled, as every commit is
while `staleBlocked` is set, the card waits for a later render. None of the card's `focus()` calls passes
`preventScroll`. The card does not move focus when a commit is pressed or when `pending` is set.

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

The card carries a `data-escape-scope` attribute while a form is open and while `pending` is set. Two other
components read it: `FlexibleColumns` (`ui/flexible-columns`) and `PaneGrid` (`ui/pane-grid`), whose own Escape
handlers close an open pane. Each leaves a key pressed inside such an element alone, and closes nothing while its
open pane holds such an element with `aria-busy="true"`. Both handlers run in the capture phase, on `document` and
on the grid's root, so they see the key before the card does. In a record column the first Escape closes the form
and the next one closes the column, unless the column still holds unsaved input such as a typed opinion. Then that
Escape only shows the unsaved line (`composer.unsaved`, a `role="status"` warning in the column head; see
[Pane grid](pane-grid.md) and [Sheet](sheet.md)), and the one after it closes the column. While `pending` is set
the card's listener is off and the attribute stays, so an Escape closes neither the form nor the column.

After a decision made by keyboard in a record column, focus is on the recorded heading, inside the column, so an
Escape closes the column. Both approvals lists (`features/approvals/ui/approvals-page.tsx`) then return focus to
the row of the document. When that row has left the list, as a decided document leaves the pending box, focus goes
to the first row left in the list, or to the find box when the list is empty. The Console list opens its first
document by itself when the address names none; a decision started there chooses that document, so the column stays
on it and shows the receipt.

A key the Korean input method owns: the Escape listener returns at once when `isImeKey` (`lib/pure/ime`) says the
input method owns the key: `isComposing` is true, the key code is 229, or the key is `Process`. The card binds no
other key, and Enter and Space on a button are the library's.

The panel draws one more line where the card was. When it has drawn the card and a later read of the document
offers no decision, with no receipt, no command on its way and no command error, as after someone else has decided,
it draws the `approvals.viewer.unavailable` message as a `<p role="status" tabindex="-1">`: in a [`Card`](card.md)
titled `approvals.viewer.decision`, or, when docked, in `DocDecisionPad` (`ui/patterns/document-decision-parts.tsx`).
That line takes focus if `document.activeElement` is the `<body>`, which is where the browser leaves focus once the
card that held it is gone. When focus is on any element other than the line, it stays there, and the panel passes
the line's words to `announce` (`lib/react/announce`), the shell's one polite live region: a `role="status"` drawn
with its words already in it is not read out by every screen reader. A command still on its way passes through the
same state just before its receipt, and shows no such line. After a command error the panel shows the error in the card's place instead.

The panel keeps the card's place, and the Console document page and the Console list keep the panel, while the
document whose decision was offered stays the one shown: all three ask `useDecisionOffered`
(`features/approvals/ui/use-approval-decision.ts`). The baseline viewer always draws the panel. So the line shows on
all three screens. Once another document, or none, has been shown, a document that offers nothing draws no panel
when it is shown again, with one exception: the Console list keeps the receipt of the last decision made in it, and
draws the recorded card again when that document is opened again.

## Accessibility contract

- **Role:** `article`, from the element. The form is a `<section>` with a name, which makes it a region. Each
  consequence box has `role="note"`. The buttons are native buttons.
- **Accessible name:** the `<article>` is named by its `<h2>` `title` through `aria-labelledby` in both the deciding
  and recorded shapes. The form is named by its `<h3>` heading. Each button is named by its text.
- **Description:** approve is described, through `aria-describedby`, by the consequence box, or by the blocked
  reason while `approveBlocked` or `staleBlocked` is set. The commit of a form is described by the blocked reason
  while `staleBlocked` is set, else by the missing-reason text until the reason is complete, and by the form's
  consequence box after that.
- **Announced:** nothing by the card itself. It has no live region. Opening a form moves focus to its heading, and
  a receipt that arrives while focus is on the `<body>` moves it to the recorded heading, which is what a screen
  reader reads at those points. `aria-busy` is the only thing set while a command runs. The receipt is announced
  only if the caller announces it: the panel passes it in a `<p role="status">`, and its command passes the same
  words to `announce` (`lib/react/announce`).

The button that opens a form and the commit of that form can have the same name. The opener's text is built in;
the commit's is `rejectLabel` or `returnLabel`. The panel passes the built-in messages as both. The two are never
rendered together.

The heading levels are fixed: `<h2>` for the title and `<h3>` for a form. No prop changes them.

Known gaps:

- A disabled button has the native `disabled` attribute, so it cannot take focus. A keyboard user cannot land on a
  blocked approve or on a commit that is not ready, and the description on the button is not read from it. The
  reason is visible text that comes before the button in the reading order. [`DisabledReason`](disabled-reason.md)
  keeps a blocked control focusable; the card does not use it.
- When a command starts, the button that was pressed gets the native `disabled` attribute while it holds focus.
  Chromium then drops focus to the `<body>`, not always at once: a refusal that comes quickly can find focus still
  on the button. After a refusal the card returns focus to that button once it is enabled: see Keyboard. The panel
  sets `staleBlocked` after a refusal with status 409, until the document it reads again has another fingerprint,
  and until then focus stays on the `<body>`. The card cannot tell that from a person who has clicked plain text in
  the meantime: the commit takes focus from the `<body>` either way once it is enabled.
- The card has no slot for the error of a command that failed. The caller places it. The panel puts
  `CommandError` (`lib/react/command-error`) first in `children`, above its opinion field.
- A running command has no words: no status text and no spinner, only `aria-busy` and disabled buttons.
- A document the Console list opened by itself, with no document named in the address, does not stay shown when
  someone else decides it and the next read of the list no longer holds it, as the pending box does not: the column
  moves on to the first document left, or closes when none is left. The line does not stay, what was typed in the
  opinion is gone, and focus that was in the card is left on the `<body>`.

The WCAG 2.2 criteria that apply:

| Criterion | How the card answers it |
|---|---|
| 1.3.1 Info and Relationships | The title and the form are headings, each consequence is a note, and each commit points at its consequence or its reason with `aria-describedby`. |
| 1.3.2 Meaningful Sequence | The document order is the body, the consequence, then the buttons. In the baseline look that is the order on screen. The Console look draws the consequence of the deciding shape after the buttons (`order: 1`), so there a screen reader reads it before the buttons while the eye reaches it after them. |
| 1.4.1 Use of Color | The danger fill of the reject commit repeats its label. A disabled button is paler, and its reason is in words beside it, except while `pending`. |
| 1.4.3 Contrast (Minimum) | Every colour is a token; none is written in the component. A disabled button is drawn at half opacity; the criterion does not cover an inactive control. |
| 1.4.10 Reflow | The card is never wider than its container, and the bar wraps. |
| 2.1.1 Keyboard | Native buttons, and Escape for the form. |
| 2.4.3 Focus Order | Focus goes to the form heading when a form opens, back to its opener when it closes, and to the recorded heading when `receipt` arrives while focus is on the `<body>`. After a refused command it returns to the commit that was pressed, once that button is enabled: see the gaps. |
| 2.4.6 Headings and Labels | The title and the form heading are the caller's words. The form heading repeats the commit's label. |
| 2.4.7 Focus Visible | The global outline on the buttons, the form heading, and the recorded heading. |
| 2.5.8 Target Size (Minimum) | The buttons are at least 40 px high (`--control-h-lg`), above the 24 px minimum. |
| 3.3.4 Error Prevention (Legal, Financial, Data) | The type requires `consequence` and `rejectConsequence`, and `returnConsequence` with request changes, and each is drawn before its commit. Reject and request changes take two presses. Approve takes one. |
| 4.1.2 Name, Role, Value | The roles, names and descriptions above. |
| 4.1.3 Status Messages | Left to the caller, through `receipt`. A running command has no status message. |

The gallery shows three cards in `apps/web/src/ui/approval-card/approval-card.gallery.tsx`: deciding, approve
blocked, and recorded with a `next` link. All three pass `progress` and `meta`. A form opens there when reject or
request changes is pressed. Pressing a commit there sets `pending`, and nothing clears it. The gallery does not
show a card without request changes.

The component has its own SSR unit test (`apps/web/src/ui/approval-card/approval-card.test.tsx`) and real-browser focus test (`apps/web/src/ui/approval-card/approval-card.browser.test.tsx`), covering `aria-labelledby` in both shapes, transition-only focus move into the recorded heading (including when a reason form was open), `:focus-visible` on keyboard-driven transitions, no focus steal on pre-recorded mount or subsequent re-renders, and a receipt that arrives while focus is on a control outside the card leaving focus there. `ui/ime-keys.browser.test.tsx` presses Escape in the reason with `isComposing` true, and with key code 229, and checks that the form stays open until a plain Escape.

`features/approvals/ui/approval-decision.browser.test.tsx`, a Vitest browser test in Chromium at 1440 px, drives the
panel on a mocked server in each screen that draws it, under StrictMode as the app is drawn. The baseline cases put a
text field above the viewer that stands for the find box of the list:

- After approve, reject and request changes made by keyboard on the viewer's own page, no button is left, focus is
  on the recorded heading, axe passes, and an observer inside the page finds that `approvals.viewer.unavailable`
  was not drawn on the way.
- While the server holds a decision the card has `aria-busy="true"`. A receipt that arrives while the person types
  in the text field leaves focus there, and the next keys go into the field.
- When the server refuses a decision made by keyboard because the document changed, focus is back on the commit
  that was pressed once the document has been read again, a second Enter sends the decision, and focus ends on the
  recorded heading: approve and reject held until focus has dropped to the `<body>`, and approve refused at once, on
  the viewer's own page; approve in the Console list; reject on the Console document page. A refusal that arrives
  while the person types in the text field leaves focus there.
- When the document is read again without its decision and none was sent, with focus in the opinion field, the
  card gives way to `approvals.viewer.unavailable`, which has focus, on the viewer's own page, in the Console list
  and on the Console document page, and nothing is passed to `announce`. On the viewer's own page, with focus in
  the text field, the line leaves focus there and its words are passed to `announce`. When the decision is then
  offered again and made by keyboard, focus is on the recorded heading.
- While the server holds an approve and the document is read again without its decision, the card stays busy and
  no status line is drawn. Once the server answers, focus is on the recorded heading.
- In the Console list, when a document whose decision was withdrawn while it was open is opened again after one
  that offers no decision, the record pane has no footer.
- In the baseline list that drops a decided document, and in the Console list with the document chosen or opened
  by the list itself, Escape after an approve made by keyboard closes the column, and focus is on the row that is
  left, or in the find box when no row is left. In each the receipt shows before the Escape.

`features/approvals/ui/approval-viewer.browser.test.tsx` checks that the panel keeps the card and focuses its
recorded heading when the document read after an approve offers no decision.

Two browser specs also drive it through the approval viewer against a mocked server:

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
- A second Escape shows the unsaved line in the column. A third closes the column.

The same search finds tests of the opposite case, a document that draws no decision button:
`e2e/mock/approvals.spec.ts`, `e2e/mock/approval-document.spec.ts`, `e2e/mock/approval-refusal.spec.ts`,
`e2e/approval-document.spec.ts` and `features/approvals/ui/approvals-page.browser.test.tsx`.

`e2e/mock/approvals-console.spec.ts` drives the docked card in the Console list and on the Console document page:

- On the document page at 1440 px: after approve the recorded heading has focus and the receipt and the link to the
  list show; reject with the other reason needs its memo, and Escape from the form returns focus to reject and keeps
  the opinion; after a refusal because the document changed the opinion stays and a second approve is recorded; a
  refusal by the server shows an alert and axe passes; a document that offers nothing draws no decision column.
- In the Console list at 1440 px: the recorded heading has focus after approve while the list is read again late; a
  refused reject keeps its commit disabled until the document is read again, and the alert stays when that read
  offers nothing; Escape while a reject is on its way leaves the pane open.
- At 1280 by 720 and 1366 by 768 px, after a refused reject, the pane body stays at least 80 px high and the footer
  scrolls with the commit inside it.
- After a refused approve on the document the list opened by itself, opening another document and coming back
  leaves no empty footer.
- At 320 px the record pane does not scroll sideways, and at 390 px the document page fits.

None of these asserts the `aria-describedby` targets, the blocked reason's row, or the scroll position after a
heading takes focus.

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
- The buttons are at least 40 px high (`--control-h-lg`) at every width. They do not grow to the 44 px touch size; the
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
- `approveLabel`, `rejectLabel` and `returnLabel` are a verb and its object. The panel passes
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
| `title` | yes | `ReactNode` |  | The decision as a sentence (dissolves the support team on 2 Nov). |
| `approveBlocked` | no | `ReactNode` |  | Why approve cannot be pressed now (e.g. the content changed while reviewing); shown next to it. |
| `compact` | no | `boolean` |  | Compact pinned footer layout inside a side pane. |
| `docked` | no | `boolean` |  | Streamlined docked pane layout with PaneHead (`title` + `meta`), single turn row, and compact spacing. |
| `due` | no | `ReactNode` |  | Optional due-date summary shown beside the turn badge in docked mode. |
| `meta` | no | `ReactNode` |  | Left of the decisions: when the card was opened and its content fingerprint. |
| `next` | no | `ReactNode` |  | The open-next-approval link, placed away from where approve was. |
| `pending` | no | `ApprovalPending` |  |  |
| `progress` | no | `ReactNode` |  | Queue position (1st of 3 left) and its bar. |
| `reasonMissing` | no | `ReactNode` |  | What is missing while it is not, beside the commit (defaults to choosing a reason code). |
| `receipt` | no | `ReactNode` |  | The server receipt once recorded; it replaces the decisions. |
| `staleBlocked` | no | `ReactNode` |  | Why no decision commit (approve, reject, or return) may run until the stale read refreshes. |
| `step` | no | `ReactNode` |  | The step this person holds (my step · delegated, 1 step). |

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
| `title` | yes | `ReactNode` |  | The decision as a sentence (dissolves the support team on 2 Nov). |
| `approveBlocked` | no | `ReactNode` |  | Why approve cannot be pressed now (e.g. the content changed while reviewing); shown next to it. |
| `compact` | no | `boolean` |  | Compact pinned footer layout inside a side pane. |
| `docked` | no | `boolean` |  | Streamlined docked pane layout with PaneHead (`title` + `meta`), single turn row, and compact spacing. |
| `due` | no | `ReactNode` |  | Optional due-date summary shown beside the turn badge in docked mode. |
| `meta` | no | `ReactNode` |  | Left of the decisions: when the card was opened and its content fingerprint. |
| `next` | no | `ReactNode` |  | The open-next-approval link, placed away from where approve was. |
| `onReturn` | no | `undefined` |  |  |
| `pending` | no | `ApprovalPending` |  |  |
| `progress` | no | `ReactNode` |  | Queue position (1st of 3 left) and its bar. |
| `reasonMissing` | no | `ReactNode` |  | What is missing while it is not, beside the commit (defaults to choosing a reason code). |
| `receipt` | no | `ReactNode` |  | The server receipt once recorded; it replaces the decisions. |
| `returnConsequence` | no | `undefined` |  |  |
| `returnLabel` | no | `undefined` |  |  |
| `staleBlocked` | no | `ReactNode` |  | Why no decision commit (approve, reject, or return) may run until the stale read refreshes. |
| `step` | no | `ReactNode` |  | The step this person holds (my step · delegated, 1 step). |

<!-- /ds:props -->

## Tokens it reads

The card's fill, border, radius and shadow come from the global `card` class, and the buttons' looks from the
global `btn` classes. Both are in `app.css` and are not listed here: see the token tables of [Card](card.md) and
[Button](button.md). The focus outline is a global rule too; it reads `--primary`.

<!-- ds:tokens apps/web/src/ui/approval-card/approval-card.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border-top-color` |
| `--border-soft` | `border-bottom`, `border-top` |
| `--card-w` | `width` |
| `--control-h-lg` | `min-height` |
| `--fw-medium` | `font-weight` |
| `--fw-semibold` | `font-weight` |
| `--fw-strong` | `font-weight` |
| `--ink` | `border`, `color` |
| `--lh-base` | `line-height` |
| `--lh-tight` | `line-height` |
| `--panel-w` | `max-width` |
| `--primary` | `color` |
| `--primary-soft` | `background` |
| `--radius` | `border-radius` |
| `--radius-sm` | `border-radius` |
| `--row-h` | `height`, `min-height` |
| `--row-h-sm` | `min-height` |
| `--space-1` | `gap`, `padding` |
| `--space-1-5` | `gap` |
| `--space-2` | `gap`, `margin`, `padding` |
| `--space-3` | `gap`, `margin`, `padding` |
| `--space-4` | `margin`, `padding` |
| `--space-half` | `padding` |
| `--steel` | `color` |
| `--surface` | `background` |
| `--text-body` | `font-size` |
| `--text-lg` | `font-size` |
| `--text-sm` | `font-size` |
| `--text-xl` | `font-size` |
| `--text-xs` | `font-size` |
| `--tracking-label` | `letter-spacing` |

<!-- /ds:tokens -->
