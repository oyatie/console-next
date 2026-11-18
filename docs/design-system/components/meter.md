<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Meter

`Meter` is a small bar that shows how much of a known total a value is.

It lives in `apps/web/src/ui/meter/meter.tsx` and is the module's only export.

## When to use it, and when not

Use it for one reading inside a known range, beside the same reading in words: how much of a retention period is
left. It is read, never operated.

One feature uses it: the roster of people who have left, for the retention period that remains
(`features/people/ui/roster-table.tsx`). That was found by searching `apps`, `e2e` and `scripts` for an import of
the module. The only other import is the gallery.

| Do not use it for | Use instead |
|---|---|
| The progress of a running task | Nothing shared exists. ARIA gives that the `progressbar` role, not `meter`. The two places that show it write a `role="progressbar"` element by hand: `ui/setup-rail/setup-rail.tsx` and `features/import/ui/job-step.tsx`. |
| The steps of a task, done and still to do | `StepLine` (`ui/step-line`). |
| Whose turn it is in a chain of people | `ChainStepper` (`ui/chain-stepper`). |
| The days left to a legal deadline | `DeadlineChip` (`ui/deadline-chip`). |
| The count on a filter | `Count` (`ui/count`). |
| A count the view acts on, as a number | `StatRow`: see [Key-value](key-value.md). |
| The loading shape of a view | `Skeleton` (`ui/skeleton`). |

The comment on the component calls it a progress bar and names a job's count as a use. No caller uses it that
way, and the element carries the `meter` role, which ARIA does not give to progress.

## Anatomy

| Part | Element | Holds |
|---|---|---|
| Track | `<span role="meter">` | `aria-label` from `label`, `aria-valuemin="0"`, `aria-valuemax` from `max`, `aria-valuenow` from `value`, and `data-warn="true"` when `warn` is set. |
| Fill | `<span>` inside the track | Nothing. Its width is the percentage below. It also carries `data-pct` with the same number, which nothing reads: no rule, test or script names it. |

How the width is worked out:

- The percentage is `value / max × 100`, rounded to a whole number.
- It is never less than 2 and never more than 100 while `max` is above 0. A value of 0 still draws a 2% fill, and so
  does a negative value.
- When `max` is 0 or less, the percentage is 0 and the track is empty.

The width reaches the fill through a custom property, `--pct`, that the component sets on the element after it is
mounted, from a ref callback. The stylesheet registers `--pct` as a percentage that does not inherit and starts at
`0%`. Markup rendered to a string therefore has no width on the fill.

There are no slots. `Meter` takes no children, no `className`, and passes no other attribute through.

## Looks and sizes

There is one look and one size.

| Part | Look |
|---|---|
| Track | `calc(var(--space-6) * 2.25)` wide, which is 72 px, and `--space-2` high, 8 px. A 4 px radius (`--radius-sm`), `--muted` fill, `overflow: hidden`. It is `display: inline-flex`, so it sits in a line of text. |
| Fill | The full height of the track, `--pct` wide, `--control-border` colour. Its corners are cut by the track. |
| Fill with `warn` | `--warn-solid` colour. Nothing else changes. |

The width and the height are fixed values. No prop changes them, and no rule makes the bar follow the width of
its container.

## States

| State | What changes |
|---|---|
| Rest | The look above. |
| Warn (`warn`) | The fill turns `--warn-solid`. The component does not decide when: the caller passes the flag. The roster sets it when 90 days or fewer are left. |
| Empty | `max` of 0 or less draws the track with no fill. A value of 0 with a positive `max` is not empty: it draws the 2% fill. |
| Full | A value at or above `max` fills the track. The fill stops at 100%. |
| Hover | Does not exist. The stylesheet has no hover rule. |
| Focus | Does not exist. The bar is not focusable. |
| Pressed | Does not exist. |
| Selected | Does not exist. |
| Disabled | Does not exist. |
| Read-only | The bar is always read-only. There is no editable form. |
| Invalid | Does not exist. A value outside the range is drawn clamped and is not marked. |
| Loading | Does not exist. |

A change of value is not animated: the stylesheet has no transition.

## Keyboard

None. `Meter` handles no key and is not a tab stop.

It takes no text, so there is no rule for a key the Korean input method owns. The module has no key handler, no
`isComposing` check, no key code 229 check and no composition event.

## Accessibility contract

| Part | Role | Accessible name | Also exposed |
|---|---|---|---|
| Track | `meter` | `label`, through `aria-label`. The prop is required. | `aria-valuemin="0"`, `aria-valuemax` and `aria-valuenow`. |
| Fill | None. An empty `<span>`. | None. | Nothing. |

- **The value is a number only.** The component sets no `aria-valuetext`. The comment on the component says the
  value is given in words; the code gives the name in words and the value as `aria-valuenow`. A caller that needs
  "37 days" read out puts those words beside the bar as text, as the roster does.
- **The value is not clamped for assistive technology.** `aria-valuenow` is `value` as passed, so it can be below
  0 or above `aria-valuemax` while the drawn fill stays between 2% and 100%. The roster clamps the low end itself
  before it passes the value.
