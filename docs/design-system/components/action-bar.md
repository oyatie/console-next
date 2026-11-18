<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# ActionBar

An action bar is the foot of a form, a step or a full page: what the server said, then what the commit will do,
then the buttons, in that order.

It lives in `apps/web/src/ui/action-bar`: the component in `action-bar.tsx` and its styles in
`action-bar.module.css`.

## When to use it, and when not

| Mode | Use it for |
|---|---|
| Inline (default) | The foot of a form inside a card, a dialog or a section of a page. |
| `sticky` | The foot of a full page, such as a wizard step or a bulk edit, so that the commit never scrolls out of view. |

| Do not use it for | Use instead |
|---|---|
| The foot of a side sheet | `Sheet` (`ui/sheet`). It has a foot of its own that takes `notice`, `consequence` and `actions` in the same order, and there `consequence` is required. |
| The commands at the head of a page | `PageHead` (`ui/page-head`). |
| The commands of one row or one fact | `RowActions` (`ui/record-actions`). |
| A record's commands behind one trigger | `ActionMenu` (`ui/menu`). |
| What the commit did, once it has run | [`Receipt`](receipt.md). |

A commit that is blocked stays in the bar: put a [`DisabledReason`](disabled-reason.md) in `actions`. The bar lays
it out, as described under Looks and sizes.

## Anatomy

| Part | Element | Holds |
|---|---|---|
| Bar | `<div>` | The three parts below. It carries `data-sticky="true"` when `sticky` is set, and no such attribute otherwise. |
| Notice | None of its own | `notice`, rendered as passed, first: what the server said, such as a refusal or a passkey error. |
| Consequence | `<div>` | `consequence`. Left out when `consequence` is `null`, `undefined`, `false` or an empty string. |
| Actions | `<div>` | `actions`. Always rendered, even when it holds nothing. |

The order is fixed: notice, consequence, actions. A test pins the consequence before the actions.

The convention is one primary button, last, with cancel beside it. The component does not enforce it: `actions`
is rendered as passed.

## Looks and sizes

There are two looks, picked by `sticky`, and one size.

| Part | Inline | `sticky` |
|---|---|---|
| Bar | A column, 12 px between its parts. A 1 px `--border-soft` line on top and 12 px of padding above the content. No fill, and no padding at the sides or the bottom. | `position: sticky` at `bottom: 0`, with `z-index: 5`. A `--surface` fill, a 1 px `--border` line on top, 12 px top and bottom and 24 px side padding. Its parts sit in one row that wraps, 16 px apart, with 8 px between wrapped rows. `margin-top: auto` pushes it to the end of a flex column. |
| Notice | A row of the column. | A full row of its own. Every direct child of the bar that is not the consequence or the actions takes one. |
| Consequence | A column of 13 px text (`--text-sm`), 4 px between its lines. | The same, growing to fill the row from a base of 320 px (`calc(var(--card-w) / 2)`). |
| Actions | A row that wraps, aligned to the end, 8 px between buttons. | The same, pushed to the end of the row. |

Text in a `<b>` or a `<strong>` inside the consequence is bold (`--fw-strong`).

A sticky bar that is a direct child of an element with the global `page` class also takes negative margins of
`--space-5` at the sides and the bottom. They cancel that element's 24 px padding, so the bar runs from edge to
edge and sits flush with the bottom.

`z-index: 5` is a literal number in a stylesheet whose first line says it holds tokens only.

Two more things the bar does:

- **A blocked commit.** The bar's stylesheet finds a `DisabledReason` wrapper that is a direct child of the
  actions: a `<span>` with a direct child that has `aria-disabled="true"`. It takes the wrapper apart
  (`display: contents`), so the inert button joins the row of buttons, and gives the explanation a full row of its
  own after it, aligned to the end. A wrapper in the `disclosure` layout is left alone. The rule tells that layout
  by the word `disclosure` in the wrapper's generated class name, which holds as long as the build keeps a module
  class's local name in the name it generates. `apps/web/vite.config.ts` sets no naming rule for module classes,
  so the bundler's default applies.
- **The status dock.** A sticky bar registers itself with the status dock (`ui/status-dock`), the fixed stack that
  holds a docked `Receipt` or a `Toast`. While a dock exists and the bar is in view, the dock is lifted by the
  distance from the top of the bar to the bottom of the window, so floating status sits above the buttons and
  never on them. The distance is
  measured again when the bar changes size, when the window changes size and on scroll. An inline bar does not
  register.

## States

The bar has no states of its own. It has no hover, focus, pressed, selected, disabled, read-only or invalid look,
and no prop for one.

- **Loading:** does not exist. There is no `pending` prop. A caller that is waiting disables its own buttons.
- **Empty:** with no `consequence` the consequence box is left out. With nothing in `actions` the bar is still
  drawn, with its top line, its padding and an empty actions row.

The buttons inside bring their own states: see [Button](button.md).

## Keyboard

None. The bar cannot take focus and handles no key. No key commits and no key cancels.

Tab moves through whatever can take focus inside it, in document order: the notice, then the consequence, then
the actions.

