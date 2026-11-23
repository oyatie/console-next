<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Sheet

A sheet is a modal panel on the right edge of the screen for one action on a record: a head with the title, a
scrolling body with the fields, and a foot that states the consequence above the buttons that commit.

It lives in `apps/web/src/ui/sheet`:

| File | What it holds |
|---|---|
| `sheet.tsx` | `Sheet`, the component. |
| `sheet-dismiss.ts` | `useSheetDismiss`, the rules for closing a sheet. `DockSheet` uses the same hook. |
| `sheet-draft.ts` | `SheetDraftProvider`, which hands a sheet the state of a saved draft. |
| `read-context.ts` | `SheetReadContext`, which hands a sheet the reads its content depends on. |
| `sheet.module.css` | The styles. |

It is built on the modal overlay of React Aria Components.

## When to use it, and when not

Use a sheet for one command on a record or a list: it opens over the side of the page, so the record stays in
view while the person fills the fields and reads what the command will do.

| Do not use it for | Use instead |
|---|---|
| A confirmation, a blocking error or an urgent notice | `Dialog`: see [Dialog](dialog.md). |
| A read-only look at a record beside a list | `SidePanel` (`ui/side-panel`). It is not modal and it holds no edits. |
| A form that must leave the view beside it usable, such as a grid whose selected cells it works on | `DockSheet` (`ui/dock-sheet`). It is not modal at 960 px and wider; below that it renders this sheet. |
| A governed form with a preview of its routing and its sign-offs | `Composer` (`ui/composer`). Its drawer layout renders this sheet. |
| A small panel that opens beside its trigger | `PopoverButton` (`ui/popover`). |
| A list of commands behind one button | `ActionMenu` or `MenuButton`: see [Menu](menu.md). |

## Anatomy

| Part | Element | Holds |
|---|---|---|
| Overlay | `<div>` | The dimmed backdrop. It fills the viewport and puts the sheet at the right edge. React Aria renders it in a portal on `<body>`. |
| Sheet | `<div data-size data-sheet-layer>` | The panel, as tall as the viewport. |
| Dialog | `<section role="dialog">` | The head, the body and the foot, in a column. |
| Head | `<div>` | The titles, then the close button. |
| Kicker | `<span>` | `kicker`: a line above the title that says where the action applies. Left out when not given. |
| Title | `<h2>` | `title`. It names the dialog. |
| Subtitle | `<p>` | `subtitle`. Left out when not given. |
| Close button | `<button class="btn btn--ghost">` | A 16 px cross icon. |
| Body | `<div>` | `children`. It is the part that scrolls. |
| Foot | `<div>` | Top to bottom: the read notice, `notice`, the draft line, the unsaved line, the consequence, the actions. |
| Consequence | `<div>` | `consequence`: one sentence that says what the command will do, built from the values it sends. |
| Actions | `<div>` | `actions`: the caller's buttons. |

The four lines above the consequence appear only when they have something to say:

| Line | Shown when | What it is |
|---|---|---|
| Read notice | The caller passed reads through `SheetReadContext`. | `QueryState` (`lib/react/query-state.tsx`) over those reads as one group, with no content of its own, so that only the state of the reads shows. What it says is `QueryState`'s to decide. |
| `notice` | The caller passes it. | What the server said: a refusal, a lost response. The caller's element. |
| Draft line | A `SheetDraftProvider` is above the sheet and its draft was restored or has a problem. | A `<div role="status">` with message `draft.restored` or `draft.unavailable`. A restored draft with no problem also gets a ghost button, message `draft.discard`, that calls the draft's `discard`. |
| Unsaved line | The sheet is dirty and a first attempt to close it was held back. See States. | A `<div role="status">` with message `composer.unsaved`. |

`consequence` and `actions` are required, and both accept `null`. The foot then keeps an empty row for each.
Several callers pass `null` for both. Two of them: the filter sheet of the access log, and the wrapper in
`features/entity/ui/fresh-entity.tsx` that shows a read's loading or refusal inside a sheet.

With `open={false}` nothing is rendered. While `open`, the sheet holds the page's live re-reads (`useLiveHold`),
so the page behind it does not change under it.

