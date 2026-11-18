<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# DisabledReason

`DisabledReason` shows a control that cannot be used now together with the reason, in visible text: the control
stays focusable, is described by the reason, and does nothing when pressed.

It lives in `apps/web/src/ui/disabled-reason`: the component in `disabled-reason.tsx` and its styles in
`disabled-reason.module.css`.

## When to use it, and when not

Use it for a command that a rule blocks now, where the person can read why and often fix it: a pick that is
missing, a date that has not come, the last passkey that cannot be removed. The reason is text on the page, tied
to the control, not a tooltip.

The caller renders either `DisabledReason` or the live control. There is no prop that turns the block off.

| Do not use it for | Use instead |
|---|---|
| A control that only waits on its own request | [`Button`](button.md) with `disabled`, as call sites do while a request is pending. |
| A refusal the server sent after the command ran | `BlockedPanel` (`ui/blocker`), or `CommandError` (`lib/react/command-error`). |
| A page tab that cannot be opened | `PageTabs` (`ui/tabs`) with `disabledReason` on the item. It renders this component in the `disclosure` layout. |
| The edit or the add of a row or a list that cannot be used | `RowActions` or `ListAdd` (`ui/record-actions`) with `why`. They render this component in the `inline` layout. |
| A caution with no blocked control beside it | `Banner` (`ui/banner`). |

## Anatomy

| Part | Element | Holds |
|---|---|---|
| Wrapper | `<span>` with the layout's class | The control, then the explanation. It is not rendered when `children` is given. |
| Control | Whatever `control` returns | The caller's own element, given the inert attributes below. |
| Explanation | `<span>` with the module's class and the global `prose` class | The reason, then the remedy. |
| Reason | `<span id>` | `reason`. The control's `aria-describedby` points here. |
| Remedy | None of its own | `remedy`, rendered as passed, straight after the reason. |

`control` is a render prop. It is called with five attributes, and the caller spreads them on the control after
the control's own props:

| Attribute | Value | What it does |
|---|---|---|
| `aria-disabled` | `true` | Says the control cannot be used. The native `disabled` attribute is not set, so the control keeps its place in the tab order. |
| `aria-describedby` | A generated id | Points at the reason. |
| `type` | `"button"` | Keeps the control from being a form's submit button. |
| `onClick` | A handler that calls `preventDefault()` and nothing else | Takes the place of the caller's click handler. |
| `className` | The module's inert class | Gives the inert look. `Button` adds it to its variant classes. A caller with a class of its own has to join the two by hand, because the spread replaces `className`. |

The component cannot make a control inert by itself. A press does nothing only because the spread `onClick` and
`type` replace the caller's. A control that sets `onClick` or `type` after the spread, or does not spread them at
all, still acts. Nothing checks this.

`children` is a second render prop, for a control and a reason that must sit in different regions of a view. It is
called with `{ control, reason }`, where `reason` is the whole explanation element, and what it returns is rendered
with no wrapper. `layout` is ignored when `children` is given.

## Looks and sizes

`layout` places the reason. The default is `stacked`.

| `layout` | Wrapper | Reason |
|---|---|---|
| `stacked` | An inline column, 4 px between its rows, aligned to the start. | Under the control. |
| `inline` | An inline grid of two columns, `max-content` and `minmax(0, 1fr)`, 12 px apart, aligned on the text baseline. | Beside the control. |
| `disclosure` | An inline column, 4 px between its rows. | Not displayed until the wrapper is hovered or holds focus. Then under the control. |

The explanation is 13 px `--steel` text (`--text-sm`). It is a row that wraps, 12 px between the reason and the
remedy and 4 px between wrapped rows, and never wider than its container. Through the `prose` class a link inside
it takes the look of a link in running text: `--primary`, with a thin underline.

The inert class sets five things on the control: a `--border` border colour, a `--muted` fill, `--steel` text, a
not-allowed cursor, and `white-space: nowrap`. It sets neither the opacity nor the border style. On a `Button`,
the button's own rules for `aria-disabled="true"` in `app.css` still supply those two.

