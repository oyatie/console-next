<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Composer

A composer is the frame of one governed change: the caller's fields, then a preview of what the change will do,
then one commit button whose label is built from the action, in a side sheet, on a page of its own or inside
another view.

It lives in `apps/web/src/ui/composer`:

| File | What it holds |
|---|---|
| `composer.tsx` | `Composer`, the component. |
| `actions.ts` | `commitLabel` and `verbLabel`, which build the label of a commit from the message catalog, and the type `ActionDescription`. |
| `routing.tsx` | `RoutingPreview`, which shows the server's answer on approval, and the type `ComposerRouting`. |
| `receipt-reference.tsx` | `ReceiptReference`, the number of a recorded action with a button that copies it. |
| `composer.module.css` | The styles. |

The composer draws the frame and nothing behind it. The request, the refusal and the recovery stay with the
caller.

## When to use it, and when not

Use a composer for a change to records that has a named action: a transfer, a department rename, an exit. It
gives every such change the same order (fields, preview, commit) and the same answers to a blocked, pending,
locked or refused commit.

`layout` picks where it sits:

| `layout` | Use it for |
|---|---|
| `drawer` (default) | A change made beside the record it applies to. It renders a [Sheet](sheet.md). |
| `page` | A change that is a page of its own, such as a bulk change. It renders the page head and a foot that stays at the bottom. |
| `inline` | A change inside a card or a section of another view. |

| Do not use it for | Use instead |
|---|---|
| A side sheet with fields and one stated consequence, and no action frame | `Sheet`: see [Sheet](sheet.md). |
| A confirmation or a short question | `Dialog`: see [Dialog](dialog.md). |
| Only the foot of a form the view lays out itself | `ActionBar`: see [Action bar](action-bar.md). |
| A form that must leave the view beside it usable | `DockSheet` (`ui/dock-sheet`). |
| What the commit did, once it has run | `Receipt`: see [Receipt](receipt.md). `ReceiptReference` goes inside it. |
| The text of a refusal | The composer does not write it. The caller passes it as `notice`; many pass `CommandError` (`lib/react/command-error`). |

## Anatomy

The same parts appear in every layout. What differs is the element around them.

| Part | Drawer | Page | Inline |
|---|---|---|---|
| Root | A `Sheet`: `<section role="dialog">` | `<section data-composer-root>`, named by the title | `<section data-composer-root>`, with no name |
| Kicker | The sheet's kicker | `crumbs` of `PageHead` (`ui/page-head`) | First in a `<header>` |
| Title | The sheet's `<h2>` | The title of `PageHead`: an `<h1>`, or an `<h2>` where the page scope says so | A heading at `headingLevel`: `<h2>` by default |
| Subtitle | The sheet's subtitle | `sub` of `PageHead` | A `<div>` after the title |
| Tools | Not used | `tools` of `PageHead` | Not used |
| Body | The sheet's body | A `<div>` | A `<div>` |
| Foot | The sheet's foot | `<footer>`, sticky | `<footer>` |
| Close | The sheet's close button | A ghost button, last of the actions | The same |

Inside the body, top to bottom:

| Part | Element | Holds |
|---|---|---|
| Form | `<form class="form" novalidate>` when `onSubmit` is given, otherwise `<div class="form">` | `children`, then the preview sections. The `<form>` has the id `formId`, or a generated one. The `<div>` has no id. |
| Preview section | `<section data-composer-section="<name>">`, named by its heading | A heading, then the caller's content for that name. |
| Section heading | `<h2>` in the page layout. Elsewhere one level under `headingLevel`: `<h3>` by default. | Message `composer.section.<name>`. |
| Sign-offs | `Checks` (`ui/choice`), inside the `preflight` section, after the caller's content | One checkbox for each statement in `signoffs.items`. Left out when the list is empty. |

The preview has eight sections, always in this order, whatever order the caller writes them in: `preflight`,
`effects`, `approvals`, `documents`, `deadlines`, `tasks`, `access`, `payroll`. A section whose content is
`null`, `undefined`, `false`, an empty string or an empty array is left out, heading and all. One exception:
when `signoffs.items` is not empty, `preflight` is always drawn, with its heading and the sign-offs, whatever the
caller passes for it. Three props feed them:

- `sections` gives content by name.
- `consequence` is the content of `effects` when `sections.effects` is `null` or not given. In the drawer it does
  not go to the consequence row of the sheet.
- `routing` takes over `approvals`: see below.

In the foot, top to bottom:

| Part | Element | Holds |
|---|---|---|
| Notice | The caller's node | `notice`: what the server said. |
| Unrouted line | `<div>` | Shown when `routing` says the change is not routed. In the drawer it sits in the consequence row of the sheet. |
| Actions | `<div>` | In order: the commit, the missing line, `secondary`, the draft button, the close button. |

The actions, in order:

| Part | Element | Shown when |
|---|---|---|
| Commit | `<button type="submit" form="<form id>">`: the label from `action`, then a `Kbd` (see [Kbd](kbd.md)) with the OS-aware shortcut hint (`⌘↵` on Apple platforms, `Ctrl+↵` elsewhere) | `onSubmit` is given and the commit is not blocked. Its id is `commitId`. |
| Blocked commit | `DisabledReason` around a `<button type="button">` with the same label and no `Kbd`: see [DisabledReason](disabled-reason.md) | `blocked` is given and the server has not refused permission. It is shown with or without `onSubmit`. |
| Missing line | `<span role="status">` with message `composer.missing` | `missing` is more than zero. |
| Secondary | The caller's node | `secondary` is given. |
| Draft button | `<button>` with message `composer.saveDraft`, or the label of `draftAction` | `onSaveDraft` is given. |
| Close button | `<button class="btn btn--ghost">` with message `composer.dismiss` | `onClose` is given, in the page and inline layouts only. |

`recovery` replaces all of these. When it is given, the actions row holds `recovery` and nothing else.

### Routing

`routing` is the server's answer on whether the change goes through approval. It has two forms.

| `routing` | What is drawn |
|---|---|
| `{ routed: true, steps }` | The `approvals` section holds a `ChainStepper` (`ui/chain-stepper`) of the steps. Whatever the caller put in `sections.approvals` is dropped. |
| `{ routed: false, why }` | No `approvals` section, also when the caller passed one. The unrouted line appears in the foot, above the commit: message `composer.routing.immediate`, then a `<details>` whose `<summary>` is message `uiBlocker.reason` and whose content is `why`. |
| not given | `sections.approvals` is drawn as the caller passed it. |

On this branch no feature passes `routing`: a search of `apps/web/src` for `routing=` finds it in the composer's
own gallery entry and unit test only. A feature that shows a route passes its own content as
`sections.approvals`; `features/org/ui/dept-name-composer.tsx` is one.

### The commit label

Callers do not write the label of the commit. They pass `action`, an `ActionDescription`:
`{ kind, mode, count?, continuation? }`. `commitLabel` turns it into text:

- `kind` picks a noun and a unit from a table of 47 kinds in `actions.ts`. `mode` picks one of 19 verbs.
- The label is message `composer.commit`, filled with the noun and the verb.
- With a `count` above zero it is message `composer.commit.count`, which adds the count and the unit: message
  `composer.unit.people` or `composer.unit.units`.
- Two kinds, `entityRecord` and `certificate`, have no noun. Their label is the verb alone.
- `continuation: "next"` wraps the result in message `composer.commit.next`.

`verbLabel(mode)` returns the verb alone, for a caller that needs it in a field label.

### ReceiptReference

`ReceiptReference` is one `<span>`: message `composer.receipt.reference`, a middle dot, the value in a `<code>`,
then a ghost button with message `composer.receipt.copy`. The button writes the value to the clipboard as it is.
With an empty `value` it renders nothing.

Most callers put it in a `Receipt`: in its `meta` (`features/people/ui/bulk-page.tsx`) or among its `actions`
(`reference/org/ui/change-receipt.tsx`). `features/account/ui/privacy-receipt.tsx` shows it on its own.

