<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Canvas (`P10`)

`CanvasPattern` arranges a viewport-locked pan/zoom canvas (`canvas` floorplan) with a `PageHead`, an optional shared `toolbar` strip, the primary `canvas` stage (`OrgCanvas`), and an optional `inspector` (`SidePaneSpec` in `PaneGrid` or docked `<aside>`).

## Regions (`CanvasPatternProps`)

| Region | Required | Role & owner |
|---|---|---|
| `q` | Yes | Primary canvas read state (`QueryState` `layout="grid"`). |
| `head` | Yes | `PageHead` (`<h1>` or `<h2>` in nested scope). |
| `tabs` | No | Optional view/route tabs above `PageReadGate`. |
| `toolbar` | No | Optional shared toolbar strip beneath `PageHead` (as-of date, search, depth toggle). Hidden until the first answer, then kept through `failed` and the reads that follow it, so the as-of date stays a way out and keeps its focus; a refusal removes it. |
| `notes` | No | Status banners or receipts above `canvas`. |
| `canvas` | Yes | Primary interactive canvas viewport (`min-height: calc(var(--row-h) * 12)`). |
| `inspector`, `inspectorLabel` | No | Optional node inspector (`SidePaneSpec` in `PaneGrid`, or docked `<aside>`). |
| `related`, `full`, `onFull`, `onSelect`, `onOpen` | No | `PaneGrid` side pane controls when `inspector` is a `SidePaneSpec`. |
| `foot` | No | Optional footer beneath `canvas`. |
| `facts` | No (optional) | Summary facts (`canvasOptionalRegions`). |
| `overlays` | No | Supporting sheets kept mounted across `loading` and `failed`. |

## Accessibility & WCAG 2.2 contract

- **Viewport-locked host & focus-not-obscured:** Keeps flex children at `min-width: 0; min-height: 0;` with `OrgCanvas` reveal insets so keyboard-focused nodes scroll clear of floating bars (WCAG 2.4.11).
- **Tree navigation & `Escape` restoration:** Preserves `role="tree"` / `role="treeitem"` arrow-key roving focus and restores focus via `SidePaneSpec.returnFocus` when `Escape` closes the inspector.
- **Phone `390px` layout:** Wrapping `.toolbar` controls and single-pane `PaneGrid` inspector drill-in prevent horizontal overflow.
