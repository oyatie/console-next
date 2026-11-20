<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# MonthGrid (`P5`)

`MonthGridPattern` arranges a monthly attendance or schedule matrix (`PersonDayGrid` or `MonthGrid`) under a merged command strip (`PeriodStepper`, scope selector, and filters), an optional flush `summary` `StatRow`, an optional `bottom` split panel (exceptions + legend), and `PaneGrid` `record` / `related` inspection docks.

## Regions (`MonthGridPatternProps`)

| Region | Required | Role & owner |
|---|---|---|
| `q` | Yes | Primary month read state governing refusal, loading skeleton, and `data-detail`. |
| `head` | Yes | Merged command strip (`PeriodStepper`, scope selector, `Segmented` filter, status, actions). |
| `tabs` | No | View tabs above `PageReadGate`. |
| `summary` | No | Flush edge-to-edge `StatRow` directly beneath `head` (wraps `2×N` on phone when `>= 4` items). |
| `notes` | No | Month-close, offline, or undo notices above `grid`. |
| `grid` | Yes | Horizontally bounded `PersonDayGrid` or `MonthGrid` inside `PaneGrid` `main`. |
| `bottom` | No | Lower split region (`PaneGrid` `bottom`) for unconfirmed exceptions and legend. |
| `record`, `related` | No | Resizable `PaneGrid` inspection docks (`SaveDock` / `DayDock`). |
| `foot` | No | Paging or count footer beneath `grid`. |
| `facts` | No (optional) | Summary facts (`monthGridOptionalRegions`). |
| `overlays` | No | Batch or close confirmation sheets kept mounted across `loading` and `failed`. |

## Accessibility & WCAG 2.2 contract

- **Landmarks & headings:** One `<main>` and one `<h1>`, `<h2>` pane headings, and `role="grid"` with roving active descendant inside `PersonDayGrid`/`MonthGrid`.
- **Reflow (WCAG 1.4.10):** `grid` scrolls inside its own `overflow-x: auto` container (`overscroll-behavior: contain`) with zero document-level horizontal overflow at `390px`.