## Looks and sizes

| Prop | Values | What it changes |
|---|---|---|
| `layout` | `drawer` (default), `page`, `inline` | The frame, as in Anatomy. |
| `size` | `md` (default), `lg` | The width of the sheet. Drawer only: see [Sheet](sheet.md). |
| `tone` | `primary` (default), `danger` | The look of the commit: see [Button](button.md). |
| `draftTone` | `secondary` (default), `primary` | The look of the draft button. |
| `headingLevel` | `2` (default), `3`, `4` | The level of the inline title. In the drawer and inline layouts the section headings are one level below this value. The title of the drawer does not follow it: it is always the sheet's `<h2>`. The page layout ignores it. |

| Part | Look |
|---|---|
| Root, page and inline | A column with a 24 px gap (`--space-5`). |
| Root, page | At least `calc(100dvh - var(--frame-top) - var(--frame-bottom))` high: the visible viewport less 48 px. The foot is pushed to the bottom of it. |
| Inline header | A column with an 8 px gap (`--space-2`). The title is 13 px (`--text-sm`), weight 700 (`--fw-strong`), with no margin. |
| Body | The global `form` class: a column with a 12 px gap (`--space-3`). |
| Preview section | A column with a 12 px gap, 16 px of padding above (`--space-4`) and a 1 px `--border` line on top. Its heading is 13 px, weight 700, with no margin. |
| Page foot | Sticky at the bottom. A column with a 12 px gap, 16 px of padding, a 1 px `--border` line above and a `--canvas` fill. |
| Inline foot | A column with a 12 px gap. Not sticky, no fill, no line. |
| Actions, drawer and inline | A row that wraps, aligned to the end, with an 8 px gap. Its first child takes a whole row. |
| Actions, page | A row that wraps, aligned to the end and to the bottom, with an 8 px gap. Its first child is `min(100%, var(--panel-w))` wide: 440 px, or the whole row when the row is narrower. |
| Commit | As wide as the space its row gives it. |
| Unrouted line | A column with an 8 px gap. |
| Inert body, inert `secondary` | Half opacity. The value is the literal `0.5`. |

So in the drawer and inline layouts the commit is a full-width button on a row of its own, and the other actions
sit on the row under it. In the page layout the commit is 440 px wide and the other actions sit beside it.

Three things about these rules:

- The first-child rule is on whatever comes first. With `recovery`, the first element of `recovery` takes that
  width.
- A blocked commit is wrapped in the `<span>` of `DisabledReason`, which stacks the button above its reason. In
  the page layout the composer reverses that stack, so the reason sits above the button and the button stays
  where the live commit would be. `composer.browser.test.tsx` checks that the commit and the close button do not
  move when a block resolves, at 390 and 1440 px.
- The same test checks, in the page and inline layouts at both widths, that the two buttons do not move when the
  label of the commit changes length.

No prop picks a visual style. The stylesheet has no transition.

## States

