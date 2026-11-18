<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Banner

A banner is a tinted message in the flow of a view: an icon, an optional title, the text and its remedies, drawn
as a boxed callout or as a strip across the page.

It lives in `apps/web/src/ui/banner/banner.tsx`.

## When to use it, and when not

Use a banner to say what happened or what holds, and then what to do about it. `tone` says which kind of message
it is:

| `tone` | Use it for |
|---|---|
| `info` | A fact or a next step. |
| `warn` | A caution that does not block. |
| `danger` | A block or a failure. |
| `ok` | Something that is done. |
| `past` | An as-of date in the past, where the page is read-only. |

`placement` says where it sits:

| `placement` | Use it for |
|---|---|
| `inline` | A callout inside a card, a sheet or a form. |
| `page` | A strip under the page head, for something that holds for the whole page. |

Some banners are already rendered by a component. Use it before building the same banner by hand:

- A failed command is usually shown by `CommandError` (`lib/react/command-error.tsx`). It renders a banner, or an
  error summary when the server names the fields that failed. It picks the tone, and the `live` value unless the
  caller passes one. Some views build a failure or refusal banner themselves.
- The as-of strip under a page head is rendered by `AsOfControl` (`ui/asof-control`), with the button that returns
  to today. It is the only caller of the `past` tone outside the gallery.

| Do not use it for | Use instead |
|---|---|
| A refusal by the server that the person cannot override here, with who can unblock it | `BlockedPanel` (`ui/blocker`). |
| What is wrong with one form control | `Field` with `error` or `warning`: see [Field](field.md). |
| The list of controls that failed validation | `ErrorSummary` (`ui/error-summary`). `Form` renders it: see [Button](button.md). |
| Why a control cannot be used now | `DisabledReason` (`ui/disabled-reason`). |
| The receipt of a command, with its undo | `Receipt` (`ui/receipt`), or `Toast` (`ui/toast`) on a record screen. |
| A view with nothing in it, or a view that failed to load | `EmptyState` (`ui/empty-state.tsx`). |
| The state of a record, as one word | `Chip`: see [Chip](chip.md). |
| A hand-written `notice` or `alert` class | `Banner`. Both classes are still in `app.css` and some views still write them. The design-system check counts each hand-written use, and the count may only go down. |

## Anatomy

| Part | Element | Holds |
|---|---|---|
| Root | `<div>` with `data-tone` and `data-placement` | Everything below. `id`, `ref`, `tabIndex` and the live role go here. |
| Icon | `<svg aria-hidden="true">`, 16 px | The icon of the tone. |
| Body | `<div>` | The title, then the text. |
| Title | `<strong>` | `title`. |
| Text | `<div class="prose">` | `children`. |
| Actions | `<div>` | `actions`. |

The title, the text and the actions are each left out when their prop is `null`, `undefined`, `false` or an empty
string. The icon and the body are always rendered, so a banner given nothing is still a tinted box with an icon.

The text block is a column. Text placed directly in `children` is one line of it, and each element placed directly
in `children` is a line of its own. A link or a chip that belongs inside a sentence therefore goes, with that
sentence, inside a `<p>`.

The icon cannot be changed or removed. Each tone has its own, from `lucide-react`:

| `tone` | Icon |
|---|---|
| `info` | `Info` |
| `warn` | `TriangleAlert` |
| `danger` | `CircleAlert` |
| `ok` | `CircleCheck` |
| `past` | `History` |

There is no close button and nothing that dismisses a banner. It stays until the view stops rendering it.

The banner takes no `className` and passes no other attribute through. It cannot be given an ARIA attribute.

## Looks and sizes

There is one size. Text is 13 px (`--text-sm`). The title is the same size at `--fw-strong`. Parts are 12 px apart
on a line (`--space-3`) and 8 px apart when they wrap (`--space-2`). The title and the text are 4 px apart
(`--space-1`), and so are the paragraphs of a text made of several `<p>`; a `<p>` in the text has no margin.

`tone` picks the colours:

| `tone` | Fill | Border | Text and icon |
|---|---|---|---|
| `info` | `--info-bg` | `--info-bd` | `--info-tx` |
| `warn` | `--warn-bg` | `--warn-bd` | `--warn-tx` |
| `danger` | `--danger-bg` | `--danger-bd` | `--danger-tx` |
| `ok` | `--ok-bg` | `--ok-bd` | `--ok-tx` |
| `past` | `--ink` | `--ink` | `--surface` |

The icon is drawn in the text colour: `lucide-react` strokes with `currentColor`.

`placement` picks the box:

| `placement` | Border | Radius | Padding | Parts aligned |
|---|---|---|---|---|
| `inline` | 1 px on every side | 6 px (`--radius`) | 8 px top and bottom (`--space-2`), 12 px sides (`--space-3`) | To the top. |
| `page` | 1 px at the bottom only | None | 8 px top and bottom, 16 px sides (`--space-4`) | To the middle. |