| Control | Inert look |
|---|---|
| `Button` in `secondary`, `ghost` or `danger` | `--muted` fill, `--border` border, `--steel` text, at half opacity. The danger fill never shows. |
| `Button` in `primary` | Full opacity and a dashed border, from `app.css`. The colours are a tie: see below. |
| `Button` in `ghost-danger` | Half opacity. The colours are a tie: see below. |
| `ToggleButton` that is on | Half opacity. The colours are a tie: see below. A toggle that is off looks as the first row says. |

The inert class is written twice in its selector so that it outranks a variant's one-class rule. Three rules in
`app.css` carry two classes, or a class and an attribute, and so rank the same as it does:

- `.btn--primary[aria-disabled="true"]` sets a `--primary` border, a `--primary-soft` fill and `--primary` text.
- `.btn--ghost.btn--danger` sets no fill, no visible border and `--danger-tx` text.
- `.btn[aria-pressed="true"]`, the on look of a `ToggleButton`, sets a `--primary` border, a `--primary-soft` fill
  and `--primary` text. One call site spreads the inert attributes on toggles, one of which is on:
  `features/org/ui/org-change-views.tsx`.

For those three the colours at rest come from whichever of the two stylesheets the build loads later. Neither
stylesheet fixes that order, and the component's tests do not check a colour. On hover the inert rule outranks
the primary rule and the pressed rule, so an inert primary, or an inert toggle that is on, is `--muted` with
`--steel` text while the pointer is on it, whatever it shows at rest.

There is one size: the control keeps the size it has.

Inside the actions of an [`ActionBar`](action-bar.md), the bar's stylesheet takes a `stacked` or `inline` wrapper
apart. The control joins the row of buttons and the explanation takes a row of its own after it, aligned to the
end.

## States

| State | What happens |
|---|---|
| Rest | The inert look. In `stacked` and `inline` the reason is always shown. |
| Hover | The inert rule repeats its values on hover, so a variant's hover fill does not show and the control does not change. The exceptions are the ties under Looks and sizes. The cursor is not-allowed. In `disclosure`, hovering the wrapper shows the reason. |
| Keyboard focus | The control shows the global focus outline: 2 px `--primary`, 2 px away. The component has no focus rule of its own. In `disclosure`, focus anywhere in the wrapper shows the reason. |
| Pressed down | Nothing happens and nothing changes. There is no `:active` rule. |
| Disabled | This is the component's only state. The control is always inert. |
| Selected, read-only, invalid, loading | Do not exist. |
| Empty | `reason` is required, and nothing checks that it has text. With an empty reason the control is described by an empty element. |

A `disclosure` reason takes its space when it appears: it is in the flow, so what follows the wrapper moves down.
It goes when the pointer and the focus have both left the wrapper. Nothing else hides it.

## Keyboard

| Key | What it does |
|---|---|
| Tab, Shift+Tab | Reaches the control, because it is not natively disabled, then a remedy that can take focus. |
| Enter, Space | On a native button they fire a click. The inert `onClick` runs in place of the caller's and does nothing but cancel the event's default. |

The component handles no key. No key hides a `disclosure` reason.

With `type="button"` the control is not its form's submit button. The component promises nothing more about Enter
in a form: the caller's submit handler still has to check the block.

A control that is not a native button gets no key handling from the component. `PageTabs` passes a
`<span role="link" tabIndex={0}>`, which takes focus and does nothing on any key.

The component takes no text and handles no key, so it has no rule for a key the Korean input method owns. The
source has no `isComposing` check, no key code 229 and no composition event.

## Accessibility contract

- **Role:** the control's own. The component adds `aria-disabled="true"`.
- **Accessible name:** the control's own. The component does not change it.
- **Description:** the reason, through `aria-describedby`. The remedy is outside the described element, so it is
  not part of the description. It is the next thing in the reading and tab order.
- **Announced:** nothing. There is no live region. The reason is read as the control's description when the
  control takes focus. A block that appears, or a reason that changes while focus is elsewhere, is not announced.

Known gaps:

- Nothing checks that the control can take focus or that it spread the inert attributes.
- In `disclosure` the reason shows only on hover or focus. The component has no press or tap handler that shows
  it, so on a touch screen it depends on whether a tap leaves the control hovered or focused.
- An inert `Button` other than `primary` is drawn at half opacity, text included.
- The colours of an inert `primary` or `ghost-danger` button, and of an inert toggle that is on, depend on the
  order of two stylesheets: see Looks and sizes.

The WCAG 2.2 criteria that apply:

