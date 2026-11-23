<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# DocumentDecision (`P4`)

`DocumentDecision` arranges an approval or review document in a two- or three-pane workspace: optional `start` rail (`KeyValue` facts, `ChainStepper`, attachments, or inbox queue), center `document` canvas, and right-hand `decision` pane (`SidePaneSpec` in `PaneGrid` or docked `<aside>`).

## Regions (`DocumentDecisionProps`)

| Region | Required | Role & owner |
|---|---|---|
| `q` | Yes | Primary document `ReadState`; `PageReadGate` and `queryView(q)` guard `data-detail` and commands. |
| `head` | Yes | `PageHead` (`h1` title, queue stepper in `filters`, reference in `meta`, trailing `actions`). |
| `tabs` | No | Box/queue tabs placed above `PageReadGate`. |
| `notes` | No | Staleness (`409`), receipt, or verification banners above `document`. |
| `start` | No | Optional `PaneGrid` `start` pane for document facts, approval chain, or queue list. |
| `document` | Yes | Center document body (`ChangeRows`, affected rows, reason, impact). |
| `decision` | No | Right-hand `DecisionPane` and pre-decision links (`SidePaneSpec` or docked `<aside>`). |
| `related` | No | Secondary `PaneGrid` related-record pane. |
| `foot` | No | Trailing metadata beneath `document`. |
| `facts` | No (optional) | Summary facts (`documentDecisionOptionalRegions`). |
| `overlays` | No | History or export sheets kept mounted across `loading` and `failed`. |

## Accessibility & WCAG 2.2 contract

- **Landmarks & headings:** One `<main>` and one `<h1>` (`head.title`), `<h2>` document/pane headings, and named `<aside>` decision region.
- **Keyboard & focus:** `PaneGrid` manages Escape dismissal and return focus when `decision` is a `SidePaneSpec`; `DecisionPane` preserves typed `opinion` across required-reason alerts and focuses the input/textarea on missing reject/return reason.
