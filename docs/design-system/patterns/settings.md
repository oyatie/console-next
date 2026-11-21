<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Settings (`P9`)

`SettingsPattern` arranges a settings workspace (`P-05`) with a `PageHead`, an optional top `summary` band, an optional `views` navigation rail inside `PaneGrid` `start`, a rule-divided primary `panel` inside `PaneGrid` `main`, and an optional `record` / `related` side pane.

## Regions (`SettingsPatternProps`)

| Region | Required | Role & owner |
|---|---|---|
| `q` | Yes | Primary gate read state (`QueryState` `layout="record"`). |
| `head` | Yes | `PageHead` (`<h1>` or `<h2>` in nested scope). |
| `tabs` | No | Optional tabs above `PageReadGate`. |
| `summary` | No | Optional governance or policy `StatRow` band above `PaneGrid`. |
| `views` | No | Optional settings category list rendered in `PaneGrid` `start`. |
| `notes` | No | Status banners or receipts above `panel`. |
| `panel` | Yes | Primary rule-divided settings sections or hub cards (independent per-section reads stay inside `panel`). |
| `record`, `related`, `full`, `onFull`, `onSelect`, `onOpen` | No | `PaneGrid` side pane inspector with splitter, `Escape` dismissal, and `returnFocus`. |
| `foot` | No | Optional footer beneath `panel`. |
| `facts` | No (optional) | Summary facts (`settingsOptionalRegions`). |
| `overlays` | No | Supporting sheets kept mounted across `loading` and `failed`. |

## Accessibility & WCAG 2.2 contract

- **Isolated card failures:** Because callers may pass a ready access `q` and host independent per-section `QueryState`s inside `panel`, one `403` or `503` setting card never blocks sibling categories.
- **Phone `390px` drill-in:** Opening `record` sets `data-detail` and switches `PaneGrid` to single-pane detail view with a back button, hiding `.head` to preserve one visible header.
- **Keyboard & touch targets:** Rail and action controls meet `44px` (`--target-touch`) on phone viewports and clamp inputs inside `min-width: 0; max-width: 100%;`.