| Criterion | How the component answers it |
|---|---|
| 1.3.1 Info and Relationships | The reason is tied to the control with `aria-describedby`. |
| 1.4.1 Use of Color | The block is `aria-disabled`, a not-allowed cursor and a reason in words. The muted colours repeat it. |
| 1.4.3 Contrast (Minimum) | A control that cannot be used is exempt. The reason is not: it is 13 px `--steel` text, which is not large text, on the surface behind it. |
| 1.4.13 Content on Hover or Focus | Applies to `disclosure`. The reason stays for as long as the wrapper is hovered or holds focus, and the pointer can move onto it, because it is inside the wrapper. No key dismisses it. It does not cover other content: it pushes it down. |
| 2.1.1 Keyboard | A native button stays in the tab order because `disabled` is not set. |
| 2.4.7 Focus Visible | The global 2 px focus outline. |
| 2.5.8 Target Size (Minimum) | The control's own size. The component does not change it. |
| 4.1.2 Name, Role, Value | `aria-disabled="true"` on the control. |
| 4.1.3 Status Messages | Not answered: nothing is announced when a control becomes blocked. |

What the gallery shows:

| Shown | Where |
|---|---|
| `stacked` on a primary button; `stacked` with a remedy; `children` placing the control and the reason in two regions; `disclosure` and `inline`, the second with a remedy, in a list | `apps/web/src/ui/disabled-reason/disabled-reason.gallery.tsx` |
| `stacked` with a link as the remedy | `apps/web/src/gallery/sections/links.gallery.tsx` |
| A blocked primary inside a sticky action bar | `apps/web/src/ui/action-bar/action-bar.gallery.tsx` |

These entries show no inert `danger` or `ghost-danger` button, no inert toggle and no control that is not a
`Button`.

`disabled-reason.test.tsx` has two tests, both on static markup. The control is a `type="button"` with
`aria-disabled="true"` and no `disabled`, described by the reason, even when the caller passed `type="submit"`
before the spread. And `children` places the control and the explanation, remedy included, in separate regions.
Neither test covers the looks or the `disclosure` layout.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component).

## Phone behaviour at 390 px

Nothing in `disabled-reason.module.css` changes with the width of the screen. There is no phone rule.

- The inert control never wraps its label (`white-space: nowrap`). A label wider than its container overflows it.
- `stacked`: the reason is under the control and wraps.
- `inline`: the first column is as wide as the control's whole label, and the reason gets what is left. The
  reason's column can shrink to nothing, so beside a long label on a narrow screen the reason has little or no
  width.
- `disclosure`: there is no hover on a touch screen. See the known gaps under Accessibility contract.
- The control is as tall as it is on a wide screen. The component does not read `--target-touch`.

## Copy rules

- The component holds no text of its own and owns no message id.
- `reason` and the label of the `remedy` come from the message catalog in `packages/i18n`, through the caller. The
  `en` catalog is the source and the `ko` catalog must define every id.
- The reason is the control's whole description, so it has to make sense read alone, after the control's name.
- The remedy is a command or a link. Its label follows the rule for a button label: a verb and its object.
- The gallery's sample text is in the gallery catalog, which production builds leave out.

## Props

<!-- ds:props apps/web/src/ui/disabled-reason/disabled-reason.tsx -->

### DisabledReason

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `control` | yes | `(p: DisabledProps) => ReactNode` |  |  |
| `reason` | yes | `ReactNode` |  |  |
| `children` | no | `(slots: { control: ReactNode; reason: ReactNode; }) => ReactNode` |  |  |
| `layout` | no | `"disclosure" \| "inline" \| "stacked"` | `"stacked"` |  |
| `remedy` | no | `ReactNode` |  |  |

<!-- /ds:props -->

`DisabledProps`, the type `control` receives, is the five attributes under Anatomy.

## Tokens it reads

The half opacity and the dashed border of an inert `Button` come from `app.css`, and the focus outline is a global
rule that reads `--primary`. None of the three is listed here.

<!-- ds:tokens apps/web/src/ui/disabled-reason/disabled-reason.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border-color` |
| `--muted` | `background` |
| `--space-1` | `gap` |
| `--space-3` | `gap` |
| `--steel` | `color` |
| `--text-sm` | `font-size` |

<!-- /ds:tokens -->
