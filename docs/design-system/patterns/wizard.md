<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Wizard (`P8`)

`WizardPattern` arranges a multi-step guided workflow (`P-04`) with a `PageHead`, an optional `steps` bar (`StepLine`), a primary step `body`, an optional reference `aside` (e.g. verification checklist or original certificate), and a sticky or inline `ActionBar`.

## Regions (`WizardPatternProps`)

| Region | Required | Role & owner |
|---|---|---|
| `q` | Yes | Primary wizard read state (`QueryState` `layout="form"`). |
| `head` | Yes | `PageHead` (`<h1>` or `<h2>` in nested scope). |
| `tabs` | No | Optional tabs above `PageReadGate`. |
| `steps` | No | Optional step indicator strip (`StepLine`) beneath `PageHead`. |
| `notes` | No | Validation or submission receipts above `body`. |
| `body` | Yes | Primary active step form or review sections. |
| `aside`, `asideLabel` | No | Optional sticky reference column beside `body` (stacks below wide). |
| `notice`, `consequence`, `actions` | `actions` Yes | Rendered inside `ActionBar` (`stickyActions` defaults to `true`). |
| `foot` | No | Optional footer beneath `body`. |
| `facts` | No (optional) | Summary facts (`wizardOptionalRegions`). |
| `overlays` | No | Supporting sheets kept mounted across `loading` and `failed`. |

## Accessibility & WCAG 2.2 contract

- **Single `<h1>` and landmark:** Managed by `PatternShell` (`<main>` and `<h1>` when standalone).
- **Refusal and loading:** `PageReadGate` strips commands, `steps`, `body`, `aside`, and `ActionBar` on `403`, while `overlays` stay mounted across `loading` and `failed`.
- **Phone `390px` containment:** `ActionBar` unsticks at phone widths so step controls never obscure focused inputs, and `<select>` / input controls clamp `min-width: 0; max-width: 100%;`.
