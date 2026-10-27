<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Tabs

Use `Tabs` with `useTabSearch(items)` from `lib/react/use-tab-search` for a module's
sub-views: `<Tabs {...useTabSearch(items)} label={label} items={items}>…</Tabs>`.
The hook reads `?tab=`, writes a history entry
on selection and keeps the other search parameters, hash and scroll position.
The first item is the default (no `tab` parameter). Unknown, malformed or removed
selections display the first available view. The route must retain `tab` in its
search validator. Use one `useTabSearch` per page.

`Tabs` accepts `label`, `items: {id, label, count?}[]`, `children(id)` and optional
`renderList(list)` for a head slot, plus `selected` and `onSelect` from the hook
or an existing controlled view. Item ids are unique
strings. Counts are server totals; finite nonnegative numbers render, through
the locale formatter, including zero after a read settles. Pass an empty string
while a count is unknown to reserve its slot; omit `count` for views without a count.
An empty item list renders
nothing; the page supplies its read or refusal state.

Pass only the views the server permits. This component makes no access decision
and never renders a refused view as a disabled tab. If a selected item disappears,
its panel disappears with it. Each panel owns its loading, empty, failed or
refused read via the shared read components; keep the head and tablist mounted.
Failures and refusals retain the server's support reference.

The gallery covers populated, loading, empty, failed, refused, eight long labels
and 2,000-count states. Labels wrap within the available width in both themes.
Arrow keys select, Home/End jump, and Tab enters the selected panel. Separate
pages use `TabNav`, router links with `tabClass` and `aria-current`, and `TabCount`.
