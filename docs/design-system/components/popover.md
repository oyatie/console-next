<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Popover

`PopoverButton` is a small trigger that opens a titled panel beside it: a heading, then whatever the caller
renders, which is handed a function that closes the panel.

It lives in `apps/web/src/ui/popover`: `popover-button.tsx` with `popover.module.css`. It is built on the dialog
trigger, the popover and the dialog of React Aria Components.

## When to use it, and when not

Use it for a small piece of content, or a short pick, that belongs beside the control that opens it: an
explanation, a legend, a date, a reason, a scope or a column picker. It closes on Escape or on a press outside,
so it suits content the user may leave without answering.

| Do not use it for | Use instead |
|---|---|
| A list of commands | `ActionMenu` or `MenuButton`: see [Menu](menu.md). |
| One choice from a short list of plain options | `SelectField`: see [Select](select.md). |
| A question that must be answered before going on | `Dialog`: see [Dialog](dialog.md). |
| A command on a record, with its fields and a stated consequence | `Sheet`: see [Sheet](sheet.md). |
| A read-only look at a record beside a list | `SidePanel` (`ui/side-panel`). |
| Saying why one control cannot be used | `DisabledReason`: see [Disabled reason](disabled-reason.md). |
| A date in a form | `DateField`: see [Date](date.md). |

## Anatomy

| Part | Element | Holds |
|---|---|---|
| Trigger | `<button type="button">` | `trigger`: text, an icon, or both. |
| Popover | `<div>` | The dialog. React Aria renders it in a portal on `<body>`, below the trigger and aligned to its start edge. |
| Dialog | `<section role="dialog">` | The title, then the body. |
| Title | `<h2>` | `title`. It can be markup, such as an icon and text. |
| Body | `<div>` | What `children` returns. |

`children` is a function. It is called with `close`, and calling `close` closes the panel. The effective-date
chip (`reference/org/ui/effective-date-chip.tsx`) closes its panel that way once an allowed date is picked.

Nothing of the panel is in the page while it is closed. State kept inside `children` is lost when the panel
closes.

Passing `isOpen` makes the component controlled: `isOpen` and `onOpenChange` go straight to React Aria's dialog
trigger. The panel then opens and closes only as the caller changes `isOpen`. A press on the trigger, Escape, a
press outside or a call to `close` calls `onOpenChange`, and the panel stays as it was until the caller updates
`isOpen` from it. With `isOpen` left out, the panel keeps its own state.

The popover asks for `placement="bottom start"` and sits 8 px from the trigger. The 8 px is React Aria's default
offset in the installed version (`react-aria-components` 1.22.1); the component passes none. React Aria sets the
position, and may move the panel to keep it on the screen.

The component passes no other attribute through. It has no `ref`, and it cannot disable its trigger.

## Looks and sizes

The trigger has three looks. `link` wins when both `link` and `chip` are passed.

| Props | Classes | Look |
|---|---|---|
| Neither | `btn btn--ghost` | The `ghost` button look: a transparent border, and no fill until hovered, at least 36 px high (`calc(var(--row-h) - var(--space-1))`), 12 px side padding, a 6 px radius, weight 600, an 8 px gap between an icon and the text. |
| `chip` | `btn btn--chip` | A pill: at least 28 px high (`calc(var(--space-6) - var(--space-1))`), 12 px of padding on the left and 8 px on the right, a 1 px `--control-border` border, a 100 px radius (`calc(var(--radius-lg) * 10)`), `--surface` fill, 13 px text (`--text-sm`) at weight 400, on one line. |
| `link` | The module's `link` | Text that reads as a link: no border, no fill and no padding, `--primary` text at 12 px (`--text-xs`) and weight 600 (`--fw-medium`), on one line, a 4 px radius (`--radius-sm`), a 2 px gap (`calc(var(--space-1) / 2)`). No minimum height: one line comes to 18 px at the body's line height of 1.5. |

The first two looks are global button classes. The [Button](button.md) page describes them as the `ghost`
variant and as the `chip` look of `ToggleButton`.

The panel has two widths. Nothing else about it changes.