`Sheet` takes the props in the Props section and nothing else. It passes no attribute through.

### The two contexts

- **`SheetDraftProvider`** takes a `draft`: `dirty`, `restored`, `problem` and `discard`. A sheet below it treats
  `draft.dirty` as its dirty state, ahead of its own `dirty` prop, and shows the draft line.
- **`SheetReadContext`** carries a list of reads. A sheet shows the read notice for the list it finds above itself,
  and resets the list to empty for everything inside it.

## Looks and sizes

`size` picks the width. The default is `md`.

| `size` | Width |
|---|---|
| `md` | `min(100%, var(--sheet-w))`: 560 px, or the width of the screen when that is less. |
| `lg` | `min(100%, var(--sheet-w-lg))`: 728 px (`--sheet-w` times 1.3), or the width of the screen when that is less. It is for a body that holds a table. |

The height is always `100dvh`.

| Part | Look |
|---|---|
| Overlay | Fixed to the viewport at `z-index: var(--z-sheet)` (20). Its fill is `--scrim`. It has no padding. |
| Sheet | `--surface` fill, `--ink` text, `--shadow-pop`. No border and no radius. |
| Head | 16 px top and bottom padding (`--space-4`), 24 px at the sides (`--space-5`), a 1 px `--border` line under it. |
| Kicker | 12 px (`--text-xs`), `--steel`. A row with a 4 px gap, for an icon and a path. |
| Title | 16 px (`--text-lg`), weight 700 (`--fw-strong`). |
| Subtitle | 13 px (`--text-sm`), `--steel`. |
| Close button | The `ghost` button look: transparent until hovered, at least 36 px high (`--control-h`), 12 px side padding. With its 16 px icon and 1 px border that is 42 px wide. |
| Body | The same padding as the head. A column with a 24 px gap (`--space-5`). It takes the height the head and the foot leave and scrolls inside it. |
| Foot | The same padding. A 1 px `--border` line above it and a `--canvas` fill. A column with a 12 px gap (`--space-3`). |
| Consequence | 13 px (`--text-sm`). A column with a 4 px gap. `<b>` and `<strong>` inside it are weight 700. |
| Actions | A row aligned to the end, with an 8 px gap (`--space-2`). It wraps. |

No prop picks a visual style. There is no open or close animation: the stylesheet has no transition and reads
neither `data-entering` nor `data-exiting`.

Every colour in the stylesheet is a token, and so is every padding, gap and font size. The opacity of an inert
body is the literal `0.5`.

The global `.overlay` and `.dialog` rules in `app.css` do not apply to a sheet. Its overlay and its dialog carry
module classes of their own.

## States

| State | What changes |
|---|---|
| Closed | Nothing is rendered. |
| Open | The sheet is drawn, everything outside it is made inert, and React Aria locks the scroll of the document. |
| Hover | The close button and the discard button of the draft line are ghost buttons and take the button hover: a `--muted` fill. The sheet's own stylesheet has no hover rule. |
| Focus | On open, focus moves to the dialog element itself, unless an element inside has already taken it. The dialog's rule sets `outline: none`, to keep the global focus outline off it: see the note under this table. The close button and the controls inside show the global focus outline. |
| Pressed, selected | Do not exist. |
| Dirty | No look until the person tries to close. See below. |
| Unsaved prompt | The unsaved line appears in the foot. The sheet stays open. |
| Pending (`pending`) | The command is sending. The close button is disabled and takes the disabled button look: half opacity and a not-allowed cursor. The body is `inert` and at half opacity. The actions are `inert` too, with no look of their own: the stylesheet does not dim them. None of the four gestures below closes the sheet. |
| Locked (`locked`) | The body is `inert` and at half opacity. The foot still acts and the sheet can still be closed. It is for a body that must not change while a lost response is being checked. |
| Loading (`loading`) | The body shows a `Skeleton` of a title and three rows in place of `children`, so the form is drawn once, whole, when its lists have arrived. The `Skeleton` is invisible for its first 200 ms: its own stylesheet starts it at `opacity: 0` and shows it after that delay. The head and the foot are drawn as usual. |
| Disabled | Does not exist for the sheet as a whole. `pending` and `locked` are the two ways it stops taking input. |
| Read-only | `locked`, above. |
| Invalid | Does not exist. Errors belong to the fields inside and to `notice`. |
| Empty | Does not exist. `children` is required. |

