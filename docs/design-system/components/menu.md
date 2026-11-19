<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Menu

A menu is a button that opens a short list of commands in a popover: `ActionMenu` lists a record's verbs with
their keys, and `MenuButton` lists commands and keeps an unavailable one in the list with its reason.

Both live in `apps/web/src/ui/menu`: `ActionMenu` in `action-menu.tsx` with `action-menu.module.css`, and
`MenuButton` in `menu-button.tsx` with `menu.module.css`. Both are built on the menu of React Aria Components.

They are two separate components. They do not share a stylesheet, and their lists look different.

## When to use it, and when not

| Component | Use it for |
|---|---|
| `ActionMenu` | The verbs of one record behind one trigger, each shown with the key that also runs it. It can be opened from outside through `open`, so a right-click or Shift+F10 on the record can open the same menu. |
| `MenuButton` | A button that opens a list of commands, where a command that cannot be used now stays in the list, not pressable, with the reason under it. |

| Do not use it for | Use instead |
|---|---|
| One command | `Button` or `IconButton`: see [Button](button.md). |
| One command that is blocked and must say why | `DisabledReason` (`ui/disabled-reason`). |
| Picking a value in a form | `SelectField` (`ui/select`) or `ChoiceField` (`ui/choice`). A menu runs a command; it holds no value. |
| Switching between views | `Segmented`, on the [Button](button.md) page, or `Tabs` and `TabNav` (`ui/tabs`). |
| A small panel of content beside its trigger | `PopoverButton` (`ui/popover`). |
| A search over places, people and tasks | `CommandPalette` (`ui/command-palette`). |
| A menu of links, a submenu or a checked entry | Neither component has them. `AccountMenu`, in `shell/top-bar/account-menu.tsx`, builds its own React Aria menu for these, with the classes of `menu.module.css`. On this branch the top bar does not render it: only the gallery's shell section and one browser test do. |

## Anatomy

`ActionMenu`:

| Part | Element | Holds |
|---|---|---|
| Trigger | `<button class="btn btn--ghost">` | `trigger`: whatever the caller passes, an icon or text or both. |
| Popover | `<div class="popover">` | The menu. React Aria renders it in a portal on `<body>`, below the trigger and aligned to its end edge. |
| Menu | `<div role="menu">` | One item per entry of `actions`, in the order given. |
| Item | `<div role="menuitem">` | The label, then the shortcut. |
| Label | `<span>` | The action's `label`. |
| Shortcut | `<kbd>` | The action's `shortcut`, when it has one. It is pushed to the end of the row. |

`MenuButton`:

| Part | Element | Holds |
|---|---|---|
| Trigger | `<button class="btn">`, with `btn--primary` when `primary` | `icon`, then `label` in a `<span>`, then a 14 px chevron. Which of the three appear depends on `icon` and `caret`: see below. |
| Popover | `<div>` | The menu, placed as above. |
| Menu | `<div role="menu">` | One item per entry of `items`, in the order given. |
| Item | `<div role="menuitem">` | A two-column grid: the label and the hint on one line, the reason on a line of its own. |
| Label | `<span>` | The entry's `label`. It can be markup, such as an icon and text. |
| Hint | `<span>` | The entry's `hint`, at the end of the first line. Left out when not given. |
| Reason | `<span>` | The entry's `why`. Left out when not given. An entry with `why` is unavailable. |

What the `MenuButton` trigger shows:

| `icon` | `caret` | Shown | `aria-label` |
|---|---|---|---|
| not given | `true` (default) | The label and the chevron. | None. |
| not given | `false` | The label. | None. |
| given | `true` (default) | The icon, the label and the chevron. | None. |
| given | `false` | The icon alone. | `label`. |

So `icon` replaces the label only together with `caret={false}`.

Both popovers ask for `placement="bottom end"` and sit 8 px from the trigger. The 8 px is React Aria's default
offset in the installed version (`react-aria-components` 1.22.1); neither component passes one.

An action or an entry is plain data. `MenuAction` is `{ id, label, shortcut?, danger?, onAction }`. `MenuEntry` is
`{ id, label, text, hint?, why? }`: `text` is the entry's label as plain text. The menu matches typed letters
against it, because `label` may be markup.

Running a command differs between the two. Each `MenuAction` carries its own `onAction`. `MenuButton` has one
`onAction` for the whole menu and passes it the `id` of the entry.

