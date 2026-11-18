<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Dialog

A dialog is a modal box in the middle of the screen: a title, then whatever the caller puts under it, while the
page behind it is dimmed and out of reach until the dialog closes.

It lives in `apps/web/src/ui/dialog.tsx`. Its styles are the `.overlay` and `.dialog` rules in
`apps/web/src/app.css`. It is built on the modal overlay of React Aria Components.

## When to use it, and when not

The component's own rule is: confirmations, blocking errors and urgent notices only. A dialog is for something
short that a person must answer before going on.

Call sites also put a short form in one. Two examples: the inbox asks for a snooze date in a dialog, and the
passkey list asks for a passkey's name in one.

| Do not use it for | Use instead |
|---|---|
| A command on a record, with its fields and a stated consequence | `Sheet`: see [Sheet](sheet.md). |
| A read-only look at a record beside a list | `SidePanel` (`ui/side-panel`). It is not modal. |
| A small panel that opens beside its trigger | `PopoverButton` (`ui/popover`). |
| A list of commands behind one button | `ActionMenu` or `MenuButton`: see [Menu](menu.md). |
| A message in the flow of a view | `Banner` (`ui/banner`). |
| The receipt of a command that is sending or done | `Toast` (`ui/toast`). |

## Anatomy

| Part | Element | Holds |
|---|---|---|
| Overlay | `<div class="overlay">` | The dimmed backdrop. It fills the viewport and centres the box. React Aria renders it in a portal on `<body>`, so where the caller declares the dialog does not matter. |
| Box | `<div class="dialog card" data-size>` | The visible panel. It scrolls when its content is taller than the screen allows. |
| Dialog | `<section role="dialog" class="dialog__body">` | The title, then `children`, in a column. |
| Title | `<h2 class="panel__title">` | `title`. It names the dialog. |
| Body | `children` | Whatever the caller renders: text, a form, buttons. |

There is no close button, no footer and no slot for actions. The caller renders its own buttons among `children`
and lays them out itself. Many call sites use a `<div class="form__actions">`, which aligns the buttons to the end
of the row and lets them wrap. Others use `ActionBar` (`ui/action-bar`).

When the dialog can be dismissed, React Aria adds one element at the start of the box: a visually hidden dismiss
button for screen readers. See the accessibility contract.

The component takes the props in the Props section and nothing else. It passes no attribute through, so a dialog
cannot be given an `id`, a class or an ARIA attribute.

With `open={false}` nothing is rendered. While `open`, the dialog holds the page's live re-reads (`useLiveHold`),
so the page behind it does not change under it.

## Looks and sizes

`size` picks the width. The default is `md`.

| `size` | Width |
|---|---|
| `md` | `min(100%, var(--dialog-w-md))`: 480 px, or the width available when that is less. |
| `sm` | `min(100%, var(--dialog-w-sm))`: 400 px, or the width available when that is less. |

The rest of the look does not change with `size`.

| Part | Look |
|---|---|
| Overlay | Fixed to the viewport at `z-index: var(--z-sheet)` (20), with 16 px of padding (`--space-4`). The dimming is written in the rule as `color-mix(in srgb, var(--ink) 40%, transparent)`. It does not read `--scrim`, the token the sheet's backdrop reads. |
| Box | From the shared `card` class: `--surface` fill, a 1 px `--border` border, a 10 px radius (`--radius-lg`) and `--shadow`. From `dialog`: 24 px of padding (`--space-5`), `--ink` text, and a maximum height of `calc(100dvh - var(--space-6))`, the viewport height less 32 px. Past that the box scrolls. |
| Dialog | A column with a 16 px gap (`--space-4`) between the title and each child. |
| Title | From the shared `panel__title` class: 16 px (`--text-lg`), weight 700 (`--fw-strong`), no margin. |

`read` adds the class `dialog__body--read`, which gives the column a minimum height of
`min(var(--panel-w), calc(100dvh - var(--space-6) - var(--space-5) * 2))`: 440 px, or the viewport height less
80 px when that is less. It is for a dialog whose content waits on a read, so the box keeps one height while the
read loads, fails and arrives. `apps/web/src/lib/react/read-geometry.browser.test.tsx` measures that at 1440 and
390 px.