The dialog's `outline: none` is a rule of one class, and the global `:focus-visible` rule in `app.css` is a rule of
one pseudo-class. The two weigh the same, so the sheet's rule wins only when its stylesheet comes after `app.css`.
This page did not check the order in a build of this branch. The [Menu](menu.md) page says the same of its items.

### Dirty, and how a sheet closes

A sheet is **dirty** when it holds an edit that closing would lose. There are two ways it knows:

- **Told.** The caller passes `dirty`, or a `SheetDraftProvider` above the sheet supplies `draft.dirty`. The
  sheet believes it.
- **Worked out.** Otherwise the sheet compares the value of each control inside it with the value that control had
  when the sheet first saw it. It reads inputs, selects, textareas, editable elements and any element with a
  `data-form-value` attribute. It does not read a search input, a file input, or an input with the role
  `searchbox` or `combobox`, so text typed to filter a list does not count. A value put back to what it was makes
  the sheet clean again.

Four gestures can close a sheet. Each calls `onClose`; none removes the sheet by itself.

| Gesture | Clean sheet | Dirty sheet | While `pending` |
|---|---|---|---|
| The close button | Closes. | With a pointer, the first press shows the unsaved line and the second closes. With Enter or Space it does not close: see the known gaps. | Disabled. |
| Escape | Closes. | The first press shows the unsaved line. The second closes. | Nothing. |
| A press on the backdrop | Closes only when the sheet holds no form control and was not told its dirty state. Otherwise nothing. | Shows the unsaved line. It never closes a dirty sheet. | Never closes. On a dirty sheet it still shows the unsaved line. |
| The browser's Back | The history moves, and the sheet closes once the destination has rendered. | The first Back is held back and shows the unsaved line. The next one goes through. | Held back. |

For the backdrop, a form control is a `<form>`, an element with the class `form`, an input, a select, a textarea,
an editable element or an element with `data-form-value`.

The Back row holds for every history move that is not a push or a replace, so the browser's Forward is treated the
same way.

The backdrop is the one gesture that still acts while `pending`, and a pending sheet can still be dirty: its fields
keep what was typed while the command is sending. What follows is read from `sheet-dismiss.ts`, not run. The
unsaved line shown this way stays, and the sheet counts it as the first attempt to close. Once `pending` clears,
the next Escape, pointer press on the close button or Back closes the sheet without asking again, unless the line
has been withdrawn first.

The unsaved line is withdrawn by any key other than Escape, by any input or change in the body, and by a change
of a value the sheet reads. The next attempt to close then asks again.

While the guard on Back is in place and the sheet is dirty, the sheet also asks the router to guard
`beforeunload`, the event behind the browser's own question on reload or on closing the tab.

Only the top sheet answers. When several sheets are open, the one last in the document handles Escape, the
backdrop and Back; the ones under it ignore them.

`e2e/mock/sheet-interactions.spec.ts` drives Escape, the backdrop, Back, stacked sheets, pickers and a restored
draft in a browser. It has no test of `pending`.

## Keyboard

| Key | What it does |
|---|---|
| Tab, Shift+Tab | Moves through the focusable elements inside the sheet. Focus stays inside: React Aria contains it. An `inert` body or `inert` actions are skipped. |
| Escape | Asks the sheet to close, as in the table above. |
| Enter, Space on the close button | Asks the sheet to close. On a dirty sheet this never closes it: see the known gaps. |
| Any other key | Withdraws the unsaved line, when it is shown. Tab is one of them. |

The sheet's own Escape handler stands aside, and so does not show the unsaved line, in these cases:

- another handler has already prevented the event's default;
- it is pressed in a list box, or on an element with `aria-expanded="true"`, such as an open picker;
- it is pressed inside another dialog nested in the sheet;
- the event's `isComposing` flag is set.

