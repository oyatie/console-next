<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Record actions

Record actions are the controls of one fact or one row of a record: `RowActions` is its edit and an overflow menu
with its history and the verb that ends it, `ListAdd` is the one add of a list, and `PathNote` is the line that
says how a change will be recorded.

All three live in `apps/web/src/ui/record-actions/record-actions.tsx`, with `record-actions.module.css`. The module
also exports the type `ChangePath`.

`RowActions` and `ListAdd` are built from three other components: [`Button`](button.md),
[`DisabledReason`](disabled-reason.md) and `MenuButton` ([Menu](menu.md)).

## When to use it, and when not

| Component | Use it for |
|---|---|
| `RowActions` | The actions that sit on the value they act on: the edit of a fact or of a row, then a menu with its history and one verb that ends it (delete, void or clear). The name of every control carries the fact, so two rows never share a name. |
| `ListAdd` | The add of a list, in the list's head. |
| `PathNote` | One line, shown before a commit, that says whether the change applies now or waits, and how it is kept. Callers put it in the `consequence` slot of a `Sheet` or a `Composer`, in the foot of a row editor, or in a dialog. |

| Do not use it for | Use instead |
|---|---|
| The commit of a form, a step or a page | `ActionBar`: see [Action bar](action-bar.md). |
| A command that is not on a row or a fact | `Button`: see [Button](button.md). |
| A menu of other commands | `MenuButton` or `ActionMenu`: see [Menu](menu.md). The menu of `RowActions` holds the history and one end verb, nothing else. |
| The edit mark of a personnel record's fact, with its class said beside it | `FieldMark`: see [Record](record.md). |
| A blocked command that is not a row's edit or a list's add | `DisabledReason`: see [Disabled reason](disabled-reason.md). |
| What a commit did, once it has run | `Receipt`: see [Receipt](receipt.md). `PathNote` speaks before the commit. |

## Anatomy

`RowActions`:

| Part | Element | Holds |
|---|---|---|
| Root | `<span>` | The edit, then the menu. It is rendered even when it holds neither. |
| Edit | `<button type="button">`, a ghost `Button` of size `sm` | The verb. Rendered when `onEdit` is given. Its `aria-label` is the message `uiRecordActions.of`, filled with `field` and the verb. With `path`, its `title` is that path's sentence. |
| Blocked edit | `DisabledReason` with `layout="inline"` | Takes the place of the edit when `why` is given as well: the same button, inert, then `why` as visible text beside it. It has no `title`, and `onEdit` is not attached. |
| Menu | `MenuButton` with an icon and no caret | A 14 px horizontal-dots icon, marked `aria-hidden`. Rendered when `history` or `end` is given. Its name is the message `uiRecordActions.more`, filled with `field`. |

The verb comes from `edit`:

| `edit` | Message id of the verb | For |
|---|---|---|
| `edit` (default) | `uiRecordActions.edit` | A fact or a row that has a value. |
| `add` | `uiRecordActions.add` | A list item. |
| `enter` | `composer.verb.enter` | A fact's first value. |
| `correct` | `uiRecordVerbs.verb.correct` | A fact that never changes freely. |

The menu holds up to two entries, in this order:

| Entry | Present when | Label | A press calls |
|---|---|---|---|
| History | `history` is given | A 14 px history icon, marked `aria-hidden`, then the message `uiRecordActions.history`. | `history` |
| End | `end` is given | The message `uiRecordActions.end.{verb}`. | `end.onPress` |

`end` is `{ verb: "delete" | "void" | "clear"; onPress: () => void; why?: ReactNode }`. The type is not exported.
With `end.why` the entry stays in the menu, cannot be pressed, and shows `why` under its label: that is the
unavailable entry of `MenuButton`.

`why` on `RowActions` blocks the edit only. The menu is not affected.

When the edit is blocked, the reason sits between the edit and the menu, because `DisabledReason` renders it
straight after the button.

`ListAdd`:

| Part | Element | Holds |
|---|---|---|
| Button | `<button type="button">`, a ghost `Button` of size `sm` | The message `uiRecordActions.addOf`, filled with `object`. A press calls `onAdd`. |
| Blocked button | `DisabledReason` with `layout="inline"` | Takes its place when `why` is given: the same button, inert, then `why` beside it. `onAdd` is not attached. |

`ListAdd` renders the button and nothing else. The title and the count of the list are the caller's.

`PathNote`:

