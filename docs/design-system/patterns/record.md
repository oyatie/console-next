<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Record (`P3`)

`RecordPattern` arranges a single-entity structured record (such as an employee record card, certificate, or exit dossier) with `PageHead`, optional route sub-tabs, an optional sticky `SecNav` section bar, rule-divided `sections`, and an optional sticky `Spine` timeline.

## Regions (`RecordProps`)

| Region | Required | Role & owner |
|---|---|---|
| `q` | Yes | Primary record `ReadState`; `PageReadGate` strips commands and data on `403` refusal while keeping `h1` and `tabs`. |
| `head` | Yes | `PageHead` (`h1` landmark heading, `crumbs`, `meta`, `asOf`, `primary`, `actions`, `commands`). |
| `tabs` | No | Route/record sub-tabs placed above `PageReadGate` so navigation stays reachable on refusal. |
| `secNav` | No | Sticky `SecNav` jump bar beneath the head. |
| `notes` | No | Status, warning, or receipt banners above the sections. |
| `strip` | No | Compact top fact strip inside the main record column. |
| `sections` | Yes | Ordered `RecordSection` blocks inside the primary column. |
| `spine` | No | Optional sticky right-hand `Spine` timeline (`<aside>`). |
| `foot` | No | Audit metadata or trailing footer beneath `sections`. |
| `facts` | No (optional) | Summary facts (`recordOptionalRegions`). |
| `overlays` | No | Sheets and dialogs kept mounted across `loading` and `failed` states. |

## Accessibility & WCAG 2.2 contract

- **Landmarks & headings:** One `<main>` (when standalone) and one `<h1>` (`head.title`), followed by `<h2>` section and spine headings.
- **Focus order:** `tabs` → `head` → `secNav` → `notes` → `strip` → `sections` (`tabIndex={-1}` jump targets) → `spine` → `foot`.
- **Responsive reflow (WCAG 1.4.10):** At `--below-wide` and `--phone` (`390px`), `spine` unsticks and stacks beneath `sections`, and `secNav` scrolls cleanly with `44px` touch targets.
