<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# RegisterTotals (`P6`)

`RegisterTotals` arranges a payroll or statutory register with a command strip, a flush `totals` band (`StepLine` stage + aggregate `StatRow`), a conditional `blockers` pre-check strip, a horizontally bounded `register` table with pinned subtotals, and an optional `preview` (`Ledger` payslip preview).

## Regions (`RegisterTotalsProps`)

| Region | Required | Role & owner |
|---|---|---|
| `q` | Yes | Primary register read state governing `PageReadGate`, `QueryState`, and `data-detail`. |
| `head` | Yes | Command strip (`PeriodStepper`, entity selector, filter `Segmented`, search, export/submit). |
| `tabs` | No | Run or register view tabs above `PageReadGate`. |
| `totals` | No | Merged stage (`StepLine`) and aggregate totals (`StatRow`) band beneath `head`. |
| `blockers` | No | Conditional pre-check / advisory strip; omitted completely when clear. |
| `notes` | No | Transient notices or receipts above `register`. |
| `register` | Yes | Horizontally bounded register table inside `PaneGrid` `main`. |
| `preview` | No | Lower `PaneGrid` `bottom` payslip/detail preview (`Ledger` columns). |
| `record`, `related` | No | Resizable `PaneGrid` side panes. |
| `foot` | No | Pagination footer beneath `register`. |
| `facts` | No (optional) | Summary facts (`registerTotalsOptionalRegions`). |
| `overlays` | No | Export, submit, or exception sheets kept mounted across `loading` and `failed`. |

## Accessibility & WCAG 2.2 contract

- **Landmarks & headings:** One `<main>` and one `<h1>`, `<h2>` preview/pane headings, semantic `<table>` headers and `<tfoot>` subtotal rows.
- **Reflow & contrast:** Multi-tile `StatRow` wraps `2×N` on `390px`; `register` stays bounded in its own scroll container (`docOverflow === 0`); blockers use cell/badge urgency tints rather than full-row washes.
