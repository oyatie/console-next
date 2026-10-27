<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Tabs

Use `PageTabs` from `ui/tabs/page-tabs` with `useTabSearch(items)` from `lib/react/use-tab-search` for a module's
sub-views: `<PageTabs {...useTabSearch(items)} label={label} items={items}>…</PageTabs>`.
The hook reads `?tab=`, replaces the current history entry
on selection and keeps the other search parameters, hash and scroll position.
The first item is the default (no `tab` parameter). Unknown, malformed or removed
selections display the first available view. The route must retain `tab` in its
search validator. Use one `useTabSearch` per page.

`PageTabs` accepts `label`, `items: {id, label, count?}[]`, `children(id)` and optional
`renderList(list)` for a head slot, plus `selected`, `onSelect` and `href` from the hook
or an existing controlled view. Item ids are unique
strings. Counts are server totals; finite nonnegative numbers render, through
the locale formatter, including zero after a read settles. Pass an empty string
while a count is unknown to reserve its slot; omit `count` for views without a count.
An empty item list renders
nothing; the page supplies its read or refusal state.

Pass only the views the server permits. This component makes no access decision
and never renders a refused view as a disabled tab. A temporarily unavailable view
has `disabledReason`: it stays focusable with its reason and has no destination.
If a selected item disappears or becomes unavailable,
its panel disappears with it. Each panel owns its loading, empty, failed or
refused read via the shared read components; keep the head and navigation mounted.
Failures and refusals retain the server's support reference.

The gallery covers populated, loading, empty, failed, refused, eight long labels
and 2,000-count states. URL views are links in a labelled nav, with
`aria-current="page"`; Tab visits links and Enter follows them. Middle-click and
copy-link retain the destination. Labels that do not fit move into 「더 보기」,
keeping the current view visible. The row never wraps or scrolls sideways.
Local panels use `Tabs` and retain ARIA tabs: arrow keys select and Home/End jump. Separate
pages use `TabNav`, router links with `tabClass` and `aria-current`, and `TabCount`.
