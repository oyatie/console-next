<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Button

The Button family is the console's command controls: a native `<button>` in one of six looks, and the icon-only
button, on/off button and segmented control built on it.

The family lives in `apps/web/src/ui/button`. Its main module, `button.tsx`, also exports `Form` and `Check`, so
this page covers them too.

## When to use it, and when not

| Component | Use it for |
|---|---|
| `Button` | A command in a view. Its label is a verb and its object. |
| `IconButton` | A command an icon can carry alone: close, more, a zoom step. Never a destructive act. |
| `ToggleButton` | An on/off choice: a filter or a view switch in a toolbar. |
| `Segmented` | Two to four views or modes of one thing, side by side, one of them on. |
| `Form` | A form in a view. It validates native controls and reports what failed. |
| `Check` | One checkbox with a visible statement, or an unlabelled box that selects a table row. |

| Do not use it for | Use instead |
|---|---|
| A command that is blocked now, where the person must learn why | `DisabledReason` (`ui/disabled-reason`). It keeps the control focusable and shows the reason. The native `disabled` attribute is not for a hard block: a keyboard user cannot reach a disabled button to find out why. |
| Going to another page | A router link. When the link must read as a command, give it the button look with `buttonClass(...)` from `button-class.ts`. That is the one case for the helper; everything else renders `Button`. |
| Views of one thing that each have a panel | `Tabs` (`ui/tabs`), or `TabNav` when each view is a route. |
| A record's commands behind one trigger | `ActionMenu` (`ui/menu`). |
| One choice from a list inside a form | `ChoiceField` or `ChipChoice` (`ui/choice`). `Segmented` has no required marker and no error. |
| Several statements a person confirms one by one | `Checks` (`ui/choice`). |
| A status word that does nothing when pressed | [`Chip`](chip.md). |

## Anatomy

| Component | Element | Parts |
|---|---|---|
| `Button` | `<button>` | `children`: the label, or an icon and the label. There is no other slot. |
| `IconButton` | `<button>` | `children`: the icon. `label` becomes both `aria-label` and `title`. |
| `ToggleButton` | `<button aria-pressed>` | `children`: the label. `count`: an optional `<span class="btn__count">` after the label. |
| `Segmented` | `<span role="group">` | One `ToggleButton` per entry of `items`. |
| `Form` | `<form novalidate>` | An error summary, shown first after a failed submit, then `children`. |
| `Check` | `<label class="check">` | An `<input type="checkbox">`, then a `<span>` with the statement when `children` is given. |

`Button` passes every other attribute to the `<button>`. `type` defaults to `"button"` (the generated Props
section says so too), so a button inside a form submits only when it says `type="submit"`.

`Form` always prevents the browser's own submit. `onSubmit` receives the `value` attribute of the button that
submitted, or `null`, so two submit buttons can mean two things.

## Looks and sizes

`variant` picks the look. The default is `secondary`.

| `variant` | Classes | For | Look |
|---|---|---|---|
| `primary` | `btn btn--primary` | The view's one commit. | `--primary` fill, `--on-primary` text. |
| `secondary` | `btn` | Everything else. | `--surface` fill, a 1 px `--border` border, `--ink` text. |
| `ghost` | `btn btn--ghost` | A tertiary command. | Transparent fill and border. |
| `danger` | `btn btn--danger` | An irreversible commit, inside the dialog that confirms it. | `--danger-solid` fill, `--on-danger` text. |
| `ghost-danger` | `btn btn--ghost btn--danger` | A quiet way into an irreversible act. | Transparent fill and border, `--danger-tx` text. |
| `link` | `link` | A command inside a line of text. | No box. `--primary` text with a thin `--primary-bd` underline. |

`size` picks the height. `icon` makes the button square.

| `size` | Minimum height | Side padding | Text | Width with `icon` |
|---|---|---|---|---|
| `md` (default) | 36 px, `calc(var(--row-h) - var(--space-1))` | 12 px | Inherited: 14 px body text. | 36 px |
| `sm` | 32 px, `--target` | 8 px | 13 px, `--text-sm` | 32 px |

The `link` variant does not carry the `btn` class, so the base box, the hover fill and the disabled look do not
apply to it. Its minimum height is 24 px (`--space-5`) and it has no padding.

`size` and `icon` still add their classes to a `link`, and those rules come later in `app.css`. `sm` makes a
link 32 px high with 8 px side padding and 13 px text. `icon` makes it 36 px wide, or 32 px with `sm`. No caller
combines them, the gallery does not show the combination, and nothing tests it: it is not a supported look.

