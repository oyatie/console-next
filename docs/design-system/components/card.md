<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Card

A card is a titled surface on a page: a `<section>` with a head for its title, its count or status and its tools,
and a body under it. `SectionHead` is the small ruled heading that splits what is inside one.

The family lives in `apps/web/src/ui/card`: `Card` in `card.tsx` and `SectionHead` in `section-head.tsx`. Both are
styled by `card.module.css`.

## When to use it, and when not

| Component | Use it for |
|---|---|
| `Card` | One section of a page, with its title and its own tools. Without a title it is a plain surface. |
| `Card` with `look="outline"` | A box inside a sheet, a panel or another section. It has no shadow, because it is not lifted off the page. |
| `Card` with `look="dashed"` | A proposal, or a value that is not recorded yet. |
| `Card` with `look="muted"` | A quoted record: a log line, or what another writer saved. |
| `SectionHead` | The heading of a part inside a card, a panel or a sheet, with an optional tool at its end. |

A card holds a section of a page. A list of records is one table inside one card, never a card for each record.

| Do not use it for | Use instead |
|---|---|
| One card for each record of a list | `Table` (`ui/table.tsx`) inside one card with `flush`. For a short list, `ItemList` (`ui/item-list`). |
| The head of the page | `PageHead` (`ui/page-head`). |
| A pane beside a list that shows the selected record | `SidePanel` (`ui/side-panel`). |
| A surface that opens over the page | `Sheet` (`ui/sheet`) for a command on a record. `Dialog` (`ui/dialog.tsx`) for a confirmation or a blocking notice. |
| A full-width strip of a full-width screen | `Band` (`ui/band`). |
| A numbered section of a personnel record | `RecordSection` (`ui/record`). |
| A message | `Banner`: see [Banner](banner.md). |
| Facts as label and value pairs | `KeyValue`, inside the card: see [KeyValue](key-value.md). |
| A view with nothing in it, or a view that failed to load | `EmptyState` (`ui/empty-state.tsx`), inside the card. |
| The loading shape of a view | `Skeleton` (`ui/skeleton`), which takes the shapes to draw and a label. The card's own `loading` draws one bar and has no label. |
| A hand-written `card` or `section-head` class | `Card` or `SectionHead`. See the next paragraph. |

`app.css` has a global `card` class with the same fill, border, radius and shadow, and a `card__body` class, a
padded column. They are for hand-written markup. `Card` does not use them: every class it writes comes from
`card.module.css`, so no global `card` rule reaches it. That includes `[data-embed] .card`, the rule that flattens
a hand-written card mounted inside a record section.

`app.css` also has a global `section-head` class, the hand-written counterpart of `SectionHead`. It is a line
with 12 px padding top and bottom (`--space-3`) and 16 px at the sides (`--space-4`). It draws no rule line and
styles no title. `SectionHead` does not use it.

Views still write these global classes by hand. The design-system check counts each hand-written use, and the
count may only go down.

## Anatomy

`Card` renders:

| Part | Element | Holds |
|---|---|---|
| Root | `<section>` | `id`, `data-look`, `data-density`, `aria-busy` and the name. |
| Head | `<div>` | The title, the meta, a spacer and the tools. Rendered when `title` or `tools` has something to show. |
| Title | `<h2>`, or `<h3>` with `level={3}` | `title`. It carries an `id`, which is `titleId` or a generated one, and `tabindex="-1"`. |
| Meta | `<span>` | `meta`: the count or the status that goes with the title. |
| Spacer | `<span>` | Nothing. It pushes the tools to the end of the head. |
| Tools | `<div>` | `tools`. |
| Body | `<div>` | `children`. `flush` marks it `data-flush`. |
| Loading block | `<div role="status">` with one `<div>` bar inside | Nothing else. It replaces the body while `loading` is set. |

A part is left out when its prop is `null`, `undefined`, `false` or an empty string.

The meta is inside the head. A card given `meta` with neither `title` nor `tools` has no head, so the meta is not
rendered.

`Card` takes no `className` and passes no other attribute through.

`SectionHead` renders:

| Part | Element | Holds |
|---|---|---|
| Root | `<div>` | The three parts below, on one line. |
| Title | `<h3>`, or `<h2>` or `<h4>` by `level` | `children`, and `id`. |
| Rule | `<span>` | Nothing. A 1 px line that fills the rest of the line. |
| Tools | None of its own | `tools`, rendered as given, after the rule. |

## Looks and sizes

`Card` with no `look`:

| Part | Look |
|---|---|
| Surface | `--surface` fill, a 1 px `--border` border, a 10 px radius (`--radius-lg`), and the `--shadow` shadow. |
| Head | At least 52 px high (`calc(var(--row-h) + var(--space-3))`). 8 px padding top and bottom (`--space-2`), 16 px at the sides (`--space-4`). A 1 px `--border` line under it. Parts are 8 px apart (`--space-2`) and wrap. |
| Title | 14 px (`--text-body`), `--fw-strong`. |
| Meta | 13 px (`--text-sm`), `--steel`. |
| Body | A column with 12 px between its children (`--space-3`). 12 px padding at the top (`--space-3`), 16 px at the sides and the bottom (`--space-4`). |
| Body with `flush` | No padding and no gap, for a table or a list that runs edge to edge. It scrolls sideways by itself (`overflow-x: auto`). |

