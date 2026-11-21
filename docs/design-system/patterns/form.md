<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Form (`P7`)

`FormPattern` arranges a governed submission form (such as mobile leave request) with a `PagePhoneHeader`-aware `head`, an optional top `summary` band (`StatRow` and segmented `Meter`), ruled form `sections` inside `Form`, and a sticky or inline `ActionBar`.

## Regions (`FormPatternProps`)

| Region | Required | Role & owner |
|---|---|---|
| `q` | Yes | Primary form read state (`QueryState` `layout="form"`). |
| `head` | Yes | `PageHead` (`<h2>` or omitted when `PagePhoneHeader` `shellOwnsH1` is true). |
| `tabs` | No | Optional tabs above `PageReadGate`. |
| `summary` | No | Optional top balance `StatRow` and segmented `Meter`. |
| `notes` | No | Validation or policy banners above `sections`. |
| `sections` | Yes | Ruled form sections (`ChoiceField`, `DateField` pairs, `KeyValue`, `TextArea`). |
| `notice`, `consequence`, `actions` | `actions` Yes | Rendered inside `ActionBar` (`stickyActions` defaults to `true`). |
| `onSubmit` | Yes | Submitter handler passed to `Form`. |
| `foot` | No | Optional footer beneath `ActionBar`. |
| `facts` | No (optional) | Summary facts (`formOptionalRegions`). |
| `overlays` | No | Supporting sheets kept mounted across `loading` and `failed`. |

## Accessibility & WCAG 2.2 contract

- **Single `<h1>`:** Coordinates with `PagePhoneHeader` (`shellOwnsH1`) so phone top bars never produce duplicate `<h1>` headings.
- **Phone `390px` containment:** Side-by-side `DateField` pairs and `<select>` controls constrain `min-width: 0; max-width: 100%;` with `44px+` touch targets.
