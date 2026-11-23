<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Design system

The design system is the set of shared parts every screen of the console is built from: the components under
`apps/web/src/ui`, the tokens in `packages/tokens/tokens.css`, and the global rules in `apps/web/src/app.css`.

It is for two readers. Someone building a screen reads a component page to learn what a component does, when to
use it and what it promises. Someone changing the system reads this page first to learn the rules a change must
keep.

How a change is proved is in the [engineering guide](../engineering.md). This folder does not repeat it.

## Working rules

The console has one classic look today. Its target visual style, Console, is being built beside it. These five rules
hold while that happens, and after.

1. **One component per piece.** A button is one component, styled through role tokens. It is never copied and
   restyled for a visual style. A visual style changes token values; the component stays the same file.
2. **Today's look does not move while Console is built.** A new token enters `packages/tokens/tokens.css` at
   the value today's look already has, so adding it changes nothing on screen.
3. **A visual style changes how things look, and nothing else.** It never changes behaviour, copy or an accessible
   name. Where a style needs a different structure, that structure is a prop on the component, so it is tested and
   documented like any other prop.
4. **Additive parts land as they are ready.** A new component, a doc page or a check that takes nothing away does
   not wait for the rest.
5. **Nothing lands without its doc page, its gallery entry and an accessibility scan.**

What holds each rule today:

| Rule | Held by |
|---|---|
| 1 | In part. The design-system check, `scripts/check-ds.mjs`, counts raw controls, hand-written system classes, restyled controls and literal values in feature code, and a count may only go down. That stops a view from rebuilding a component by hand. A second copy inside `apps/web/src/ui` is caught by review. |
| 2 | In part. `scripts/check-ds.mjs` compares each token of `packages/tokens/tokens.css`, in both themes, with the merge base and fails on a changed or removed value; an intended change is recorded in `scripts/ds-token-changes.json`. Whether a rule that now reads a new token still draws the same pixels is checked by review. |
| 3 | Review, plus the tests each component already has. |
| 4 | Nothing to hold: it is a permission. |
| 5 | In part. `scripts/ds-docs.mjs` proves that the generated tables of a page that exists match the code; nothing checks the hand-written text. The scan exists but no workflow runs it: `e2e/visual.spec.ts` runs axe over the whole gallery in the light and the dark theme, and it skips itself on the served build, which is the only build the workflows open it against. Until a scan in CI exists, which is planned, the scan is step 6 below, run by hand. A check that fails a component with no page or no gallery entry is planned and does not exist yet. |

## Add or change a component

1. Write or change the component under `apps/web/src/ui/<name>/`. Its styles read tokens and nothing else.
2. Show every state in the gallery: a `<name>.gallery.tsx` beside the component, with fixture data and no network.
   See step 2 of "Adding or changing a screen" in the engineering guide.
3. Put its text in `packages/i18n`, never in the component. The `en` catalog is the source and the `ko` catalog
   must define every id. Gallery text goes in the gallery catalog, which stays out of production.
4. Write or update its page in [`components/`](components) to the outline below, and add a new page to the index
   at the foot of this page.
5. Refresh the generated blocks: `node scripts/ds-docs.mjs --write`.
6. Prove the change as the engineering guide says in "Proving a change": `npm run check`, then the browser specs
   for what you touched. For a component, those include the gallery scan, which no workflow runs. Run it against
   the local stack the engineering guide describes:
   `npx playwright test e2e/visual.spec.ts --project=parallel --grep "pass axe"`.
   It fails on a serious or critical axe violation anywhere in the gallery, in either theme.

Forty pages exist so far, listed at the foot of this page. Most components under `apps/web/src/ui` have none yet.

## The outline of a component page

Every page has the same headings, in this order, so a reader always knows where to look. A section with nothing to
say still appears and says so in plain words: "There is no disabled look", not silence.

| Heading | What it holds |
|---|---|
| Title, then one sentence | What the component is. |
| When to use it, and when not | The cases it is for. For each case it is not for, the component to use instead. |
| Anatomy | The named parts and slots, and what element each one is. |
| Looks and sizes | Every variant and size, with the class or value behind it. |
| States | Rest, hover, focus, pressed, disabled, invalid and any other state, or that the state does not exist. |
| Keyboard | Each key and what it does, including what happens to a key the Korean input method owns. |
| Accessibility contract | Role, accessible name, what is announced, and the WCAG 2.2 criteria that apply. |
| Phone behaviour at 390 px | What changes at phone width, or that nothing does. |
| Copy rules | Where the text comes from. Message ids are named; Korean copy is never quoted. |
| Props | Generated. |
| Tokens it reads | Generated. |

Nothing checks the outline yet. Pages are English only, like the rest of the documentation.