Neither placement sets a width. The banner is a block and fills its container.

Any tone goes with either placement. No rule ties `past` to `page`.

The icon has a top margin of `calc((var(--text-sm) * var(--lh-base) - var(--space-4)) / 2)`, 1.75 px, which
centres it on the first line of the text when the parts are aligned to the top, as in `inline`. `page` does not
reset the margin, though its parts are aligned to the middle. There the icon's margin box is what is centred, so
the icon sits below the middle by half the margin.

A link inside the text is styled by the global `prose` class as a link in running text: `--primary`, with a 1 px
`--primary-bd` underline. Its weight is `--fw-medium`, from the global rule for every link.

## States

| State | What changes |
|---|---|
| Rest | The look above. |
| Hover | Nothing on the banner. A link in the text: its underline takes the link's colour. |
| Focus | The banner is not focusable unless the caller passes `tabIndex`. It has no focus rule of its own. The only focus look is the global rule for every focusable element, a 2 px `--primary` outline 2 px away, and the browser decides whether that shows when focus is moved by script. A link in the text shows the same underline change as on hover. |
| Pressed | Does not exist. |
| Selected | Does not exist. |
| Disabled | Does not exist. |
| Read-only | Does not exist. The `past` tone tells the person that the page is read-only; it changes nothing about the banner. |
| Invalid | Does not exist. `danger` is a tone, not a state. |
| Loading | Does not exist. |
| Empty | No look. A banner with no title, no text and no actions renders the tinted box with its icon. |

A banner appears and goes with no transition.

## Keyboard

None of its own. The banner handles no key, and Tab skips it unless the caller passes `tabIndex={0}`.

Links in the text and controls in `actions` are reached with Tab in document order: the text first, then the
actions.

There is no key that dismisses a banner, because nothing dismisses one.

The banner takes no text, so it has no rule for a key the Korean input method owns. The module has no `keydown`
handler, no `isComposing` check, no key code 229 check and no composition event.

## Accessibility contract

| `live` | Role on the root |
|---|---|
| not set | None. It is a plain `<div>`. |
| `polite` | `status` |
| `assertive` | `alert` |

- **Accessible name:** none, and there is no prop that gives one. The title is a `<strong>`, not a heading, so it
  is not in the heading outline and it does not name the banner.
- **Tone:** not exposed. The icon is hidden from assistive technology and the banner adds no hidden word for the
  tone. Only the caller's words carry it, so the text must say what kind of message this is.
- **Announced:** nothing without `live`. With `live`, the role makes the root a live region. The role sits on the
  same element as the content: the component does not keep an empty region mounted and then fill it, so the region
  and its text arrive together when the view renders the banner.
- **A change with no visible message:** not a banner. Call `announce` from `lib/react/announce`. It speaks through
  the shell's one polite live region (`Announcer`, `ui/announcer.tsx`), which is in the page before the text
  arrives.
- **On load:** a banner that is there when the page loads leaves `live` unset. `live` is for a banner that appears
  after an action.
- **Focus:** `ref` and `tabIndex` exist so that a view can move focus to the banner. `tabIndex={-1}` takes focus
  from script and stays out of the Tab order.

The WCAG 2.2 criteria that apply:

| Criterion | How the banner answers it |
|---|---|
| 1.3.1 Info and Relationships | In part. The title is marked as strong text and the text is its own block. Nothing ties the title to the text, and without `live` the banner has no role. |
| 1.4.1 Use of Color | Each tone has its own icon as well as its colours. For a screen reader only the words carry the tone. |
| 1.4.3 Contrast (Minimum) | Each tone pairs a text token with its own fill token. The text is 13 px, so it needs 4.5:1. Computed from the token values, the lowest pair is 5.91:1 in the light theme (`danger`) and 8.60:1 in the dark theme (`info`). A link in the text is `--primary`. On the `info`, `warn`, `danger` and `ok` fills it is at least 6.48:1 in the light theme and 4.65:1 in the dark theme. On the `past` fill it fails: see the first gap below. |
| 1.4.10 Reflow | The parts wrap and the text can shrink. Only the icon has a fixed size, 16 px. |
| 1.4.11 Non-text Contrast | The icon is drawn in the text colour, so it has the text's ratio. The focus outline of a link in the text, or of a control in `actions`, is `--primary` on the banner's fill. That is the link's pair: it is above 3:1 on the four tinted fills and below it on the `past` fill. See the second gap below. |
| 2.1.1 Keyboard | The banner has nothing of its own to operate. |
| 2.4.7 Focus Visible | The global focus outline, when the caller makes the banner focusable. |
| 4.1.2 Name, Role, Value | No role unless `live` is set. No name in any case. |
| 4.1.3 Status Messages | `live` gives the banner the `status` or the `alert` role. Without it, a banner that appears after an action is not announced. The choice is the caller's. |