`IconButton` defaults to `ghost` and cannot be `danger` or `ghost-danger`: its type leaves them out.

`ToggleButton` has two looks:

| `look` | Off | On |
|---|---|---|
| not set | `ghost` | `secondary`, with the "on" look under States. |
| `chip` | A pill: at least 28 px high, a 1 px `--control-border` border, fully rounded, 13 px regular text, one line. | The same pill with the "on" look and medium weight. |

`Segmented` draws one group with a 1 px `--control-border` border. Its segments are at least 32 px high with
13 px text, 12 px side padding and a hairline between them.

`size` on a `Segmented` is passed to each segment's button and changes nothing visible today. The segment's own
rule sets the same three properties `sm` sets (height, side padding, text size), and in the built stylesheets it
comes after the `sm` rule, so it wins at either size. No caller passes it.

No prop picks a visual style: there is one look per variant. Two props change what is rendered: `count` adds an
element after the label of a `ToggleButton`, and `icon` makes the box square.

## States

| State | What changes |
|---|---|
| Hover | `secondary` and `ghost`: `--muted` fill. `primary`: `--primary-hover` fill. `danger`: `--danger-tx` fill and border. `ghost-danger`: `--danger-bg` fill. `link`: the underline takes the text colour. |
| Keyboard focus | The global rule for every focusable element: a 2 px `--primary` outline, 2 px away. The family adds one focus rule of its own: on keyboard focus, as on hover, the underline of the `link` variant takes the text colour. |
| Pressed down | No look. There is no `:active` rule. |
| On (`aria-pressed="true"`) | `--primary` border and text on a `--primary-soft` fill. The count turns `--primary`. A segment also gets a 1 px inset `--primary` ring. A button placed directly in a `.tabs` row shows the tab underline instead. |
| Disabled (`disabled` or `aria-disabled="true"`) | Half opacity and a not-allowed cursor. |
| Disabled `primary` with `aria-disabled="true"` | Stays at full opacity so it can be read: a dashed `--primary` border, `--primary-soft` fill, `--primary` text. |
| Disabled `link` | No look. The disabled rule is on `btn`, which the link variant does not carry. |
| Busy or loading | Does not exist. |
| Count tone | `countTone="warn"` turns the count `--warn-tx` while the button is off. The count of an on button is always `--primary`: the warn tone does not show. The count keeps a minimum width of three characters, so the label does not move when the number arrives. |

`Check` has no styled states: the box is the browser's own checkbox, 32 px square.

`Form` has one state of its own. After a submit that fails validation it shows an error summary and moves focus
to it. From then on it validates again on every change, until a submit passes. A form given `noValidate` skips
validation and always calls `onSubmit`.

## Keyboard

| Key | What it does |
|---|---|
| Tab, Shift+Tab | Moves focus to and from the button. A button with the native `disabled` attribute is skipped. |
| Enter, Space | Presses the focused button. This is the native behaviour; the family adds no key handler. |
| Space on a `Check` | Ticks or clears the box. Native. |

Each segment of a `Segmented` is its own tab stop. Arrow keys do not move between segments: it is a group of
on/off buttons, not a radio group.

Pressing the segment that is already on does nothing. `onChange` is not called.