`shortcut` is shown and nothing more. `ActionMenu` does not listen for the key; the caller binds it. The same
holds for opening the menu by right-click or Shift+F10: the caller listens and sets `open`. The organisation chart
does both.

Passing `open` makes `ActionMenu` controlled: `open` and `onOpenChange` go straight to React Aria's menu trigger.
The menu then opens and closes only as the caller changes `open`. A press on the trigger, Escape, a press outside
or a chosen action calls `onOpenChange`, and the menu stays as it was until the caller updates `open` from it.
With `open` left out, the menu keeps its own state.

Neither component handles an empty list. With no actions or items the trigger is still drawn and opens an empty
menu. Callers leave the menu out when they have nothing to list.

Neither component passes other attributes through. `MenuButton` takes `buttonRef` for the trigger element;
`ActionMenu` has no ref.

## Looks and sizes

There are no sizes. The looks are fixed, apart from `primary` and the icon-only trigger of `MenuButton`.

| Part | `ActionMenu` | `MenuButton` |
|---|---|---|
| Trigger | The `ghost` button look: transparent until hovered, at least 36 px high, 12 px side padding. | The `secondary` button look, or `primary` with `primary`. With an icon, no caret and no `primary`: a 36 px square (`calc(var(--row-h) - var(--space-1))`) with no padding. |
| Popover box | From the global `popover` class: `--surface` fill, a 1 px `--border` border, a 6 px radius (`--radius`), `--shadow-pop`, and `overflow: auto`. | The same fill, border, radius and shadow, written in its own module. No `overflow` rule. |
| Popover width | At least 220 px, written as a literal. | Between 275 px (`calc(var(--panel-w) / 1.6)`) and 440 px (`--panel-w`). |
| Menu | A column with 4 px of padding (`--space-1`). | The same. |
| Item | At least 32 px high (`--target`), 12 px side padding, a 4 px radius, 13 px text (`--text-sm`). A row with a 12 px gap. | 8 px top and bottom padding and 12 px at the sides, a 4 px radius, 13 px text. No minimum height: one line comes to 35.5 px at the body's line height of 1.5. |
| Label | Inherits the item's text. | Weight 600 (`--fw-medium`). |
| Shortcut or hint | The shortcut is a key cap: 12 px monospace text (`--text-xs`, `--font-mono`), `--steel`, on `--kbd-bg` with a 1 px `--border` border and a 4 px radius. | The hint has no look of its own. It is placed at the end of the line. |
| Reason | Does not exist. | 12 px (`--text-xs`), `--steel`, across the full width under the label. |
| Dangerous entry | `danger` turns the item's text `--danger-tx`. | Does not exist. |

In a table cell the icon-only `MenuButton` trigger is smaller: 24 px wide and at least 24 px high (`--space-5`),
with a transparent border and fill. The rule is `td .icon` in `menu.module.css`.

Three things about these rules are not what they seem:

- The global `popover` class sets `width: var(--trigger-width)`, the width of the trigger. The module of
  `ActionMenu` sets `width: auto` to undo that. Both are single-class rules, so the module's rule wins only when
  its stylesheet comes after `app.css`. The same holds for the `icon` class of the square trigger against the
  padding of `btn`, and for `outline: none` on an item against the global focus outline. This page did not check
  the order in a build of this branch.
- The global `popover` class also sets `z-index: 30`, as a literal, and a maximum height of
  `calc(var(--row-h) * 8)`. React Aria sets `z-index` and `max-height` on the popover element itself when it
  places it, and an inline style wins over a class. Neither value from the class is the one in effect.
- `menu.module.css` gives the `MenuButton` popover no `overflow`, so a list taller than the height React Aria
  allows is not scrolled by the popover.

No prop picks a visual style. There is no open or close animation: neither module has a transition or reads
`data-entering` or `data-exiting`.

## States

The trigger:

| State | What changes |
|---|---|
| Rest, hover | The button looks on the [Button](button.md) page. Hover is a `--muted` fill, or `--primary-hover` for `primary`. |
| Keyboard focus | The global 2 px `--primary` outline. |
| Open | No look. React Aria sets `aria-expanded="true"` and `data-pressed` on the trigger; no rule reads either. |
| Disabled | Does not exist. Neither component can disable its trigger. |

An item:

