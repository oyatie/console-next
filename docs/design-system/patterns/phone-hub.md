<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# PhoneHub (`P12`)

`PhoneHub` arranges a phone-first single-column self-service hub (such as My Account) with a `PagePhoneHeader`-aware head, `identity` band, flush `stats` `StatRow`, rule-divided `links`, and `--surface-2`-headed `sections`.

## Regions (`PhoneHubProps`)

| Region | Required | Role & owner |
|---|---|---|
| `q` | Yes | Primary profile/hub read state. |
| `head` | Yes | `PageHead` coordinating `<h1>` ownership with `PagePhoneHeader`. |
| `tabs` | No | Optional tabs above `PageReadGate`. |
| `identity` | No | Name, status tag, and role subtitle band. |
| `stats` | No | Flush summary `StatRow` directly beneath `identity`. |
| `links` | No | Full-width rule-divided quick navigation rows (`PhoneHubLinkItem[]`) with optional `renderLink`. |
| `notes` | No | Recovery or policy banners above `sections`. |
| `sections` | Yes | Grouped `PhoneHubSection[]` (`--surface-2` header with `<h2>` and optional trailing action). |
| `foot` | No | Trailing footer content. |
| `facts` | No (optional) | Summary facts (`phoneHubOptionalRegions`). |
| `overlays` | No | Edit or reveal sheets kept mounted across `loading` and `failed`. |

## Accessibility & WCAG 2.2 contract

- **Landmarks & headings:** Single `<main>` and single `<h1>` (via `PagePhoneHeader` or `PageHead`), followed by labelled `<section>` landmarks (`<h2>`).
- **Phone `390px` containment:** All controls (`select`, `input`, `KeyValue`) constrain `min-width: 0; max-width: 100%;` and every link row meets `--row-h` (`48px` on phone).