No prop picks a visual style. There is no open or close animation: no rule reads the `data-entering` or
`data-exiting` attribute React Aria sets.

A sheet's overlay is on the same layer, `--z-sheet`. Of two open overlays, the one later in the document is drawn
on top.

## States

| State | What happens |
|---|---|
| Closed | Nothing is rendered. |
| Open | The overlay and the box are drawn. Everything outside the dialog is made inert, and React Aria locks the scroll of the document. |
| Hover, pressed, selected | Do not exist. The dialog has no control of its own. |
| Focus | On open, focus moves to the dialog element itself, unless an element inside has already taken it. `dialog__body` sets `outline: none`, so the dialog shows no ring while it holds focus. Controls inside show the global focus outline. |
| Not dismissable (`dismissable={false}`) | No look. Escape and a press on the backdrop do nothing; only the caller's own buttons close the dialog. |
| Disabled, read-only, invalid | Do not exist. They belong to the controls the caller puts inside. |
| Loading | No state of its own. `read` only reserves height for a read the caller renders. |
| Empty | Does not exist. `children` is required. |

`dismissable` can change while the dialog is open. Call sites use that to keep a dialog open while its command is
sending, or while a field in it has text.

## Keyboard

| Key | What it does |
|---|---|
| Tab, Shift+Tab | Moves through the focusable elements inside the dialog. Focus stays inside: React Aria contains it. |
| Escape | Closes the dialog: `onClose` is called. Does nothing when `dismissable` is `false`. |

A press on the backdrop also closes a dismissable dialog.

When the dialog closes, focus returns to the element that had it before the dialog opened.
`apps/web/src/ui/dialog.browser.test.tsx` checks this.

The component has no key handler of its own, and no check of `isComposing`, of key code 229 or of a composition
event. Escape is handled by React Aria's overlay. The installed version (`react-aria-components` 1.22.1) skips a
key event whose `isComposing` flag is set. So an Escape that the browser flags as part of a composition, in a field
inside the dialog, does not close the dialog. React Aria does not check key code 229. No test in this repository
presses Escape in a dialog while the Korean input method is composing.

## Accessibility contract

- **Role:** `dialog`, on the `<section>`. The component never sets `alertdialog`.
- **Accessible name:** `title`, through `aria-labelledby` on the dialog, which points at the `<h2>`. `title` is
  required and is plain text.
- **Description:** none. The dialog has no `aria-describedby`; the text under the title is not tied to it.
- **Modality:** the dialog has no `aria-modal` attribute. While it is open, everything outside it is `inert`
  instead: it cannot be focused, pressed or read.
- **Announced:** nothing through a live region. Opening moves focus into the dialog, which is how a screen reader
  comes to read its role and name. A change inside an open dialog is the caller's to announce.
- **Hidden dismiss button:** a dismissable dialog starts with a visually hidden button that closes it. It is not
  in the tab order. React Aria names it with its own text for "dismiss", in the locale the app gives React Aria.
  A dialog with `dismissable={false}` has no such button.

What `apps/web/src/ui/dialog.browser.test.tsx` proves in a real browser:

- The page root is `inert` while the dialog is open, and the dialog does not add `aria-hidden` to it.
- An `inert` or `aria-hidden` attribute the page already had on another element is left as the page set it.
- Content added to the page while the dialog is open is made inert too.
- After a second dialog opened from inside the first has closed, and the first has then handed over to another
  dialog, the page is still inert.
- After the dialog closes, focus is back on the element that opened it.

The WCAG 2.2 criteria that apply:

| Criterion | How the dialog answers it |
|---|---|
| 1.3.1 Info and Relationships | The title is a heading and is the dialog's name. |
| 1.4.3 Contrast (Minimum), 1.4.11 Non-text Contrast | The box's colours are tokens. The dimming is a mix of `--ink` written in the rule. |
| 1.4.10 Reflow | The box is never wider than the space available, and it scrolls inside itself when it is taller. |
| 2.1.1 Keyboard | Escape closes a dismissable dialog. Everything else is the caller's controls. |
| 2.1.2 No Keyboard Trap | Focus is held inside on purpose. The way out is Escape, or a button the caller renders. A dialog with `dismissable={false}` and no button of its own would have no way out; the component does not check for that. |
| 2.4.3 Focus Order | Focus moves into the dialog on open and back to where it was on close. |
| 2.4.7 Focus Visible | The global 2 px outline on the controls inside. The dialog element itself shows none. |
| 2.4.11 Focus Not Obscured (Minimum) | The page behind is inert, so focus cannot sit under the overlay. |
| 4.1.2 Name, Role, Value | Role `dialog`, named by its title. |

Known gaps:

- The role is always `dialog`. A blocking error or an urgent notice, which the component is meant for, is not
  exposed as `alertdialog`, and its message is not the dialog's description. No prop changes either.
- There is no visible close control. A pointer user closes a dismissable dialog by the backdrop or by a button the
  caller adds.
- The name of the hidden dismiss button is React Aria's text, not a message from `packages/i18n`.

What the gallery shows: one `md` dialog with a line of text and one button, opened from the states section,
`apps/web/src/gallery/sections/states.gallery.tsx`. There is no `dialog.gallery.tsx`. The gallery does not show
`size="sm"`, `read` or a dialog that cannot be dismissed.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component).

## Phone behaviour at 390 px

No rule of the dialog depends on the width of the screen. There is no media query and no container query.

- The width is the smaller of 100% and the size. At 390 px the overlay's content box is 358 px wide, 390 less
  16 px of padding on each side. That is less than either size, so `sm` and `md` give the same box.
- The box is never taller than the viewport less 32 px. Taller content scrolls inside the box. The unit is `dvh`,
  so the limit follows the visible viewport.
- A rule in `app.css` sets `overscroll-behavior: contain` on the overlay and everything in it, so that a scroll
  inside the dialog does not carry on into the page.
- The dialog has no control of its own, so it has no target size. Buttons the caller puts in `form__actions` wrap
  onto more lines.

## Copy rules

- The dialog owns no message id. The component imports no text.
- `title` is the caller's text, from the message catalog in `packages/i18n`. The `en` catalog is the source and
  the `ko` catalog must define every id. It is a string, not markup.
- Everything under the title, the buttons' labels included, is the caller's.
- The one built-in text is the name of the hidden dismiss button. It comes from React Aria, not from the catalog.

## Props

<!-- ds:props apps/web/src/ui/dialog.tsx -->

### Dialog

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `children` | yes | `ReactNode` |  |  |
| `onClose` | yes | `() => void` |  |  |
| `open` | yes | `boolean` |  |  |
| `title` | yes | `string` |  |  |
| `dismissable` | no | `boolean` | `true` | false: Esc and outside clicks do nothing; only the dialog's own buttons close it (one-time codes). |
| `read` | no | `boolean` | `false` | Reserve the body across a required read's loading, failure and ready states. |
| `size` | no | `"md" \| "sm"` | `"md"` |  |

<!-- /ds:props -->

## Tokens it reads

The overlay. The second rule that names `.overlay` is the scroll-chaining rule; it reads no token.

<!-- ds:tokens apps/web/src/app.css .overlay -->

| Token | Read by |
| --- | --- |
| `--ink` | `background` |
| `--space-4` | `padding` |
| `--z-sheet` | `z-index` |

<!-- /ds:tokens -->

The box and the column inside it. The box's fill, border, radius and shadow come from the shared `card` class and
the title's size and weight from `panel__title`; those are not in this table. They read `--surface`, `--border`,
`--radius-lg`, `--shadow`, `--text-lg` and `--fw-strong`.

<!-- ds:tokens apps/web/src/app.css .dialog -->

| Token | Read by |
| --- | --- |
| `--dialog-w-md` | `width` |
| `--dialog-w-sm` | `width` |
| `--ink` | `color` |
| `--panel-w` | `min-block-size` |
| `--space-4` | `gap` |
| `--space-5` | `min-block-size`, `padding` |
| `--space-6` | `max-height`, `min-block-size` |

<!-- /ds:tokens -->