The family has no rule for a key the Korean input method owns, because none of these components handles a key or
takes text. The one such key in a form is Enter in a text input, and `TextInput` handles it: see
[Field](field.md#keyboard).

## Accessibility contract

| Component | Role | Accessible name | State exposed |
|---|---|---|---|
| `Button` | `button` | Its text. | `disabled`, when set. |
| `IconButton` | `button` | `label`, through `aria-label`. `title` repeats it as a tooltip. Neither can be overridden. | `disabled`, when set. |
| `ToggleButton` | `button` | Its text. The count is inside the button, so it is part of the name. | `aria-pressed`, always `true` or `false`. It cannot be overridden. |
| `Segmented` | `group` | `label`, through `aria-label`. Each segment is named by its item's label. | `aria-pressed` on each segment: `true` on the one whose `id` equals `value`. |
| `Check` | `checkbox` | The statement, because the `<label>` wraps the box. With no statement, `aria-label`. | Checked or not. |

What is announced:

- A button announces nothing by itself. It has no live region. The result of a command is the caller's to
  announce.
- A failed submit of a `Form` is announced: the error summary has `role="alert"`, takes focus, and is titled by
  message `common.validation.title`. It lists one line per invalid control: the control's label, then what is
  wrong. Each line is a link that focuses the control.
- An icon inside a button is decoration. The caller marks it `aria-hidden`; the component does not.

The WCAG 2.2 criteria that apply:

| Criterion | How the family answers it |
|---|---|
| 1.3.1 Info and Relationships | `Segmented` is a named group. `Check` ties its statement to the box with a `<label>`. |
| 1.4.1 Use of Color | "On" is `aria-pressed`, and each look adds a cue that is not a colour. The default toggle gains a border: off, its border is transparent. The chip look goes from regular to medium weight. A segment gains an inset ring and medium weight. A destructive act says what it does in words: `IconButton` cannot take a danger look. |
| 1.4.3 Contrast (Minimum), 1.4.11 Non-text Contrast | Every colour is a token; none is written in the family. A blocked primary command keeps full opacity. |
| 2.1.1 Keyboard | Native `<button>` and `<input>` elements. |
| 2.4.7 Focus Visible | The global 2 px focus outline. |
| 2.5.8 Target Size (Minimum) | The smallest boxes are 32 px (`sm`, a segment, the check box) and 28 px (the chip look), above the 24 px minimum. The `link` variant is at least 24 px high and as wide as its text. |
| 3.3.1 Error Identification | `Form` names each invalid control and what is wrong, in text. |
| 4.1.2 Name, Role, Value | The table above. |
| 4.1.3 Status Messages | The error summary is an alert. |

What the gallery shows of this family:

| Shown | Where |
|---|---|
| `Button` in the five boxed variants, a natively disabled button, one plain `ToggleButton` | `apps/web/src/ui/button/button.gallery.tsx` |
| `sm` buttons, and `IconButton` at both sizes | `apps/web/src/ui/button/button-sizes.gallery.tsx` |
| `Form` with a `Check` and two submit-row buttons | `apps/web/src/gallery/sections/forms.gallery.tsx` |

No gallery entry reaches the `link` variant, the chip look, the count and its warn tone, or `Segmented`: those
looks are shown nowhere in the gallery. A button with `aria-disabled` is shown by the `DisabledReason` entry,
`apps/web/src/ui/disabled-reason/disabled-reason.gallery.tsx`.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component).

## Phone behaviour at 390 px

Nothing in the family's own rules changes with the width of the screen.

- A button is as tall at 390 px as at 1440 px: 36 px, or 32 px for `sm`. It does not grow to the 44 px touch
  size; the family does not read `--target-touch`.
- A long label wraps and the button grows, because the height is a minimum. The chip look is the exception: it
  stays on one line.
- A `Segmented` has no rule that wraps its segments onto a second line, and in a flex row it keeps its full width
  instead of shrinking. Its segments must fit the row, which is why it holds two to four short labels.
- A `Check` wraps its statement beside the box.

The only rules in `app.css` that restyle a button by width belong to the shell's top bar, not to the family: they
tighten the side padding of a button in the top bar to 8 px on narrow screens. They appear in the token table
below because their selectors name `.btn`.

Other components and views place or restyle these parts in their own stylesheets, and some of those rules do
depend on width. Two examples: the address field puts its button in its own grid cell at phone width, and the long
table hides the statement of a `Check` in a table head until a narrow table turns into cards. Such rules belong
to the component that writes them and are not listed here.

## Copy rules

- A label is a verb and its object.
- No text is written in a component or in a view. Every label comes from the message catalog in `packages/i18n`.
  The `en` catalog is the source and the `ko` catalog must define every id.
- The `label` of an `IconButton` is real copy. It comes from the catalog like any other label.
- A destructive command always says what it does in words.
- The count in a `ToggleButton` is the server's number, not copy.
- `Form` owns these message ids, one per native validity flag: `uiField.valueMissing`, `uiField.typeMismatch`,
  `uiField.patternMismatch`, `uiField.tooShort`, `uiField.tooLong`, `uiField.rangeUnderflow`,
  `uiField.rangeOverflow`, `uiField.stepMismatch` and `uiField.badInput`. A control with a custom validity
  message shows that message instead.
- The gallery's sample labels are in the gallery catalog, which production builds leave out.

## Props

<!-- ds:props apps/web/src/ui/button/button.tsx -->

### Button

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `icon` | no | `boolean` |  |  |
| `ref` | no | `Ref<HTMLButtonElement>` |  |  |
| `size` | no | `ButtonSize` |  |  |
| `variant` | no | `ButtonVariant` | `"secondary"` |  |

Also accepts the attributes of `ButtonHTMLAttributes` (`@types/react`). Defaults `type` to `"button"`.

