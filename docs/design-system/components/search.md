<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Search

`SearchField` is the box that finds things in the current view: a search icon, then one `type="search"` input
whose label is also its placeholder.

It lives in `apps/web/src/ui/search`: `search-field.tsx` with `search.module.css`. The input is the `TextInput` of
the [Field](field.md) family.

React Aria Components exports a component with the same name. Four shared components use that one and not this
one: `CommandPalette`, `KeyMap`, `LongTable` and `PathList`. This page is about `ui/search/search-field.tsx`
only.

## When to use it, and when not

Use it for a box that narrows what the current view shows as the user types: the rows of a list or the nodes of
a tree. The caller holds the text and does the filtering.

| Do not use it for | Use instead |
|---|---|
| A search over places, people and tasks from anywhere | `CommandPalette` (`ui/command-palette`). |
| One line of free text in a form | `TextInput` inside a `Field`: see [Field](field.md). |
| Picking one record from a list the server searches | `ServerPicker` (`ui/server-picker`). |
| Picking one option from a short list | `SelectField` (`ui/select`) or `ChoiceField`: see [Choice](choice.md). |
| The find box of a long table | The `find` prop of `LongTable` (`ui/long-table`). The table draws its own box. |

## Anatomy

| Part | Element | Holds |
|---|---|---|
| Wrapper | `<div>` | The icon and the input. `className` lands here, after the module's class. |
| Icon | `<svg>`, 16 px, `aria-hidden` | The search glyph. It sits inside the left end of the input and takes no pointer events. |
| Input | `<input type="search" class="field__input">` | `value`. Its `aria-label` and its `placeholder` are both `label`. |