| Part | Element | Holds |
|---|---|---|
| Root | `<span data-k id>` | A 12 px icon, marked `aria-hidden`, then the message `uiRecordActions.path.{path}`. `data-k` is `path`. `id` is the caller's, so that a control can point `aria-describedby` at the line. |

`ChangePath` is `"setup" | "revision" | "correction" | "approval" | "second" | "stepUp"`:

| `path` | The change | Icon |
|---|---|---|
| `setup` | Applies at once, in the setup phase. | Zap |
| `revision` | Applies at once, as a dated revision. | Clock |
| `correction` | Applies at once, as a correction record. | Stamp |
| `approval` | Waits for the approval route. | Shield with a check |
| `second` | Waits for a second person. | User with a check |
| `stepUp` | Waits for the actor's passkey. | Shield with a check |

`approval` and `stepUp` share an icon. The sentence tells them apart.

None of the three passes other attributes through.

## Looks and sizes

There are no sizes and no variants.

| Part | Look |
|---|---|
| `RowActions` root | An inline row, 4 px gaps (`--space-1`), items centred. No wrapping rule. |
| Edit, and the `ListAdd` button | The ghost `sm` look of [`Button`](button.md): at least 32 px high (`--target`), 8 px side padding (`--space-2`), 13 px text (`--text-sm`) of weight 600, no visible border and no fill. |
| Blocked edit or add | The inert look of a ghost `Button` under [Disabled reason](disabled-reason.md): `--muted` fill, `--border` border, `--steel` text, half opacity, a not-allowed cursor. The label never wraps. |
| Reason | 13 px `--steel` text beside the button, 12 px away (`--space-3`). |
| Menu trigger | The icon-only trigger of `MenuButton`: see [Menu](menu.md). Outside a table cell it has the bordered `secondary` look and is at least 36 px high, beside a 32 px edit with no border. Inside a `<td>` it is 24 px wide, at least 24 px high, with no visible border or fill. |
| `PathNote` | An inline row with a 4 px gap. 12 px text (`--text-xs`). `--steel` for `setup`, `revision` and `correction`; `--ink` for `approval`, `second` and `stepUp`, the three that wait. |

The module's stylesheet has two rules of its own, for the root of `RowActions` and for `PathNote`. Every other
look comes from the three components named above.

The padding of the menu trigger outside a table cell is a tie between two stylesheets, described on the
[Menu](menu.md) page. This page did not check it in a build either.

## States

| State | What happens |
|---|---|
| Rest | The looks above. |
| Hover | The edit, the add and the menu trigger take a `--muted` fill, from the hover rule of `btn`. A blocked button does not change. `PathNote` has no hover look. With `path`, the browser shows the path sentence as a tooltip over the edit. |
| Keyboard focus | The global rule on each button: a 2 px `--primary` outline, 2 px away. The module has no focus rule. |
| Pressed | No look. |
| Open menu | No look on the trigger. The items are on the [Menu](menu.md) page. |
| Selected | Does not exist. |
| Disabled | The blocked edit and the blocked add: `aria-disabled="true"`, still focusable, described by the reason, and a press does nothing. The native `disabled` attribute is never set. An end verb with `why` is an unavailable menu entry. |
| Read-only | Does not exist as a prop. A caller that may not edit leaves the component out. Without `onEdit` there is no edit; a void row in the people card keeps only its history this way. |
| Invalid | Does not exist. |
| Loading | Does not exist. No prop marks an action as pending. |
| Empty | With no `onEdit`, no `history` and no `end`, `RowActions` is an empty `<span>`. |

## Keyboard

