<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Page frame contract

`Page` owns page chrome and its read boundary. It does not fetch, infer grants,
or create support references. Pass the existing query result and server errors.

```tsx
<Page floorplan="list" q={people} head={{
  title: t("people.title"),
  titleId: "people-title",
  crumbs: <Crumbs items={ancestors} />,
  meta: <span><Count n={counts.data?.total} /></span>,
  primary: createAction,
  actions: <PageHeadActions label={moreLabel} items={secondaryCommands} />,
  asOf: dateControl,
  tabs: viewTabs,
}} empty={rows => rows.length ? null : emptyState}>
  {rows => <Roster rows={rows} />}
</Page>
```

For a page without a read, omit `q` and pass ordinary children. The `floorplan`
attribute identifies the intended template; template-specific geometry is a
later slice. The supported values are list, record, form, dashboard, wizard,
settings and canvas. Existing `PageHead` callers keep their current props.

`PageMain` is the shell's main landmark. A standalone `Page` renders main;
inside `PageMain` it renders a div. Nested pages and PageHeads in their body
(including sheets rendered through a portal) use h2. The head's `titleId`
remains a programmatic focus target. Put breadcrumbs only in `head.crumbs`.

The read contract reuses `QueryState` and `PageReadGate`: `q`, `empty`, `own`,
`back`, `removed`, `layout`, and a child function receiving the successful data.
The title stays mounted through loading, empty, failed and refused states.
Refusals hide the data and head controls, including on placeholder reads after
a refusal. Transient refetch failures retain the last data and shared warning.
Failure and refusal details use the server's existing support reference.
Supply a safe title and crumbs that do not depend on permission to read data.

`head.primary` stays visible at phone widths. Pass `PageHeadActions{label, items}`
in `head.actions`: its secondary commands appear inline on desktop and in the
existing accessible ActionMenu on phones. Keeping this import with the caller
leaves the menu implementation out of heads without actions. Only pass commands already permitted by the
server. `head.tools` remains available for existing callers and other controls;
opaque tool nodes cannot be converted into menu commands. `head.asOf` carries
the existing AsOfControl or AsOf fact. `head.meta` carries PhaseLine and Count;
keep Count mounted in an inline fact (`span`) with `n={undefined}` while its
read loads to reserve both the number's width and its text line's height.
Tab panels belong in the body; `head.tabs` contains only the tab list.

`/_gallery` exercises loading, empty, failed, refused, populated, long-title and
2,000-row inputs (50 rows at a time), with the nested-sheet heading case.