There is no label element and no slot. The component draws nothing after the input, and no clear control of its
own. A browser may draw one: see [Looks and sizes](#looks-and-sizes).

How the props reach the input:

- Every attribute of a native input other than `value`, `onChange` and `type` is accepted and goes to the input.
- They are spread first. `type`, `aria-label`, `placeholder`, `value` and `onChange` are set after them, so a caller
  cannot replace any of the five. A `placeholder` or an `aria-label` passed by a caller is dropped.
- An `aria-labelledby` passed by a caller is not dropped. It reaches the input, where it outranks `aria-label`
  when the accessible name is worked out. No caller on this branch passes one.
- `className` goes to the wrapper, not to the input. The input's classes are fixed.
- `onChange` is called with the new text, not with the event.
- There is no `ref` prop. A caller that must focus the box gives it an `id`; the structure toolbar does.

The component holds no state. It does not debounce, trim or search: a search that runs on a server request is
timed by the caller.

Text in the box is not an edit. A sheet that works out for itself whether closing would lose something does not
read a search input: see [Sheet](sheet.md).

## Looks and sizes

There is one look and one size. No prop changes either.

| Part | Look |
|---|---|
| Wrapper | A flex row, items centred, `position: relative`. It can shrink (`min-width: 0`). It has no width of its own. |
| Input | The control box of the Field family: 40 px high (`--row-h`), a 1 px `--control-border` border, a 6 px radius (`--radius`), `--surface` fill, 12 px padding on the right (`--space-3`). It fills the wrapper and can shrink. |
| Input, left padding | 36 px: `calc(var(--space-3) + var(--space-4) + var(--space-2))`, which clears the icon. |
| Icon | 16 px, `--steel`, placed 12 px (`--space-3`) from the left edge of the wrapper. The wrapper's `align-items: center` centres it on the input. |
| Text | Inherits the body size, 14 px. |
| Placeholder | The browser's own placeholder colour. `app.css`, `search.module.css` and `field.module.css` have no `::placeholder` rule. |

Three things about these rules are not what they seem:

- The left padding is set by the module's `input` class and the box by the global `field__input` class, whose
  `padding` shorthand also sets the left padding, to 12 px. Both are single-class rules, and the module's comes
  later: the entry module imports `app.css` statically and reaches this component only through lazy imports, so
  the module's stylesheet loads after `app.css`. So the module's 36 px wins, and typed text does not sit under
  the icon. This was read from the stylesheets and the imports, not checked in a browser.
- The icon's place and the padding that clears it are written as `left` and `padding-left`. They do not follow
  the direction of the text.
- `app.css` has a global `search` class of its own. The component does not carry it: its wrapper class comes from
  the module.

A caller sizes the box through `className`. The structure toolbar gives the wrapper a width and makes the input
36 px high that way.

The component draws no clear control, and it does not hide the browser's. Neither `search.module.css` nor
`app.css` has a rule for `::-webkit-search-cancel-button`, the clear button that a browser with that
pseudo-element draws inside a search input. The stylesheets of `CommandPalette`, `Palette` and `LongTable` each
hide it for their own box. So where a browser draws that button, this box shows it as the browser draws it, and
where a browser draws none, the box has no clear control. This page did not open the box in a browser to see
which browsers draw one.

## States

| State | What changes |
|---|---|
| Rest, empty | The placeholder shows `label`. |
| Rest, typed | The text replaces the placeholder. Nothing visible then says what the box finds, apart from the icon. |
| Hover | Nothing. There is no hover rule. |
| Focus | The global rule for every focusable element: a 2 px `--primary` outline, 2 px away. The input has no focus rule of its own. |
| Pressed | Does not exist. |
| Selected | Does not exist. |
| Disabled | No look. `disabled` reaches the input and disables it natively, but neither class has a disabled rule, and the icon does not change. The [Field](field.md#states) page says what a disabled `field__input` looks like in each browser. |
| Read-only | No look. `readOnly` reaches the input. |
| Invalid | Does not exist. There is no `error` prop and no error line. An `aria-invalid` passed by a caller reaches the input and changes nothing on screen: the red border of the Field family is a rule of `Field`'s own control row. |
| Loading | Does not exist. The box shows nothing while a caller's search is running. |
| Empty result | Not the box's. Saying that nothing matched is left to the view that is filtered. |

The gallery entry shows two of these: empty and typed.

## Keyboard

| Key | What it does |
|---|---|
| Tab, Shift+Tab | Moves focus to and from the input. The icon is not focusable. |
| Typing | Calls `onChange` with the new text on every change of the input. |
| Enter | Never submits a form. `TextInput` prevents the default, then calls the caller's `onKeyDown`. |
| Enter while the Korean input method is composing | Left to the input method. `TextInput` does not prevent it, stops it from reaching handlers further up, and does not call the caller's `onKeyDown`. |
| Escape | Nothing of the component's: neither `SearchField` nor `TextInput` handles Escape. What a browser does with Escape in a search input by itself, such as emptying it, was not tested for this page. |
| Any other key | Passed to the caller's `onKeyDown`. |

`SearchField` has no key handler of its own. The Enter rule is `TextInput`'s, which decides that the input method
is composing from the event's `isComposing` flag, or from key code 229.

Typing is not held back for the input method. `onChange` fires for each step of a syllable that is still being
composed, so a view that filters as the user types filters on a half-built syllable too. The component has no
composition handler. A caller that must wait for a whole syllable listens itself: the access log passes
`onCompositionStart` and `onCompositionEnd` and does not search while a composition is open.

What callers add through `onKeyDown`, as two examples: the insurance filing table runs its search on Enter, and
the structure toolbar binds Enter, ArrowDown and ArrowUp to its find command and clears the text on Escape.

## Accessibility contract

| Part | Role | Accessible name | Also exposed |
|---|---|---|---|
| Input | `searchbox`, from `type="search"` | `label`, through `aria-label`, unless a caller passes `aria-labelledby`: see Label below. | The placeholder, which is the same text as `label`. |
| Icon | None. It is `aria-hidden`. | | |
| Wrapper | None. | | |

- **Announced:** nothing. The component has no live region. A view that wants the number of matches read out
  announces it itself.
- **Label:** `aria-label` is always `label`. A caller cannot remove or replace that attribute, or the
  placeholder. A caller can pass `aria-labelledby`: it reaches the input and outranks `aria-label`, so the name
  is then the text of the elements it points at. No caller on this branch passes one. There is no visible label
  apart from the placeholder, which goes once text is typed.
- **Landmark:** the component adds no `search` landmark. It is one input.

The WCAG 2.2 criteria that apply:

| Criterion | How the component answers it |
|---|---|
| 1.3.1 Info and Relationships | A native search input with a name. |
| 1.4.3 Contrast (Minimum) | The text inherits its colour, which is `--ink` on the body, and sits on `--surface`. The placeholder's colour is the browser's, not a token. |
| 1.4.11 Non-text Contrast | The edge is `--control-border` on `--surface`. The icon is `--steel`. |
| 2.1.1 Keyboard | A native input. |
| 2.4.6 Headings and Labels | `label` says what the box finds. It is shown as the placeholder only. |
| 2.4.7 Focus Visible | The global 2 px focus outline. |
| 2.5.3 Label in Name | The placeholder and `aria-label` are the same text. |
| 2.5.8 Target Size (Minimum) | The input is 40 px high. |
| 3.2.2 On Input | Typing changes what the view shows. That is the caller's doing: the component only reports the text. |
| 3.3.2 Labels or Instructions | Answered by the placeholder alone. |
| 4.1.2 Name, Role, Value | The table above. |
| 4.1.3 Status Messages | Not answered by the component: it announces no result count. |

Known gaps:

- The only visible label is the placeholder. A filled box shows no label.
- The placeholder's colour is not set, so its contrast is whatever the browser gives.
- A disabled box has no look of its own: see States.
- Nothing is held back while the Korean input method is composing: see Keyboard.
- The component draws no clear control and does not hide the browser's, so whether the box has one depends on
  the browser: see Looks and sizes.

What the gallery shows:

| Shown | Where |
|---|---|
| An empty box and a typed one | `apps/web/src/ui/search/search.gallery.tsx` |
| The box of the insurance filing table | `apps/web/src/features/statutory/ui/filing-table.gallery.tsx` |

The gallery shows no disabled or read-only box.

Tests: `apps/web/src/ui/canonical.test.tsx` checks that the markup is a `type="search"` input named by `label`
with a hidden icon, and presses no key. `apps/web/src/ui/page/page.browser.test.tsx` renders the box as the filter
of a list page and checks that it keeps its text and its focus while the list is read again. The Enter rule is
tested on `TextInput`, in `apps/web/src/ui/field/form.browser.test.tsx`. The rest is driven in a browser through
the screens that use the box. Two examples: `e2e/states/access-log-search.spec.ts`, which also checks that the
access log waits for a composition to end, and `e2e/mock/approvals.spec.ts`.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component). When it runs, it covers the boxes of the two entries above
as they are drawn, with no key pressed in them.

## Phone behaviour at 390 px

Nothing changes with the width of the screen. `search.module.css` has no media query and no container query.

- The input is 40 px high at every width. It does not grow to the 44 px touch size; the component does not read
  `--target-touch`.
- The wrapper and the input can both shrink (`min-width: 0`).
- Typed text is 14 px at every width.
- The icon and the left padding are the same at every width.

How wide the box is at 390 px is decided by the layout around it. The wrapper has no width of its own.

## Copy rules

- The component owns no message id and imports no text.
- `label` is the caller's, from the message catalog in `packages/i18n`. The `en` catalog is the source and the `ko`
  catalog must define every id.
- `label` is the `aria-label` and the placeholder at once. Write it so that it says what the box finds, such as
  the fields it matches. It is the only text the box has.
- There is no separate placeholder. A caller that wants a longer hint passes `title`, as the structure toolbar
  does.
- The gallery entry takes its text from the gallery catalog: `section.search`, `search.label`, `search.typed` and
  `search.person`.

## Props

<!-- ds:props apps/web/src/ui/search/search-field.tsx -->

### SearchField

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `label` | yes | `string` |  |  |
| `onChange` | yes | `(value: string) => void` |  |  |
| `value` | yes | `string` |  |  |

Also accepts the attributes of `InputHTMLAttributes` (`@types/react`), except `type`.

<!-- /ds:props -->

## Tokens it reads

The component's own stylesheet:

<!-- ds:tokens apps/web/src/ui/search/search.module.css -->

| Token | Read by |
| --- | --- |
| `--space-2` | `padding-left` |
| `--space-3` | `left`, `padding-left` |
| `--space-4` | `padding-left` |
| `--steel` | `color` |

<!-- /ds:tokens -->

The input's box, `field__input` in `app.css`:

<!-- ds:tokens apps/web/src/app.css .field__input -->

| Token | Read by |
| --- | --- |
| `--control-border` | `border` |
| `--radius` | `border-radius` |
| `--row-h` | `height` |
| `--space-3` | `padding` |
| `--surface` | `background` |

<!-- /ds:tokens -->

The focus outline is a global rule and is not listed: it reads `--primary`.