### Check

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `checked` | yes | `boolean` |  |  |
| `onChange` | yes | `(v: boolean) => void` |  |  |
| `aria-describedby` | no | `string` |  |  |
| `aria-label` | no | `string` |  |  |
| `children` | no | `ReactNode` |  |  |

### Form

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `onSubmit` | yes | `(submitter: string \| null) => void` |  |  |

Also accepts the attributes of `FormHTMLAttributes` (`@types/react`).

### IconButton

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `label` | yes | `string` |  |  |
| `ref` | no | `Ref<HTMLButtonElement>` |  |  |
| `size` | no | `ButtonSize` |  |  |
| `variant` | no | `"ghost" \| "link" \| "primary" \| "secondary"` | `"ghost"` |  |

Also accepts the attributes of `ButtonHTMLAttributes` (`@types/react`), except `aria-label` and `title`.

### ToggleButton

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `pressed` | yes | `boolean` |  |  |
| `count` | no | `ReactNode` |  | The server's count after the label: it keeps its width while it loads, so nothing beside it moves. |
| `countTone` | no | `"warn"` |  | `warn`: a to-do count (something waits on someone). |
| `look` | no | `"chip"` |  | `chip`: a filter drawn as a pill, bordered when off. |
| `size` | no | `ButtonSize` |  |  |

Also accepts the attributes of `ButtonHTMLAttributes` (`@types/react`), except `aria-pressed`.

<!-- /ds:props -->

<!-- ds:props apps/web/src/ui/button/segmented.tsx -->

### Segmented

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `items` | yes | `readonly { id: T; label: ReactNode; }[]` |  |  |
| `label` | yes | `string` |  |  |
| `onChange` | yes | `(id: T) => void` |  |  |
| `value` | yes | `T` |  |  |
| `size` | no | `ButtonSize` |  |  |

<!-- /ds:props -->

## Tokens it reads

The first table is every rule in `app.css` whose selector names `.btn`. That includes the top bar's and the tab
row's rules for a button inside them. The focus outline is a global rule and is not listed: it reads `--primary`.

<!-- ds:tokens apps/web/src/app.css .btn -->

| Token | Read by |
| --- | --- |
| `--border` | `border` |
| `--control-border` | `border-color` |
| `--danger-bg` | `background` |
| `--danger-solid` | `background`, `border-color` |
| `--danger-tx` | `background`, `border-color`, `color` |
| `--fw-body` | `font-weight` |
| `--fw-medium` | `font-weight` |
| `--ink` | `color` |
| `--muted` | `background` |
| `--on-danger` | `color` |
| `--on-primary` | `color` |
| `--primary` | `background`, `border-color`, `color` |
| `--primary-hover` | `background` |
| `--primary-soft` | `background` |
| `--radius` | `border-radius` |
| `--radius-lg` | `border-radius` |
| `--row-h` | `min-height`, `width` |
| `--space-1` | `min-height`, `width` |
| `--space-2` | `gap`, `padding`, `padding-inline` |
| `--space-3` | `padding` |
| `--space-6` | `min-height` |
| `--steel` | `color` |
| `--surface` | `background` |
| `--tab-selected` | `box-shadow` |
| `--target` | `min-height`, `width` |
| `--text-sm` | `font-size` |
| `--warn-tx` | `color` |

<!-- /ds:tokens -->

The `link` variant:

<!-- ds:tokens apps/web/src/app.css .link -->

| Token | Read by |
| --- | --- |
| `--fw-medium` | `font-weight` |
| `--primary` | `color` |
| `--primary-bd` | `text-decoration` |
| `--space-5` | `min-height` |

<!-- /ds:tokens -->

`Check`:

<!-- ds:tokens apps/web/src/app.css .check -->

| Token | Read by |
| --- | --- |
| `--space-2` | `gap` |
| `--space-6` | `height`, `width` |
| `--target` | `min-height` |
| `--text-sm` | `font-size` |

<!-- /ds:tokens -->

`Segmented`. `--ring-in` is set and read inside the same rule; it is not a token from `packages/tokens`.

<!-- ds:tokens apps/web/src/ui/button/segmented.module.css -->

| Token | Read by |
| --- | --- |
| `--control-border` | `border`, `border-left` |
| `--fw-body` | `font-weight` |
| `--fw-medium` | `font-weight` |
| `--primary` | `--ring-in`, `color` |
| `--primary-soft` | `background` |
| `--radius` | `border-radius` |
| `--ring-in` | `box-shadow` |
| `--space-3` | `padding` |
| `--target` | `min-height` |
| `--text-sm` | `font-size` |

<!-- /ds:tokens -->