Both gaps are on the `past` tone. Their ratios are computed from the token values, not measured in a browser.

Known gap: a link in the text of a `past` banner. The `prose` rule colours a link `--primary`, and the `past` fill
is `--ink`. That pair is 2.47:1 in the light theme and 2.63:1 in the dark theme, below the 4.5:1 that 1.4.3 asks
for. Nothing in the banner changes the link colour for this tone. The `past` banner in the gallery has no link.

Known gap: the focus outline inside a `past` banner. The global rule draws a 2 px `--primary` outline 2 px outside
the focused element, so the outline of a control in `actions`, or of a link in the text, lies on the `--ink` fill.
It is the same pair, 2.47:1 and 2.63:1, below the 3:1 that 1.4.11 asks for. `Button` sets no focus outline of its
own. This is therefore the outline of the button that returns to today in the as-of strip, and of the button in
the gallery's `past` banner.

The gallery entry is `apps/web/src/ui/banner/banner.gallery.tsx`. It shows `info` with text alone, `warn` with a
title, `danger` with an action, `ok` with `live="polite"`, and `past` as a page strip with an action. It does not
show `live="assertive"`, a link in the text, or a banner that takes focus.

The banner has no test file of its own. The assertions on its role and its hidden icon are in
`apps/web/src/ui/canonical.test.tsx`.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component).

## Phone behaviour at 390 px

Nothing in the banner changes with the width of the screen. `banner.module.css` has no media query and no
container query.

It wraps by itself instead:

- The body asks for 220 px (`calc(var(--panel-w) / 2)`), grows to fill the line and can shrink below that.
- When the icon, 220 px of body and the actions do not fit on one line, the actions move to a line of their own.
  They start at the banner's left edge, under the icon.
- The actions wrap among themselves.
- The icon keeps its 16 px.

The text is 13 px and the padding is the same at every width.

The banner has no target of its own. The size of a control in `actions` is that control's: the banner does not
read `--target-touch`.

## Copy rules

- The banner holds no text of its own and owns no message id.
- The title, the text and the labels of the actions come from the message catalog in `packages/i18n`, through the
  caller. The `en` catalog is the source and the `ko` catalog must define every id.
- Say what happened or what holds first, then the remedy. A remedy the person can take here is a control in
  `actions`.
- The words must say what kind of message this is. A screen reader gets no tone.
- Keep the title to one short statement. It is not a heading.
- Pass sentences that need their own lines as `<p>` elements inside `children`. Wrap a sentence that holds a
  link in a `<p>` too: see Anatomy.

## Props

<!-- ds:props apps/web/src/ui/banner/banner.tsx -->

### Banner

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `actions` | no | `ReactNode` |  |  |
| `children` | no | `ReactNode` |  |  |
| `id` | no | `string` |  |  |
| `live` | no | `"assertive" \| "polite"` |  |  |
| `placement` | no | `"inline" \| "page"` | `"inline"` |  |
| `ref` | no | `Ref<HTMLDivElement>` |  |  |
| `tabIndex` | no | `number` |  |  |
| `title` | no | `ReactNode` |  |  |
| `tone` | no | `BannerTone` | `"info"` |  |

<!-- /ds:props -->

`BannerTone` is `"info" | "warn" | "danger" | "ok" | "past"`.

## Tokens it reads

The banner's own stylesheet:

<!-- ds:tokens apps/web/src/ui/banner/banner.module.css -->

| Token | Read by |
| --- | --- |
| `--danger-bd` | `border-color` |
| `--danger-bg` | `background` |
| `--danger-tx` | `color` |
| `--fw-strong` | `font-weight` |
| `--info-bd` | `border-color` |
| `--info-bg` | `background` |
| `--info-tx` | `color` |
| `--ink` | `background`, `border-color` |
| `--lh-base` | `margin-top` |
| `--ok-bd` | `border-color` |
| `--ok-bg` | `background` |
| `--ok-tx` | `color` |
| `--panel-w` | `flex` |
| `--radius` | `border-radius` |
| `--space-1` | `gap` |
| `--space-2` | `gap`, `padding` |
| `--space-3` | `gap`, `padding` |
| `--space-4` | `margin-top`, `padding` |
| `--surface` | `color` |
| `--text-sm` | `font-size`, `margin-top` |
| `--warn-bd` | `border-color` |
| `--warn-bg` | `background` |
| `--warn-tx` | `color` |

<!-- /ds:tokens -->

A link inside the text, through the global `prose` class in `app.css`:

<!-- ds:tokens apps/web/src/app.css .prose -->

| Token | Read by |
| --- | --- |
| `--primary` | `color` |
| `--primary-bd` | `text-decoration` |

<!-- /ds:tokens -->

The focus outline and the weight of a link are global rules and are not listed: they read `--primary` and
`--fw-medium`.