`look` changes the surface and the body:

| `look` | What changes |
|---|---|
| `outline` | No shadow. A 6 px radius (`--radius`). The body has 12 px padding on every side (`--space-3`) and 8 px between its children (`--space-2`). |
| `dashed` | As `outline`, with a dashed `--control-border` border and a `--canvas` fill. |
| `muted` | As `outline`, with a `--muted` fill. |

`flush` does not remove the padding of a card that has a `look`. The body rule of a look is more specific than
the `flush` rule, so the 12 px padding and the 8 px gap stay. Only the sideways scroll applies.

`density` changes the text size and the head:

| `density` | What changes |
|---|---|
| `dense` | Text in the card is 13 px (`--text-sm`). The head is at least 40 px high (`--row-h`), with 4 px padding top and bottom (`--space-1`) and 12 px at the sides (`--space-3`). The title stays 14 px, because its size is set on the title. The body padding does not change. |
| `default`, or not set | Nothing. `default` writes `data-density="default"`, which no rule reads. |

`level` changes the heading element and nothing visible.

`SectionHead` has one look. The line is at least 32 px high (`--target`) with 8 px between its parts
(`--space-2`). The title is 12 px (`--text-xs`), `--fw-medium`, `--steel`, with `--tracking-label` letter spacing,
on one line. The rule is 1 px of `--border-soft`. `level` changes the heading element and nothing visible.

## States

| State | What changes |
|---|---|
| Rest | The look above. |
| Hover | Does not exist. |
| Focus | The title can take focus from script, through `tabindex="-1"`, and is never a Tab stop. The family has no focus rule. The only focus look is the global rule for every focusable element, a 2 px `--primary` outline 2 px away, and the browser decides whether that shows when focus is moved by script. The root and `SectionHead` are not focusable. |
| Pressed | Does not exist. |
| Selected | Does not exist. |
| Disabled | Does not exist. |
| Read-only | Does not exist. |
| Invalid | Does not exist. |
| Loading (`loading` on `Card`) | The root gets `aria-busy="true"`. The body is replaced by the loading block: 16 px padding (`--space-4`) around one bar, 32 px high (`--space-6`), `--border-soft`, with a 6 px radius (`--radius`). `children` are not rendered. The head stays. The bar does not move, and the block holds no text. |
| Empty | No look. A card with no `children` renders no body: the head alone, or an empty `<section>` when it has no head either. |

`SectionHead` has no loading state.

## Keyboard

None. `Card` and `SectionHead` handle no key.

Tab never stops on the title. It moves through the controls the caller put in `tools` and in the body, in document
order: the tools of the head before the body.

Neither component takes text, so there is no rule for a key the Korean input method owns. The two modules have no
`keydown` handler, no `isComposing` check, no key code 229 check and no composition event.

## Accessibility contract

| Case | Role | Accessible name |
|---|---|---|
| `Card` with a title | `region`: a named `<section>`. | The title, through `aria-labelledby` on the root, which points at the heading. `label` is ignored. |
| `Card` with `label` and no title | `region` | `label`, through `aria-label`. |
| `Card` with neither | None. A `<section>` with no name is not a landmark. | None. |
| `SectionHead` | None on the line. The title is a heading. | The heading's text. |

- **Landmarks:** every card with a title or a `label` is a `region` landmark. A page of several cards has as many
  landmarks.
- **Headings:** the title is a real heading. `Card` takes level 2 or 3 and `SectionHead` takes 2, 3 or 4. The
  caller picks the level; nothing checks that the levels on a page are in order.
- **Meta:** part of the head and not part of the name. `aria-labelledby` points at the heading alone.
- **Moving focus:** `titleId` gives the heading a known `id`, for a view that moves focus to it.
- **Naming a part:** a `SectionHead` names nothing by itself. Give it an `id` and point the `aria-labelledby` of
  the part's own region at it.
- **Announced:** nothing. While `loading`, the root is `aria-busy` and the loading block has `role="status"`, but
  the block holds no text and takes no label, so there are no words to announce.

The WCAG 2.2 criteria that apply:

| Criterion | How the family answers it |
|---|---|
| 1.3.1 Info and Relationships | `<section>`, a heading, and `aria-labelledby` between them. |
| 1.4.3 Contrast (Minimum) | The meta and the `SectionHead` title are `--steel` at 13 px and 12 px, so they need 4.5:1. The fills a card can have are `--surface`, `--canvas` and `--muted`. Computed from the token values, `--steel` on those is at least 5.24:1 in the light theme and 6.44:1 in the dark theme. |
| 1.4.10 Reflow | The card can shrink, the head wraps, and a `flush` body scrolls sideways inside the card. `SectionHead` does not wrap: see the phone section. |
| 2.4.3 Focus Order | Tab order is document order: the controls in `tools`, then those in the body. The title is never a Tab stop. |
| 2.4.6 Headings and Labels | The title is a heading. Its level and its words are the caller's. |
| 2.4.7 Focus Visible | The global focus outline, on a title that was given focus. |
| 4.1.2 Name, Role, Value | The table above. |
| 4.1.3 Status Messages | Not answered. The loading block has the `status` role and no text. |

