<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Decision pane

`DecisionPane` renders the side-by-side approval decision area (`reject`, optional `return`, and primary `approve`) with a single controlled comment box that is optional on approve and required on reject or request-changes.

## When to use it, and when not

| Use it for |
|---|
| Side-pane (`Worklist` `P1`) and document-pane (`DocumentDecision` `P4`) approval decisions where comment entry and side-by-side decision buttons stay visible together. |

| Do not use it for | Use instead |
|---|
| Standalone single-column executive cards requiring reason-code radio chips | [`ApprovalCard`](approval-card.md). |
| Ordinary record edit or create forms | [`Composer`](composer.md) or [`ActionBar`](action-bar.md). |

## Anatomy

| Part | Element | Purpose |
|---|---|---|
| Root | `<div data-decision-pane>` | Vertical stack holding the comment field, conditional alert, and button row. |
| Label & input | `<label>` + `<input type="text">` | Controlled comment box (`uiWorklist.opinionOptional`). |
| Validation alert | `<div role="alert">` | Shown in place when `reject` or `return` is pressed while `opinion` is blank. |
| Actions row | `<div>` | Side-by-side `Button` (`size="lg"`) controls: `reject`, optional `return`, and `approve` (`variant="primary"`). |

## Looks and sizes

Decision buttons render at `size="lg"` (`--control-h-lg`: `32px` on Console desk, `48px` on Console phone, `40px` on Classic), with `approve` given `2:1` flex weight beside `reject`.

## States

- Idle: optional comment box, enabled buttons.
- Missing required comment on reject/return: input sets `aria-invalid="true"` and `aria-describedby` pointing to `<div role="alert">`, and focus moves to the input without clearing text.
- Pending (`pending="approve" | "reject" | "return"`): active button enters `Button` `pending` (`aria-disabled="true"` keeping focus) while sibling buttons disable.

## Keyboard

| Key | What it does |
|---|---|
| `Tab` / `Shift+Tab` | Moves focus from the comment input across `reject`, optional `return`, and `approve`. |
| `Enter` / `Space` on buttons | Commits the decision or focuses the comment box if a required comment is missing. Korean IME composition inside the input never submits prematurely. |

## Accessibility contract

The comment input is explicitly labelled via `htmlFor`/`id`; missing-reason validation sets `aria-invalid="true"`, links the message via `aria-describedby`, and announces via `role="alert"` (WCAG 2.2 AA 1.3.1, 3.3.1, 3.3.2, 4.1.2).

## Phone behaviour at 390 px

At `390px`, `--field-h` and `--control-h-lg` expand to `48px`, keeping every control above the `44px` touch floor.

## Copy rules

Default labels read `uiWorklist.opinionOptional`, `uiWorklist.opinionRequired`, `uiWorklist.approve`, `uiWorklist.reject`, and `uiWorklist.return` from `packages/i18n`.

## Props

<!-- ds:props apps/web/src/ui/decision-pane/decision-pane.tsx -->

### DecisionPane

| Prop | Required | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `onApprove` | yes | `(opinion: string) => void` |  | Invoked when approve is pressed (`opinion` may be empty). |
| `onOpinionChange` | yes | `(next: string) => void` |  | Updates the controlled comment string. |
| `onReject` | yes | `(opinion: string) => void` |  | Invoked when reject is pressed with a non-empty `opinion`. |
| `opinion` | yes | `string` |  | Controlled comment string preserved across attempts and server errors. |
| `approveLabel` | no | `string` |  | Custom approve button label; defaults to `uiWorklist.approve`. |
| `onReturn` | no | `(opinion: string) => void` |  | Optional request-changes callback; rendered only when the record kind supports returning. |
| `pending` | no | `"approve" \| "reject" \| "return"` |  | In-flight action (`"approve"`, `"reject"`, or `"return"`). |
| `rejectLabel` | no | `string` |  | Custom reject button label; defaults to `uiWorklist.reject`. |
| `resetKey` | no | `number \| string` |  | Optional record key; changing it clears stale missing-reason validation alerts. |
| `returnLabel` | no | `string` |  | Custom request-changes button label; defaults to `uiWorklist.return`. |

<!-- /ds:props -->

## Tokens it reads

<!-- ds:tokens apps/web/src/ui/decision-pane/decision-pane.module.css -->

| Token | Read by |
| --- | --- |
| `--control-border` | `border` |
| `--danger-solid` | `border-color` |
| `--danger-tx` | `color` |
| `--field-h` | `height` |
| `--fw-medium` | `font-weight` |
| `--radius` | `border-radius` |
| `--space-2` | `gap`, `padding` |
| `--steel` | `color` |
| `--surface` | `background` |
| `--text-sm` | `font-size` |
| `--text-xs` | `font-size` |

<!-- /ds:tokens -->
