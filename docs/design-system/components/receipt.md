<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Receipt

A receipt says what an action did: one polite status region that shows a draft, a request on its way, the server's
record, a lost response being checked, or a change that was applied and can be undone.

It lives in `apps/web/src/ui/receipt`: the component in `receipt.tsx`, its styles in `receipt.module.css`, and one
exported class name, `receiptAction`, in `receipt-action.ts`.

## When to use it, and when not

`state` picks what the receipt says. The states follow the order in which an action happens.

| `state` | Use it for |
|---|---|
| `draft` | A change made on the screen and not sent yet. It is the only state whose undo is local. |
| `sending` | A request that was sent and has no record yet. Nothing reads as done. |
| `recorded` | The server's record of the action, with what can follow it: an audit link, the server's follow-up commands, a link to the next item. |
| `checking` | A response that was lost. The caller is looking the request up again with the same key. |
| `applied` | A change the server applied at once and can put back. It stays until it is dismissed or replaced. |

No feature renders `draft` on this branch. A search of `apps/web/src` for the states passed to `Receipt` finds
`recorded`, `applied`, `checking` and `sending` in feature code, and `draft` only in the gallery.

| Do not use it for | Use instead |
|---|---|
| A command that failed | `CommandError` (`lib/react/command-error`). A receipt has no failure state. |
| Floating feedback that must also show a failure in the same place | `Toast` (`ui/toast`). Its states are `sending`, `done` and `error`, and it is always docked. |
| A caution or a fact that holds while the view is open | `Banner` (`ui/banner`). |
| A refusal from the server, with who can unblock it | `BlockedPanel` (`ui/blocker`). |
| Words for a screen reader only, with nothing to show | `announce` (`lib/react/announce`), which speaks through the shell's one polite live region. |
| The state of a record | [`Chip`](chip.md). |

## Anatomy

The outer element is always `<div role="status">`. What is inside depends on `state`.

| `state` | Box | Parts, in order |
|---|---|---|
| `draft` | A bar, `<div>` | A tag `<span>` with message `uiReceipt.draft`. The message, a `<span>`. An undo `<button type="button">`: an icon and message `uiReceipt.undo`. |
| `sending` | A card, `<div>` | A title `<p>`: a spinner icon and `message`. A detail `<p>`: message `uiReceipt.sending`. |
| `recorded` | A card, `<div>` | A title `<p>`: a check icon and `message`. A detail `<p>`: a badge `<span>` with message `uiReceipt.recorded`, then `meta`. An actions `<div>` holding `actions`. |
| `checking` | A card, `<div>` | A title `<p>`: an icon and `message`, or message `uiReceipt.checking.title` when `message` is not given. A detail `<p>`: message `uiReceipt.checking`. |
| `applied` | A bar, `<div>` | A check icon. The message, a `<span>`. An undo `<button type="button">` with message `uiReceipt.undoApplied`, only when `onUndo` is given. Then `actions`, with no element around it. A dismiss `<button type="button">` that holds only an icon. |

Every icon is marked `aria-hidden`.

- `message` is a string. `meta` and `actions` are slots: the caller's own elements.
- Only `applied` has a dismiss button of its own. A `recorded` receipt that can be closed gets its close button
  from the caller, inside `actions`.
- `recorded` renders the actions `<div>` whenever `actions` is not `null` or `undefined`. A caller that passes
  `false` or an empty string gets an empty `<div>`, and the card's gap leaves `--space-2` of space for it under the
  detail line. A call site that writes `actions={condition && <Button ... />}` passes `false` when the condition
  fails: `features/attendance/ui/attendance-page.tsx` is one.
- `receiptAction` is the class of the undo button, exported so that a link in the `actions` of an `applied`
  receipt can take the same look.
- Nothing times out. The component has no timer: a receipt goes when the caller stops rendering it.

`placement` decides where the outer element goes:

| `placement` | Where |
|---|---|
| `inline` (default) | In the flow, where the caller renders it. |
| `docked` | Out of the flow. The receipt is rendered through `StatusDock` (`ui/status-dock`), which moves it into one fixed stack appended to `<body>`, shared by everything rendered through `StatusDock`. A receipt that lands there does not push the page. |

## Looks and sizes

There are two looks, the bar and the card, and one size. No prop picks a look: `state` does.

**The bar** (`draft`, `applied`) is a dark strip: `--ink` fill and `--surface` text, so it inverts with the theme.