## Generated blocks

The props and token tables are not written by hand. A page names a source between two markers, and
`scripts/ds-docs.mjs` writes everything between them:

```md
<!-- ds:props apps/web/src/ui/button/button.tsx -->
<!-- /ds:props -->

<!-- ds:tokens apps/web/src/app.css .btn -->
<!-- /ds:tokens -->
```

- **`ds:props <file>`** takes a TypeScript module, and nothing after the path. Every export that starts with a
  capital letter and can be called gets a table, and so does the default export, under the name it is declared
  with. A table lists each prop this repository declares, whether it is required, its type, its default and its
  doc comment. Props that a library declares, such as the attributes of a native element, are one closing line
  that names the library type, not a row each. A default the component gives one of those props is named in that
  line. A capitalised export that is a class, or whose first parameter is not an object, gets no table: a closing
  line names it as not documented.
- **`ds:tokens <file> [class]`** takes a stylesheet. It lists every token the file reads and the properties that
  read it. With a class after the path, only rules whose selector names that class are read, so one component's
  rules can be picked out of `app.css`. `.btn` takes `.btn:hover`, `.btn--sm` and `.btn__count`, and leaves
  `.btn-group` to its own component.

Text outside the markers is yours and is never touched. Do not edit between them: the next run overwrites it. A
marker inside a fenced code block is an example and is not read.

Props are read from the files the root `tsconfig.json` names, the same ones `tsc` reads. A type declared in a file
the component never imports is therefore resolved here as it is there.

| Command | What it does |
|---|---|
| `node scripts/ds-docs.mjs --write` | Rewrites the generated blocks of every page. |
| `node scripts/ds-docs.mjs --check` | Changes nothing. Fails, naming the page and the block, when a block differs from what the code says now. `npm run check` runs it. |

The check also fails on:

- a source path that does not exist, or text after a `ds:props` path;
- a marker that is never closed, a closing marker with nothing to close, or a comment that starts with `ds` and a
  punctuation mark but is not a marker, which is how a mistyped marker looks;
- a page with no generated block;
- a module that exports no component, or a class after a `ds:tokens` path that no rule names;
- a source that does not parse or does not typecheck. A file elsewhere in the project that does not parse fails it
  too, because one program is built for every page.

Four things to know when a table looks wrong:

- A description is the prop's doc comment. TypeScript counts a comment that sits on its own line above the prop;
  one that follows other code on the same line is not picked up. The comment is copied as written, so it follows
  the documentation rules too.
- A default is shown only when the component sets it where it destructures its props.
- A type is printed as TypeScript prints it, with one change: the members of a union are in alphabetical order,
  `null` and `undefined` last, not in the order the source wrote them. That keeps a table the same whichever
  other pages exist. A named type shows its name, not its members.
- A page checked out with Windows line endings is compared by its text, and a rewritten block keeps them.

## The live gallery

The gallery renders every shared component in its states, with fixture data and no backend. It is served at
`/_gallery` in development and test builds, and production builds leave it out. Start the app with `npm run dev`
and open `/_gallery`. Add `?entry=<name>` to show the one entry in `<name>.gallery.tsx`.

Entries are discovered, not listed: any `*.gallery.tsx` under `apps/web/src` that default-exports a component is
rendered, in the order of its `order` export.

## Page patterns

The thirteen page patterns a screen is drawn through, and how a route names its own, are in
[Page patterns](patterns/README.md).

## Component pages