On a dirty sheet that has not yet shown the unsaved line, such an Escape does nothing to the sheet. On a clean
sheet, React Aria's overlay still closes the sheet if the Escape reaches it.

The last case is the sheet's rule for the Korean input method. `sheet-dismiss.ts` checks `isComposing` and
nothing else: it does not check key code 229 and listens for no composition event. An Escape flagged as composing
neither shows the unsaved line nor closes the sheet. The sheet's handler stands aside, and React Aria's overlay
skips such an event too in the installed version (`react-aria-components` 1.22.1). No test in this repository
presses Escape in a sheet while the input method is composing.

Other keys pressed while composing are not treated specially. Like any key, and like the input they produce, they
withdraw the unsaved line.

When the sheet closes, focus returns to the element that had it before the sheet opened.
`apps/web/src/ui/dialog.browser.test.tsx` checks this for the sheet as well as the dialog.

## Accessibility contract

| Part | Role | Accessible name | Also exposed |
|---|---|---|---|
| Dialog | `dialog` | `title`, through `aria-labelledby`, which points at the `<h2>`. | Nothing else. There is no `aria-describedby`: the kicker, the subtitle and the consequence are not its description. There is no `aria-modal`. |
| Close button | `button` | Message `uiSheet.close`, through `aria-label`. The icon is `aria-hidden`. | `disabled` while `pending`. |
| Loading placeholder | `status` | Message `common.loading`, through `aria-label`. | `aria-busy="true"`. |
| Draft line, unsaved line | `status` | None. Its text is its content. | |

- **Modality:** while the sheet is open, everything outside it is `inert`: it cannot be focused, pressed or read.
  `apps/web/src/ui/dialog.browser.test.tsx` proves three things for a sheet in a real browser: the page root is
  `inert` and gets no `aria-hidden` from the sheet; an `inert` or `aria-hidden` attribute the page already had on
  another element is left as the page set it; and focus is back on the opener after the sheet closes. Its other
  two checks, on content added while open and on one overlay handing over to another, run on a dialog only.
- **Inert parts:** while `pending` or `locked`, the body's controls cannot be focused or read. While `pending`
  the same holds for the actions.
- **Announced:** opening moves focus into the dialog, which is how a screen reader comes to read its role and
  name. The draft line and the unsaved line are `role="status"` elements. Each is added to the foot already
  holding its text; the sheet does not keep an empty status region to fill later. Nothing in this repository
  checks that a screen reader announces them.
- **No hidden dismiss button:** React Aria adds one only to an overlay it may dismiss by itself. The sheet handles
  the backdrop by its own rules, so it has none. The visible close button is the control.

The WCAG 2.2 criteria that apply:

| Criterion | How the sheet answers it |
|---|---|
| 1.3.1 Info and Relationships | The title is a heading and is the dialog's name. |
| 1.4.3 Contrast (Minimum), 1.4.11 Non-text Contrast | Every colour is a token. An inert body is drawn at half opacity. |
| 1.4.10 Reflow | The sheet is never wider than the screen. The body scrolls; the head and the foot stay. |
| 2.1.1 Keyboard | Escape and the close button, with the gap below for the close button of a dirty sheet. |
| 2.1.2 No Keyboard Trap | Focus is held inside on purpose. Escape and the close button are the way out. While `pending` there is none, until the caller clears `pending`. |
| 2.4.3 Focus Order | Focus moves into the sheet on open and back to where it was on close. |
| 2.4.7 Focus Visible | The global 2 px outline on the close button and on the controls inside. The dialog element itself is meant to show none, with the caveat under the States table. |
| 2.4.11 Focus Not Obscured (Minimum) | The page behind is inert. Inside, the head and the foot sit beside the scrolling body, not over it. |
| 2.5.8 Target Size (Minimum) | The close button is at least 36 px high and 42 px wide. |
| 3.3.4 Error Prevention (Legal, Financial, Data) | The foot states the consequence above the buttons that commit, and a dirty sheet asks once before it is closed. Whether a command also needs a confirmation step is the caller's to decide. |
| 4.1.2 Name, Role, Value | The table above. |
| 4.1.3 Status Messages | The draft line and the unsaved line are status regions, with the limit stated above. |