| Part | Look |
|---|---|
| Bar | 13 px text (`--text-sm`), a 6 px radius, the `--shadow-pop` shadow. Padding: 8 px top and bottom, 16 px left, 12 px right. Its parts sit in one row that wraps, 12 px apart, with 8 px between wrapped rows. The message takes the spare width. |
| Tag | 12 px medium text in a 1 px `--surface` border, a 4 px radius, 8 px side padding. |
| Undo, dismiss, `receiptAction` | At least 32 px high (`--target`), 12 px side padding, a 1 px `--surface` border, a 6 px radius, no fill, medium `--surface` text, 4 px between icon and text. The dismiss button holds a 14 px icon, so it is 40 px wide. |

**The card** (`sending`, `recorded`, `checking`) is a `--surface` box with a 1 px `--border` border, a 3 px left
edge, a 6 px radius, 12 px top and bottom and 16 px side padding, and 13 px text. Its lines are 8 px apart.

| `state` | Left edge | Icon |
|---|---|---|
| `sending` | `--control-border` | `--steel`, turning once a second |
| `recorded` | `--ok-solid` | `--ok-tx` |
| `checking` | `--warn-solid` | `--warn-tx` |

| Part | Look |
|---|---|
| Title | Bold (`--fw-strong`), with a 16 px icon 8 px before the text. |
| Detail | 12 px, `--steel`. It wraps, and a long word breaks anywhere. |
| Badge | `--ok-tx`, medium weight. |
| Actions | A row that wraps: 16 px between items, 8 px between rows. |

Width and place:

| `placement` | Look |
|---|---|
| `inline` | At most 640 px wide (`--card-w`). It can shrink to nothing (`min-width: 0`). |
| `docked` | The receipt's own rule drops the 640 px limit and gives the outer element a `--surface` fill, a 6 px radius and the `--shadow-pop` shadow. The dock sets the rest in its own stylesheet: fixed at the bottom left, 16 px (`--space-4`) in from the frame's start and bottom edges, at `z-index` 40, and at most 770 px wide (`calc(var(--panel-w) * 1.75)`), less when the window is narrower. |

The component styles nothing that is passed in `meta` or `actions`. In an `applied` receipt, `actions` sits on the
dark bar, so what goes there must read on `--ink`:

- A link inherits the bar's text colour through the global link rule. With `receiptAction` it also takes the
  bordered look of the undo button.
- A `Button` keeps its own colours. Its text is `--ink`, and a `ghost` Button has no fill, so by the stylesheets
  its label is `--ink` on the `--ink` bar until it is hovered. One call site puts a ghost Button there:
  `ReceiptReference`, inside the receipt in `reference/org/ui/change-receipt.tsx`.

## States

| State | What happens |
|---|---|
| Rest | The look of the current `state`, above. |
| Hover | No look. `receipt.module.css` has no hover rule. The undo and dismiss buttons show a pointer cursor. |
| Keyboard focus | The undo button, the dismiss button and an element with `receiptAction` show two things at once: the global 2 px `--primary` outline, 2 px away, and the `--focus` shadow, a 2 px `--surface` ring with a 2 px `--primary` ring around it. The stylesheet adds the shadow and does not remove the outline. The receipt itself cannot take focus. |
| Pressed down | No look. There is no `:active` rule. |
| Selected | Does not exist. |
| Disabled | `undoing` puts the native `disabled` attribute on the undo button of an `applied` receipt. It has no look: the stylesheet has no disabled rule, and the button's own rule sets its colour, its border and the pointer cursor, so a disabled undo looks like an enabled one. No other part can be disabled. |
| Read-only, invalid | Do not exist. |
| Loading | `sending` is the loading state: the spinner turns for as long as it is shown. Under `prefers-reduced-motion: reduce` it does not turn. `undoing` shows no spinner. |
| Empty | `checking` with no `message` shows message `uiReceipt.checking.title`. `recorded` with no `meta` shows the badge alone, and with no `actions` it has no actions row. In every other state `message` is required, and nothing checks that it has text. |

## Keyboard

| Key | What it does |
|---|---|
| Tab, Shift+Tab | Moves through the buttons and links inside the receipt in document order. In an `applied` receipt that is undo, then whatever is in `actions`, then dismiss. A disabled undo is skipped. |
| Enter, Space | Presses the focused button. Native. |

The component handles no key. No key dismisses a receipt and no key is bound to undo.

The component has no focus code. Focus is not moved to a receipt when it appears. When a receipt that holds focus
goes, as it does when its dismiss button is pressed, the component does not place focus anywhere.