| Page | Components | Source |
|---|---|---|
| [Action bar](components/action-bar.md) | `ActionBar` | `apps/web/src/ui/action-bar` |
| [Approval card](components/approval-card.md) | `ApprovalCard` | `apps/web/src/ui/approval-card` |
| [Avatar](components/avatar.md) | `Avatar` | `apps/web/src/ui/avatar` |
| [Badge](components/badge.md) | `Badge` | `apps/web/src/ui/badge` |
| [Banner](components/banner.md) | `Banner` | `apps/web/src/ui/banner` |
| [Button](components/button.md) | `Button`, `IconButton`, `ToggleButton`, `Segmented`, `Form`, `Check` | `apps/web/src/ui/button` |
| [Card](components/card.md) | `Card`, `SectionHead` | `apps/web/src/ui/card` |
| [Chain stepper](components/chain-stepper.md) | `ChainStepper` | `apps/web/src/ui/chain-stepper` |
| [Change rows](components/change-rows.md) | `ChangeRows` | `apps/web/src/ui/change-rows` |
| [Chip](components/chip.md) | `Chip` | `apps/web/src/ui/chip.tsx` |
| [Choice](components/choice.md) | `ChoiceField`, `ChipChoice`, `Checks`, `GroupedChoice`, `ChoiceAdd` | `apps/web/src/ui/choice` |
| [Command palette](components/command-palette.md) | `CommandPalette` | `apps/web/src/ui/command-palette` |
| [Composer](components/composer.md) | `Composer`, `RoutingPreview`, `ReceiptReference` | `apps/web/src/ui/composer` |
| [Date](components/date.md) | `DateField`, `DateInput`, `DateCalendar` | `apps/web/src/ui/date` |
| [Deadline chip](components/deadline-chip.md) | `DeadlineChip` | `apps/web/src/ui/deadline-chip` |
| [Deadline strip](components/deadline-strip.md) | `DeadlineStrip` | `apps/web/src/ui/deadline-strip` |
| [Decision pane](components/decision-pane.md) | `DecisionPane` | `apps/web/src/ui/decision-pane` |
| [Dialog](components/dialog.md) | `Dialog` | `apps/web/src/ui/dialog.tsx` |
| [Disabled reason](components/disabled-reason.md) | `DisabledReason` | `apps/web/src/ui/disabled-reason` |
| [Due cell](components/due-cell.md) | `DueCell` | `apps/web/src/ui/due-cell` |
| [Field](components/field.md) | `Field`, `FieldSet`, `Marker`, `TextInput`, `TextArea`, `SelectInput`, `DerivedValue` | `apps/web/src/ui/field` |
| [Item list](components/item-list.md) | `ItemList` | `apps/web/src/ui/item-list` |
| [Key cap](components/kbd.md) | `Kbd` | `apps/web/src/ui/kbd` |
| [Key-value](components/key-value.md) | `KeyValue`, `StatRow` | `apps/web/src/ui/key-value` |
| [Ledger](components/ledger.md) | `Ledger` | `apps/web/src/ui/ledger` |
| [Masked field](components/masked-field.md) | `MaskedField` | `apps/web/src/ui/masked-field` |
| [Menu](components/menu.md) | `ActionMenu`, `MenuButton` | `apps/web/src/ui/menu` |
| [Meter](components/meter.md) | `Meter` | `apps/web/src/ui/meter` |
| [Module navigation](components/module-nav.md) | `ModuleNavBar` | `apps/web/src/ui/module-nav` |
| [Month grid](components/month-grid.md) | `MonthGrid` | `apps/web/src/ui/month-grid` |
| [Page head](components/page-head.md) | `PageHead`, `PageHeadActions`, `Crumbs`, `PhaseLine`, `AsOf` | `apps/web/src/ui/page-head` |
| [Pane grid](components/pane-grid.md) | `PaneGrid`, `PaneHead` | `apps/web/src/ui/pane-grid` |
| [Period stepper](components/period-stepper.md) | `PeriodStepper` | `apps/web/src/ui/period-stepper` |
| [Person-day grid](components/person-day-grid.md) | `PersonDayGrid` | `apps/web/src/ui/person-day-grid` |
| [Phone bars](components/phone-bars.md) | `PhoneTopBar`, `PhoneBottomNav` | `apps/web/src/ui/phone-bars` |
| [Popover](components/popover.md) | `PopoverButton` | `apps/web/src/ui/popover` |
| [Reason field](components/reason.md) | `ReasonField` | `apps/web/src/ui/reason` |
| [Receipt](components/receipt.md) | `Receipt` | `apps/web/src/ui/receipt` |
| [Record](components/record.md) | `RecordSection`, `SectionLine`, `SubHead`, `FieldRow`, `FieldMark`, `RecordRows`, `Strip`, `StripItem`, `SecNav`, `Spine`, `EditRow`, `RowInput`, `Saving`, `Masked`, `Gate`, `Tag`, and the kit's own `Kbd` | `apps/web/src/ui/record` |
| [Record actions](components/record-actions.md) | `RowActions`, `ListAdd`, `PathNote` | `apps/web/src/ui/record-actions` |
| [Search](components/search.md) | `SearchField` | `apps/web/src/ui/search` |
| [Select](components/select.md) | `SelectField` | `apps/web/src/ui/select` |
| [Sheet](components/sheet.md) | `Sheet` and its draft and read-context helpers | `apps/web/src/ui/sheet` |
| [Sort control](components/sort-control.md) | `SortControl` | `apps/web/src/ui/sort-control` |
| [Status bar](components/status-bar.md) | `StatusBar` | `apps/web/src/ui/status-bar` |
| [Step line](components/step-line.md) | `StepLine` | `apps/web/src/ui/step-line` |
| [Tree](components/tree.md) | `TreeView` | `apps/web/src/ui/tree` |
| [Workspace tabs](components/workspace-tabs.md) | `WorkspaceTabs` | `apps/web/src/ui/workspace-tabs` |