Known gaps:

- By keyboard, the close button never closes a dirty sheet. The keydown of Enter or Space is a key other than
  Escape, so it withdraws the unsaved line; the press that follows then finds no line and shows it again. This
  repeats on every press. Escape pressed twice does close a dirty sheet, and so does a button of the caller's that
  calls `onClose`. This is read from `sheet-dismiss.ts`; no test presses the close button of a dirty sheet by
  keyboard.
- The actions are `inert` while `pending` but look the same, unless the caller also disables its buttons.
- A status line arrives together with its text. There is no region that is mounted first and filled later.
- The dialog has no description: the kicker and the subtitle are not tied to it.
- A locked body is dimmed and inert, and the sheet itself does not say why. The reason is the caller's `notice`.

What the gallery shows:

| Shown | Where |
|---|---|
| An `lg` sheet with a kicker, a subtitle, a two-line consequence, two actions and one field | `apps/web/src/ui/sheet/sheet.gallery.tsx` |
| An `md` sheet with a title, a consequence and one action | `apps/web/src/gallery/sections/page.gallery.tsx` |
| Two `md` sheets drawn by `Composer` in its drawer layout, each with one field | `apps/web/src/ui/composer/composer.gallery.tsx` |
| An `md` sheet drawn by `DockSheet` below 960 px, with a kicker, a consequence and two actions. The entry starts open, so at that width the gallery loads with this sheet open. | `apps/web/src/ui/dock-sheet/dock-sheet.gallery.tsx` |

Three entries that belong to features open a sheet from a button, through a feature component:
`features/people/ui/rrn-entry.gallery.tsx`, `features/payroll/ui/payroll.gallery.tsx` and
`features/people/ui/roster-saved-views.gallery.tsx`. The last opens only once its list read has data. These seven
are all there is: a trace of the imports of every `*.gallery.tsx` reaches one more feature entry, and it renders
no sheet.

No entry opens a sheet that starts `pending`, `locked` or `loading`. In the four entries of the table none of the
three is ever true, and `notice` is not passed. Between them, the three feature entries tie all three and `notice`
to a command or a read; this page did not run them. No entry is under a `SheetDraftProvider` or passes reads through
`SheetReadContext`, so none shows the draft line or the read notice. The unsaved line appears in the first entry
once its field is edited and Escape is pressed.

Tests: `ui/sheet` has no unit test of its own. The sheet is proved in a browser by
`apps/web/src/ui/dialog.browser.test.tsx`, by `e2e/mock/sheet-interactions.spec.ts` and by
`e2e/mock/sheet-layout.spec.ts`. The last opens a real sheet at 1440 and 390 px in the light and the dark theme,
checks that it fits, runs axe over the dialog, and checks that the record behind it does not change width when
the sheet opens or closes.

Other specs drive a sheet on the screen that owns it. One example: `e2e/states/structure-sheet-read.spec.ts` holds
a read back and expects a `common.loading` status inside the sheet. Where this page traced it, for the sheet that
adds a workplace, that status is the read placeholder the caller renders as the sheet's content
(`features/entity/ui/fresh-entity.tsx`), not the sheet's own `loading` placeholder.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component).

That scan does not reach an open sheet. A closed sheet renders nothing and the scan opens none. It runs at
1280 px, where the `DockSheet` entry is docked and is not this sheet. For this component it covers the buttons
that open the gallery's sheets and no more. Other specs do scan an open sheet. Two of them:
`e2e/mock/sheet-layout.spec.ts`, as above, and `e2e/mock/sheet-interactions.spec.ts`, which runs axe over the
dialog while the unsaved line is shown, and again with a restored draft.

## Phone behaviour at 390 px

`sheet.module.css` has no media query and no container query. What changes at 390 px follows from the width rule.

- The width is the smaller of 100% and the size. Both sizes are wider than 390 px, so either sheet fills the
  whole width of the screen.
- No backdrop is left to see or to press. The close button, Escape and Back remain.
- The height is `100dvh`, so the sheet follows the visible viewport. The head and the foot stay in place and the
  body scrolls between them. The body sets `overscroll-behavior: contain`.
