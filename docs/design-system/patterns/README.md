<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Page patterns

A page pattern is a named arrangement of regions that a screen is drawn through. The pattern places the regions
and the screen supplies what goes in each, so every screen of one kind has the same landmarks, headings, focus
order and read states.

Every screen of the console is to be drawn through one of thirteen patterns. Nine are built so far.

## The thirteen patterns

| Id | The screen it is for | Built |
|---|---|---|
| [`worklist`](worklist.md) | A worklist of items that need action, with a record pane. | Yes |
| `list-record` | A list with a record pane beside it. | Yes |
| [`record`](record.md) | One record, in sections. | Yes |
| [`document-decision`](document-decision.md) | A document with a decision pane. | Yes |
| [`month-grid`](month-grid.md) | A month grid. | Yes |
| [`register-totals`](register-totals.md) | A register with totals. | Yes |
| [`form`](form.md) | A form. | Yes |
| `wizard` | A multi-step wizard. | No |
| `settings` | A list of settings views with a panel. | No |
| `canvas` | A canvas with a toolbar and an inspector. | No |
| `sign-in` | Sign-in, outside the shell. | No |
| [`phone-hub`](phone-hub.md) | A phone hub of fact strips and links. | Yes |
| [`phone-statement`](phone-statement.md) | A phone statement with a period bar and a ledger. | Yes |

The ids are the `PATTERNS` list in `apps/web/src/ui/patterns/patterns.ts`, in this order. `BUILT_PATTERNS` in the
same file lists the ones that have a component. Nothing checks this table against those two lists; change them
together.

## What a pattern is in files

A pattern lives in `apps/web/src/ui/patterns/`. For example, `list-record` is five files:

| File | What it holds |
|---|---|
| `list-record-contract.ts` | The contract, with no component code. The `ListRecordProps` type names the regions: the read state `q`, `head` and `list` are required, and `record`, `related`, `tabs`, `views`, `find`, `filters`, `tools`, `notes`, `foot`, `facts` and `overlays` may be left out by a screen. `listRecordOptionalRegions` lists the regions the arrangement itself may leave undrawn: `facts` only, and the component does not draw it today. The doc comment says which roles the content keeps and which part owns the heading, the panes and the overlays. |
| `list-record.tsx` | The component, `ListRecord`. It arranges the regions, puts the head and the data regions behind the shared read boundary, and marks its root with `data-pattern="list-record"`. |
| `list-record.module.css` | The layout of the frame, the head and the controls row. |
| `list-record.fixture.tsx` | The pattern filled with synthetic content and no network. The review route `/_review/patterns/list-record` renders it inside the shell, and with `?state=refused` shows the refusal. The route exists only in a build made with `VITE_REVIEW_STATE_ROUTES=1`, which is how the mock browser suite builds the app. |
| `list-record.test.tsx` | The in-process test. It renders the pattern to markup and asserts that every supplied region except `facts` is placed once under one `main` and one `h1`, that a screen may leave regions out, that a refusal removes every data region and command, and that loading and failure keep the commands and their overlays mounted. |

A new pattern is expected to arrive as the same kinds of file: a contract, the component, a fixture with a review
route, and an in-process test.

## How a route names its pattern

A route names the pattern its screen is drawn through with the `pattern` key of its static data, beside
`floorplan`:

```ts
path: "/people",
staticData: { access: readRequirement("/people"), floorplan: "P-01", pattern: "list-record" },
```

The key is optional. Five routes declare one today: `/` and `/inbox` (drawn through `Worklist`), `/people` (drawn through
`ListRecord`), and the two review routes (`/_review/patterns/worklist` and `/_review/patterns/list-record`).

`apps/web/src/routes/route-pattern.test.ts` builds the router and fails when a route names a pattern that is not
one of the thirteen, or one that is not in `BUILT_PATTERNS`. It also holds the list of routes that declare a
pattern, so a screen that starts to be drawn through a pattern adds its route there.

## Floorplan

`floorplan` is the earlier key, and it remains for now. It is one of six values, `P-01` to `P-05` and `canvas`,
listed in `apps/web/src/ui/page/floorplan.ts`. A route declares it in the same static data, and the `Page`
component takes it as a prop and writes it on its root as `data-floorplan`.
`apps/web/src/routes/route-floorplan.test.ts` fails an app route that declares none, unless the route is in
`apps/web/src/routes/route-floorplan-allow.json`, a list that may only shrink.

Six values cannot name thirteen patterns, so `pattern` is a second key. A route that declares a pattern keeps its
floorplan.