| State | `ActionMenu` | `MenuButton` |
|---|---|---|
| Rest | No fill. | No fill. |
| Focused (`data-focused`) | `--muted` fill. | `--primary-soft` fill and a 3 px `--primary` bar on the left edge (`--selected-bar`). |
| Hover | The focused look. React Aria moves focus to the item under the pointer; there is no separate hover rule. | The same. |
| Keyboard focus (`data-focus-visible`) | The focused fill plus a ring: `--focus`, 2 px of `--surface` then 2 px of `--primary`. | No extra rule. Keyboard focus looks the same as hover. |
| Pressed | No look. | No look. |
| Selected | Does not exist. A menu here runs commands and keeps no selection. | Does not exist. |
| Unavailable | Does not exist. `MenuAction` has no such field. | An entry with `why`: `--steel` text, the default cursor, and the reason under the label. It cannot be pressed, and neither the pointer nor the arrow keys give it the focused look. |
| Danger | `--danger-tx` text. | Does not exist. |

Both item rules set `outline: none`, in place of the global focus outline.

Read-only, invalid and loading do not exist. Empty is not handled: see Anatomy.

## Keyboard

On the trigger:

| Key | What it does |
|---|---|
| Tab, Shift+Tab | Moves focus to and from the trigger. |
| Enter, Space, ArrowDown | Opens the menu and focuses the first item that can be used. |
| ArrowUp | Opens the menu. `MenuButton` then focuses the last item that can be used. `ActionMenu` focuses the first, as it always does (`autoFocus="first"`). |

Opened by a pointer, `ActionMenu` still focuses its first item. `MenuButton` gives focus to the menu itself, and
no item has it until the pointer or an arrow key moves.

In the open menu:

| Key | What it does |
|---|---|
| ArrowDown, ArrowUp | Moves to the next or previous item, and wraps at either end. An unavailable entry is skipped. |
| Home, End | Moves to the first or last item. |
| Typing | Moves to the item whose text starts with what was typed. The text is the action's `label`, or the entry's `text`. |
| Enter, Space | Runs the focused item and closes the menu. |
| Escape | Closes the menu. Focus returns to the trigger. |

A press outside the menu also closes it.

`apps/web/src/ui/page/page.browser.test.tsx` checks, for an `ActionMenu`, that Enter on the trigger focuses the
first item and that Escape returns focus to the trigger. What Tab does inside an open menu was not worked out for
this page: React Aria handles it, and no test here covers it.

These keys are React Aria's; neither component has a key handler. Neither component checks `isComposing`, key
code 229 or a composition event, so there is no rule of their own for a key the Korean input method owns. A menu
holds no text field. In the installed version (`react-aria-components` 1.22.1), React Aria's handlers for the
arrow keys, Enter, Space and Escape skip a key event whose `isComposing` flag is set. Its type-ahead has no such
check: it reads the `key` of every keydown. No test in this repository presses a key in a menu with the Korean
input method active.

## Accessibility contract

| Part | Role | Accessible name | Also exposed |
|---|---|---|---|
| Trigger of `ActionMenu` | `button` | `label`, through `aria-label`. It replaces any text inside `trigger`. | `aria-haspopup="true"`, `aria-expanded`, and `aria-controls` while open. |
| Trigger of `MenuButton` | `button` | Its text, `label`. With an icon and no caret: `label`, through `aria-label`. | The same three. |
| Popover | `dialog` | The trigger, through `aria-labelledby`. | React Aria gives a modal popover this role unless it holds a dialog of its own. |
| Menu | `menu` | The trigger's name, through `aria-labelledby`: React Aria points it at the trigger. The components also set `aria-label={label}` on the menu. `aria-labelledby` comes first when a name is computed, and the trigger's name is `label` too, so both say the same. | |
| Item of `ActionMenu` | `menuitem` | The label, through `aria-labelledby`. | The shortcut is its description, through `aria-describedby`. |
| Item of `MenuButton` | `menuitem` | Its content: the label, then the hint, then the reason. | `aria-disabled="true"` on an entry with `why`. |

- **Modality:** while a menu is open, everything outside the popover is `inert`, and React Aria locks the scroll
  of the document.
- **Announced:** nothing through a live region. Opening moves focus into the menu.
- **Hidden dismiss buttons:** React Aria puts a visually hidden button at the start and at the end of the popover.
  Each closes the menu. Neither is in the tab order. React Aria names them with its own text for "dismiss", in the
  locale the app gives React Aria.