| Part | Look |
|---|---|
| Popover | `--surface` fill, a 1 px `--border` border, a 10 px radius (`--radius-lg`), `--shadow-pop`. |
| Popover width | 414 px (`calc(var(--panel-w) - var(--space-5) - 2px)`), and never more than the screen less 16 px (`calc(100vw - var(--space-4))`). |
| Popover width with `wide` | 504 px (`calc(var(--panel-w) + var(--space-6) * 2)`), with the same cap. For a picker that holds a tree or a list of rows. |
| Title | A row with an 8 px gap (`--space-2`), 8 px top and bottom padding and 12 px at the sides, a 1 px `--border` line under it, 13 px text (`--text-sm`) at weight 700 (`--fw-strong`), no margin. |
| Body | A column with an 8 px gap (`--space-2`), 10 px top and bottom padding (`calc(var(--space-2) + 2px)`) and 12 px at the sides (`--space-3`), 13 px text (`--text-sm`). |
| Dialog | No look of its own. It sets `outline: none` against the global focus outline: see the second point below. |

Five things about these rules are worth knowing:

- The component does not carry the global `popover` class of `app.css` and relies on no rule of it. Its box is
  drawn by its own module.
- The dialog's `outline: none` is a rule of one class, and the global `:focus-visible` rule in `app.css` is a
  rule of one pseudo-class. The two weigh the same, so the module's rule wins only when its stylesheet comes
  after `app.css`. This page did not check the order in a build of this branch. Where this page says that the
  focused dialog shows no outline, it takes that order as given.
- The module gives the popover no `overflow`. React Aria sets a maximum height on the popover element when it
  places it, and content taller than that is not scrolled by the popover.
- React Aria also sets `z-index` on the popover element itself. The module sets none.
- The width is fixed, not fitted to the content: a short explanation sits in a 414 px panel.

There is no open or close animation: the module has no transition and reads neither `data-entering` nor
`data-exiting`.

## States

The trigger:

| State | What changes |
|---|---|
| Rest | The look above. |
| Hover | `ghost` and `chip`: a `--muted` fill, from the global button rule. `link`: nothing but the pointer cursor; the module has no hover rule. |
| Keyboard focus | The global 2 px `--primary` outline, 2 px away. No look has a focus rule of its own. |
| Open | No look. React Aria sets `aria-expanded="true"` and `data-pressed` on the trigger; no rule reads either. |
| Pressed | No look. |
| Selected | Does not exist. The `chip` class has a pressed look for `aria-pressed="true"`, which this trigger never sets. |
| Disabled | Does not exist. The component cannot disable its trigger. |

The panel is open or it is not in the page. It has no other state. Read-only, invalid, loading and empty do not
exist: what the body shows while its data loads, or when it has nothing to show, is the caller's.

## Keyboard

| Key | Where | What it does |
|---|---|---|
| Tab, Shift+Tab | Trigger | Moves focus to and from the trigger. |
| Enter, Space | Trigger | Opens the panel. Focus moves to the dialog element itself, not to its first control. |
| Tab, Shift+Tab | Open panel | Moves through the focusable elements of the body. React Aria keeps focus inside the panel. |
| Escape | Open panel | Closes the panel. Focus returns to the trigger. |

A press outside the panel also closes it.

A caller can put focus on a control of its own as the body mounts, and the dialog then leaves it there. The
reason panel in `reference/org/ui/inline-unit-fields.tsx` does this with a ref on its text area.