- **The range is not checked.** `aria-valuemax` is `max` as passed, and `aria-valuemin` is always 0. With a `max`
  of 0 or less the track is empty and the declared maximum is at or below the minimum.
- **Warn is not exposed.** `warn` changes the colour of the fill and nothing else: no attribute that assistive
  technology reads, no icon, no text.
- **Announced:** nothing. The bar is not a live region, and a changed value is not announced. A view that must
  announce a change calls `announce` from `lib/react/announce`.

Contrast, computed from the token values in `packages/tokens/tokens.css`:

| Pair | Light | Dark |
|---|---|---|
| Fill (`--control-border`) on the track (`--muted`) | 3.16:1 | 3.18:1 |
| Warn fill (`--warn-solid`) on the track | 4.35:1 | 9.03:1 |
| Track (`--muted`) on `--surface` | 1.15:1 | 1.14:1 |
| Track on `--canvas` | 1.05:1 | 1.24:1 |

Known gaps:

- The empty part of the track is under 1.3:1 against `--surface` and `--canvas`, in both themes. The fill is
  drawn at 3:1 or more on the track. The end of the track, which shows how much is left, is not.
- Warn is colour alone, and the two fill colours are told apart by hue: `--control-border` against `--warn-solid`
  is 1.38:1 in the light theme and 2.84:1 in the dark theme.
- There is no `aria-valuetext`, and `aria-valuenow` can lie outside the range.
- A `max` of 0 or less declares a range whose maximum is not above its minimum.

The WCAG 2.2 criteria that apply:

| Criterion | How the component answers it |
|---|---|
| 1.1.1 Non-text Content | The bar has a name, from `label`. |
| 1.3.1 Info and Relationships | The `meter` role with its minimum, maximum and present value. |
| 1.4.1 Use of Color | Not answered for `warn`: it is colour alone. The roster shows the days left as text beside the bar. |
| 1.4.11 Non-text Contrast | The fill is above 3:1 on the track in both themes. The track against the surface is not: see the gaps. |
| 4.1.2 Name, Role, Value | The table above. The value can be outside the range it declares. |
| 4.1.3 Status Messages | Not answered by the component: nothing is announced. |

2.1.1 Keyboard, 2.4.7 Focus Visible and 2.5.8 Target Size do not apply: there is nothing to operate.

The bar has no gallery file of its own. `apps/web/src/gallery/sections/chips.gallery.tsx` shows one bar, 75 of 100,
without `warn`. The gallery shows no bar with `warn`, no empty bar and no full one.

What tests it:

| Test | Covers |
|---|---|
| `apps/web/src/ui/meter/meter.test.tsx` | The role, the name, `aria-valuenow`, `aria-valuemax`, and `data-warn`. It renders to a string, so it does not see the width. |
| `scripts/ds-runtime.test.ts` | In a browser, with the real stylesheet: the fill is 0% and 60% of the track when `--pct` is `0%` and `60%`. |
| `scripts/check-ds-refs.test.ts` | That the design-system check fails a stylesheet outside the meter's that reads `--pct`. |

Neither test in `meter.test.tsx` covers the rounding, the 2% floor or the cap at 100%, and no other test renders
the component: the tests under `apps/web/src`, `e2e` and `scripts` were searched for `<Meter` and `role="meter"`.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component).

## Phone behaviour at 390 px

Nothing changes. The stylesheet has no media query and no container query, and it gives the bar the same 72 px by
8 px at every width.

The bar is not a target: it cannot be pressed, and the module does not read `--target` or `--target-touch`.

## Copy rules

- The component holds no text of its own and owns no message id.
- `label` is the caller's text, from the message catalog in `packages/i18n`. The `en` catalog is the source and
  the `ko` catalog must define every id. The roster passes `roster.keep.meter`.
- `label` says what is measured, not how much. It is never visible.
- Put the reading in words beside the bar, as visible text. The roster does, with `roster.keep.left` and
  `roster.keep.over`. The bar alone gives a sighted reader a proportion and a screen reader a bare number.
- The gallery's label is `meter.usage`, in the gallery catalog, which production builds leave out.

## Props

<!-- ds:props apps/web/src/ui/meter/meter.tsx -->

### Meter

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `label` | yes | `string` |  |  |
| `max` | yes | `number` |  |  |
| `value` | yes | `number` |  |  |
| `warn` | no | `boolean` |  |  |

<!-- /ds:props -->

No prop has a doc comment, so the descriptions are empty. `value` and `max` are in the same unit. `label` is the
accessible name. `warn` turns the fill to the warning colour.

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/meter/meter.module.css -->

| Token | Read by |
| --- | --- |
| `--control-border` | `background` |
| `--muted` | `background` |
| `--pct` | `width` |
| `--radius-sm` | `border-radius` |
| `--space-2` | `height` |
| `--space-6` | `width` |
| `--warn-solid` | `background` |

<!-- /ds:tokens -->

`--pct` is not a token of `packages/tokens`. It is the property the component sets on the fill, and this stylesheet
registers it.