The bar takes no text and handles no key, so it has no rule for a key the Korean input method owns. The source
has no `isComposing` check, no key code 229 and no composition event.

## Accessibility contract

- **Role:** none. The bar and its two boxes are plain `<div>` elements. It is not a landmark, a group or a
  toolbar.
- **Accessible name:** none.
- **Announced:** nothing by the bar itself. It has no live region.

What follows from that:

- A notice is announced only if what the caller passes announces itself: a `Banner` with `live`, an element with
  `role="alert"`.
- The consequence is a slot, not a live region. When its text changes as the form changes, nothing announces it.
- The consequence is not tied to the commit button with `aria-describedby`. It comes before the buttons in the
  reading order, and that is the only link between them.

Known gap: a sticky bar is opaque and stays at the bottom of its scrolling area, so content scrolls under it. The
stylesheet sets no scroll padding and no scroll margin for it. Nothing in the component keeps a control that takes
focus from ending up under the bar.

The WCAG 2.2 criteria that apply:

| Criterion | How the bar answers it |
|---|---|
| 1.3.2 Meaningful Sequence | The document order is the order on screen in both looks: notice, consequence, actions. |
| 1.4.10 Reflow | The actions row wraps, and so does the row of a sticky bar. |
| 2.4.3 Focus Order | Follows the document order. |
| 2.4.11 Focus Not Obscured (Minimum) | Not answered for a sticky bar: see the gap above. |
| 2.5.8 Target Size (Minimum) | The buttons' own sizes. The bar does not change them. |
| 3.3.4 Error Prevention (Legal, Financial, Data) | The bar gives a place to say what a commit will do before it is pressed. It does not require one: `consequence` is optional. |
| 4.1.3 Status Messages | Left to the caller, through `notice`. |

What the gallery shows:

| Shown | Where |
|---|---|
| An inline bar with a consequence, cancel and a primary; a sticky bar whose primary is blocked, in a `DisabledReason` | `apps/web/src/ui/action-bar/action-bar.gallery.tsx` |
| An inline bar with two buttons and no consequence, at the foot of a `Form` | `apps/web/src/gallery/sections/forms.gallery.tsx` |

Neither entry passes `notice`.

The component has no test file of its own. Two tests in `apps/web/src/ui` render it:

- `canonical.test.tsx`: the consequence comes before the actions, and `data-sticky` is present only when `sticky`
  is set.
- `live/change-notice.browser.test.tsx`: at 1440 and 390 px, in both themes, every piece of floating status stays
  above the button of a sticky bar, and the page does not scroll sideways.

Neither asserts the layout of a sticky bar itself, the phone rule or the rule for a blocked commit. A search of
`e2e` for `data-sticky` and for `action-bar` finds nothing.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component).

## Phone behaviour at 390 px

One media query applies, `@media (max-width: 767px)`, and only to a sticky bar:

| Part | At 767 px and narrower |
|---|---|
| Sticky bar | Side padding drops from 24 px to 16 px (`--space-4`). |
| Actions of a sticky bar | Take a full row of their own, under the consequence. The buttons stay aligned to the end and wrap. |

An inline bar does not change with the width of the screen. It is already a column.

- The query is written as a literal width. It is not the shared phone breakpoint, `width < 768px`, that other
  components use. The two differ only for a window between 767 and 768 px wide.
- The negative margins of a sticky bar inside a `page` element stay at 24 px, as that element's padding does:
  `app.css` has one rule for its padding, at every width. So at 390 px the bar still runs from edge to edge, and
  its content starts 16 px in.
- The buttons are as tall as they are on a wide screen. The bar does not read `--target-touch`.
- The lift of the status dock follows the bar's real height, so it grows when the bar wraps onto more rows.

## Copy rules

- The bar holds no text of its own and owns no message id.
- Everything in it comes from the message catalog in `packages/i18n`, through the caller. The `en` catalog is the
  source and the `ko` catalog must define every id.
- The consequence says what the commit will do, in numbers. The gallery's example names how many people move,
  where to and from which date.
- The notice is what the server said. The bar adds no words to it.
- A button label is a verb and its object: see [Button](button.md#copy-rules).
- The gallery's sample text is in the gallery catalog, which production builds leave out.

## Props

<!-- ds:props apps/web/src/ui/action-bar/action-bar.tsx -->

### ActionBar

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `actions` | yes | `ReactNode` |  |  |
| `consequence` | no | `ReactNode` |  |  |
| `notice` | no | `ReactNode` |  |  |
| `sticky` | no | `boolean` |  |  |

<!-- /ds:props -->

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/action-bar/action-bar.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border-top-color` |
| `--border-soft` | `border-top` |
| `--card-w` | `flex` |
| `--fw-strong` | `font-weight` |
| `--space-1` | `gap` |
| `--space-2` | `gap` |
| `--space-3` | `gap`, `padding`, `padding-top` |
| `--space-4` | `gap`, `padding-inline` |
| `--space-5` | `margin-bottom`, `margin-inline`, `padding` |
| `--surface` | `background` |
| `--text-sm` | `font-size` |

<!-- /ds:tokens -->