- **Icons:** an icon in `trigger`, `icon` or a label is decoration. The caller marks it `aria-hidden`; the
  components do not. The chevron of `MenuButton` is marked by the component.

The WCAG 2.2 criteria that apply:

| Criterion | How the menus answer it |
|---|---|
| 1.3.1 Info and Relationships | A `menu` of `menuitem`s, tied to a trigger that says it has a popup. |
| 1.4.1 Use of Color | A dangerous action is a colour and nothing else, so its label must say what it does. An unavailable entry is `aria-disabled` and carries its reason in words. |
| 1.4.3 Contrast (Minimum), 1.4.11 Non-text Contrast | Every colour is a token. |
| 2.1.1 Keyboard | The tables above. |
| 2.1.2 No Keyboard Trap | Escape closes the menu and returns focus to the trigger. |
| 2.4.3 Focus Order | Focus moves into the menu on open and back to the trigger on Escape. |
| 2.4.7 Focus Visible | The trigger shows the global outline. An `ActionMenu` item shows a ring. A `MenuButton` item shows a fill and a bar, the same as on hover. |
| 2.5.3 Label in Name | The caller's to keep for `ActionMenu`: `aria-label` replaces the text in `trigger`, so `label` must contain that text. |
| 2.5.8 Target Size (Minimum) | Triggers are at least 36 px high. The icon-only `MenuButton` trigger in a table cell is 24 px wide and at least 24 px high, which is the minimum. `ActionMenu` items are at least 32 px high. |
| 4.1.2 Name, Role, Value | The table above. |

Known gaps:

- Focus does not reach an unavailable entry of `MenuButton`: the arrow keys skip it and the pointer does not
  focus it. Its reason is in the item's content, so it is seen, but a keyboard user moving by arrow keys is not
  taken to it.
- A dangerous action in `ActionMenu` is marked by colour alone. The component adds no icon and no hidden text.
- A `MenuButton` item has no keyboard-only focus look.
- The names of the hidden dismiss buttons are React Aria's text, not messages from `packages/i18n`.
- The comment on `MenuEntry` calls `hint` the entry's key. The one caller that passes `hint`, the inbox's snooze
  menu, passes a date.

What the gallery shows:

| Shown | Where |
|---|---|
| An `ActionMenu` with a text trigger, three actions with shortcuts, one of them dangerous | `apps/web/src/ui/org-canvas/org-canvas.gallery.tsx` |
| An `ActionMenu` with an icon trigger and one action, in a page head. The page head shows it below 768 px. | `apps/web/src/gallery/sections/page.gallery.tsx` |
| An icon-only `MenuButton` with two entries, and one with a single entry, inside the row actions | `apps/web/src/ui/record-actions/record-actions.gallery.tsx` |

`ui/menu` has no gallery file of its own, so both menus are shown only where another component's entry uses them.
These three are all there is: a trace of the imports of every `*.gallery.tsx` finds no other entry that renders
either component. They do not show a `primary` or a caret `MenuButton`, a hint, or an unavailable entry with its
reason.

Tests: `ui/menu` has no unit test. The menus are driven in a browser through the screens that use them. Two
examples: `apps/web/src/ui/page/page.browser.test.tsx` for an `ActionMenu` in a page head, and
`e2e/mock/inbox-snooze.spec.ts` for a `MenuButton` with a hint and an unavailable entry, which it checks for fit
and with axe at both widths.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component).

That scan opens neither an `ActionMenu` nor a `MenuButton`, so for these two components it covers the triggers in
the gallery and no open menu. Another test in the same file opens the gallery's `AccountMenu` and runs axe over
its menus, which carry the classes of `menu.module.css`. An open menu of these components is scanned elsewhere: a
`MenuButton` by `e2e/mock/inbox-snooze.spec.ts`, as above, and the organisation chart's `ActionMenu`, opened by
right-click, by `e2e/structure-order.spec.ts` and `e2e/structure-entity-order.spec.ts`.

## Phone behaviour at 390 px

Neither module has a media query or a container query. Nothing in the menus' own rules changes with the width of
the screen.

- The popover of `ActionMenu` is at least 220 px wide and that of `MenuButton` between 275 px and 440 px. Both
  minimums fit in 390 px.