| State | What changes |
|---|---|
| Closed (`open={false}`) | Nothing is rendered, and the key chord is not listened for. Any other value of `open` draws the composer. |
| Rest | The commit is a primary button, or a danger button with `tone="danger"`. |
| Hover, focus, pressed | The composer's stylesheet has no rule for them. Its buttons take the looks on the [Button](button.md) page, and the global focus outline. |
| Selected | Does not exist. |
| Incomplete (`incomplete`) | The commit gets `aria-disabled="true"`. A primary commit takes the look `app.css` gives that: a dashed `--primary` border, `--primary-soft` fill and `--primary` text in `baseline`, and a solid `--border` border, `--muted` fill and `--steel` text in non-baseline experiences. A danger commit is drawn at half opacity. Both show a not-allowed cursor. The button is not disabled: a press, the key chord and Enter in a field still submit, and `onSubmit` still runs. |
| Blocked (`blocked`) | The commit is replaced by the blocked commit, with `blocked.reason` and then `blocked.remedy` as its reason. A press does nothing, unless `blocked.press` is given: then a press runs it, as long as the composer is not pending, loading or locked. A submit that still reaches the form is dropped. |
| Missing (`missing` above zero) | The missing line appears after the commit, with the count. |
| Invalid | The composer has no invalid look, and neither the browser nor the shared form checks the fields on submit. The `<form>` has `novalidate`, which turns the browser's check off. The shared `Form` (`ui/button`) skips its own validity check and its error summary when it is given `noValidate`, as it is here. So `required` and the other native constraints do not stop a submit: the caller validates in `onSubmit` and returns `false`. Focus then moves on the next frame to the first element in the form that has `aria-invalid="true"` or is an `input` inside an element with `data-invalid`. With `signoffs.missing`, the sign-offs show message `composer.signoffs.missing`. |
| Pending (`pending`) | The commit, the draft button and the close button are disabled, and so are the sign-offs. The body is `inert` at half opacity in all three layouts. In the drawer the sheet is pending, which also makes its whole actions row `inert`: see [Sheet](sheet.md). In the page and inline layouts `secondary` is left as the caller made it. |
| Loading (`loading`) | The commit is disabled. In the drawer the sheet shows its placeholder in place of the body. In the page and inline layouts nothing else changes: the body is drawn and can be edited. |
| Locked, read-only (`locked`) | The commit and the draft button are disabled, and so are the sign-offs. The body is `inert` at half opacity. The close button and `secondary` still work. |
| Refused (`error` with `status` 403) | Everything `locked` does, without the caller setting `locked`. In addition a blocked commit gives way to the disabled commit, when `onSubmit` is given, and `secondary` is wrapped in an `inert` `<div>` at half opacity. The close button still works. An `error` with any other status changes nothing. |
| Recovery (`recovery`) | The actions are replaced by `recovery`. A submit that reaches the form is dropped. |
| Dirty (`dirty`) | Drawer only: it is passed to the sheet when given. The page and inline layouts ignore it, and their close button asks nothing before it calls `onClose`. |
| Disabled | Does not exist for the composer as a whole. Pending and locked are the ways it stops taking input. |
| Empty | Does not exist. `children` is required, and an empty preview section is left out. |

The refused state is for a permission the server took away after the form opened. The composer locks itself; the
caller renders the refusal in `notice`.

A submit is dropped, without calling `onSubmit`, in five cases: pending, loading, locked (or refused), blocked,
and recovery.

`composer.browser.test.tsx` checks in a browser, in all three layouts, that a 403 disables the commit, keeps the
typed value in a field that is now inert and at half opacity, disables the draft button, makes `secondary` inert
and leaves the close button enabled. In the inline layout it checks that a 409 or a 422 leaves the form
editable, and that an explicit `locked` leaves `secondary` usable and in the row of the commit.

## Keyboard

| Key | What it does |
|---|---|
| Command+Enter or Control+Enter | Presses the commit, from anywhere inside the composer. |
| The same chord with Shift | Nothing. The composer ignores it, so a caller can bind it. `features/people/ui/register-sheet.tsx` binds it to a second commit. |
| Enter in a single-line field | The browser's own submission of the form. The composer adds no handling. |
| Enter or Space on the reason summary | Opens and closes the reason of the unrouted line. It is a native `<details>`. The browser test opens it with Enter. |
| Tab, Shift+Tab | The order of the document: the fields, the preview, then the foot. In the drawer the sheet's close button comes before them. An `inert` body is skipped. |
| Escape | In the drawer, the sheet's rules: see [Sheet](sheet.md). In the page and inline layouts, nothing. |

How the chord works:

- The composer listens for `keydown` on the window while it is not closed.
- It acts when the key is Enter, Command or Control is held, Shift is not, and focus is inside the composer: inside
  the dialog in the drawer, inside the root `<section>` otherwise. Focus in the foot counts.
- It then cancels the key and clicks the commit.
- A commit that is disabled by `pending`, `loading` or `locked` does not react to that click.
- On a blocked commit the click does what a press does: nothing, or `blocked.press`.
- With `recovery` there is no commit, and the key is cancelled and nothing else happens.
- Without `onSubmit` there is no form to find, and the chord is not handled at all.

