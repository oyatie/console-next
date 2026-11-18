<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Kbd

A `Kbd` is a small key cap that shows the key or chord of a command beside that command: a `<kbd>` drawn for the
eye only, hidden from assistive technology.

It lives in `apps/web/src/ui/kbd`: the component in `kbd.tsx` and its styles in `kbd.module.css`.

## When to use it, and when not

Use it to show the key that also runs a command, inside the control that carries the command or in a line of key
hints. Three places that do: the commit button of `Composer` (`ui/composer`), the tiles of `ActionGrid`
(`ui/action-grid`) that have a key and can be used, and the selection line in
`features/people/ui/unplaced-rows.tsx`.

`Kbd` shows a key and nothing more. It does not listen for the key; the caller binds it.

| Do not use it for | Use instead |
|---|---|
| The only statement of what a control does | The control's own label. A `Kbd` is not read by a screen reader, so the label must stand without it. |
| The shortcut of an entry in a menu | `ActionMenu` with `shortcut` on the action: see [Menu](menu.md). It draws its own key cap. |
| A status word in a tinted box | `Chip`: see [Chip](chip.md). |
| The server's count on a filter | `Count` (`ui/count`). |

## Anatomy

One element: `<kbd aria-hidden="true">`, with `keys` as its text and one class from the module.

`keys` is one string, shown as written. A chord is one string in one cap (`Ctrl+D`); two keys in a row are two
`Kbd` elements. There is no icon, no slot and no `className`. The component takes `keys` only and passes no
attribute through.

## Looks and sizes

There is one look and one size.

| Property | Value |
|---|---|
| Height | `calc(var(--space-5) - var(--space-1))`: 20 px, borders included. |
| Width | At least 24 px (`--space-5`), with 4 px side padding (`--space-1`). The text is centred and stays on one line. |
| Margin | 4 px on the left (`--space-1`), always. |
| Border | 1 px `--border`, with a 4 px radius (`--radius-sm`). |
| Fill | `--muted`. |
| Text | 12 px (`--text-xs`), `--font-mono`, weight 400 (`--fw-body`), `--steel`. |

Inside a primary button the cap changes: a rule on `.btn--primary` makes the fill transparent and lets the text
and the border take the button's text colour.

Three things about these rules:

- Only the primary button has such a rule. On any other fill the cap keeps its `--muted` fill and `--steel` text.
  One example: `features/people/ui/lifecycle-cancel.tsx` gives its composer a `danger` commit, and by these rules
  the cap in that commit keeps those two colours on the danger fill. This is read from the CSS, not seen in a
  browser.
- The left margin is a physical `margin-left`, and it applies wherever the cap sits, also when it is the first
  thing in its line. Inside a button it adds to the button's own 8 px gap (`--space-2`).
- The fill reads `--muted`, not `--kbd-bg`. Today `--kbd-bg` is defined as `--muted`, so the two draw the same.

No prop picks a visual style.

## States

There are none. A `Kbd` has no hover, focus, pressed, selected, disabled, read-only, invalid, loading or empty
look. An empty `keys` still draws an empty cap 24 px wide; the component does not check.

A cap inside a disabled button is dimmed with the button, by the button's own half opacity.

## Keyboard

None. A `Kbd` is not focusable and handles no key, so it has no rule for a key the Korean input method owns. The
component has no check of `isComposing`, of key code 229 or of a composition event.

Whether the key it shows works, and what happens to it while the input method is composing, is decided by the
caller that binds the key.

## Accessibility contract

- **Role:** none that reaches assistive technology. The element is a `<kbd>` with `aria-hidden="true"`.
- **Accessible name:** none. Its text is not part of the name of the control around it. A button that holds a
  label and a `Kbd` is named by the label alone.
- **Announced:** nothing.

`apps/web/src/ui/kbd/kbd.test.tsx` checks the element, the `aria-hidden` attribute and the text.

The WCAG 2.2 criteria that apply:

| Criterion | How `Kbd` answers it |
|---|---|
| 1.3.1 Info and Relationships | It carries none. The cap is decoration; the command is named by its control. |
| 1.4.3 Contrast (Minimum) | The text is 12 px regular, which is not large text, so it needs 4.5:1. At rest the pair is `--steel` on `--muted`. On a primary button it is the button's own text colour on the button's fill. On another filled button the pair is `--steel` on `--muted` inside that fill; no rule adapts it. |
| 1.4.10 Reflow | The cap stays on one line and has no ellipsis. A long chord makes it wider. |
| 2.1.4 Character Key Shortcuts | Not the component's. A caller that shows a single letter or digit here owns that shortcut and this criterion. |

Known gaps:

- The key is not exposed to assistive technology in any way. The component cannot set `aria-keyshortcuts`, because
  it is a child of the control, and no caller does it for it: a search of `apps/web/src` for `aria-keyshortcuts`
  finds two controls, and neither holds a `Kbd` from this module.
- `keys` is not adapted to the platform. A caller that passes the Command glyph shows it on every system.
- There are two components with this name. `ui/record/record-section.tsx` exports another `Kbd`, which takes `k`
  instead of `keys` and has its own, smaller look in `record.module.css`. Outside tests and gallery files,
  thirteen files import each of them. This page documents the one in `ui/kbd`.
- Key caps are also drawn by hand, without either component, by rules named `kbd` in four more stylesheets
  (`ui/command-palette`, `ui/menu`, `ui/long-table` and `features/structure/ui/chart.module.css`) and by
  `top__kbd` in `app.css`.

What the gallery shows:

| Shown | Where |
|---|---|
| One cap at rest, among the chips | `apps/web/src/gallery/sections/chips.gallery.tsx` |
| One cap inside a primary button, once a composer is opened | `apps/web/src/ui/composer/composer.gallery.tsx` |

There is no `kbd.gallery.tsx`. `chips.gallery.tsx` is the only gallery file that imports this module. No gallery
entry shows a cap on a `danger` button. Feature galleries were not traced for this page.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component). The cap is `aria-hidden`, and this page did not check whether
that scan measures the contrast of hidden text.

## Phone behaviour at 390 px

Nothing changes. `kbd.module.css` has no media query and no container query, and the cap is the same size at
390 px as at 1440 px.

The cap is not a target: it takes no press of its own. It is also still drawn at phone width, where there may be
no keyboard. Hiding it there is the caller's choice, and the component has no prop for it.

## Copy rules

- `Kbd` owns no message id and imports no text.
- `keys` is shown as written. Every caller found passes a literal or a value from its own data: a chord such as
  `Ctrl+D`, a key name such as `Esc` or `F8`, a letter, or a row's number. None passes a message from
  `packages/i18n`, so a key name reads the same in English and in Korean.
- The label beside the cap is the caller's, from the message catalog.

## Props

<!-- ds:props apps/web/src/ui/kbd/kbd.tsx -->

### Kbd

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `keys` | yes | `string` |  |  |

<!-- /ds:props -->

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/kbd/kbd.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border` |
| `--font-mono` | `font-family` |
| `--fw-body` | `font-weight` |
| `--muted` | `background` |
| `--radius-sm` | `border-radius` |
| `--space-1` | `height`, `margin-left`, `padding` |
| `--space-5` | `height`, `min-width` |
| `--steel` | `color` |
| `--text-xs` | `font-size` |

<!-- /ds:tokens -->

The rule for a cap inside a primary button reads no token. It sets `currentcolor`, `transparent` and `inherit`.