- The actions wrap onto more lines.
- The close button is the same size as at 1440 px: at least 36 px high and 42 px wide. It does not grow to the
  44 px touch size; the sheet does not read `--target-touch`.

`DockSheet` renders this sheet below 960 px. That switch belongs to `DockSheet`, not to the sheet.

## Copy rules

- `title` is the caller's text, from the message catalog in `packages/i18n`. The `en` catalog is the source and
  the `ko` catalog must define every id. It is a string, not markup.
- `consequence` is one sentence, built from the values the request sends.
- `kicker` says where the action applies. `subtitle` is optional.
- `notice` is for what the server said.
- The actions' labels are the caller's.
- The sheet has one message id of its own: `uiSheet.close`, the name of the close button.
- It also uses five ids from other parts of the catalog: `common.loading` for the loading placeholder,
  `composer.unsaved` for the unsaved line, and `draft.restored`, `draft.unavailable` and `draft.discard` for the
  draft line.

## Props

<!-- ds:props apps/web/src/ui/sheet/sheet.tsx -->

### Sheet

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `actions` | yes | `ReactNode` |  |  |
| `children` | yes | `ReactNode` |  |  |
| `consequence` | yes | `ReactNode` |  |  |
| `onClose` | yes | `() => void` |  |  |
| `open` | yes | `boolean` |  |  |
| `title` | yes | `string` |  |  |
| `dirty` | no | `boolean` |  | An authoritative dirty state; without it, committed form values are compared with this opening. |
| `kicker` | no | `ReactNode` |  | A line above the title saying where the action applies (an icon and a path). |
| `loading` | no | `boolean` |  | The lists the body draws from are still arriving: one loading line stands in for the whole body, so the form draws once, whole. Drawn field by field, a list landing late (a catalog's chips) grew above fields already under the pointer and pushed them down. |
| `locked` | no | `boolean` |  | The body is read-only (a lost response is being checked); the foot still acts. |
| `notice` | no | `ReactNode` |  |  |
| `pending` | no | `boolean` |  |  |
| `size` | no | `"lg" \| "md"` |  |  |
| `subtitle` | no | `ReactNode` |  |  |

<!-- /ds:props -->

<!-- ds:props apps/web/src/ui/sheet/sheet-draft.ts -->

### SheetDraftProvider

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `draft` | yes | `SheetDraftState` |  |  |
| `children` | no | `ReactNode` |  |  |

<!-- /ds:props -->

<!-- ds:props apps/web/src/ui/sheet/read-context.ts -->

### SheetReadContext

Accepts the attributes of `ProviderProps` (`@types/react`).

<!-- /ds:props -->

Notes on the tables:

- The comment on `loading` speaks of one loading line. The code draws a `Skeleton` of a title and three rows.
- `SheetDraftState` is an object with `dirty` and `restored` (booleans), `problem` (`"unreadable"`,
  `"unavailable"` or `null`) and `discard` (a function).
- `SheetReadContext` is a React context, used as a provider. Its `value` is the list of reads.
- `sheet-dismiss.ts` exports a hook and no component, so it has no table.

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/sheet/sheet.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border-bottom`, `border-top` |
| `--canvas` | `background` |
| `--fw-strong` | `font-weight` |
| `--ink` | `color` |
| `--scrim` | `background` |
| `--shadow-pop` | `box-shadow` |
| `--sheet-w` | `width` |
| `--sheet-w-lg` | `width` |
| `--space-1` | `gap` |
| `--space-2` | `gap` |
| `--space-3` | `gap` |
| `--space-4` | `padding` |
| `--space-5` | `gap`, `padding` |
| `--steel` | `color` |
| `--surface` | `background` |
| `--text-lg` | `font-size` |
| `--text-sm` | `font-size` |
| `--text-xs` | `font-size` |
| `--z-sheet` | `z-index` |

<!-- /ds:tokens -->

The close button carries the global `btn` and `btn--ghost` classes. Their tokens are on the
[Button](button.md#tokens-it-reads) page.