**The Korean input method.** The chord is not handled while a syllable is being composed. The handler returns
when the event's `isComposing` flag is set, and also when its key code is 229, which covers a key that ends a
composition with the flag already off. It listens for no composition event. `composer.browser.test.tsx` sends
such a key to a text area between a composition start and end and checks that nothing is committed, and that the
chord commits once the composition has ended.

A plain Enter has no such check in the composer, because the composer does not handle it. Whether an Enter that
ends a composition also submits the form is the browser's to decide.

The hint in the commit uses `modChord("↵")` from `apps/web/src/lib/pure/keys.ts`: it renders `⌘↵` on Apple
platforms (Mac, iPhone, iPad, iPod, iOS) and `Ctrl+↵` on Windows, Linux, and during SSR. The blocked commit has no
hint although the chord still reaches it.

## Accessibility contract

| Part | Role | Accessible name | Also exposed |
|---|---|---|---|
| Root, drawer | `dialog`, from the sheet | `title` | See [Sheet](sheet.md). |
| Root, page | `region` | `title`, through `aria-labelledby` | |
| Root, inline | None | None. The `<section>` has no name. | |
| Preview section | `region` | Its heading, through `aria-labelledby` | |
| Commit | `button` | The label from `action`. The `Kbd` is `aria-hidden` and is not part of the name. | `aria-disabled="true"` when `incomplete`. `disabled` when pending, loading or locked. |
| Blocked commit | `button` | The same label | `aria-disabled="true"`, and `aria-describedby` pointing at the reason. It stays in the tab order. |
| Missing line | `status` | None. Its text is its content. | |
| Sign-offs | `group`, from `Checks` | Its label, message `composer.signoffs` | See [Choice](choice.md). Disabled while pending or locked. With `signoffs.missing`, its error is message `composer.signoffs.missing`. |
| Routed steps | A list, from `ChainStepper` | Message `uiChainStepper.label` | |
| Reason of the unrouted line | A native disclosure | Message `uiBlocker.reason` | |
| Draft button | `button` | Message `composer.saveDraft`, or the label of `draftAction` | With `localDraft`, a `title` with message `composer.draftHint`. |
| Close button | `button` | Message `composer.dismiss` | `disabled` while pending. |
| Copy button of `ReceiptReference` | `button` | Message `composer.receipt.copy` | |

- **Headings:** in the inline layout the section headings are one level under the title, and the caller sets
  `headingLevel` to fit the view around it. `composer.test.tsx` checks the levels of an inline composer at
  level 3. In the drawer the title is always the sheet's `<h2>`, and `headingLevel` moves only the section
  headings: `<h3>` at the default, `<h4>` at 3, `<h5>` at 4. Any value but the default leaves a gap between the
  title and the sections. A search of `apps/web/src` for `headingLevel` finds no feature that gives a drawer a
  value other than 2; `composer.browser.test.tsx` renders a drawer at 3. In the page layout the section headings
  are always `<h2>`. That is one level under the title when `PageHead` draws it as `<h1>`, and the same level as
  the title where the page scope makes it `<h2>`.
- **Inert parts:** the controls of an inert body, and of an inert `secondary`, cannot be focused or read.
- **Announced:** the missing line is a status region. It is added already holding its text; the composer does not
  keep an empty region to fill later. `ReceiptReference` speaks through the shell's one polite live region:
  message `composer.receipt.copied` after a copy, message `common.copyFailed` when the copy fails. The composer
  announces nothing else. A refusal is announced by what the caller puts in `notice`.
- **Focus:** the composer moves focus in one case, to the first invalid field after `onSubmit` returns `false`.
  The focus moves that `composer.browser.test.tsx` checks after a refusal are made by `CommandError`, which that
  test passes as `notice`. They are not the composer's.

The WCAG 2.2 criteria that apply:

| Criterion | How the composer answers it |
|---|---|
| 1.3.1 Info and Relationships | The title and each preview section are headings, and each section is a named region. |
| 1.4.3 Contrast (Minimum), 1.4.11 Non-text Contrast | Every colour in the stylesheet is a token. An inert body is drawn at half opacity. |
| 1.4.10 Reflow | The actions wrap, and the commit takes a row of its own when the space is narrow. |
| 2.1.1 Keyboard | Every action is a button. The chord presses the commit without leaving the field. |
| 2.1.4 Character Key Shortcuts | The one shortcut needs Command or Control, so it is not a single-character shortcut. |
| 2.4.3 Focus Order | The fields come first, then the preview, then the notice and the actions. |
| 2.4.6 Headings and Labels | Section headings are fixed messages. The commit says what it does: the verb, the noun and the count. |
| 2.4.7 Focus Visible | The global 2 px outline on every button and field. |
| 2.4.11 Focus Not Obscured (Minimum) | In the page layout the foot is sticky over the bottom of the scrolling page. See the gaps. |
| 2.5.8 Target Size (Minimum) | Its buttons are at least 36 px high: see [Button](button.md). |
| 3.3.1 Error Identification | The missing line gives the count, and the sign-offs say when one is missing. Errors of the fields are the caller's. |
| 3.3.4 Error Prevention (Legal, Financial, Data) | The preview states what the change will do before the commit, and sign-offs must be ticked one by one. |
| 4.1.2 Name, Role, Value | The table above. |
| 4.1.3 Status Messages | The missing line, with the limit stated above. |

Known gaps:

- The key chord is not exposed to assistive technology. Its hint is `aria-hidden`, and the commit has no
  `aria-keyshortcuts`.
- An `incomplete` commit says it is disabled and still acts.
- The root of an inline composer has no accessible name.
- In the drawer, a `headingLevel` of 3 or 4 skips a heading level between the title and the sections.
- In the page and inline layouts `loading` shows no placeholder and leaves the body editable, and `dirty` is
  ignored.
- The sticky foot of the page layout can cover what scrolls under it. Nothing was found that reserves room for
  it: there is no `scroll-padding` or `scroll-margin` in `app.css`, in the composer's styles or under `ui/page`.
  The status dock's stylesheet sets a `scroll-padding-bottom` on `#main` while the dock is mounted; it is sized
  for the dock, not for the foot. This page did not check in a browser whether a focused field can end up wholly
  under the foot.
- The page foot does not register with the status dock. A sticky `ActionBar` does, through `useDockClearance`
  (`ui/status-dock`), and the dock is then lifted above it; `ActionBar` is the only caller. The dock is fixed to
  the bottom of the viewport with `z-index: 40`, and nothing lifts it above the composer's page foot. Whether
  the dock then sits over the foot was not checked in a browser.
- After a copy, `ReceiptReference` changes nothing on screen. The result is announced and not shown.
- `common.copyFailed` is a shared message. Its English source speaks of a code, not of a receipt number.

What the gallery shows, in `apps/web/src/ui/composer/composer.gallery.tsx`:

| Shown | How |
|---|---|
| Two drawers and two pages, each opened from a button | One example of each pair is routed and shows the steps in `approvals`. The other is not routed and shows the unrouted line. |
| The `preflight` and `effects` sections, and one required field | In all four. |

That entry shows no inline layout, no blocked, incomplete, pending, loading, locked or refused commit, and no
missing line, sign-offs, `secondary`, draft button or `recovery`. No `*.gallery.tsx` under `apps/web/src` names
`ReceiptReference`. Feature galleries that open a composer through a feature component were not traced for this
page.

Tests:

- `composer.test.tsx` renders to markup. It checks the order of the sections, that empty ones are left out, the
  heading levels, where the sign-offs go, both forms of `routing`, and a table of commit labels.
- `composer.browser.test.tsx` runs in a real browser. What it checks is named in the sections above.
- `receipt-reference.test.tsx` checks the markup of `ReceiptReference` and that an empty value renders nothing.
  No test presses its copy button.
- `e2e/mock/composer.spec.ts` opens each of the four gallery examples at 1440 and 390 px, checks the sections,
  the unrouted line above the commit and its reason, and runs an accessibility check with the composer open.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component). A composer in the gallery is closed until its button is