A docked receipt sits in the dock, which is appended to `<body>` after the application's own root. Its buttons
therefore come after the page's content in the tab order.

The receipt takes no text and handles no key, so it has no rule for a key the Korean input method owns. The source
has no `isComposing` check, no key code 229 and no composition event.

## Accessibility contract

- **Role:** `status` on the outer element, in every state and both placements. A status is a polite live region
  that is read as a whole.
- **Accessible name:** the region has none. The undo button is named by its text. The dismiss button is named by
  `aria-label`, message `uiReceipt.dismiss`.
- **Announced:** a change of text inside a receipt that is already on the page is announced politely. The buttons
  are inside the region, so their labels are part of its text.

The component's own contract is to keep one receipt mounted and change its `state`, so that every change happens
inside a region that is already there. Many call sites do not do that. They render the receipt only while there is
something to show, as in `{done && <Receipt ... />}`, or swap one receipt for another, so the region enters the page
with its text already in it. Whether a status that arrives already filled is read out is up to the browser and the
screen reader. The component does nothing about it.

Known gaps:

- A disabled undo has no look: see States.
- A ghost `Button` in the `actions` of an `applied` receipt is `--ink` on `--ink`: see Looks and sizes.
- A docked receipt comes after the page's content in the tab order and takes no focus, so a keyboard user has to
  travel the page to reach its undo.
- Pressing dismiss removes the button that holds focus, and nothing says where focus goes next.
- `applied` has no built-in word for its state. Its check icon is hidden from a screen reader, so the caller's
  `message` has to say that the change was made.

The WCAG 2.2 criteria that apply:

| Criterion | How the receipt answers it |
|---|---|
| 1.4.1 Use of Color | The left edge and the icon colour repeat what the words say: the tag, the badge and the detail line name the state in `draft`, `recorded`, `sending` and `checking`. |
| 1.4.3 Contrast (Minimum), 1.4.11 Non-text Contrast | Every colour is a token; none is written in the component. The bar pairs `--surface` text and borders with an `--ink` fill. Content in `actions` is the caller's: see the ghost Button above. |
| 1.4.10 Reflow | The bar and the actions row wrap. The detail line breaks long words. |
| 2.1.1 Keyboard | Native buttons. |
| 2.2.1 Timing Adjustable | Nothing times out. |
| 2.2.2 Pause, Stop, Hide | The spinner turns for as long as `sending` is shown and has no control to stop it. It stops under `prefers-reduced-motion: reduce`. |
| 2.4.3 Focus Order | Inline, the buttons are where the caller renders them. Docked, they come after the page's content. |
| 2.4.7 Focus Visible | The global outline and the `--focus` ring. |
| 2.4.11 Focus Not Obscured (Minimum) | A docked receipt is fixed over the page. While a dock exists, the dock's stylesheet pads the bottom of the main region (`#main`) by the space the dock takes plus `--space-4`, and sets the same scroll padding, so the page can scroll clear of it. |
| 2.5.8 Target Size (Minimum) | The undo and dismiss buttons are at least 32 px high, above the 24 px minimum. |
| 4.1.2 Name, Role, Value | The role and the names above. |
| 4.1.3 Status Messages | `role="status"`, without moving focus. |

The gallery shows the five states, inline, in `apps/web/src/ui/receipt/receipt.gallery.tsx`. It does not show a
docked receipt, an `applied` receipt without undo, with `undoing` or with `actions`, a `checking` receipt with its
own message, or a `recorded` receipt without `meta` or `actions`.

The component has no test file of its own. Two tests in `apps/web/src/ui` render it:

- `canonical.test.tsx`: a docked receipt still renders as one `role="status"` element.
- `live/change-notice.browser.test.tsx`: at 1440 and 390 px, in both themes, a docked `recorded` receipt stays
  inside the window, above a sticky action bar's button, clear of the other pieces in the dock, and the page does
  not scroll sideways.

Neither asserts anything about the other four states, the undo and dismiss buttons or the built-in text.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component).

## Phone behaviour at 390 px

Nothing in `receipt.module.css` changes with the width of the screen. Its one media query is for reduced motion.

- The bar is a row that wraps: when its parts do not fit on one line, the buttons drop to the next.
- The card's detail line and its actions row wrap.
- The buttons are at least 32 px high at every width. They do not grow to the 44 px touch size; the component
  does not read `--target-touch`.
- An inline receipt is a block: as wide as its container, up to 640 px.

