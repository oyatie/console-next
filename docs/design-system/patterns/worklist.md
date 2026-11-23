<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Worklist (`P1`)

`Worklist` arranges an actionable operational queue (`/` Home and `/inbox`) with an inline command strip, optional deadline schedule strip and operational summary bands, and a resizable side record and decision pane.

## Regions (`WorklistProps`)

| Region | Required | Role & owner |
|---|---|---|
| `q` | Yes | Primary queue `ReadState`; `PageReadGate` strips commands and data regions on `403` refusal, while `QueryState` renders loading skeletons and retryable failures. |
| `head` | Yes | `PageHead` (`h1` landmark heading, optional `asOf`, `primary`, `actions`, `commands`). |
| `tabs` | No | Optional view navigation rendered above `PageReadGate` so route tabs remain reachable on refusal. |
| `views`, `filters`, `find` | No | Placed in `PageHead`'s inline `filters` slot (`Segmented` attention filters, statutory `Check`, and `[data-list-find]` search). |
| `tools` | No | Placed in `PageHead`'s trailing `tools` slot (`SortControl` and column visibility chooser). |
| `notes` | No | Partial-source unavailability banners, setup receipt, and live-stream hold notices above `list`. |
| `list` | Yes | Primary worklist table/grid, setup rail, or empty state inside `PaneGrid`'s `main` slot. |
| `schedule`, `bands` | No | Optional `DeadlineStrip` and lower operational bands placed in `PaneGrid`'s `bottom` slot. |
| `record`, `related` | No | Complementary `<aside>` panes managed by `PaneGrid` (splitter resize, Escape close, `openInTab`, pinned `DecisionPane` footer). |
| `foot` | No | Paging or view-all footer beneath `list`. |
| `facts` | No (optional) | Summary facts (`worklistOptionalRegions`). |
| `overlays` | No | Command sheets and dialogs kept mounted across `loading` and `failed` states. |

## Accessibility & WCAG 2.2 contract

- **Landmarks & headings:** Exactly one `<main>` (when top-level) and one `<h1>` (`head.title`), followed by `<h2>` pane headings (`PaneGrid` side panes) and `<h3>` subsection bands.
- **Focus order:** `tabs` → command strip (`views` → `filters` → `find` → `tools` → `primary`/`actions`) → `notes` → `list` → `foot` → `schedule` → `bands` → splitter → `record` (`openInTab`, close, scrollable body, `DecisionPane` footer).
- **Keyboard between regions:** `/` focuses `[data-list-find] input` when single-key shortcuts are enabled; `ArrowDown`/`ArrowUp` (`J`/`K`) navigates selectable list rows; `ArrowLeft`/`ArrowRight`/`Home` resizes the splitter without dragging (WCAG 2.5.7); `Escape` inside `PaneGrid` closes `related` then `record` and restores focus to `returnFocus` while respecting Korean IME composition (`isImeKey`).
- **Focus not obscured (WCAG 2.4.11) & target size (WCAG 2.5.8):** Sticky table headers and pinned `DecisionPane` footers sit in separate flex containers from scrolling pane bodies, and every control meets `24px` on Console desk and `44px` on phone (`390px`).