pressed, and this page did not check whether that scan opens one.

## Phone behaviour at 390 px

`composer.module.css` has no media query and no container query. What changes at 390 px comes from the parts
around it and from the width rules.

- **Drawer:** the sheet fills the width of the screen: see [Sheet](sheet.md). The commit is a full-width row, as
  at any width.
- **Page:** the commit's 440 px is more than the row has, so the commit takes the whole row and the other
  actions wrap under it. The foot stays sticky at the bottom, with its 16 px of padding. `PageHead` has phone
  rules of its own, below 768 px.
- **Inline:** nothing changes. The commit is already a full-width row.
- **Targets:** the buttons are 36 px high, as at 1440 px. They do not grow to the 44 px touch size; the composer
  does not read `--target-touch`.
- **The key hint** is still drawn in the commit.

`composer.browser.test.tsx` runs its two layout checks at 390 px as well as 1440 px, and
`e2e/mock/composer.spec.ts` runs the gallery examples at 390 px.

## Copy rules

- `title` is the caller's text, from the message catalog in `packages/i18n`. The `en` catalog is the source and
  the `ko` catalog must define every id. It is a string, not markup.
- The label of the commit is never written by the caller. It comes from `action` through `commitLabel`, so one
  kind and one verb read the same on every screen. A new action is a new entry in `actions.ts` and a new message.
- The source fixes what four of the verbs mean: `withdraw` is for a request still in approval, `cancel` for a
  change not yet in effect, `correct` for an applied fact, and `revoke` for an applied act.
- The preview headings are fixed. The caller gives the content, not the heading.
- `notice` is for what the server said. `blocked.reason` says why the commit cannot be used now, and
  `blocked.remedy` is the way to fix it.

Message ids the module uses for its own text:

| Where | Ids |
|---|---|
| Section headings | `composer.section.preflight`, `.effects`, `.approvals`, `.documents`, `.deadlines`, `.tasks`, `.access`, `.payroll` |
| Commit label | `composer.commit`, `composer.commit.count`, `composer.commit.next`, `composer.unit.people`, `composer.unit.units`, the `composer.action.*` nouns and the `composer.verb.*` verbs |
| Nouns and a verb from other parts of the catalog | `supportAccess.title`, `directoryViews.noun`, `payroll.employee.wage`, `lifecycle.menu.relocate`, and `empDoc.cert.commit` for the verb `issue` |
| Actions | `composer.missing`, `composer.saveDraft`, `composer.draftHint`, `composer.dismiss` |
| Sign-offs | `composer.signoffs`, `composer.signoffs.missing` |
| Unrouted line | `composer.routing.immediate`, `uiBlocker.reason` |
| `ReceiptReference` | `composer.receipt.reference`, `composer.receipt.copy`, `composer.receipt.copied`, `common.copyFailed` |

Two more ids start with `composer.` and are used elsewhere: `composer.unsaved` by the sheet, and
`composer.reason` by callers that label a reason field with a verb.

The text of the key hint is formatted by `modChord("↵")` in `apps/web/src/lib/pure/keys.ts` (`⌘↵` or `Ctrl+↵`), not a catalog message.

## Props

<!-- ds:props apps/web/src/ui/composer/composer.tsx -->

