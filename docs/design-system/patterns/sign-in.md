<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# SignIn (`P11`)

`SignInPattern` arranges standalone authentication and passkey enrollment screens outside `ExperienceShell`. It intentionally omits `PatternShell`, `PageReadGate`, `QueryState`, `ActionMenu`, `status-bar-store`, and screen `@console/i18n` catalogs so unauthenticated routes stay within `checkSignInBudget`.

## Regions (`SignInPatternProps`)

| Region | Required | Role & owner |
|---|---|---|
| `title`, `titleId` | `title` Yes | Primary `<h1>` heading rendered through `PageHead`. |
| `context` | No | Optional workspace/access context chip beside the title. |
| `busy` | No | Marks the card `aria-busy` during passkey or OTP ceremonies. |
| `loading` | No | Skeleton placeholder replacing the card while initial policy/terms load (withholds interactive controls until settled). |
| `notices` | No | Error, refusal, or session status banners above `body`. |
| `body` | Yes | Primary sign-in ID, passkey, or consent enrollment controls. |
| `secondary` | No | Optional secondary method (e.g. collapsible one-time code disclosure). |
| `foot` | No | Optional help or sign-out/cancel controls. |
| `facts` | No (optional) | Summary facts (`signInOptionalRegions`). |
| `overlays` | No | Supporting dialogs mounted inside `<main data-pattern="sign-in">`. |
| `baseline` | No | Temporary Classic (`baseline`) fallback renderer until Phase 7. |

## Accessibility & WCAG 2.2 contract

- **Standalone landmark & single `<h1>`:** Owns the sole `<main data-pattern="sign-in">` landmark and single `<h1>` outside the app shell.
- **Zero premature layout shift:** Rendering `loading` withholds interactive controls and buttons until initial terms/documents resolve.
- **Still top edge (Console):** The card's top edge sits at `--panel-top` on a desktop (200 px, coming up on a window too short to keep 500 px under it, so its actions stay in view) and at the top on a phone, so content that arrives (documents, a notice) grows the card downward and moving between the sign-in, error and setup screens never moves it.
- **Theme surface contrast:** Sets an explicit `background: var(--canvas)` on `[data-pattern="sign-in"]` and `background: var(--surface)` on the card across light and dark modes.