| Key | Where | What it does |
|---|---|---|
| Tab, Shift+Tab | | Reaches the edit, then the menu trigger. A blocked button stays in the tab order. |
| Enter, Space | Edit, add | Presses it: `onEdit` or `onAdd` runs. Native. |
| Enter, Space | Blocked edit or add | Nothing. The inert click handler runs in place of the caller's. |
| Enter, Space, ArrowDown, ArrowUp | Menu trigger | Opens the menu. See [Menu](menu.md#keyboard). |
| ArrowDown, ArrowUp, Home, End | Open menu | Moves between entries. An unavailable entry is skipped. |
| Enter, Space | Open menu | Runs the entry, `history` or `end.onPress`, and closes the menu. |
| Escape | Open menu | Closes the menu. Focus returns to the trigger. |

The path tooltip is a `title`. Keyboard focus does not show it.

`PathNote` takes no focus.

The module handles no key and takes no text. A search of the folder for a key handler, `isComposing`, key code 229
and composition events finds none, so there is no rule of its own for a key the Korean input method owns. The menu
keys are React Aria's; what they do while an input method is composing is on the [Menu](menu.md#keyboard) page.

## Accessibility contract

| Part | Role | Accessible name | Also exposed |
|---|---|---|---|
| Edit | `button` | `aria-label`: the message `uiRecordActions.of`, filled with `field` and the verb. It replaces the visible verb. | With `path`: the path sentence, as the `title` attribute. |
| Blocked edit | `button` | The same. | `aria-disabled="true"`. `why` is its description, through `aria-describedby`. No `title`. |
| Menu trigger | `button` | `aria-label`: the message `uiRecordActions.more`, filled with `field`. | `aria-haspopup` and `aria-expanded`, from React Aria. |
| Menu | `menu` | The same as the trigger. | |
| Menu entry | `menuitem` | Its text. | `aria-disabled="true"` and the reason in its content, for an end with `why`. |
| `ListAdd` button | `button` | Its text: the message `uiRecordActions.addOf`, filled with `object`. | When blocked: `aria-disabled="true"`, described by `why`. |
| `PathNote` | None | None | Its text. The icon is hidden. |

Announced: nothing. No part is a live region. A reason is read as the description of its button when the button
takes focus.

Known gaps:

- `path` on `RowActions` is a `title` attribute and nothing else. It is not visible text. A pointer shows it as a
  tooltip; keyboard focus and touch do not. `PathNote` is the visible form of the same sentence, and the caller
  has to place it.
- `path` is dropped when the edit is blocked.
- An end verb runs `end.onPress` straight from the menu. `RowActions` asks for no confirmation, and delete, void
  and clear look the same as History: `MenuButton` has no danger look. A confirmation is the caller's.
- Outside a table cell the menu trigger is bordered and at least 36 px high, and the edit beside it is 32 px with
  no border.
- The verbs for `enter` and `correct` are read from two ids outside this component's own: `composer.verb.enter`
  and `uiRecordVerbs.verb.correct`.
- `RowActions` with nothing to show still renders an empty `<span>`.

The WCAG 2.2 criteria that apply:

| Criterion | How the components answer it |
|---|---|
| 1.3.1 Info and Relationships | A reason is tied to its button with `aria-describedby`. The path sentence is tied to the edit only as a `title`. |
| 1.4.1 Use of Color | A blocked button is `aria-disabled` and has its reason in words. The two colours of `PathNote` repeat what its sentence says. |
| 1.4.3 Contrast (Minimum) | `PathNote` is 12 px `--steel` or `--ink` text on the surface behind it; it has no fill of its own. A blocked button is exempt; its reason is not. |
| 1.4.13 Content on Hover or Focus | The path tooltip is the browser's own, which the criterion leaves out. It is still out of reach for keyboard and touch: see the first gap. |
| 2.1.1 Keyboard | Every control is a native button or a React Aria menu. |
| 2.4.6 Headings and Labels | Every name carries the fact or the list, so the controls of two rows differ. |
| 2.4.7 Focus Visible | The global outline on the buttons. The menu entries are on the [Menu](menu.md) page. |
| 2.5.3 Label in Name | The name of the edit is built from its visible verb and the field. |
| 2.5.8 Target Size (Minimum) | The edit and the add are at least 32 px high. The menu trigger is at least 36 px high, or 24 px by 24 px inside a table cell, which is the minimum. |
| 3.3.4 Error Prevention (Legal, Financial, Data) | Left to the caller: the component neither confirms nor undoes an end verb. |
| 4.1.2 Name, Role, Value | The table above. |
| 4.1.3 Status Messages | Not answered: nothing is announced. |

What the gallery shows, in `apps/web/src/ui/record-actions/record-actions.gallery.tsx`: a `RowActions` with a
`path`, a history and a clear; a `ListAdd`; a blocked `RowActions` with its reason and a history; and one
`PathNote` for each of the six paths. It does not show `edit` set to `add`, `enter` or `correct`, an end verb with
`why`, a blocked `ListAdd`, or a `RowActions` with no `onEdit`.

`record-actions.test.tsx` has three tests, all on static markup:

- the edit carries the field in its `aria-label` and the path sentence as its `title`, and the menu trigger's name
  carries the field;
- a blocked edit is `aria-disabled="true"`, has no `disabled` attribute, and its reason is in the markup;
- there is no menu trigger without `history` or `end`, the text of `ListAdd` names its object, and `PathNote` says
  its sentence for `setup` and for `correction`.

No test in the folder opens the menu or presses anything. Browser specs reach the components through the screens:
`e2e/states/entity-fields.spec.ts` finds edits by their names and opens the menu to run a clear, and
`e2e/states/person-record-refusals.spec.ts` presses a list's add.

A search of the feature views found six call sites of `RowActions`, three of `ListAdd` and four of `PathNote`.
None of them passes `end.why`, and none passes `id` to `PathNote`.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component). That scan does not open the menu.

