<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# PhoneStatement (`P13`)

`PhoneStatement` arranges a period-stepped personal statement (such as a mobile payslip) with a `PagePhoneHeader`-aware head, a `period` stepper bar, a `hero` net-amount band, top summary `stats`, stacked `ledgers` (`Ledger`), optional `contextStats`, and bottom `actions`.

## Regions (`PhoneStatementProps`)

| Region | Required | Role & owner |
|---|---|---|
| `q` | Yes | Primary statement read state. |
| `head` | Yes | `PageHead` coordinating `<h1>` ownership with `PagePhoneHeader`. |
| `tabs` | No | Optional tabs above `PageReadGate`. |
| `period`, `periodMeta` | No | Period bar holding `PeriodStepper` (`variant="plain"`) and pay-date metadata. |
| `hero` | Yes | Prominent net-amount figure band. |
| `stats` | No | Flush 2-column summary `StatRow` directly beneath `hero`. |
| `notes` | No | Provisional or notice banners above `ledgers`. |
| `ledgers` | Yes | Stacked itemized `Ledger` tables (`headerSurface="muted"`, `detailLayout="inline"`). |
| `contextStats` | No | Contextual `StatRow` beneath `ledgers` (e.g. worked days and leave used). |
| `actions` | No | Equal-width bottom action buttons (`PDF`, history). |
| `foot` | No | Trailing footer content. |
| `facts` | No (optional) | Summary facts (`phoneStatementOptionalRegions`). |
| `overlays` | No | History or export sheets kept mounted across `loading` and `failed`. |

## Accessibility & WCAG 2.2 contract

- **Tabular figures & semantic tables:** Monetary figures use `tabular-nums`, and each `Ledger` exposes semantic `<th scope="row">` and `<tfoot>` totals.
- **Reflow (WCAG 1.4.10):** Inline ledger details wrap cleanly at `390px` and `320px` with zero horizontal overflow.
