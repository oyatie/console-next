<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Design system

The design system is the set of shared parts every screen of the console is built from: the components under
`apps/web/src/ui`, the tokens in `packages/tokens/tokens.css`, and the global rules in `apps/web/src/app.css`.

It is for two readers. Someone building a screen reads a component page to learn what a component does, when to
use it and what it promises. Someone changing the system reads this page first to learn the rules a change must
keep.

How a change is proved is in the [engineering guide](../engineering.md). This folder does not repeat it.

## Working rules

The console has one look today. A second visual style, Control room, is being built beside it. These five rules
hold while that happens, and after.

1. **One component per piece.** A button is one component, styled through role tokens. It is never copied and
   restyled for a visual style. A visual style changes token values; the component stays the same file.
2. **Today's look does not move while Control room is built.** A new token enters `packages/tokens/tokens.css` at
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
| 2 | Review. |
| 3 | Review, plus the tests each component already has. |
| 4 | Nothing to hold: it is a permission. |
| 5 | In part. Every gallery entry is scanned: `e2e/visual.spec.ts` runs axe over the whole gallery in the light and the dark theme. `scripts/ds-docs.mjs` proves that a page that exists matches the code. A check that fails a component with no page or no gallery entry is planned and does not exist yet. |

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
   for what you touched.

Most components under `apps/web/src/ui` have no page yet. Changing one of them does not require writing its page
today; writing it is welcome.

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

- **`ds:props <file>`** takes a TypeScript module. Every export that starts with a capital letter and can be
  called gets a table: each prop this repository declares, whether it is required, its type, its default and its
  doc comment. Props that a library declares, such as the attributes of a native element, are one closing line
  that names the library type, not a row each.
- **`ds:tokens <file> [selector text]`** takes a stylesheet. It lists every token the file reads and the
  properties that read it. With text after the path, only rules whose selector contains that text are read, so one
  component's rules can be picked out of `app.css`.

Text outside the markers is yours and is never touched. Do not edit between them: the next run overwrites it.

| Command | What it does |
|---|---|
| `node scripts/ds-docs.mjs --write` | Rewrites the generated blocks of every page. |
| `node scripts/ds-docs.mjs --check` | Changes nothing. Fails, naming the page and the block, when a block differs from what the code says now. `npm run check` runs it. |

The check also fails on a source path that does not exist, a marker that is never closed, and a page with no
generated block.

Three things to know when a table looks wrong:

- A description is the prop's doc comment. TypeScript counts a comment that sits on its own line above the prop;
  one that follows other code on the same line is not picked up. The comment is copied as written, so it follows
  the documentation rules too.
- A default is shown only when the component sets it where it destructures its props.
- A type is printed as TypeScript prints it. A named type shows its name, not its members, and the order of an
  inline union can follow the other sources in the run. `--write` refreshes every page at once, so run it and
  commit what changes.

## The live gallery

The gallery renders every shared component in its states, with fixture data and no backend. It is served at
`/_gallery` in development and test builds, and production builds leave it out. Start the app with `npm run dev`
and open `/_gallery`. Add `?entry=<name>` to show the one entry in `<name>.gallery.tsx`.

Entries are discovered, not listed: any `*.gallery.tsx` under `apps/web/src` that default-exports a component is
rendered, in the order of its `order` export.

## Component pages

| Page | Components | Source |
|---|---|---|
| [Button](components/button.md) | `Button`, `IconButton`, `ToggleButton`, `Segmented`, `Form`, `Check` | `apps/web/src/ui/button` |
| [Chip](components/chip.md) | `Chip` | `apps/web/src/ui/chip.tsx` |
| [Field](components/field.md) | `Field`, `FieldSet`, `Marker`, `TextInput`, `TextArea`, `SelectInput`, `DerivedValue` | `apps/web/src/ui/field` |