The gallery entry is `apps/web/src/ui/card/card.gallery.tsx`. It shows a titled card with a meta and a tool, a
`SectionHead` with a tool inside that card, and an untitled card. It does not show `look`, `density`, `flush`,
`loading`, `label` or `level`.

No workflow runs the accessibility scan of the gallery. `e2e/visual.spec.ts` runs axe with the WCAG 2.2 A and AA
rules over the whole gallery, in the light and the dark theme, when it is run against a development stack. It
skips itself on the served build, which is the one the workflows use. The command is in
[the guide](../README.md#add-or-change-a-component).

## Phone behaviour at 390 px

Nothing in the family changes with the width of the screen. `card.module.css` has no media query and no container
query.

- The card can shrink below the width of its content (`min-width: 0`), and so can the body.
- The head wraps. Tools that do not fit beside the title move to a second line and start at its left edge.
- The padding does not change with the width.
- A `flush` body scrolls sideways inside the card, so a wide table does not push the page wide.
- `SectionHead` stays on one line. Its title does not wrap and has no ellipsis, and the line has no wrap rule, so
  a title and tools wider than the line overflow it. The rule shrinks to nothing first.

The family has no target of its own. The size of a control in `tools` is that control's: the family does not read
`--target-touch`.

## Copy rules

- The family holds no text of its own and owns no message id.
- The title, the meta, `label` and the `SectionHead` title come from the message catalog in `packages/i18n`,
  through the caller. The `en` catalog is the source and the `ko` catalog must define every id.
- The title names the section. `meta` is the slot for a count or a status that goes with it. That is a
  convention the code does not enforce, and a view exists that puts a count in the title.
- `label` is a plain string. It is used only when there is no title, so write it as the title would read.
- The loading block has no words. A card that must say what it is loading uses `Skeleton` with a label in its
  body.

## Props

<!-- ds:props apps/web/src/ui/card/card.tsx -->

### Card

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `children` | no | `ReactNode` |  |  |
| `density` | no | `"default" \| "dense"` |  |  |
| `flush` | no | `boolean` |  |  |
| `id` | no | `string` |  |  |
| `label` | no | `string` |  | The region's name when the card has no visible title (a list whose count is its name). |
| `level` | no | `2 \| 3` | `2` |  |
| `loading` | no | `boolean` |  |  |
| `look` | no | `"dashed" \| "muted" \| "outline"` |  |  |
| `meta` | no | `ReactNode` |  |  |
| `title` | no | `ReactNode` |  |  |
| `titleId` | no | `string` |  | The title's id, for a screen that moves focus to it (the heading takes focus, never a tab stop). |
| `tools` | no | `ReactNode` |  |  |

<!-- /ds:props -->

<!-- ds:props apps/web/src/ui/card/section-head.tsx -->

### SectionHead

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `children` | yes | `ReactNode` |  |  |
| `id` | no | `string` |  |  |
| `level` | no | `2 \| 3 \| 4` | `3` |  |
| `tools` | no | `ReactNode` |  |  |

<!-- /ds:props -->

## Tokens it reads

The family's own stylesheet:

<!-- ds:tokens apps/web/src/ui/card/card.module.css -->

| Token | Read by |
| --- | --- |
| `--border` | `border`, `border-bottom` |
| `--border-soft` | `background` |
| `--canvas` | `background` |
| `--control-border` | `border-color` |
| `--fw-medium` | `font-weight` |
| `--fw-strong` | `font-weight` |
| `--muted` | `background` |
| `--radius` | `border-radius` |
| `--radius-lg` | `border-radius` |
| `--row-h` | `min-height` |
| `--shadow` | `box-shadow` |
| `--space-1` | `padding` |
| `--space-1-5` | `padding` |
| `--space-2` | `gap`, `padding` |
| `--space-3` | `gap`, `min-height`, `padding` |
| `--space-4` | `padding` |
| `--space-6` | `height` |
| `--steel` | `color` |
| `--surface` | `background` |
| `--surface-2` | `background` |
| `--target` | `min-height` |
| `--text-body` | `font-size` |
| `--text-sm` | `font-size` |
| `--text-xs` | `font-size` |
| `--tracking-label` | `letter-spacing` |

<!-- /ds:tokens -->

The global `card` and `card__body` classes in `app.css`. `Card` does not use them; they are listed because they
draw the same surface for hand-written markup:

<!-- ds:tokens apps/web/src/app.css .card -->

| Token | Read by |
| --- | --- |
| `--border` | `border`, `border-bottom` |
| `--radius-lg` | `border-radius` |
| `--shadow` | `box-shadow` |
| `--space-3` | `gap`, `padding-top` |
| `--space-4` | `padding` |
| `--surface` | `background` |
| `--surface-2` | `background` |

<!-- /ds:tokens -->

The focus outline is a global rule and is not listed: it reads `--primary`.