## Phone behaviour at 390 px

Nothing in `record-actions.module.css` changes with the width of the screen. It has no media query and no
container query.

- The root of `RowActions` is one inline row with no wrapping rule: the edit, the reason when there is one, and
  the menu trigger stay on one line.
- A blocked button never wraps its label, and the reason beside it gets what is left. See the phone section of
  [Disabled reason](disabled-reason.md).
- The path tooltip does not show on a touch screen.
- Targets are the same size as on a wide screen: 32 px for the edit and the add, 36 px for the menu trigger, or
  24 px in a table cell. Nothing reads `--target-touch`.
- `PathNote` has no wrapping rule of its own. It is an inline row holding one run of text.

## Copy rules

The built-in text is in the `uiRecordActions.` ids of `packages/i18n`, and in two ids outside them. The `en`
catalog is the source and the `ko` catalog defines every id.

| Message id | Used for |
|---|---|
| `uiRecordActions.edit`, `uiRecordActions.add` | The verb on the edit, for `edit` and `add`. |
| `composer.verb.enter` | The verb for `enter`. |
| `uiRecordVerbs.verb.correct` | The verb for `correct`. |
| `uiRecordActions.of` | The accessible name of the edit. It takes the field and the verb. |
| `uiRecordActions.more` | The name of the menu trigger and of the menu. It takes the field. |
| `uiRecordActions.history` | The history entry. |
| `uiRecordActions.end.delete`, `uiRecordActions.end.void`, `uiRecordActions.end.clear` | The end entry. |
| `uiRecordActions.addOf` | The text of `ListAdd`. It takes the object. |
| `uiRecordActions.path.setup`, `.revision`, `.correction`, `.approval`, `.second`, `.stepUp` | The sentence of `PathNote`, and the `title` of the edit. |

- `field` is the value's label as its row shows it, as plain text. `object` is the name of the list's item. Both
  come from the caller.
- `why` is the caller's: why the edit cannot be used now, and how to unblock it. It is the button's whole
  description, so it has to make sense read after the button's name.
- One verb for each action. The visible text of the edit is the verb alone; the field is in the name.
- Feature views also read these ids directly, for a button or a dialog title of their own. Changing a message
  changes those too.
- The gallery's sample text is in the gallery catalog, which production builds leave out.

## Props

<!-- ds:props apps/web/src/ui/record-actions/record-actions.tsx -->

### ListAdd

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `object` | yes | `string` |  |  |
| `onAdd` | yes | `() => void` |  |  |
| `why` | no | `ReactNode` |  |  |

### PathNote

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `path` | yes | `ChangePath` |  |  |
| `id` | no | `string` |  |  |

### RowActions

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `field` | yes | `string` |  | The value's label as its row shows it. |
| `edit` | no | `"add" \| "correct" \| "edit" \| "enter"` | `"edit"` | `add` for a list item; `enter` for a fact's first value; `correct` for a fact that never changes freely. |
| `end` | no | `RowEnd` |  |  |
| `history` | no | `() => void` |  |  |
| `onEdit` | no | `() => void` |  |  |
| `path` | no | `ChangePath` |  |  |
| `why` | no | `ReactNode` |  | The edit cannot be used now: why and how to unblock, beside it (never a tooltip). |

<!-- /ds:props -->

`ChangePath` and the type of `end` are under Anatomy.

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/record-actions/record-actions.module.css -->

| Token | Read by |
| --- | --- |
| `--ink` | `color` |
| `--space-1` | `gap` |
| `--steel` | `color` |
| `--text-xs` | `font-size` |

<!-- /ds:tokens -->

The table lists the module's own two rules. The looks of the buttons, the blocked state and the menu come from
`app.css`, `ui/disabled-reason` and `ui/menu`: see their pages.