These keys are React Aria's; the component has no key handler. It does not check `isComposing`, key code 229 or
a composition event, so it has no rule of its own for a key the Korean input method owns. In the installed
version (`react-aria-components` 1.22.1), React Aria's Escape handler skips a key event whose `isComposing` flag
is set. An Escape that carries the flag, pressed while a syllable is being composed in a field inside the panel,
therefore does not close the panel. A field inside the panel brings its own key rules: `TextInput` keeps its
Enter rule, on the [Field](field.md#keyboard) page. Neither browser test named in the accessibility section
composes text in a panel.

## Accessibility contract

| Part | Role | Accessible name | Also exposed |
|---|---|---|---|
| Trigger | `button` | `label`, through `aria-label`. It replaces the text inside `trigger`. | `aria-expanded`, and `aria-controls` while open, pointing at the dialog. No `aria-haspopup`: React Aria sets it for a menu or a list, not for a dialog. |
| Popover | None. | | `aria-labelledby`, pointing at the trigger, on an element with no role. React Aria's dialog trigger gives it to the popover. The popover drops its own role, `id` and `tabindex` when it holds a dialog, and keeps this attribute. |
| Dialog | `dialog` | `title`, through `aria-labelledby`, which points at the heading. | `tabindex="-1"`. No `aria-modal`. |
| Title | `heading`, level 2 | Its text. | |

- **Modality:** the panel behaves as a modal one. While it is open, everything outside the popover is `inert`,
  React Aria locks the scroll of the document, and focus is kept inside. The component's own comment calls the
  panel non-modal; the code does not ask React Aria for a non-modal popover.
- **Announced:** nothing through a live region. Opening moves focus to the dialog, which is named by its title.
- **Hidden dismiss buttons:** React Aria puts a visually hidden button at the start and at the end of the popover.
  Each closes the panel. Neither is in the tab order. React Aria names them with its own text for "dismiss", in
  the locale the app gives React Aria.
- **Heading level:** the title is always an `<h2>`, wherever the trigger sits in the outline of the page.
- **Icons:** an icon in `trigger` or `title` is decoration. The caller marks it `aria-hidden`; the component does
  not.

The WCAG 2.2 criteria that apply:

| Criterion | How the component answers it |
|---|---|
| 1.3.1 Info and Relationships | A `dialog` named by its heading, tied to a trigger that says whether it is open. |
| 1.4.3 Contrast (Minimum), 1.4.11 Non-text Contrast | Every colour is a token. |
| 1.4.10 Reflow | The panel is never wider than the screen less 16 px. |
| 2.1.1 Keyboard | The table above. |
| 2.1.2 No Keyboard Trap | Escape closes the panel and returns focus to the trigger. |
| 2.4.3 Focus Order | Focus moves into the panel on open and back to the trigger on close. |
| 2.4.7 Focus Visible | The trigger shows the global outline. The dialog element, which takes focus on open, sets `outline: none` and shows nothing, given the stylesheet order noted under Looks and sizes. |
| 2.5.3 Label in Name | The caller's to keep: `aria-label` replaces the text in `trigger`, so `label` must contain that text. |
| 2.5.8 Target Size (Minimum) | The `ghost` trigger is at least 36 px high and the `chip` trigger at least 28 px. The `link` trigger is 18 px high, below the 24 px minimum unless the space around it makes up for it. |
| 4.1.2 Name, Role, Value | The table above. |

Known gaps:

- The `link` trigger has no minimum height and no padding: 18 px for one line of text.
- `aria-label` is always set, even when `trigger` is plain text. The visible text is then never the name, and
  keeping the two alike is left to each caller. The headcount explainer does not keep them alike in the `en`
  catalog: its name is `structure.headcount.explain`, and its visible text is `structure.headcount.label` followed
  by `uiBlocker.reason`.
- Focus lands on the dialog element, which shows no focus look, so nothing visible has focus until Tab is pressed.
  This holds when the module's stylesheet comes after `app.css`: see Looks and sizes.
- The popover element has no role and still carries `aria-labelledby`, pointing at the trigger.
- The title is a level 2 heading in every place the component is used.
- Content taller than the height React Aria allows is not scrolled by the popover.
- The names of the hidden dismiss buttons are React Aria's text, not messages from `packages/i18n`.
- The comment on the component, and the one at the top of its stylesheet, call the panel non-modal. It is not.

What the gallery shows:

| Shown | Where |
|---|---|
| A `ghost` trigger that opens a paragraph of explanation | `apps/web/src/features/structure/ui/structure-copy.gallery.tsx`, through the headcount explainer |
| A `chip` trigger with a `wide` panel | `apps/web/src/features/org-bulk/ui/org-history.gallery.tsx`, through the as-of control |
| A `ghost` trigger that opens the views that do not fit a row of tabs | `apps/web/src/ui/tabs/tabs.gallery.tsx`, through `PageTabs`. The trigger is rendered only when the row overflows. |

`ui/popover` has no gallery file of its own, so the component is shown only where another component's entry uses
it. These three are all there is: a trace of the imports of every `*.gallery.tsx` finds no other entry that
reaches it. They do not show the `link` look, or a `wide` panel on a `ghost` trigger.

Tests: `ui/popover` has no unit test. The two unit tests that name the component,
`apps/web/src/ui/asof-control/asof-control.test.tsx` and `apps/web/src/features/structure/ui/page-head.test.tsx`,
replace it with a stub that renders the trigger and the body one after the other. The real component is driven in a
browser. Two examples: `apps/web/src/ui/tabs/tabs.browser.test.tsx` opens the overflow panel at 390 px, finds it
as a dialog named by its title and follows a link in it; `e2e/states/org-dates.spec.ts` opens the as-of panel at
1440 px and at 390 px, in the light and the dark theme, and checks fit and axe with it open.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component). That scan opens no panel of this component: it scans the
gallery with every panel closed, and again with the gallery's example dialog open. So it covers the triggers the
gallery draws at the width it runs at, and no open panel.