### Composer

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `action` | yes | `ActionDescription` |  |  |
| `children` | yes | `ReactNode` |  |  |
| `title` | yes | `string` |  |  |
| `blocked` | no | `{ reason: ReactNode; remedy?: ReactNode; press?: (() => void) \| undefined; }` |  |  |
| `commitId` | no | `string` |  |  |
| `consequence` | no | `ReactNode` |  |  |
| `dirty` | no | `boolean` |  |  |
| `draftAction` | no | `ActionDescription` |  |  |
| `draftTone` | no | `"primary" \| "secondary"` |  |  |
| `error` | no | `unknown` |  | The command error locks writes after an authoritative permission denial; render its refusal in notice. |
| `formId` | no | `string` |  |  |
| `headingLevel` | no | `2 \| 3 \| 4` |  |  |
| `incomplete` | no | `boolean` |  |  |
| `kicker` | no | `ReactNode` |  |  |
| `layout` | no | `"drawer" \| "inline" \| "page"` |  |  |
| `loading` | no | `boolean` |  |  |
| `localDraft` | no | `boolean` |  |  |
| `locked` | no | `boolean` |  |  |
| `missing` | no | `number` |  |  |
| `notice` | no | `ReactNode` |  |  |
| `onClose` | no | `() => void` |  |  |
| `onSaveDraft` | no | `() => void` |  |  |
| `onSubmit` | no | `() => boolean \| void` |  |  |
| `open` | no | `boolean` |  |  |
| `pending` | no | `boolean` |  |  |
| `recovery` | no | `ReactNode` |  |  |
| `routing` | no | `ComposerRouting` |  |  |
| `secondary` | no | `ReactNode` |  |  |
| `sections` | no | `Partial<Record<"access" \| "approvals" \| "deadlines" \| "documents" \| "effects" \| "payroll" \| "preflight" \| "tasks", ReactNode>>` |  |  |
| `signoffs` | no | `{ items: readonly { id: string; label: string; }[]; value: readonly string[]; onChange: (value: string[]) => void; missing: boolean; }` |  |  |
| `size` | no | `"lg" \| "md"` |  |  |
| `subtitle` | no | `ReactNode` |  |  |
| `tone` | no | `"danger" \| "primary"` |  |  |
| `tools` | no | `ReactNode` |  |  |

<!-- /ds:props -->

<!-- ds:props apps/web/src/ui/composer/routing.tsx -->

### RoutingPreview

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `routing` | yes | `ComposerRouting` |  |  |

<!-- /ds:props -->

<!-- ds:props apps/web/src/ui/composer/receipt-reference.tsx -->

### ReceiptReference

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `value` | yes | `string` |  |  |

<!-- /ds:props -->

Notes on the tables:

- No default is shown for `Composer`, because it reads its props from one object and sets none where it takes
  them. In effect `layout` is `drawer`, `headingLevel` is `2`, `tone` is `primary`, and the composer is open
  unless `open` is `false`. `size` and `draftTone` are passed on as given: the sheet then uses `md` and the
  button `secondary`.
- `ActionDescription` is `{ kind, mode, count?, continuation? }`: see "The commit label". `actions.ts` exports
  no component, so it has no table.
- `ComposerRouting` is one of the two forms under "Routing".
- The keys of `sections` are the eight section names.
- `onSubmit` may return `false` to say the form is not valid: see Invalid, under States.
- Pass `formId` when something outside the composer must address its form. The exit steps under
  `features/people/ui` pass one and move focus to the first invalid field in that form.
  `features/payroll/ui/contract-wage-form.tsx` passes one and calls `reportValidity()` on the form from
  `onSubmit`.
- Pass `commitId` when the commit needs a fixed id. Four features pass one; `features/people/ui/bulk-page.tsx`
  gives its commit the id `bulk-commit`.
- `RoutingPreview` is drawn by `Composer`. No other file imports it.

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/composer/composer.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border-top` |
| `--canvas` | `background` |
| `--frame-bottom` | `min-block-size` |
| `--frame-top` | `min-block-size` |
| `--fw-strong` | `font-weight` |
| `--panel-w` | `flex-basis` |
| `--space-2` | `gap` |
| `--space-3` | `gap` |
| `--space-4` | `padding`, `padding-top` |
| `--space-5` | `gap` |
| `--text-sm` | `font-size` |

<!-- /ds:tokens -->

The half opacity of an inert part is a literal and is not in the table.

The composer draws most of what it shows with other components, and their tokens are on their own pages: the
buttons on [Button](button.md), the drawer on [Sheet](sheet.md), the key hint on [Kbd](kbd.md), the blocked
commit on [DisabledReason](disabled-reason.md) and the sign-offs on [Choice](choice.md). The body's `form` class
is a global rule in `app.css`.
