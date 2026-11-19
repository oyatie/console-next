<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Chip

A chip is a short status word in a tinted box: a `<span>` that shows a state and does nothing when pressed.

It lives in `apps/web/src/ui/chip.tsx`.

## When to use it, and when not

Use a chip for the state of a record, in a table cell or beside a title: an employment status, a decision.

| Do not use it for | Use instead |
|---|---|
| A filter a person turns on and off | `ToggleButton` with `look="chip"`: see [Button](button.md). |
| One pick from a short list | `ChipChoice` (`ui/choice`). |
| A deadline with the days left | `DeadlineChip` (`ui/deadline-chip`). Its tones follow the server's severity and live in its own module. |
| A message with a reason or a remedy | `Banner` (`ui/banner`). |
| Anything that must be announced when it changes | `Banner` with `live`. A chip has no live region. |

## Anatomy

One element: `<span class="chip chip--<tone>">`, with `children` as its text.

`className` adds classes after the two above, for layout. There is no icon slot, no dot and no close button. The
chip passes no other attribute through: it takes `tone`, `className` and `children` only, so it cannot be given
an `id` or an ARIA attribute.

## Looks and sizes

`tone` picks the colours. The default is `neutral`.

| `tone` | Fill | Border | Text |
|---|---|---|---|
| `ok` | `--ok-bg` | `--ok-bd` | `--ok-tx` |
| `warn` | `--warn-bg` | `--warn-bd` | `--warn-tx` |
| `danger` | `--danger-bg` | `--danger-bd` | `--danger-tx` |
| `info` | `--info-bg` | `--info-bd` | `--info-tx` |
| `neutral` | `--muted` | `--border` | `--steel` |

There is one size: 20 px high (`calc(var(--space-5) - var(--space-1))`), 8 px side padding, a 1 px border, a 4 px
radius (`--radius-sm`), 12 px medium text (`--text-xs`), on one line.

## States

There are none. A chip has no hover, focus, pressed, selected or disabled look.

## Keyboard

None. A chip is not focusable and handles no key. It takes no text, so it has no rule for a key the Korean input
method owns.

## Accessibility contract

- **Role:** none. It is a plain `<span>`.
- **Accessible name:** none. Its text is read in place, as ordinary text.
- **Announced:** nothing. A chip that appears, or changes tone or text, is not announced: it has no live region
  and no `role="status"`.

The tone is colour and nothing else. The component adds no icon and no hidden text, so the word inside must say
the state by itself.

The WCAG 2.2 criteria that apply:

| Criterion | How the chip answers it |
|---|---|
| 1.4.1 Use of Color | Only through its text. The caller's word carries the state; the tone repeats it. |
| 1.4.3 Contrast (Minimum) | Each tone pairs a text token with its own fill token. The text is 12 px medium, which is not large text, so the pair needs the full 4.5:1. |
| 1.4.10 Reflow | By its own rule the chip stays on one line and has no ellipsis, so a long label is the caller's to avoid. |

The gallery shows the five tones and one long label in `apps/web/src/gallery/sections/chips.gallery.tsx`.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component).

## Phone behaviour at 390 px

Nothing in the chip's own rules changes with the width of the screen. There is no phone rule.

By its own rule the chip never wraps its text (`white-space: nowrap`). It has no maximum width and no ellipsis,
so a label wider than its container overflows it.

A view can restyle a chip in its own stylesheet, and one does: `features/people/ui/bulk-page.module.css` lets a
chip inside its table wrap and grow.

## Copy rules

- The chip holds no text of its own and owns no message id.
- Its word comes from the message catalog in `packages/i18n`, through the caller. The `en` catalog is the source
  and the `ko` catalog must define every id.
- Keep it to a word or two. It does not wrap unless the view around it says so.
- The word must name the state without the colour.

## Props

<!-- ds:props apps/web/src/ui/chip.tsx -->

### Chip

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `children` | yes | `ReactNode` |  |  |
| `className` | no | `string` |  |  |
| `tone` | no | `Tone` | `"neutral"` |  |

<!-- /ds:props -->

The values of `Tone` are the five tones under Looks and sizes.

## Tokens it reads

<!-- ds:tokens apps/web/src/app.css .chip -->

| Token | Read by |
| --- | --- |
| `--border` | `border-color` |
| `--danger-bd` | `border-color` |
| `--danger-bg` | `background` |
| `--danger-tx` | `color` |
| `--fw-medium` | `font-weight` |
| `--info-bd` | `border-color` |
| `--info-bg` | `background` |
| `--info-tx` | `color` |
| `--muted` | `background` |
| `--ok-bd` | `border-color` |
| `--ok-bg` | `background` |
| `--ok-tx` | `color` |
| `--radius-sm` | `border-radius` |
| `--space-1` | `height` |
| `--space-2` | `padding` |
| `--space-5` | `height` |
| `--steel` | `color` |
| `--text-xs` | `font-size` |
| `--warn-bd` | `border-color` |
| `--warn-bg` | `background` |
| `--warn-tx` | `color` |

<!-- /ds:tokens -->