- React Aria places the popover against the trigger and sets its position and its maximum height itself.
- Triggers and items are the same size as at 1440 px. Nothing grows to the 44 px touch size; the modules do not
  read `--target-touch`.
- The `td .icon` rule depends on being in a table cell, not on width.

A caller can decide by width whether a menu is shown at all. The page head does: below 768 px it hides its
secondary buttons and shows the same actions in an `ActionMenu`. That rule is in `ui/page-head`, not here.

## Copy rules

- Neither component owns a message id or imports any text.
- `label`, each action's `label`, and each entry's `label`, `text`, `hint` and `why` are the caller's, from the
  message catalog in `packages/i18n`. The `en` catalog is the source and the `ko` catalog must define every id.
- `label` names both the trigger and the menu. For an icon-only trigger it is the only name, so it is real copy.
- An entry's `text` says the same as its `label`, as plain text.
- `why` says why the command cannot be used now. An unavailable command stays in the list; it is not left out.
- A dangerous action's label says what it does in words.
- `shortcut` is shown as written. Callers pass key names such as `F2` or `Del` as literals, not catalog messages.
- The one built-in text is the name of the hidden dismiss buttons. It comes from React Aria, not from the catalog.

## Props

<!-- ds:props apps/web/src/ui/menu/action-menu.tsx -->

### ActionMenu

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `actions` | yes | `readonly MenuAction[]` |  |  |
| `label` | yes | `string` |  |  |
| `trigger` | yes | `ReactNode` |  |  |
| `onOpenChange` | no | `(open: boolean) => void` |  |  |
| `open` | no | `boolean` |  |  |

<!-- /ds:props -->

<!-- ds:props apps/web/src/ui/menu/menu-button.tsx -->

### MenuButton

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `items` | yes | `MenuEntry[]` |  |  |
| `label` | yes | `string` |  |  |
| `onAction` | yes | `(id: string) => void` |  |  |
| `buttonRef` | no | `Ref<HTMLButtonElement>` |  |  |
| `caret` | no | `boolean` | `true` |  |
| `icon` | no | `ReactNode` |  |  |
| `primary` | no | `boolean` |  |  |

<!-- /ds:props -->

## Tokens it reads

`ActionMenu`:

<!-- ds:tokens apps/web/src/ui/menu/action-menu.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border` |
| `--danger-tx` | `color` |
| `--focus` | `box-shadow` |
| `--font-mono` | `font-family` |
| `--kbd-bg` | `background` |
| `--muted` | `background` |
| `--radius-sm` | `border-radius` |
| `--space-1` | `padding` |
| `--space-3` | `gap`, `padding` |
| `--steel` | `color` |
| `--target` | `min-height` |
| `--text-sm` | `font-size` |
| `--text-xs` | `font-size` |

<!-- /ds:tokens -->

`MenuButton`. `AccountMenu` (`shell/top-bar/account-menu.tsx`) reads the same module.

<!-- ds:tokens apps/web/src/ui/menu/menu.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border` |
| `--fw-medium` | `font-weight` |
| `--panel-w` | `max-width`, `min-width` |
| `--primary-soft` | `background` |
| `--radius` | `border-radius` |
| `--radius-sm` | `border-radius` |
| `--row-h` | `width` |
| `--selected-bar` | `box-shadow` |
| `--shadow-pop` | `box-shadow` |
| `--space-1` | `padding`, `width` |
| `--space-2` | `padding` |
| `--space-3` | `gap`, `padding` |
| `--space-5` | `min-height`, `width` |
| `--steel` | `color` |
| `--surface` | `background` |
| `--text-sm` | `font-size` |
| `--text-xs` | `font-size` |

<!-- /ds:tokens -->

The popover of `ActionMenu` also carries the global `popover` class. `--trigger-width` is not a token from
`packages/tokens`: React Aria sets it on the popover to the width of the trigger.

<!-- ds:tokens apps/web/src/app.css .popover -->

| Token | Read by |
| --- | --- |
| `--border` | `border` |
| `--radius` | `border-radius` |
| `--row-h` | `max-height` |
| `--shadow-pop` | `box-shadow` |
| `--surface` | `background` |
| `--trigger-width` | `width` |

<!-- /ds:tokens -->

The triggers carry the global `btn` classes. Their tokens are on the [Button](button.md#tokens-it-reads) page.