## Phone behaviour at 390 px

`popover.module.css` has no media query and no container query. The width of the panel still follows the screen,
through `100vw` in its width rule.

- Both widths are capped at the screen less 16 px. At 390 px that is 374 px, which is less than 414 px and less
  than 504 px, so the panel is 374 px wide and `wide` makes no difference.
- Triggers are the same size as at 1440 px. Nothing grows to the 44 px touch size; the module does not read
  `--target-touch`.
- The title and the body keep their padding and their text size.
- React Aria places the popover against the trigger and sets its position and its maximum height itself.

Both browser tests named above open a panel at 390 px.

## Copy rules

- The component owns no message id and imports no text.
- `label`, `title` and the text inside `trigger` are the caller's, from the message catalog in `packages/i18n`.
  The `en` catalog is the source and the `ko` catalog must define every id.
- `label` is the trigger's accessible name and replaces its visible text. Write it so that it contains that text.
  For an icon-only trigger it is the only name.
- `title` names the dialog and is its visible heading. It says what the panel is, not what the trigger does.
- A value shown in the trigger, such as a date or the name of a scope, is part of `label` too. The as-of control
  and the roster's scope picker build their labels that way.
- The one built-in text is the name of the hidden dismiss buttons. It comes from React Aria, not from the catalog.

## Props

<!-- ds:props apps/web/src/ui/popover/popover-button.tsx -->

### PopoverButton

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `children` | yes | `(close: () => void) => ReactNode` |  |  |
| `label` | yes | `string` |  |  |
| `title` | yes | `ReactNode` |  |  |
| `trigger` | yes | `ReactNode` |  |  |
| `chip` | no | `boolean` |  |  |
| `isOpen` | no | `boolean` |  |  |
| `link` | no | `boolean` |  |  |
| `onOpenChange` | no | `(open: boolean) => void` |  |  |
| `wide` | no | `boolean` |  |  |

<!-- /ds:props -->

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/popover/popover.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border`, `border-bottom` |
| `--fw-medium` | `font-weight` |
| `--fw-strong` | `font-weight` |
| `--panel-w` | `width` |
| `--primary` | `color` |
| `--radius-lg` | `border-radius` |
| `--radius-sm` | `border-radius` |
| `--shadow-pop` | `box-shadow` |
| `--space-1` | `gap` |
| `--space-2` | `gap`, `padding` |
| `--space-3` | `padding` |
| `--space-4` | `width` |
| `--space-5` | `width` |
| `--space-6` | `width` |
| `--surface` | `background` |
| `--text-sm` | `font-size` |
| `--text-xs` | `font-size` |

<!-- /ds:tokens -->

The `ghost` and `chip` triggers carry the global `btn` classes. Their tokens are on the
[Button](button.md#tokens-it-reads) page. The focus outline is a global rule and is not listed: it reads
`--primary`.