A docked receipt does change, through the dock's stylesheet and not its own. Below 768 px, the shared phone
breakpoint, the dock runs from 8 px inside the left edge to 8 px inside the right edge and stretches what it holds
to that width.

A sticky [`ActionBar`](action-bar.md) lifts the dock by the height the bar takes at the foot of the window, at
every width, so a docked receipt sits above the bar's buttons, not on them.

## Copy rules

- `message` is the caller's sentence, from the message catalog in `packages/i18n`. It says what happened, to what.
  The `en` catalog is the source and the `ko` catalog must define every id.
- `meta` and `actions` are the caller's too. A command in `actions` is a verb and its object.
- The receipt owns these message ids, in `packages/i18n/src/catalogs/en/ui-receipt.ts` and its `ko` twin:

| Message id | Where it shows |
|---|---|
| `uiReceipt.draft` | The tag of a `draft` receipt. |
| `uiReceipt.undo` | The undo button of a `draft` receipt. |
| `uiReceipt.sending` | The detail line of a `sending` receipt. |
| `uiReceipt.recorded` | The badge of a `recorded` receipt. |
| `uiReceipt.checking.title` | The title of a `checking` receipt with no `message`. |
| `uiReceipt.checking` | The detail line of a `checking` receipt. |
| `uiReceipt.undoApplied` | The undo button of an `applied` receipt. |
| `uiReceipt.dismiss` | The accessible name of the dismiss button of an `applied` receipt. |

- One caller reuses `uiReceipt.dismiss` for a close button of its own in the `actions` of a `recorded` receipt:
  `features/people/ui/person-history.tsx`.
- The gallery's sample text is in the gallery catalog, which production builds leave out.

## Props

`Receipt` takes one of five shapes, one for each value of `state`. The `state` row of each table below says which
state the table is for. Every shape also takes `placement`.

<!-- ds:props apps/web/src/ui/receipt/receipt.tsx -->

### Receipt

**Shape 1 of 5**

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `message` | yes | `string` |  |  |
| `onDismiss` | yes | `() => void` |  |  |
| `state` | yes | `"applied"` |  |  |
| `actions` | no | `ReactNode` |  |  |
| `onUndo` | no | `() => void` |  |  |
| `placement` | no | `"docked" \| "inline"` |  |  |
| `undoing` | no | `boolean` |  |  |

**Shape 2 of 5**

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `state` | yes | `"checking"` |  |  |
| `message` | no | `string` |  |  |
| `placement` | no | `"docked" \| "inline"` |  |  |

**Shape 3 of 5**

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `message` | yes | `string` |  |  |
| `onUndo` | yes | `() => void` |  |  |
| `state` | yes | `"draft"` |  |  |
| `placement` | no | `"docked" \| "inline"` |  |  |

**Shape 4 of 5**

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `message` | yes | `string` |  |  |
| `state` | yes | `"recorded"` |  |  |
| `actions` | no | `ReactNode` |  |  |
| `meta` | no | `ReactNode` |  |  |
| `placement` | no | `"docked" \| "inline"` |  |  |

**Shape 5 of 5**

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `message` | yes | `string` |  |  |
| `state` | yes | `"sending"` |  |  |
| `placement` | no | `"docked" \| "inline"` |  |  |

<!-- /ds:props -->

## Tokens it reads

The focus outline is a global rule and is not listed: it reads `--primary`. The tokens that place a docked receipt
are read by the status dock's stylesheet, `apps/web/src/ui/status-dock/status-dock.module.css`, and are not listed
here either.

<!-- ds:tokens apps/web/src/ui/receipt/receipt.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border` |
| `--card-w` | `max-width` |
| `--control-border` | `border-left-color` |
| `--focus` | `box-shadow` |
| `--fw-medium` | `font-weight` |
| `--fw-strong` | `font-weight` |
| `--ink` | `background` |
| `--ok-solid` | `border-left` |
| `--ok-tx` | `color` |
| `--radius` | `border-radius` |
| `--radius-sm` | `border-radius` |
| `--shadow-pop` | `box-shadow` |
| `--space-1` | `gap` |
| `--space-2` | `gap`, `padding` |
| `--space-3` | `gap`, `padding` |
| `--space-4` | `gap`, `padding` |
| `--steel` | `color` |
| `--surface` | `background`, `border`, `color` |
| `--target` | `min-height` |
| `--text-sm` | `font-size` |
| `--text-xs` | `font-size` |
| `--warn-solid` | `border-left-color` |
| `--warn-tx` | `color` |

<!-- /ds:tokens -->
